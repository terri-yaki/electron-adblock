import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import WebSocket from 'ws';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.join(root, '_shots');
const DEFAULT_EXE = 'C:\\Users\\hoyul\\AppData\\Local\\Programs\\OP.GG\\OP.GG.exe';

function argValue(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  if (index === -1) return fallback;
  const next = process.argv[index + 1];
  return next && !next.startsWith('--') ? next : fallback;
}

const options = {
  exe: argValue('exe', DEFAULT_EXE),
  port: Number(argValue('port', '9333')),
  relaunch: process.argv.includes('--relaunch'),
  picker: process.argv.includes('--picker'),
  noScanAdd: process.argv.includes('--no-scan-add'),
  quit: process.argv.includes('--quit'),
  keep: process.argv.includes('--keep'),
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(...values) {
  console.log('[live]', ...values);
}

async function httpJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 1500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForDebugEndpoint(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const version = await httpJson('http://127.0.0.1:' + port + '/json/version', 1200);
    if (version) return version;
    await sleep(400);
  }
  return null;
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    socket.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.id) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message || 'CDP error'));
        else entry.resolve(message.result);
        return;
      }
      const handlers = this.events.get(message.method);
      if (handlers) for (const handler of handlers) handler(message.params || {});
    });
    socket.on('close', () => {
      for (const entry of this.pending.values()) entry.reject(new Error('CDP socket closed'));
      this.pending.clear();
    });
  }

  static connect(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { perMessageDeflate: false });
      const timer = setTimeout(() => {
        try {
          socket.close();
        } catch {
          // ignore
        }
        reject(new Error('CDP connect timeout: ' + url));
      }, timeoutMs || 8000);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve(new CdpClient(socket));
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  send(method, params, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('CDP timeout: ' + method));
      }, 20000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify(payload));
    });
  }

  on(method, handler) {
    const list = this.events.get(method) || [];
    list.push(handler);
    this.events.set(method, list);
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // ignore
    }
  }
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed';
    throw new Error(text);
  }
  return result.result ? result.result.value : undefined;
}

async function callApi(client, method, ...args) {
  const serialized = args.map((value) => JSON.stringify(value)).join(', ');
  return evaluate(client, 'window.adblock.' + method + '(' + serialized + ')');
}

async function waitForApi(client, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ready = await evaluate(client, 'typeof window.adblock === "object"');
      if (ready) return true;
    } catch {
      // renderer still loading
    }
    await sleep(400);
  }
  return false;
}

async function waitForAttached(client, appId, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const state = await callApi(client, 'getBootstrap');
    const app = state.apps.find((item) => item.id === appId);
    last = app;
    if (app && app.attached) return app;
    await sleep(700);
  }
  return last;
}

async function capturePage(client, file) {
  await client.send('Page.enable');
  const result = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  return file;
}

async function captureDesktop(file) {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
    '$graphics = [System.Drawing.Graphics]::FromImage($bitmap)',
    '$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
    '$bitmap.Save("' + file.replace(/\\/g, '\\\\') + '", [System.Drawing.Imaging.ImageFormat]::Png)',
    '$graphics.Dispose()',
    '$bitmap.Dispose()',
  ].join('; ');
  await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20000 }, () => resolve());
  });
  return file;
}

async function findPageTarget(port, predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const targets = await httpJson('http://127.0.0.1:' + port + '/json/list', 1500);
    if (Array.isArray(targets)) {
      const match = targets.find(predicate);
      if (match) return match;
    }
    await sleep(500);
  }
  return null;
}

async function openPageClient(port, predicate) {
  const target = await findPageTarget(port, predicate, 15000);
  if (!target) return null;
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  return client;
}

