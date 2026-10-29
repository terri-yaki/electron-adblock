// Read-only inspector smoke for hidden custom-scheme windows (TFTAcademy style).
// It never launches, closes, injects into, hides or filters any target; the only optional
// side effect is debugger.attach + immediate detach behind --attach.
//   node --import tsx tests/helpers/inspector-smoke.ts [--inspector-port 54601] [--cdp-port 54600]
//        [--contains tftacademy://] [--attach]
import { CdpConnection, fetchTargets, type TargetInfo } from './cdp';

interface SmokeWindow {
  id?: number;
  url?: string;
  type?: string;
  visible?: boolean;
}

interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

const checks: CheckResult[] = [];
let failures = 0;

function check(name: string, pass: boolean, detail = ''): void {
  checks.push({ name, pass: Boolean(pass), detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
  if (!pass) failures += 1;
}

function argValue(name: string, fallback: string): string {
  const index = process.argv.indexOf('--' + name);
  if (index === -1) return fallback;
  const next = process.argv[index + 1];
  return next && !next.startsWith('--') ? next : fallback;
}

async function fetchJson(url: string, timeoutMs = 3000): Promise<unknown> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function parseWindows(value: unknown): SmokeWindow[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      id: typeof entry.id === 'number' ? entry.id : undefined,
      url: typeof entry.url === 'string' ? entry.url : '',
      type: typeof entry.type === 'string' ? entry.type : '',
      visible: typeof entry.visible === 'boolean' ? entry.visible : undefined,
    }));
}

const INSPECT_EXPRESSION =
  '(() => { try { const electron = process.mainModule.require("electron"); return electron.webContents.getAllWebContents().filter((wc) => !wc.isDestroyed()).map((wc) => ({ id: wc.id, url: wc.getURL(), type: wc.getType(), visible: wc.isVisible() })); } catch (error) { return { error: String(error) }; } })()';

const ATTACH_EXPRESSION =
  '(() => { const results = []; try { const electron = process.mainModule.require("electron"); for (const wc of electron.webContents.getAllWebContents()) { if (wc.isDestroyed()) continue; if (!wc.getURL().startsWith(' +
  JSON.stringify(argValue('contains', 'tftacademy://')) +
  ')) continue; const entry = { url: wc.getURL(), attached: false, title: "" }; try { wc.debugger.attach("1.3"); entry.attached = true; entry.title = wc.getTitle(); } catch (error) { entry.error = String(error); } finally { try { if (wc.debugger.isAttached()) wc.debugger.detach(); } catch {} } results.push(entry); } } catch (error) { return { error: String(error) }; } return results; })()';

async function main(): Promise<void> {
  const inspectorPort = Number(argValue('inspector-port', '54601'));
  const cdpPort = Number(argValue('cdp-port', '54600'));
  const contains = argValue('contains', 'tftacademy://');
  const attach = process.argv.includes('--attach');

  const nodeTargets = await fetchTargets(inspectorPort);
  if (nodeTargets.length === 0) {
    check('node inspector port ' + String(inspectorPort) + ' is open', false, 'GET /json/list returned no targets');
    console.log('RESULT ' + String(checks.length - failures) + '/' + String(checks.length) + ' checks passed');
    process.exitCode = 2;
    return;
  }
  const nodeTarget: TargetInfo | undefined = nodeTargets.find((target) => target.type === 'node');
  check('node inspector target is listed', Boolean(nodeTarget), 'targets=' + String(nodeTargets.length));

  const cdpTargets = (await fetchJson('http://127.0.0.1:' + String(cdpPort) + '/json/list')) as unknown;
  const cdpUrls: string[] = Array.isArray(cdpTargets)
    ? cdpTargets
        .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
        .map((entry) => String(entry.url ?? ''))
    : [];

  if (!nodeTarget || typeof nodeTarget.webSocketDebuggerUrl !== 'string') {
    console.log('RESULT ' + String(checks.length - failures) + '/' + String(checks.length) + ' checks passed');
    process.exitCode = 2;
    return;
  }

  const connection = await CdpConnection.connect(nodeTarget.webSocketDebuggerUrl);
  try {
    const inspected = await connection.send('Runtime.evaluate', {
      expression: INSPECT_EXPRESSION,
      returnByValue: true,
      awaitPromise: true,
    });
    const remote = inspected.result as { value?: unknown } | undefined;
    const windows = parseWindows(remote?.value);
    const windowList = windows.map((window) => String(window.id) + ':' + String(window.type) + ':' + String(window.url));
    console.log('main-process windows: ' + JSON.stringify(windowList));

    check('main process webContents are enumerable', windows.length > 0, 'count=' + String(windows.length));
    const hiddenWindows = windows.filter((window) => (window.url ?? '').includes(contains));
    check(
      'hidden custom-scheme window is visible to the main process',
      hiddenWindows.length > 0,
      'match=' + contains + ' count=' + String(hiddenWindows.length),
    );
    check(
      'hidden window URL is absent from the CDP target list',
      cdpUrls.length > 0 && !cdpUrls.some((url) => url.includes(contains)),
      'cdp targets=' + String(cdpUrls.length),
    );

    if (attach) {
      const attached = await connection.send('Runtime.evaluate', {
        expression: ATTACH_EXPRESSION,
        returnByValue: true,
        awaitPromise: true,
      });
      const attachRemote = attached.result as { value?: unknown } | undefined;
      const results = Array.isArray(attachRemote?.value)
        ? (attachRemote?.value as Array<Record<string, unknown>>)
        : [];
      check(
        'debugger attach/detach works on the hidden window',
        results.length > 0 && results.every((entry) => entry.attached === true),
        JSON.stringify(results),
      );
    } else {
      console.log('NOOP: --attach not set; no debugger was attached (read-only enumeration only)');
    }
  } finally {
    await connection.close();
  }

  console.log('RESULT ' + String(checks.length - failures) + '/' + String(checks.length) + ' checks passed');
  if (failures > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error('SMOKE FAILURE: ' + (error instanceof Error ? (error.stack ?? error.message) : String(error)));
  process.exitCode = 2;
});
