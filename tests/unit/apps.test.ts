import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  isExcludedElectronTarget,
  parseCimProcessOutput,
  parseShortcutEntries,
  parseTasklistCsv,
  parseWindowsCommandLine,
} from '../../src/main/apps/discovery';
import {
  allocateDebugPort,
  buildLaunchArguments,
  cleanChildEnvironment,
  parseListeningPorts,
  waitForDebugEndpoint,
} from '../../src/main/apps/launcher';
import { createDefaultState } from '../../src/shared/defaults';
import type { PersistedApp } from '../../src/shared/types';
import { AppStore, sanitizePersistedState } from '../../src/main/store';

type RequestHandler = (request: IncomingMessage, response: ServerResponse) => void;

function startServer(handler: RequestHandler): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to bind test server'));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'eab-apps-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createTestApp(overrides: Partial<PersistedApp> = {}): PersistedApp {
  return {
    id: 'app-1',
    name: 'Test App',
    exePath: 'C:\\Program Files\\Test App\\Test App.exe',
    shortcutArgs: ['--flag'],
    source: 'manual',
    enabled: true,
    addedAt: 1_700_000_000_000,
    cosmeticRules: [],
    networkRules: [],
    layoutRules: [],
    ...overrides,
  };
}

test('parseTasklistCsv parses quoted tasklist rows and skips junk', () => {
  const output = [
    '"System Idle Process","0","Services","0","8 K"',
    '"OP.GG.exe","13172","Console","1","350,000 K"',
    '"Some, App.exe","2048","Console","1","1,234 K"',
    '"Quote ""Name"".exe","4096","Console","1","1 K"',
    '',
    'INFO: No tasks are running which match the specified criteria.',
    'garbage without a pid',
  ].join('\r\n');
  const processes = parseTasklistCsv(output);
  assert.deepEqual(processes.map((process) => process.pid), [13172, 2048, 4096]);
  assert.equal(processes[0].name, 'OP.GG.exe');
  assert.equal(processes[1].name, 'Some, App.exe');
  assert.equal(processes[2].name, 'Quote "Name".exe');
});

test('parseWindowsCommandLine splits quoted Windows arguments', () => {
  assert.deepEqual(parseWindowsCommandLine(''), []);
  assert.deepEqual(parseWindowsCommandLine('--user-data-dir="C:\\Users\\A B\\dir"'), [
    '--user-data-dir=C:\\Users\\A B\\dir',
  ]);
  assert.deepEqual(parseWindowsCommandLine('  "C:\\Program Files\\Test App\\Test App.exe" --flag  '), [
    'C:\\Program Files\\Test App\\Test App.exe',
    '--flag',
  ]);
  assert.deepEqual(parseWindowsCommandLine('one "" two'), ['one', '', 'two']);
});

test('parseShortcutEntries accepts only resolved shortcut JSON lines', () => {
  const output = [
    JSON.stringify({ shortcut: 'C:\\Start\\Foo.lnk', name: 'Foo', target: 'C:\\Foo\\Foo.exe', args: '--a --b' }),
    'not json',
    '{}',
    JSON.stringify({ name: 'NoTarget' }),
  ].join('\r\n');
  assert.deepEqual(parseShortcutEntries(output), [
    {
      shortcutPath: 'C:\\Start\\Foo.lnk',
      name: 'Foo',
      targetPath: 'C:\\Foo\\Foo.exe',
      arguments: '--a --b',
    },
  ]);
});

test('parseCimProcessOutput accepts arrays, single objects and BOM output', () => {
  const arrayJson = JSON.stringify([
    { ProcessId: 42, Name: 'OP.GG.exe', ExecutablePath: 'C:\\Apps\\OP.GG\\OP.GG.exe' },
    { ProcessId: 42, Name: 'duplicate' },
    { ProcessId: 0, Name: 'System Idle Process' },
  ]);
  assert.deepEqual(parseCimProcessOutput(arrayJson), [
    { pid: 42, name: 'OP.GG.exe', exePath: 'C:\\Apps\\OP.GG\\OP.GG.exe' },
  ]);
  const single = JSON.stringify({ ProcessId: 7, Name: 'App.exe', ExecutablePath: null });
  assert.deepEqual(parseCimProcessOutput('\uFEFF' + single), [{ pid: 7, name: 'App.exe' }]);
  assert.deepEqual(parseCimProcessOutput(''), []);
});