async function pickElement(client, selector) {
  const rect = await evaluate(
    client,
    '(function(){var el=document.querySelector(' + JSON.stringify(selector) + ');if(!el)return null;var r=el.getBoundingClientRect();if(!r.width||!r.height)return null;return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height};})()',
  );
  if (!rect) return null;
  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await sleep(150);
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await sleep(60);
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  return { x, y, width: rect.w, height: rect.h };
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  if (!fs.existsSync(path.join(root, 'build', 'main.cjs'))) {
    throw new Error('Run npm run build before live verification');
  }
  if (!fs.existsSync(options.exe)) throw new Error('Executable not found: ' + options.exe);

  const env = { ...process.env, EAB_DEBUG_PORT: String(options.port) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;

  log('starting Electron Adblock with debug port', options.port);
  const child = spawn(electronPath, ['.'], { cwd: root, env, stdio: 'ignore', detached: true });
  child.unref();
  log('app pid', child.pid);

  const version = await waitForDebugEndpoint(options.port, 25000);
  if (!version) throw new Error('Electron Adblock did not expose its debug port');

  const appClient = await openPageClient(options.port, (target) => target.type === 'page' && String(target.url || '').includes('index.html'), 15000);
  if (!appClient) throw new Error('Could not find the Electron Adblock renderer target');
  await appClient.send('Runtime.enable');
  await waitForApi(appClient, 20000);

  let state = await callApi(appClient, 'getBootstrap');
  let app = state.apps.find((item) => item.exePath.toLowerCase().endsWith('op.gg.exe'));
  if (!app) {
    log('adding', options.exe);
    const added = await callApi(appClient, 'addApp', options.exe);
    app = added;
  }
  log('app id', app.id, 'status', app.status, 'attached', app.attached);

  if (!app.attached) {
    if (options.relaunch) {
      log('relaunching through Electron Adblock (closes the running instance)');
      await callApi(appClient, 'relaunchApp', app.id);
    } else {
      log('app is not attached. Re-run with --relaunch to restart it under ad blocking.');
      console.log(JSON.stringify({ ok: false, reason: 'not-attached', status: app.status }));
      process.exitCode = 2;
      return;
    }
  }

  app = await waitForAttached(appClient, app.id, 60000);
  if (!app || !app.attached) {
    throw new Error('App did not attach: ' + JSON.stringify(app && { status: app.status, error: app.lastError }));
  }
  log('attached. pages', app.pages, 'electron', app.electronVersion || 'unknown');
  await sleep(2500);
  let opggTargets = [];
  try {
    opggTargets = await httpJson('http://127.0.0.1:' + (app.debugPort || 0) + '/json/list', 2000) || [];
    log('opgg page targets:');
    for (const target of opggTargets.filter((item) => item.type === 'page')) {
      log('  target', target.title || '(no title)', '|', target.url);
    }
  } catch (error) {
    log('target list failed:', error.message);
  }
  let beforeShot = null;
  try {
    const beforeClient = await openPageClient(app.debugPort || 0, (target) => target.type === 'page' && /^https?:/.test(String(target.url || '')), 12000);
    if (beforeClient) {
      beforeShot = await capturePage(beforeClient, path.join(outDir, 'live-app-before.png'));
      beforeClient.close();
    }
  } catch (error) {
    log('before screenshot failed:', error.message);
  }
  await sleep(1500);

  state = await callApi(appClient, 'getBootstrap');
  app = state.apps.find((item) => item.id === app.id);
  log('blocked requests so far:', app.stats.blockedRequests, 'hidden:', app.stats.hiddenElements);
  log('current page:', app.currentUrl || '(unknown)');

  let candidates = [];
  try {
    candidates = await callApi(appClient, 'scanForAds', app.id);
  } catch (error) {
    log('scan failed:', error.message);
  }
  log('scan candidates:', candidates.length);
  for (const candidate of candidates.slice(0, 8)) {
    log('  candidate', candidate.selector, '|', candidate.reason, '|', candidate.matchCount, 'matches', candidate.width + 'x' + candidate.height);
  }

  if (!options.noScanAdd && candidates.length > 0) {
    const useful = candidates.filter((item) => item.width >= 80 && item.height >= 24).slice(0, 3);
    for (const candidate of useful) {
      try {
        await callApi(appClient, 'addCosmeticRule', app.id, {
          selector: candidate.selector,
          label: candidate.reason,
          source: 'suggestion',
        });
        log('added hide rule', candidate.selector);
      } catch (error) {
        log('could not add', candidate.selector, error.message);
      }
    }
  }

  if (options.picker && candidates.length > 0) {
    const target = candidates.find((item) => item.width >= 80 && item.height >= 24) || candidates[0];
    log('starting picker and clicking', target.selector);
    try {
      await callApi(appClient, 'startPicker', app.id);
      await sleep(500);
      const opggState = await callApi(appClient, 'getBootstrap');
      const opggApp = opggState.apps.find((item) => item.id === app.id);
      const opggClient = await openPageClient(opggApp.debugPort || 0, (item) => item.type === 'page' && /^https?:/.test(String(item.url || '')), 12000);
      if (!opggClient) throw new Error('Could not open OP.GG page target');
      const hit = await pickElement(opggClient, target.selector);
      log('clicked at', hit ? hit.x + ',' + hit.y : 'no rect');
      await sleep(1800);
      await callApi(appClient, 'stopPicker', app.id);
      opggClient.close();
    } catch (error) {
      log('picker flow failed:', error.message);
      try {
        await callApi(appClient, 'stopPicker', app.id);
      } catch {
        // ignore
      }
    }
  }

  await sleep(3000);
  state = await callApi(appClient, 'getBootstrap');
  app = state.apps.find((item) => item.id === app.id);
  log('final blocked:', app.stats.blockedRequests, 'hidden:', app.stats.hiddenElements, 'rules:', app.cosmeticRules.length, 'network rules:', app.networkRules.length);
  log('blocked log sample:', (await callApi(appClient, 'getBlockedLog', app.id)).slice(0, 5).map((entry) => entry.url));

  const dashboard = await capturePage(appClient, path.join(outDir, 'live-dashboard.png'));
  log('dashboard screenshot', dashboard);
  log('before screenshot', beforeShot);

  let opggShot = null;
  try {
    const currentState = await callApi(appClient, 'getBootstrap');
    const currentApp = currentState.apps.find((item) => item.id === app.id);
    const opggClient = await openPageClient(
      currentApp.debugPort || 0,
      (target) => target.type === 'page' && /^https?:/.test(String(target.url || '')),
      12000,
    );
    if (opggClient) {
      opggShot = await capturePage(opggClient, path.join(outDir, 'live-app-window.png'));
      await capturePage(opggClient, path.join(outDir, 'live-app-after.png'));
      log('app screenshot', opggShot);
      opggClient.close();
    }
  } catch (error) {
    log('app screenshot failed:', error.message);
  }

  const desktop = await captureDesktop(path.join(outDir, 'live-desktop.png'));
  log('desktop screenshot', desktop);

  if (options.quit) {
    try {
      await callApi(appClient, 'detachApp', app.id);
    } catch {
      // ignore
    }
    process.kill(child.pid);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        appId: app.id,
        attached: app.attached,
        pages: app.pages,
        blockedRequests: app.stats.blockedRequests,
        hiddenElements: app.stats.hiddenElements,
        cosmeticRules: app.cosmeticRules.length,
        screenshots: [dashboard, opggShot, desktop].filter(Boolean),
        quit: options.quit,
      },
      null,
      2,
    ),
  );
  if (!options.quit) log('Electron Adblock is still running (pid ' + child.pid + '). Quit it from the tray when done.');
  appClient.close();
}

main().catch((error) => {
  console.error('[live] failed:', error);
  process.exitCode = 1;
});
