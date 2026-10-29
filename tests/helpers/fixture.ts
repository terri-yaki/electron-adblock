import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { waitForEndpoint } from './cdp';

const execFileAsync = promisify(execFile);

export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const FIXTURE_MAIN_PATH = path.join(PROJECT_ROOT, 'fixture', 'main.js');
export const ELECTRON_EXE = path.join(PROJECT_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

const OUTPUT_LIMIT = 20000;

export interface FixtureResource {
  close(): Promise<void> | void;
}

export interface LaunchFixtureOptions {
  url?: string;
  /** Extra resources (for example the ad server) closed together with the fixture. */
  cleanup?: FixtureResource[];
  extraArgs?: string[];
  startupTimeoutMs?: number;
}

export interface FixtureExitInfo {
  exited: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface FixtureHandle {
  readonly pid: number;
  readonly port: number;
  readonly url: string;
  readonly userDataDir: string;
  output(): string;
  exitInfo(): FixtureExitInfo;
  close(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function allocateTcpPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to allocate a local TCP port'));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function ensureElectronBinary(): Promise<void> {
  try {
    await access(ELECTRON_EXE);
  } catch {
    throw new Error('Electron binary not found at ' + ELECTRON_EXE + '. Run "npm install" in ' + PROJECT_ROOT + '.');
  }
}

async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      // taskkill returns non-zero when the process already exited; that is not an error here.
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

export async function launchFixture(options: LaunchFixtureOptions = {}): Promise<FixtureHandle> {
  await ensureElectronBinary();

  const url = options.url ?? 'about:blank';
  const port = await allocateTcpPort();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'electron-adblock-fixture-'));
  const args = [
    FIXTURE_MAIN_PATH,
    '--remote-debugging-port=' + port,
    '--host-resolver-rules=MAP ads.test 127.0.0.1',
    '--user-data-dir=' + userDataDir,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    ...(options.extraArgs ?? []),
  ];

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FIXTURE_URL: url,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  };
  // The DSH shell exports ELECTRON_RUN_AS_NODE=1, which would run our fixture as plain Node.
  // Node-only options from the test runner must not leak into the Electron main process.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.NODE_OPTIONS;
  delete env.NODE_USE_ENV_PROXY;

  const child = spawn(ELECTRON_EXE, args, {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const outputChunks: string[] = [];
  let outputSize = 0;
  const recordOutput = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    outputChunks.push(text);
    outputSize += text.length;
    while (outputSize > OUTPUT_LIMIT && outputChunks.length > 1) {
      const removed = outputChunks.shift();
      outputSize -= removed ? removed.length : 0;
    }
  };
  child.stdout?.on('data', recordOutput);
  child.stderr?.on('data', recordOutput);

  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let spawnError: Error | null = null;
  let started = false;
  const abortController = new AbortController();

  child.once('exit', (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
    if (!started) abortController.abort();
  });
  child.once('error', (error) => {
    spawnError = error;
    if (!started) abortController.abort();
  });

  try {
    await waitForEndpoint(port, {
      timeoutMs: options.startupTimeoutMs ?? 20000,
      signal: abortController.signal,
      requirePage: true,
    });
    started = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const spawnErrorMessage: string | null = (spawnError as Error | null)?.message ?? null;
    const exitDetail = exited
      ? ' (fixture exited with code ' + String(exitCode) + ' signal ' + String(exitSignal) + ')'
      : spawnErrorMessage
        ? ' (spawn error: ' + spawnErrorMessage + ')'
        : '';
    await killProcessTree(child.pid ?? 0);
    await waitForChildExit(child, 10000);
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    throw new Error(
      'fixture failed to start on CDP port ' + port + exitDetail + ': ' + message + '\n--- fixture output ---\n' + outputChunks.join(''),
    );
  }

  let closePromise: Promise<void> | null = null;

  const handle: FixtureHandle = {
    pid: child.pid ?? 0,
    port,
    url,
    userDataDir,
    output(): string {
      return outputChunks.join('');
    },
    exitInfo(): FixtureExitInfo {
      return { exited, code: exitCode, signal: exitSignal };
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        if (child.pid !== undefined && !exited) {
          await killProcessTree(child.pid);
          const stopped = await waitForChildExit(child, 10000);
          if (!stopped) {
            try {
              child.kill('SIGKILL');
            } catch {
              // Already gone.
            }
            await waitForChildExit(child, 5000);
          }
        }
        for (const resource of options.cleanup ?? []) {
          try {
            await resource.close();
          } catch (error) {
            process.stderr.write('[fixture] cleanup failed: ' + (error instanceof Error ? error.message : String(error)) + '\n');
          }
        }
        await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
      })();
      return closePromise;
    },
  };

  return handle;
}

export interface ElectronProcessInfo {
  pid: number;
  commandLine: string;
}

/** Lists electron.exe processes whose command line references the fixture main script. */
export async function listElectronProcessesForFixture(
  fixturePath = FIXTURE_MAIN_PATH,
): Promise<ElectronProcessInfo[]> {
  if (process.platform !== 'win32') return [];

  const escaped = fixturePath.replace(/'/g, "''");
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "Get-CimInstance Win32_Process -Filter \"Name = 'electron.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('" +
      escaped +
      "') } | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; commandLine = [string]$_.CommandLine } } | ConvertTo-Json -Compress",
  ].join('; ');

  const result = (await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    timeout: 20000,
  })) as { stdout: string };
  const text = result.stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => {
    const record = row as { pid?: unknown; commandLine?: unknown };
    return { pid: Number(record.pid), commandLine: String(record.commandLine ?? '') };
  });
}

/** Waits until no fixture Electron process remains, throwing a descriptive error on timeout. */
export async function waitForNoFixtureProcesses(timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let remaining = await listElectronProcessesForFixture();
  while (remaining.length > 0 && Date.now() < deadline) {
    await delay(200);
    remaining = await listElectronProcessesForFixture();
  }
  if (remaining.length > 0) {
    const detail = remaining.map((processInfo) => processInfo.pid + ': ' + processInfo.commandLine).join('\n');
    throw new Error('leftover Electron processes for the fixture:\n' + detail);
  }
}
