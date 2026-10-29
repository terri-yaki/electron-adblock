import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { ProcessInfo } from '../../shared/types';
import { delay, runCommand, runPowerShell } from './command';
import { listProcessesForExecutable } from './discovery';

const NETSTAT_TIMEOUT_MS = 10_000;
const POWERSHELL_TIMEOUT_MS = 15_000;
const DEBUG_PROBE_TIMEOUT_MS = 900;
const MAX_PROBE_CANDIDATES = 12;
const MAX_ENDPOINT_TIMEOUT_MS = 120_000;
const DEFAULT_ENDPOINT_TIMEOUT_MS = 15_000;
const SPAWN_TIMEOUT_MS = 10_000;
const DEBUG_PORT_FLAG = '--remote-debugging-port';

function isDebugPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536;
}

function portFromAddress(address: string): number | null {
  const value = address.trim();
  if (!value) return null;
  const bracketed = /^\[[^\]]*\]:(\d+)$/.exec(value);
  if (bracketed) {
    const port = Number.parseInt(bracketed[1], 10);
    return Number.isInteger(port) ? port : null;
  }
  const separator = value.lastIndexOf(':');
  if (separator <= 0) return null;
  const port = Number.parseInt(value.slice(separator + 1), 10);
  return Number.isInteger(port) ? port : null;
}

// Parses netstat -ano TCP rows and returns listening local ports for the given pids.
export function parseListeningPorts(output: string, pids?: ReadonlySet<number>): number[] {
  const ports = new Set<number>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 4) continue;
    if (!/^tcp/i.test(fields[0])) continue;
    const localPort = portFromAddress(fields[1]);
    if (localPort === null || localPort <= 0) continue;
    const pid = Number.parseInt(fields[fields.length - 1], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (pids && !pids.has(pid)) continue;
    const remotePort = portFromAddress(fields[2]);
    const state = fields.length >= 5 ? fields[3].toUpperCase() : '';
    // Remote port 0 identifies a listening socket even on localized netstat builds.
    if (state !== 'LISTENING' && state !== 'LISTEN' && remotePort !== 0) continue;
    ports.add(localPort);
  }
  return [...ports].sort((left, right) => left - right);
}

function canBindPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

export async function allocateDebugPort(preferred?: number): Promise<number> {
  if (isDebugPort(preferred) && (await canBindPort(preferred))) return preferred;
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    let settled = false;
    const finish = (error?: Error, port?: number) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      if (error) reject(error);
      else resolve(port as number);
    };
    server.once('error', (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close(() => {
        if (port > 0) finish(undefined, port);
        else finish(new Error('allocateDebugPort: could not allocate a local port'));
      });
    });
  });
}

// Keeps shortcut arguments but drops stale debug flags before appending ours.
export function buildLaunchArguments(args: readonly string[], debugPort: number): string[] {
  const input = Array.isArray(args) ? args : [];
  const result: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    if (typeof arg !== 'string' || arg.trim().length === 0) continue;
    const normalized = arg.trim().toLowerCase();
    if (normalized === DEBUG_PORT_FLAG) {
      index += 1;
      continue;
    }
    if (normalized.startsWith(DEBUG_PORT_FLAG + '=')) continue;
    result.push(arg);
  }
  result.push(DEBUG_PORT_FLAG + '=' + debugPort);
  return result;
}

// Copies the current environment without the DSH/Electron host variables.
export function cleanChildEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    const normalized = key.toUpperCase();
    if (normalized === 'ELECTRON_RUN_AS_NODE' || normalized === 'ELECTRON_NO_ATTACH_CONSOLE') continue;
    environment[key] = value;
  }
  return environment;
}

