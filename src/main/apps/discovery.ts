import path from 'node:path';
import type { DiscoveredApp, ProcessInfo } from '../../shared/types';
import { delay, psQuote, runCommand, runPowerShell } from './command';
import {
  discoverCommonInstallApps,
  discoverRegistryApps,
  fileExists,
  hasAppAsar,
  isExcludedElectronTarget,
  mergeDiscoveredApps,
  normalizeExecutablePath,
  sameWindowsPath,
} from './detection';

export {
  discoverCommonInstallApps,
  discoverRegistryApps,
  discoverRunningApps,
  findRunningAppFor,
  isExcludedElectronTarget,
} from './detection';

const SHORTCUT_TIMEOUT_MS = 25_000;
const TASKLIST_TIMEOUT_MS = 12_000;
const PROCESS_QUERY_TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 12_000;
const DEFAULT_GRACEFUL_CLOSE_MS = 2_500;
const MAX_GRACEFUL_CLOSE_MS = 15_000;
const TASKLIST_MAX_BUFFER = 8 * 1024 * 1024;

export interface ShortcutEntry {
  shortcutPath: string;
  name: string;
  targetPath: string;
  arguments: string;
}

// Enumerates Start Menu shortcuts and resolves them through WScript.Shell.
const START_MENU_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$roots = @(($env:APPDATA + '\Microsoft\Windows\Start Menu\Programs'), ($env:ProgramData + '\Microsoft\Windows\Start Menu\Programs'))
$shell = New-Object -ComObject WScript.Shell
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  Get-ChildItem -LiteralPath $root -Filter *.lnk -Recurse -File |
    ForEach-Object {
      try {
        $shortcut = $shell.CreateShortcut($_.FullName)
        $target = $shortcut.TargetPath
        if ($target -and $target.ToLowerInvariant().EndsWith('.exe')) {
          [pscustomobject]@{
            shortcut = $_.FullName
            name = $_.BaseName
            target = $target
            args = [string]$shortcut.Arguments
          } | ConvertTo-Json -Compress
        }
      } catch {}
    }
}
`;

export function exeNameForPath(exePath: string): string {
  return path.basename(exePath);
}

// Parses a Windows command line the way CommandLineToArgvW does.
export function parseWindowsCommandLine(commandLine: string): string[] {
  const args: string[] = [];
  let current = '';
  let tokenStarted = false;
  let inQuotes = false;
  let index = 0;
  while (index < commandLine.length) {
    const char = commandLine[index];
    if (char === '\\') {
      let slashCount = 0;
      while (index < commandLine.length && commandLine[index] === '\\') {
        slashCount += 1;
        index += 1;
      }
      if (index < commandLine.length && commandLine[index] === '"') {
        current += '\\'.repeat(Math.floor(slashCount / 2));
        if (slashCount % 2 === 1) {
          current += '"';
          index += 1;
        }
      } else {
        current += '\\'.repeat(slashCount);
      }
      tokenStarted = true;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      tokenStarted = true;
      index += 1;
      continue;
    }
    if (!inQuotes && (char === ' ' || char === '\t')) {
      if (tokenStarted) {
        args.push(current);
        current = '';
        tokenStarted = false;
      }
      index += 1;
      continue;
    }
    current += char;
    tokenStarted = true;
    index += 1;
  }
  if (tokenStarted) args.push(current);
  return args;
}

// Parses the per-line JSON emitted by the Start Menu script.
export function parseShortcutEntries(output: string): ShortcutEntry[] {
  const entries: ShortcutEntry[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const targetPath = typeof record.target === 'string' ? record.target.trim() : '';
    if (!targetPath) continue;
    entries.push({
      shortcutPath: typeof record.shortcut === 'string' ? record.shortcut : '',
      name: typeof record.name === 'string' ? record.name.trim() : '',
      targetPath,
      arguments: typeof record.args === 'string' ? record.args : '',
    });
  }
  return entries;
}

export function parseTasklistCsv(output: string): ProcessInfo[] {
  const processes: ProcessInfo[] = [];
  const seen = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    if (fields.length < 2) continue;
    const name = fields[0].trim();
    const pid = Number.parseInt(fields[1].trim(), 10);
    if (!name || !Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    processes.push({ pid, name });
  }
  return processes;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((field) => field.trim());
}

// Parses Get-CimInstance JSON (single object or array, one object per line).
export function parseCimProcessOutput(output: string): ProcessInfo[] {
  const text = output.replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  const items: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) items.push(...parsed);
    else items.push(parsed);
  } catch {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        items.push(JSON.parse(trimmed));
      } catch {
        /* skip malformed line */
      }
    }
  }
  const processes: ProcessInfo[] = [];
  const seen = new Set<number>();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const rawPid = record.ProcessId;
    const pid = typeof rawPid === 'number' ? rawPid : Number.parseInt(String(rawPid ?? ''), 10);
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    const name = typeof record.Name === 'string' ? record.Name : '';
    const exePath = typeof record.ExecutablePath === 'string' && record.ExecutablePath.trim()
      ? record.ExecutablePath.trim()
      : undefined;
    const process: ProcessInfo = { pid, name };
    if (exePath) process.exePath = exePath;
    seen.add(pid);
    processes.push(process);
  }
  return processes;
}

export async function discoverStartMenuApps(): Promise<DiscoveredApp[]> {
  const result = await runPowerShell(START_MENU_SCRIPT, SHORTCUT_TIMEOUT_MS);
  const entries = parseShortcutEntries(result.stdout);
  const asarCache = new Map<string, Promise<boolean>>();
  const candidates = await Promise.all(entries.map(async (entry) => {
    const exePath = normalizeExecutablePath(entry.targetPath);
    if (!exePath || !exePath.toLowerCase().endsWith('.exe')) return null;
    if (isExcludedElectronTarget(exePath)) return null;
    if (!(await fileExists(exePath))) return null;
    if (!(await hasAppAsar(exePath, asarCache))) return null;
    return { entry, exePath };
  }));
  const seen = new Set<string>();
  const apps: DiscoveredApp[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = candidate.exePath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const fallbackName = path.win32.basename(candidate.exePath, path.win32.extname(candidate.exePath));
    apps.push({
      exePath: candidate.exePath,
      name: candidate.entry.name.trim() || fallbackName,
      source: 'start-menu',
      shortcutArgs: parseWindowsCommandLine(candidate.entry.arguments),
    });
  }
  apps.sort((left, right) => left.name.localeCompare(right.name) || left.exePath.localeCompare(right.exePath));
  return apps;
}

// Merges Start Menu entries with registry uninstall entries and common install folders.
// Start Menu wins for names and shortcut arguments; duplicate exe paths collapse.
export async function discoverInstalledApps(): Promise<DiscoveredApp[]> {
  const [startMenu, registry, commonInstallDirs] = await Promise.all([
    discoverStartMenuApps(),
    discoverRegistryApps(),
    discoverCommonInstallApps(),
  ]);
  return mergeDiscoveredApps([startMenu, registry, commonInstallDirs]);
}

export async function listProcesses(): Promise<ProcessInfo[]> {
  const result = await runCommand('tasklist.exe', ['/FO', 'CSV', '/NH'], TASKLIST_TIMEOUT_MS, TASKLIST_MAX_BUFFER);
  return parseTasklistCsv(result.stdout);
}

export async function listProcessesForExecutable(exePath: string): Promise<ProcessInfo[]> {
  const exeName = exeNameForPath(exePath);
  if (!exeName) return [];
  const expected = exeName.toLowerCase();
  let processes: ProcessInfo[] = [];
  const query = await runPowerShell(buildProcessQueryScript(exeName), PROCESS_QUERY_TIMEOUT_MS);
  if (query.ok) {
    processes = query.stdout.trim() ? parseCimProcessOutput(query.stdout) : [];
  } else {
    // CIM can be blocked or missing; tasklist still gives name-only matches.
    const all = await listProcesses();
    processes = all.filter((process) => process.name.toLowerCase() === expected);
  }
  processes = processes.filter((process) => process.name.toLowerCase() === expected);
  const verified = processes.filter((process) => {
    return typeof process.exePath === 'string' && sameWindowsPath(process.exePath, exePath);
  });
  // Prefer path-verified hits; name-only fallback covers updater-launched apps.
  return verified.length > 0 ? verified : processes;
}

export async function closeProcesses(pids: number[], gracefulWaitMs: number = DEFAULT_GRACEFUL_CLOSE_MS): Promise<void> {
  const targets = Array.isArray(pids) ? pids : [];
  const unique = [...new Set(targets.filter((pid) => {
    return Number.isInteger(pid) && pid > 4 && pid !== process.pid && pid <= 0x7fffffff;
  }))];
  if (unique.length === 0) return;
  const waitMs = Number.isFinite(gracefulWaitMs)
    ? Math.min(Math.max(Math.floor(gracefulWaitMs), 0), MAX_GRACEFUL_CLOSE_MS)
    : DEFAULT_GRACEFUL_CLOSE_MS;
  await runPowerShell(buildGracefulCloseScript(unique), CLOSE_TIMEOUT_MS);
  if (waitMs > 0) await waitForProcessExit(unique, waitMs);
  await runPowerShell(buildForceCloseScript(unique), CLOSE_TIMEOUT_MS);
}

// Returns as soon as every target exited, so graceful closes do not burn the full timeout.
async function waitForProcessExit(pids: number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pids.some(isProcessAlive)) return;
    await delay(Math.min(200, deadline - Date.now()));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function buildProcessQueryScript(exeName: string): string {
  const quotedName = psQuote(exeName);
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
    '$name = ' + quotedName,
    '$filter = "Name = \'" + $name.Replace("\'", "\'\'") + "\'"',
    'Get-CimInstance Win32_Process -Filter $filter | Select-Object ProcessId, Name, ExecutablePath | ConvertTo-Json -Compress',
  ].join('\n');
}

function buildGracefulCloseScript(pids: number[]): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'foreach ($targetPid in @(' + pids.join(', ') + ')) {',
    '  try {',
    '    $targetProcess = Get-Process -Id $targetPid -ErrorAction Stop',
    '    if ($targetProcess.MainWindowHandle -ne 0) { [void]$targetProcess.CloseMainWindow() }',
    '  } catch {}',
    '}',
  ].join('\n');
}

function buildForceCloseScript(pids: number[]): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'foreach ($targetPid in @(' + pids.join(', ') + ')) {',
    '  try {',
    '    $targetProcess = Get-Process -Id $targetPid -ErrorAction Stop',
    '    Stop-Process -Id $targetProcess.Id -Force -ErrorAction Stop',
    '  } catch {}',
    '}',
  ].join('\n');
}