test('isExcludedElectronTarget filters this adblocker and node_modules electron', () => {
  assert.equal(isExcludedElectronTarget('C:\\Program Files\\Electron Adblock\\Electron Adblock.exe', 'C:\\Other\\electron.exe'), true);
  assert.equal(isExcludedElectronTarget('C:\\Dev\\node_modules\\electron\\dist\\electron.exe', 'C:\\Other\\electron.exe'), true);
  assert.equal(isExcludedElectronTarget('C:\\Other\\electron.exe', 'C:\\Other\\electron.exe'), true);
  assert.equal(isExcludedElectronTarget('C:\\Program Files\\App\\App.exe', 'C:\\Other\\electron.exe'), false);
});

test('parseListeningPorts finds TCP listeners for the given pids', () => {
  const output = [
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1816',
    '  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       4242',
    '  TCP    [::1]:9229             [::]:0                 LISTENING       4242',
    '  TCP    127.0.0.1:52344        127.0.0.1:9222         ESTABLISHED     5000',
    '  TCP    127.0.0.1:9223         0.0.0.0:0              ABHOEREN        7777',
    '  TCP    127.0.0.1:9224         127.0.0.1:9999         ESTABLISHED     7777',
    '  UDP    0.0.0.0:500            *:*                    1816',
  ].join('\r\n');
  assert.deepEqual(parseListeningPorts(output), [135, 9222, 9223, 9229]);
  assert.deepEqual(parseListeningPorts(output, new Set([4242])), [9222, 9229]);
});

test('allocateDebugPort honors free ports and avoids busy ones', async () => {
  const { server, port: busyPort } = await startServer((_request, response) => {
    response.statusCode = 204;
    response.end();
  });
  try {
    const ephemeral = await allocateDebugPort();
    assert.ok(ephemeral > 0 && ephemeral < 65536);
    const avoidBusy = await allocateDebugPort(busyPort);
    assert.ok(avoidBusy > 0 && avoidBusy < 65536);
    assert.notEqual(avoidBusy, busyPort);
    let preferredFree = false;
    for (let attempt = 0; attempt < 5 && !preferredFree; attempt += 1) {
      const candidate = await allocateDebugPort();
      preferredFree = (await allocateDebugPort(candidate)) === candidate;
    }
    assert.equal(preferredFree, true);
  } finally {
    await closeServer(server);
  }
});

test('waitForDebugEndpoint probes the /json/version endpoint', async () => {
  const debugServer = await startServer((request, response) => {
    if (request.url === '/json/version') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ Browser: 'Chrome/144.0.0.0', webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/x' }));
      return;
    }
    response.statusCode = 404;
    response.end('nope');
  });
  try {
    assert.equal(await waitForDebugEndpoint(debugServer.port, 3000), true);
  } finally {
    await closeServer(debugServer.server);
  }
  const plainServer = await startServer((_request, response) => {
    response.statusCode = 404;
    response.end('nope');
  });
  try {
    assert.equal(await waitForDebugEndpoint(plainServer.port, 700), false);
  } finally {
    await closeServer(plainServer.server);
  }
  const closed = await startServer((_request, response) => response.end());
  const closedPort = closed.port;
  await closeServer(closed.server);
  assert.equal(await waitForDebugEndpoint(closedPort, 900), false);
});

test('buildLaunchArguments replaces stale debug flags', () => {
  assert.deepEqual(buildLaunchArguments([], 9222), ['--remote-debugging-port=9222']);
  assert.deepEqual(
    buildLaunchArguments(['--foo', '--remote-debugging-port=1111', 'bar', '--remote-debugging-port', '2222'], 9333),
    ['--foo', 'bar', '--remote-debugging-port=9333'],
  );
});

test('cleanChildEnvironment strips DSH Electron host variables', () => {
  const environment = cleanChildEnvironment({
    PATH: 'x',
    ELECTRON_RUN_AS_NODE: '1',
    electron_no_attach_console: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    KEEP: 'yes',
  });
  assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(environment.electron_no_attach_console, undefined);
  assert.equal(environment.ELECTRON_NO_ATTACH_CONSOLE, undefined);
  assert.equal(environment.PATH, 'x');
  assert.equal(environment.KEEP, 'yes');
});