// Starts a detached GUI process without a shell; returns its pid.
export async function launchExecutable(exePath: string, args: string[], debugPort: number): Promise<number> {
  if (typeof exePath !== 'string' || exePath.trim().length === 0) {
    throw new Error('launchExecutable: executable path is required');
  }
  if (!isDebugPort(debugPort)) {
    throw new Error('launchExecutable: invalid debug port');
  }
  const executable = path.resolve(exePath.trim());
  try {
    await fs.access(executable);
  } catch {
    throw new Error('launchExecutable: executable not found: ' + executable);
  }
  const launchArgs = buildLaunchArguments(Array.isArray(args) ? args : [], debugPort);
  const environment = cleanChildEnvironment();
  return await new Promise<number>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error, pid?: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(pid as number);
    };
    timer = setTimeout(() => finish(new Error('launchExecutable: timed out starting ' + path.basename(executable))), SPAWN_TIMEOUT_MS);
    timer.unref();
    try {
      const child = spawn(executable, launchArgs, {
        detached: true,
        stdio: 'ignore',
        env: environment,
        windowsHide: false,
        shell: false,
      });
      child.once('error', (error) => {
        finish(new Error('launchExecutable: failed to start ' + path.basename(executable) + ': ' + error.message));
      });
      child.once('spawn', () => {
        const pid = child.pid;
        if (typeof pid === 'number' && pid > 0) {
          try {
            child.unref();
          } catch {
            /* already unrefed */
          }
          finish(undefined, pid);
        } else {
          finish(new Error('launchExecutable: spawned process has no pid'));
        }
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  timer.unref();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probeDebugEndpoint(port: number, timeoutMs: number): Promise<boolean> {
  const payload = await fetchJson('http://127.0.0.1:' + port + '/json/version', timeoutMs);
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  return typeof record.webSocketDebuggerUrl === 'string' || typeof record.Browser === 'string';
}

export async function waitForDebugEndpoint(port: number, timeoutMs: number = DEFAULT_ENDPOINT_TIMEOUT_MS): Promise<boolean> {
  if (!isDebugPort(port)) return false;
  const total = Number.isFinite(timeoutMs)
    ? Math.min(Math.max(Math.floor(timeoutMs), 250), MAX_ENDPOINT_TIMEOUT_MS)
    : DEFAULT_ENDPOINT_TIMEOUT_MS;
  const deadline = Date.now() + total;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (await probeDebugEndpoint(port, Math.min(DEBUG_PROBE_TIMEOUT_MS, remaining))) return true;
    if (Date.now() >= deadline) break;
    await delay(Math.min(250, deadline - Date.now()));
  }
  return false;
}

function parsePortJsonLines(output: string): number[] {
  const ports = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const port = (parsed as Record<string, unknown>).port;
      if (isDebugPort(port)) ports.add(port);
    } catch {
      /* skip malformed line */
    }
  }
  return [...ports];
}

// Returns null when netstat itself failed, so callers can try a fallback.
async function netstatListeningPorts(pids: number[]): Promise<number[] | null> {
  const result = await runCommand('netstat.exe', ['-ano', '-p', 'tcp'], NETSTAT_TIMEOUT_MS, 8 * 1024 * 1024);
  if (!result.ok) return null;
  return parseListeningPorts(result.stdout, new Set(pids));
}

async function powershellListeningPorts(pids: number[]): Promise<number[] | null> {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$ids = @(' + pids.join(', ') + ')',
    'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids -contains [int]$_.OwningProcess } | ForEach-Object { [pscustomobject]@{ port = [int]$_.LocalPort } | ConvertTo-Json -Compress }',
  ].join('\n');
  const result = await runPowerShell(script, POWERSHELL_TIMEOUT_MS);
  if (!result.ok) return null;
  return parsePortJsonLines(result.stdout);
}

async function commandLineDebugPorts(pids: number[]): Promise<number[]> {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'foreach ($targetPid in @(' + pids.join(', ') + ')) {',
    '  try {',
    '    $targetProcess = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $targetPid) -ErrorAction Stop',
    "    if ($targetProcess -and $targetProcess.CommandLine -and ($targetProcess.CommandLine -match '" + DEBUG_PORT_FLAG + "=([0-9]{2,5})')) {",
    '      [int]$matches[1]',
    '    }',
    '  } catch {}',
    '}',
  ].join('\n');
  const result = await runPowerShell(script, POWERSHELL_TIMEOUT_MS);
  const ports = new Set<number>();
  for (const line of result.stdout.split(/\r?\n/)) {
    const port = Number.parseInt(line.trim(), 10);
    if (isDebugPort(port)) ports.add(port);
  }
  return [...ports];
}

// Probes candidates concurrently; the lowest responsive port wins.
async function probePortCandidates(ports: number[]): Promise<number | null> {
  const candidates = [...new Set(ports.filter(isDebugPort))]
    .sort((left, right) => left - right)
    .slice(0, MAX_PROBE_CANDIDATES);
  if (candidates.length === 0) return null;
  const results = await Promise.all(candidates.map(async (port) => {
    return { port, reachable: await probeDebugEndpoint(port, DEBUG_PROBE_TIMEOUT_MS) };
  }));
  const match = results.find((result) => result.reachable);
  return match ? match.port : null;
}

export async function findDebugPortForApp(exePath: string): Promise<number | null> {
  try {
    const processes = await processesForExecutable(exePath);
    const pids = [...new Set(processes.map((process) => process.pid).filter((pid) => Number.isInteger(pid) && pid > 0))];
    if (pids.length === 0) return null;
    let listening = await netstatListeningPorts(pids);
    if (listening === null) listening = await powershellListeningPorts(pids);
    if (listening === null) listening = await commandLineDebugPorts(pids);
    if (listening.length === 0) return null;
    return await probePortCandidates(listening);
  } catch {
    return null;
  }
}

export async function processesForExecutable(exePath: string): Promise<ProcessInfo[]> {
  return await listProcessesForExecutable(exePath);
}