test('AppStore roundtrips state through the JSON file', async () => {
  await withTempDir(async (dir) => {
    const store = new AppStore(dir);
    await store.load();
    assert.deepEqual(store.data, createDefaultState());
    store.data.settings.enabled = false;
    store.data.settings.pickerHotkey = 'Ctrl+Shift+X';
    store.data.apps.push(createTestApp());
    await store.save();
    const files = await readdir(dir);
    assert.ok(files.includes('adblock-data.json'));
    assert.equal(files.filter((file) => file.endsWith('.tmp')).length, 0);
    const onDisk = JSON.parse(await readFile(path.join(dir, 'adblock-data.json'), 'utf8')) as { schemaVersion: number };
    assert.equal(onDisk.schemaVersion, 1);
    const reloaded = new AppStore(dir);
    await reloaded.load();
    assert.deepEqual(reloaded.data, store.data);
  });
});

test('AppStore creates a missing data directory', async () => {
  await withTempDir(async (parent) => {
    const dir = path.join(parent, 'nested', 'data');
    const store = new AppStore(dir);
    await store.load();
    await store.save();
    assert.ok((await readdir(dir)).includes('adblock-data.json'));
  });
});

test('AppStore backs up corrupt JSON and resets to defaults', async () => {
  await withTempDir(async (dir) => {
    const dataPath = path.join(dir, 'adblock-data.json');
    await writeFile(dataPath, '{ this is not valid json', 'utf8');
    const store = new AppStore(dir);
    await store.load();
    assert.deepEqual(store.data, createDefaultState());
    const backups = (await readdir(dir)).filter((file) => file.startsWith('adblock-data.json.corrupt-'));
    assert.equal(backups.length, 1);
    assert.match(await readFile(path.join(dir, backups[0]), 'utf8'), /not valid json/);
    const rewritten = JSON.parse(await readFile(dataPath, 'utf8')) as { schemaVersion: number };
    assert.equal(rewritten.schemaVersion, 1);
  });
});

test('AppStore rejects an incompatible schema version', async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, 'adblock-data.json'),
      JSON.stringify({ schemaVersion: 2, settings: {}, apps: [] }),
      'utf8',
    );
    const store = new AppStore(dir);
    await store.load();
    assert.deepEqual(store.data, createDefaultState());
    const backups = (await readdir(dir)).filter((file) => file.startsWith('adblock-data.json.corrupt-'));
    assert.equal(backups.length, 1);
  });
});

test('AppStore serializes concurrent saves without losing the last update', async () => {
  await withTempDir(async (dir) => {
    const store = new AppStore(dir);
    await store.load();
    store.data.settings.enabled = false;
    const first = store.save();
    store.data.settings.blockAnalytics = true;
    const second = store.save();
    await Promise.all([first, second]);
    const reloaded = new AppStore(dir);
    await reloaded.load();
    assert.equal(reloaded.data.settings.enabled, false);
    assert.equal(reloaded.data.settings.blockAnalytics, true);
  });
});

test('sanitizePersistedState merges settings and drops invalid apps', () => {
  const state = sanitizePersistedState({
    schemaVersion: 1,
    settings: { enabled: false, pickerHotkey: 'Alt+Q' },
    apps: [createTestApp(), createTestApp({ id: 'APP-1' }), { id: 'broken' }, 'nope'],
  });
  assert.ok(state);
  assert.equal(state.settings.enabled, false);
  assert.equal(state.settings.pickerHotkey, 'Alt+Q');
  assert.equal(state.settings.blockAnalytics, createDefaultState().settings.blockAnalytics);
  assert.equal(state.apps.length, 1);
  assert.equal(state.apps[0].name, 'Test App');
  assert.equal(sanitizePersistedState(null), null);
  assert.equal(sanitizePersistedState({ schemaVersion: 2, apps: [] }), null);
  assert.equal(sanitizePersistedState({ schemaVersion: 1, apps: 'nope' }), null);
});
