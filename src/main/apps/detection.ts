import { existsSync, promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { DiscoveredApp } from '../../shared/types';
import { psQuote, runPowerShell } from './command';

const RUNNING_PROCESS_TIMEOUT_MS = 30_000;
const REGISTRY_TIMEOUT_MS = 20_000;
const VERSION_INFO_TIMEOUT_MS = 20_000;
const FALLBACK_SCAN_TIMEOUT_MS = 20_000;
const FALLBACK_SCAN_DIR_CAP = 3_000;
const MAX_CHILD_APP_FOLDERS = 80;
const MAX_CHILD_DIRECTORIES = 25;
const MAX_VERSION_INFO_BATCH = 100;

const SCRUBBED_DIR_NAMES = new Set([
  'resources',
  'locales',
  'node_modules',
  'cache',
  'caches',
  'gpucache',
  'code cache',
  'cacheddata',
  'logs',
  'log',
  'crashpad',
  'crashdumps',
  'temp',
  'tmp',
  'blob_storage',
  'local storage',
  'service worker',
  'indexeddb',
  'databases',
  'swiftshader',
  'vulkan',
  'dxvk',
  'unpacked',
  'packages',
  'windowsapps',
  'squirreltemp',
  'connecteddevicesplatform',
  'microsoftedge',
  'installer',
]);

const GENERIC_APP_NAMES = new Set([
  'electron',
  'electronapp',
  'electronhelper',
  'chromium',
  'chrome',
  'defaultapp',
  'app',
]);

const ELECTRON_MARKER_PATTERNS: readonly RegExp[] = [
  /--type=renderer\b/i,
  /--type=gpu-process\b/i,
  /--app-path[=\s]/i,
  /resources[\\/]app\.asar/i,
];

export interface CimProcessEntry {
  pid: number;
  name: string;
  exePath?: string;
  commandLine?: string;
}

export interface ExecutableVersionInfo {
  productName?: string;
  fileDescription?: string;
}

export interface RegistryEntry {
  displayName: string;
  installLocation?: string;
  displayIcon?: string;
  hive?: string;
}

export interface RunningProcessSearch {
  processes: CimProcessEntry[];
  versions: Map<string, ExecutableVersionInfo>;
}

export interface RunningAppBuildOptions {
  hasAppAsar?: (exePath: string) => boolean;
  versionInfo?: (exePath: string) => ExecutableVersionInfo | undefined;
  ownExePath?: string;
  systemRoot?: string;
  // Chromium browsers and CEF apps also spawn --type=renderer children, so renderer
  // markers alone are only trusted when this explicit opt-in is set.
  trustRendererMarkers?: boolean;
}

export interface InstallRootScanOptions {
  maxDepth?: number;
  dirCap?: number;
  timeoutMs?: number;
  pruneChildNames?: ReadonlySet<string>;
}

export interface ScannedAppFolder {
  exePath: string;
  hintName: string;
  // Versioned installs (app-1.2.3, current) share one install key so only the newest survives.
  installKey: string;
}

interface CommonInstallRoot {
  rootPath: string;
  maxDepth: number;
  pruneChildNames?: ReadonlySet<string>;
}

// One CIM pass for running processes plus FileVersionInfo for each executable.
const RUNNING_PROCESS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
  '$processes = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | Select-Object ProcessId, Name, ExecutablePath, CommandLine)',
  'if ($processes.Count -gt 0) {',
  '  Write-Output ("PROC|" + (ConvertTo-Json -InputObject $processes -Compress -Depth 3))',
  '  $paths = @($processes | ForEach-Object { $_.ExecutablePath } | Select-Object -Unique)',
  '  foreach ($path in $paths) {',
  '    try {',
  '      $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path)',
  '      if ($info) {',
  '        $record = [pscustomobject]@{ path = [string]$path; productName = [string]$info.ProductName; fileDescription = [string]$info.FileDescription }',
  '        Write-Output ("VER|" + (ConvertTo-Json -InputObject $record -Compress))',
  '      }',
  '    } catch {}',
  '  }',
  '}',
].join('\n');

const REGISTRY_UNINSTALL_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
  '$keys = @(',
  "  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
  "  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
  "  'HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
  ')',
  'foreach ($key in $keys) {',
  '  Get-ItemProperty -Path $key -ErrorAction SilentlyContinue | ForEach-Object {',
  '    if ($_.DisplayName) {',
  '      $record = [pscustomobject]@{',
  '        displayName = [string]$_.DisplayName',
  '        installLocation = [string]$_.InstallLocation',
  '        displayIcon = [string]$_.DisplayIcon',
  '        hive = [string]$key',
  '      }',
  '      Write-Output (ConvertTo-Json -InputObject $record -Compress)',
  '    }',
  '  }',
  '}',
].join('\n');

export function normalizeExecutablePath(rawPath: string): string {
  let value = String(rawPath ?? '').trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1).trim();
  }
  if (!value) return '';
  const normalized = path.win32.normalize(value);
  return path.win32.isAbsolute(normalized) ? normalized : '';
}

export function normalizePathForCompare(targetPath: string): string {
  let value = path.win32.normalize(String(targetPath ?? '').trim());
  if (value.length > 3 && value.endsWith('\\')) value = value.slice(0, -1);
  return value.toLowerCase();
}

export function sameWindowsPath(left: string, right: string): boolean {
  return normalizePathForCompare(left) === normalizePathForCompare(right);
}

export async function fileExists(targetPath: string): Promise<boolean> {
  // Electron's patched fs.promises.access treats *.asar paths as archive entries and reports
  // ENOENT for a real app.asar file, which would hide every installed Electron app. existsSync
  // checks the filesystem entry itself in both Node and Electron.
  try {
    return existsSync(targetPath);
  } catch {
    return false;
  }
}

async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// An Electron app ships resources/app.asar next to the executable folder (or one level up).
export async function hasAppAsar(exePath: string, cache: Map<string, Promise<boolean>>): Promise<boolean> {
  const exeDir = path.win32.dirname(exePath);
  const baseDirs = [exeDir, path.win32.dirname(exeDir)];
  for (const baseDir of baseDirs) {
    const asarPath = path.win32.join(baseDir, 'resources', 'app.asar');
    const key = asarPath.toLowerCase();
    let check = cache.get(key);
    if (!check) {
      check = fileExists(asarPath);
      cache.set(key, check);
    }
    if (await check) return true;
  }
  return false;
}

async function hasAppAsarInFolder(folderPath: string): Promise<boolean> {
  return await fileExists(path.win32.join(folderPath, 'resources', 'app.asar'));
}

export function isExcludedElectronTarget(exePath: string, ownExePath: string = process.execPath): boolean {
  const normalized = path.win32.normalize(String(exePath ?? '').trim()).toLowerCase();
  const baseName = path.win32.basename(normalized);
  if (normalized === path.win32.normalize(String(ownExePath ?? '')).toLowerCase()) return true;
  if (baseName.includes('electron adblock') || baseName.includes('electron-adblock')) return true;
  if (baseName === 'electron.exe' && normalized.includes('node_modules')) return true;
  return false;
}

export function isSystemExecutablePath(exePath: string, systemRoot?: string): boolean {
  const normalized = normalizeExecutablePath(exePath).toLowerCase();
  if (!normalized) return false;
  const root = path.win32.normalize(systemRoot ?? process.env.SystemRoot ?? 'C:\\Windows').toLowerCase();
  const trimmedRoot = root.length > 3 && root.endsWith('\\') ? root.slice(0, -1) : root;
  return normalized === trimmedRoot || normalized.startsWith(trimmedRoot + '\\');
}

export function isAuxiliaryExecutableName(baseName: string): boolean {
  const name = path.win32.basename(String(baseName ?? '')).toLowerCase();
  if (!name.endsWith('.exe')) return false;
  const stem = name.slice(0, -4);
  if (/^(unins\d*|uninstaller?|update|updater|squirrel|setup|installer?|remove|elevate[ds]?|crashpad|chrome_crashpad_handler|notification_helper|service|webhelper)$/.test(stem)) {
    return true;
  }
  if (/crashpad|uninstall|updater|squirrel|elevate/.test(stem)) return true;
  if (/(^|[-_.])helper$/.test(stem)) return true;
  return false;
}

// Lowercase and strip punctuation so "OP.GG" and "OPGG" compare equal.
export function normalizeExecutableName(value: string): string {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return '';
  const stripped = text.replace(/\.exe$/, '').replace(/[^\p{L}\p{N}]+/gu, '');
  return stripped || text.replace(/[^\p{L}\p{N}]+/gu, '');
}

export function expandEnvironmentVariables(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return String(value ?? '').replace(/%([^%]+)%/g, (match, name: string) => {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
    const replacement = key ? env[key] : undefined;
    return typeof replacement === 'string' && replacement.length > 0 ? replacement : match;
  });
}

// DisplayIcon may be "\"C:\\App\\app.exe\",0" or "C:\\App\\app.exe,0"; only exe icons are useful.
export function parseDisplayIconPath(value: string | undefined | null): string | null {
  let text = String(value ?? '').trim();
  if (!text) return null;
  if (text.startsWith('"')) {
    const closing = text.indexOf('"', 1);
    if (closing > 1) text = text.slice(1, closing);
  } else if (text.startsWith("'")) {
    const closing = text.indexOf("'", 1);
    if (closing > 1) text = text.slice(1, closing);
  } else {
    text = text.replace(/,\s*-?\d+\s*$/, '');
  }
  text = text.trim();
  if (!text) return null;
  return text.toLowerCase().endsWith('.exe') ? text : null;
}

// Registry display names often append a version ("OP.GG 2.0.0"); drop it for the UI.
export function cleanAppDisplayName(value: string): string {
  const original = String(value ?? '').trim();
  if (!original) return '';
  let name = original.replace(/\s+/g, ' ');
  name = name.replace(/\s*[-\u2013]?\s*v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?\s*$/i, '').trim();
  return name || original;
}

export function pickAppDisplayName(
  productName: string | undefined,
  fileDescription: string | undefined,
  exePath: string,
  hintName?: string,
): string {
  const candidates = [productName, fileDescription];
  for (const candidate of candidates) {
    const clean = String(candidate ?? '').trim();
    if (clean && !GENERIC_APP_NAMES.has(normalizeExecutableName(clean))) return clean;
  }
  if (hintName) {
    const raw = hintName.trim();
    const hint = raw.includes('\\') || raw.includes('/')
      ? path.win32.basename(raw.replace(/[\\/]+$/, ''))
      : raw;
    const cleanHint = hint.trim();
    if (cleanHint && !GENERIC_APP_NAMES.has(normalizeExecutableName(cleanHint))) return cleanHint;
  }
  const exeBase = path.win32.basename(String(exePath ?? ''), path.win32.extname(String(exePath ?? ''))).trim();
  return exeBase || 'Electron app';
}

export function isAuxiliaryPathCandidate(exePath: string): boolean {
  return isAuxiliaryExecutableName(path.win32.basename(exePath));
}

export function pickInstalledExecutable(exePaths: readonly string[], hintName: string): string | null {
  const candidates = exePaths.filter((exePath) => {
    const name = path.win32.basename(exePath);
    return name.toLowerCase().endsWith('.exe') && !isAuxiliaryExecutableName(name);
  });
  if (candidates.length === 0) return null;
  const hint = normalizeExecutableName(hintName);
  let best: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const exePath of candidates) {
    const base = path.win32.basename(exePath, path.win32.extname(exePath));
    const baseNorm = normalizeExecutableName(base);
    let score = 0;
    if (hint && baseNorm === hint) score = 100;
    else if (hint && baseNorm.length >= 3 && (hint.includes(baseNorm) || baseNorm.includes(hint))) score = 60;
    score -= base.length / 100;
    if (score > bestScore) {
      best = exePath;
      bestScore = score;
    }
  }
  return best;
}

// True when both executables live in the same install tree (exe folder or a subfolder).
export function isNestedInstallPath(leftExePath: string, rightExePath: string): boolean {
  const leftDir = path.win32.dirname(normalizeExecutablePath(leftExePath)).toLowerCase();
  const rightDir = path.win32.dirname(normalizeExecutablePath(rightExePath)).toLowerCase();
  if (!leftDir || !rightDir) return false;
  if (leftDir === rightDir) return true;
  return leftDir.startsWith(rightDir + '\\') || rightDir.startsWith(leftDir + '\\');
}

function isRelatedAppName(leftName: string, rightName: string): boolean {
  if (!leftName || !rightName) return false;
  if (leftName === rightName) return true;
  const shorter = leftName.length <= rightName.length ? leftName : rightName;
  const longer = leftName.length <= rightName.length ? rightName : leftName;
  return shorter.length >= 4 && longer.includes(shorter);
}

function isSameNestedApp(left: DiscoveredApp, right: DiscoveredApp): boolean {
  if (!isNestedInstallPath(left.exePath, right.exePath)) return false;
  const leftNames = [normalizeExecutableName(left.name), normalizeExecutableName(exeStem(left.exePath))];
  const rightNames = [normalizeExecutableName(right.name), normalizeExecutableName(exeStem(right.exePath))];
  return leftNames.some((leftName) => rightNames.some((rightName) => isRelatedAppName(leftName, rightName)));
}

function exeStem(exePath: string): string {
  return path.win32.basename(exePath, path.win32.extname(exePath));
}

export function mergeDiscoveredApps(sources: ReadonlyArray<readonly DiscoveredApp[]>): DiscoveredApp[] {
  const merged = new Map<string, DiscoveredApp>();
  for (const source of sources) {
    for (const app of source) {
      const key = normalizePathForCompare(app.exePath);
      if (!key) continue;
      const existing = merged.get(key);
      if (!existing) {
        // Same app name inside the same install tree (e.g. a tray helper and the main exe).
        let nested: DiscoveredApp | undefined;
        for (const candidate of merged.values()) {
          if (isSameNestedApp(candidate, app)) {
            nested = candidate;
            break;
          }
        }
        if (nested) {
          if (nested.shortcutArgs.length === 0 && app.shortcutArgs.length > 0) {
            nested.shortcutArgs = [...app.shortcutArgs];
          }
          continue;
        }
        merged.set(key, { ...app, shortcutArgs: [...app.shortcutArgs] });
        continue;
      }
      if (existing.shortcutArgs.length === 0 && app.shortcutArgs.length > 0) {
        existing.shortcutArgs = [...app.shortcutArgs];
      }
      if (!existing.name && app.name) existing.name = app.name;
    }
  }
  return [...merged.values()].sort((left, right) => {
    return left.name.localeCompare(right.name) || left.exePath.localeCompare(right.exePath);
  });
}

function parseJsonItems(output: string): unknown[] {
  const text = String(output ?? '').replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const items: unknown[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) items.push(...parsed);
        else items.push(parsed);
      } catch {
        /* skip malformed line */
      }
    }
    return items;
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toProcessEntries(items: readonly unknown[]): CimProcessEntry[] {
  const entries: CimProcessEntry[] = [];
  const seen = new Set<number>();
  for (const item of items) {
    const record = parseJsonRecord(item);
    if (!record) continue;
    const rawPid = record.ProcessId;
    const pid = typeof rawPid === 'number' ? rawPid : Number.parseInt(String(rawPid ?? ''), 10);
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    const exePath = normalizeExecutablePath(typeof record.ExecutablePath === 'string' ? record.ExecutablePath : '');
    const commandLine = readOptionalString(record.CommandLine);
    const name = typeof record.Name === 'string' ? record.Name.trim() : '';
    const entry: CimProcessEntry = { pid, name };
    if (exePath) entry.exePath = exePath;
    if (commandLine) entry.commandLine = commandLine;
    seen.add(pid);
    entries.push(entry);
  }
  return entries;
}

export function parseCimProcessDetails(output: string): CimProcessEntry[] {
  return toProcessEntries(parseJsonItems(output));
}

export function parseRunningProcessSearch(output: string): RunningProcessSearch {
  const processItems: unknown[] = [];
  const versionItems: unknown[] = [];
  let sawProcessLine = false;
  for (const rawLine of String(output ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('PROC|')) {
      sawProcessLine = true;
      processItems.push(...parseJsonItems(line.slice(5)));
      continue;
    }
    if (line.startsWith('VER|')) {
      versionItems.push(...parseJsonItems(line.slice(4)));
    }
  }
  if (!sawProcessLine) processItems.push(...parseJsonItems(output));
  const versions = new Map<string, ExecutableVersionInfo>();
  for (const item of versionItems) {
    const record = parseJsonRecord(item);
    if (!record) continue;
    const versionPath = normalizeExecutablePath(typeof record.path === 'string' ? record.path : '');
    if (!versionPath) continue;
    const info: ExecutableVersionInfo = {};
    const productName = readOptionalString(record.productName);
    const fileDescription = readOptionalString(record.fileDescription);
    if (productName) info.productName = productName;
    if (fileDescription) info.fileDescription = fileDescription;
    if (info.productName || info.fileDescription) versions.set(normalizePathForCompare(versionPath), info);
  }
  return { processes: toProcessEntries(processItems), versions };
}

export function parseVersionInfoOutput(output: string): Map<string, ExecutableVersionInfo> {
  const versions = new Map<string, ExecutableVersionInfo>();
  const items = parseJsonItems(output);
  for (const item of items) {
    const record = parseJsonRecord(item);
    if (!record) continue;
    const versionPath = normalizeExecutablePath(typeof record.path === 'string' ? record.path : '');
    if (!versionPath) continue;
    const info: ExecutableVersionInfo = {};
    const productName = readOptionalString(record.productName);
    const fileDescription = readOptionalString(record.fileDescription);
    if (productName) info.productName = productName;
    if (fileDescription) info.fileDescription = fileDescription;
    if (info.productName || info.fileDescription) versions.set(normalizePathForCompare(versionPath), info);
  }
  return versions;
}

export function parseRegistryEntries(output: string): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  const seen = new Set<string>();
  for (const item of parseJsonItems(output)) {
    const record = parseJsonRecord(item);
    if (!record) continue;
    const displayName = readOptionalString(record.displayName);
    if (!displayName) continue;
    const key = displayName.toLowerCase() + '|' + (readOptionalString(record.installLocation) ?? '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry: RegistryEntry = { displayName };
    const installLocation = readOptionalString(record.installLocation);
    const displayIcon = readOptionalString(record.displayIcon);
    const hive = readOptionalString(record.hive);
    if (installLocation) entry.installLocation = installLocation;
    if (displayIcon) entry.displayIcon = displayIcon;
    if (hive) entry.hive = hive;
    entries.push(entry);
  }
  return entries;
}

export function hasElectronCommandLineMarker(commandLine: string | undefined): boolean {
  if (!commandLine) return false;
  return ELECTRON_MARKER_PATTERNS.some((pattern) => pattern.test(commandLine));
}

// app-path and app.asar references are Electron-only; renderer/gpu markers are shared with CEF.
export function hasDefinitiveElectronCommandLineMarker(commandLine: string | undefined): boolean {
  if (!commandLine) return false;
  return /--app-path[=\s]/i.test(commandLine) || /resources[\\/]app\.asar/i.test(commandLine);
}

export function extractAppPathFromCommandLine(commandLine: string | undefined): string | null {
  if (!commandLine) return null;
  const equals = /--app-path=(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(commandLine);
  if (equals) {
    const value = (equals[1] ?? equals[2] ?? equals[3] ?? '').trim();
    if (value) return value;
  }
  const spaced = /--app-path\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(commandLine);
  if (spaced) {
    const value = (spaced[1] ?? spaced[2] ?? spaced[3] ?? '').trim();
    if (value) return value;
  }
  return null;
}

// "C:\App\resources\app.asar" names the app folder; other paths are used as-is.
export function deriveAppHintFromAppPath(appPath: string | null | undefined): string | undefined {
  const value = String(appPath ?? '').trim();
  if (!value) return undefined;
  const cleaned = value.replace(/[\\/]+$/, '');
  if (/[\\/]resources[\\/]app\.asar$/i.test(cleaned)) {
    const appFolder = path.win32.dirname(path.win32.dirname(cleaned));
    return path.win32.basename(appFolder) || undefined;
  }
  return path.win32.basename(cleaned) || undefined;
}

export function selectMainProcessEntry(entries: readonly CimProcessEntry[]): CimProcessEntry | null {
  if (entries.length === 0) return null;
  const withoutType = entries.filter((entry) => !/--type=/i.test(entry.commandLine ?? ''));
  const pool = withoutType.length > 0 ? withoutType : entries;
  return pool.reduce((best, current) => (current.pid < best.pid ? current : best), pool[0]);
}

export function groupProcessEntriesByExecutable(entries: readonly CimProcessEntry[]): Map<string, CimProcessEntry[]> {
  const groups = new Map<string, CimProcessEntry[]>();
  for (const entry of entries) {
    const exePath = normalizeExecutablePath(entry.exePath ?? '');
    if (!exePath) continue;
    const key = normalizePathForCompare(exePath);
    if (!key) continue;
    const normalizedEntry: CimProcessEntry = { ...entry, exePath };
    const group = groups.get(key);
    if (group) group.push(normalizedEntry);
    else groups.set(key, [normalizedEntry]);
  }
  return groups;
}

export function isCrashpadOnlyProcessGroup(entries: readonly CimProcessEntry[]): boolean {
  if (entries.length === 0) return true;
  return entries.every((entry) => /--type=crashpad-handler\b/i.test(entry.commandLine ?? ''));
}

export function buildRunningApps(
  entries: readonly CimProcessEntry[],
  options: RunningAppBuildOptions = {},
): DiscoveredApp[] {
  const groups = groupProcessEntriesByExecutable(entries);
  const apps: DiscoveredApp[] = [];
  for (const groupEntries of groups.values()) {
    const exePath = groupEntries[0]?.exePath;
    if (!exePath) continue;
    if (isExcludedElectronTarget(exePath, options.ownExePath ?? process.execPath)) continue;
    if (isAuxiliaryExecutableName(path.win32.basename(exePath))) continue;
    if (isSystemExecutablePath(exePath, options.systemRoot)) continue;
    if (isCrashpadOnlyProcessGroup(groupEntries)) continue;
    const marked = groupEntries.some((entry) => hasElectronCommandLineMarker(entry.commandLine));
    const definitive = groupEntries.some((entry) => hasDefinitiveElectronCommandLineMarker(entry.commandLine));
    const asarPresent = options.hasAppAsar ? options.hasAppAsar(exePath) === true : false;
    const isElectron = definitive || asarPresent || (marked && options.trustRendererMarkers === true);
    if (!isElectron) continue;
    const mainEntry = selectMainProcessEntry(groupEntries) ?? groupEntries[0];
    const orderedEntries = [mainEntry, ...groupEntries.filter((entry) => entry !== mainEntry)];
    let appPath: string | null = null;
    for (const entry of orderedEntries) {
      appPath = extractAppPathFromCommandLine(entry.commandLine);
      if (appPath) break;
    }
    const version = options.versionInfo ? options.versionInfo(exePath) : undefined;
    apps.push({
      exePath,
      name: pickAppDisplayName(version?.productName, version?.fileDescription, exePath, deriveAppHintFromAppPath(appPath)),
      source: 'running',
      shortcutArgs: [],
    });
  }
  apps.sort((left, right) => left.name.localeCompare(right.name) || left.exePath.localeCompare(right.exePath));
  return apps;
}

async function listExecutableFiles(folderPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
      .map((entry) => path.win32.join(folderPath, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

async function listChildDirectories(folderPath: string, limit: number): Promise<string[]> {
  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && !isScrubbedDirName(entry.name))
      .map((entry) => path.win32.join(folderPath, entry.name))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function isScrubbedDirName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('.') || lower.startsWith('$')) return true;
  // Staged updater payloads duplicate an already installed app.
  if (lower.includes('updater')) return true;
  return SCRUBBED_DIR_NAMES.has(lower);
}

async function findMainExecutableInFolder(folderPath: string, hintName: string): Promise<string | null> {
  const direct = pickInstalledExecutable(await listExecutableFiles(folderPath), hintName);
  if (direct) return normalizeExecutablePath(direct);
  for (const childDir of await listChildDirectories(folderPath, MAX_CHILD_DIRECTORIES)) {
    const nested = pickInstalledExecutable(await listExecutableFiles(childDir), hintName);
    if (nested) return normalizeExecutablePath(nested);
  }
  return null;
}

const VERSIONED_FOLDER_PATTERN = /^(app-[\d.]+|current|latest|stable|beta|v?\d+(?:\.\d+)+)$/i;

function deriveFolderHint(appFolder: string): string {
  const base = path.win32.basename(appFolder);
  if (VERSIONED_FOLDER_PATTERN.test(base)) {
    return path.win32.basename(path.win32.dirname(appFolder));
  }
  return base;
}

async function findAppFoldersWithAsar(locationPath: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(locationPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const folders: string[] = [];
  const candidates = entries
    .filter((entry) => entry.isDirectory() && !isScrubbedDirName(entry.name))
    .slice(0, MAX_CHILD_APP_FOLDERS);
  for (const candidate of candidates) {
    const folderPath = path.win32.join(locationPath, candidate.name);
    if (await hasAppAsarInFolder(folderPath)) folders.push(folderPath);
  }
  folders.sort((left, right) => {
    return path.win32.basename(right).localeCompare(path.win32.basename(left), undefined, { numeric: true });
  });
  return folders;
}

async function resolveRegistryEntryExecutable(
  entry: RegistryEntry,
  asarCache: Map<string, Promise<boolean>>,
): Promise<string | null> {
  const iconPath = parseDisplayIconPath(entry.displayIcon);
  if (iconPath) {
    const expandedIcon = normalizeExecutablePath(expandEnvironmentVariables(iconPath));
    if (expandedIcon && (await fileExists(expandedIcon)) && (await hasAppAsar(expandedIcon, asarCache))) {
      return expandedIcon;
    }
  }
  const locationRaw = expandEnvironmentVariables(String(entry.installLocation ?? '')).trim();
  const location = normalizeExecutablePath(locationRaw);
  if (!location || !(await directoryExists(location))) return null;
  if (await hasAppAsarInFolder(location)) {
    const executable = await findMainExecutableInFolder(location, entry.displayName);
    if (executable) return executable;
  }
  for (const folder of await findAppFoldersWithAsar(location)) {
    const executable = await findMainExecutableInFolder(folder, entry.displayName);
    if (executable) return executable;
  }
  return null;
}

export async function discoverRunningApps(): Promise<DiscoveredApp[]> {
  const result = await runPowerShell(RUNNING_PROCESS_SCRIPT, RUNNING_PROCESS_TIMEOUT_MS);
  if (!result.stdout.trim()) return [];
  const search = parseRunningProcessSearch(result.stdout);
  if (search.processes.length === 0) return [];
  const groups = groupProcessEntriesByExecutable(search.processes);
  const asarCache = new Map<string, Promise<boolean>>();
  const asarByKey = new Map<string, boolean>();
  const needsAsarCheck: Array<{ key: string; exePath: string }> = [];
  for (const [key, groupEntries] of groups) {
    const exePath = groupEntries[0]?.exePath;
    if (!exePath) continue;
    if (groupEntries.some((entry) => hasDefinitiveElectronCommandLineMarker(entry.commandLine))) continue;
    if (isExcludedElectronTarget(exePath)) continue;
    if (isAuxiliaryExecutableName(path.win32.basename(exePath))) continue;
    if (isSystemExecutablePath(exePath)) continue;
    needsAsarCheck.push({ key, exePath });
  }
  await Promise.all(needsAsarCheck.map(async ({ key, exePath }) => {
    asarByKey.set(key, await hasAppAsar(exePath, asarCache));
  }));
  return buildRunningApps(search.processes, {
    hasAppAsar: (exePath) => asarByKey.get(normalizePathForCompare(exePath)) === true,
    versionInfo: (exePath) => search.versions.get(normalizePathForCompare(exePath)),
  });
}

export async function findRunningAppFor(exePath: string, appName?: string): Promise<DiscoveredApp | null> {
  const apps = await discoverRunningApps();
  const targetKey = normalizePathForCompare(exePath ?? '');
  if (targetKey) {
    const byPath = apps.find((app) => normalizePathForCompare(app.exePath) === targetKey);
    if (byPath) return byPath;
    const targetBase = path.win32.basename(String(exePath ?? '')).toLowerCase();
    if (targetBase.endsWith('.exe') && !isAuxiliaryExecutableName(targetBase)) {
      const byBase = apps.find((app) => path.win32.basename(app.exePath).toLowerCase() === targetBase);
      if (byBase) return byBase;
    }
  }
  const nameKey = normalizeExecutableName(appName ?? '');
  if (nameKey.length >= 3) {
    const byName = apps.find((app) => {
      if (normalizeExecutableName(app.name) === nameKey) return true;
      const exeBase = path.win32.basename(app.exePath, path.win32.extname(app.exePath));
      return normalizeExecutableName(exeBase) === nameKey;
    });
    if (byName) return byName;
  }
  return null;
}

export async function discoverRegistryApps(): Promise<DiscoveredApp[]> {
  const result = await runPowerShell(REGISTRY_UNINSTALL_SCRIPT, REGISTRY_TIMEOUT_MS);
  if (!result.stdout.trim()) return [];
  const entries = parseRegistryEntries(result.stdout);
  const asarCache = new Map<string, Promise<boolean>>();
  const seen = new Set<string>();
  const apps: DiscoveredApp[] = [];
  for (const entry of entries) {
    const exePath = await resolveRegistryEntryExecutable(entry, asarCache);
    if (!exePath) continue;
    if (isExcludedElectronTarget(exePath)) continue;
    const key = normalizePathForCompare(exePath);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const fallbackName = path.win32.basename(exePath, path.win32.extname(exePath));
    apps.push({
      exePath,
      name: cleanAppDisplayName(entry.displayName) || fallbackName,
      source: 'start-menu',
      shortcutArgs: [],
    });
  }
  apps.sort((left, right) => left.name.localeCompare(right.name) || left.exePath.localeCompare(right.exePath));
  return apps;
}

async function readExecutableVersionInfo(exePaths: readonly string[]): Promise<Map<string, ExecutableVersionInfo>> {
  const versions = new Map<string, ExecutableVersionInfo>();
  const unique = [...new Set(exePaths.map((exePath) => normalizeExecutablePath(exePath)).filter(Boolean))];
  for (let start = 0; start < unique.length; start += MAX_VERSION_INFO_BATCH) {
    const batch = unique.slice(start, start + MAX_VERSION_INFO_BATCH);
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}',
      '$paths = @(' + batch.map((exePath) => psQuote(exePath)).join(', ') + ')',
      'foreach ($path in $paths) {',
      '  try {',
      '    $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path)',
      '    if ($info) {',
      '      $record = [pscustomobject]@{ path = [string]$path; productName = [string]$info.ProductName; fileDescription = [string]$info.FileDescription }',
      '      Write-Output (ConvertTo-Json -InputObject $record -Compress)',
      '    }',
      '  } catch {}',
      '}',
    ].join('\n');
    const result = await runPowerShell(script, VERSION_INFO_TIMEOUT_MS);
    for (const [key, info] of parseVersionInfoOutput(result.stdout)) versions.set(key, info);
  }
  return versions;
}

export function commonInstallRoots(env: NodeJS.ProcessEnv = process.env): CommonInstallRoot[] {
  const localAppData = env.LOCALAPPDATA ?? '';
  const programFiles = env.ProgramFiles ?? '';
  const programFilesX86 = env['ProgramFiles(x86)'] ?? '';
  const roots: CommonInstallRoot[] = [];
  const add = (rootPath: string, maxDepth: number, pruneChildNames?: string[]): void => {
    if (!rootPath) return;
    const normalized = path.win32.normalize(rootPath);
    if (!path.win32.isAbsolute(normalized)) return;
    if (roots.some((root) => normalizePathForCompare(root.rootPath) === normalizePathForCompare(normalized))) return;
    const root: CommonInstallRoot = { rootPath: normalized, maxDepth };
    if (pruneChildNames && pruneChildNames.length > 0) {
      root.pruneChildNames = new Set(pruneChildNames.map((name) => name.toLowerCase()));
    }
    roots.push(root);
  };
  if (localAppData) add(path.win32.join(localAppData, 'Programs'), 3);
  add(programFiles, 4);
  add(programFilesX86, 4);
  if (localAppData) {
    add(localAppData, 3, ['programs', 'temp', 'crashdumps', 'packages', 'connecteddevicesplatform', 'microsoftedge', 'installer']);
  }
  return roots;
}

export async function scanRootForElectronApps(
  rootPath: string,
  options: InstallRootScanOptions = {},
): Promise<ScannedAppFolder[]> {
  const root = normalizeExecutablePath(rootPath);
  if (!root) return [];
  const maxDepth = Math.min(Math.max(Math.floor(options.maxDepth ?? 3), 0), 6);
  const dirCap = Math.max(Math.floor(options.dirCap ?? FALLBACK_SCAN_DIR_CAP), 1);
  const timeoutMs = Math.max(Math.floor(options.timeoutMs ?? FALLBACK_SCAN_TIMEOUT_MS), 1_000);
  const pruneChildNames = options.pruneChildNames ?? new Set<string>();
  const deadline = Date.now() + timeoutMs;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const found: ScannedAppFolder[] = [];
  let visited = 0;
  while (queue.length > 0 && visited < dirCap && Date.now() < deadline) {
    const current = queue.shift()!;
    visited += 1;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const directoryNames = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name.toLowerCase()));
    if (directoryNames.has('resources')) {
      const asarPath = path.win32.join(current.dir, 'resources', 'app.asar');
      if (await fileExists(asarPath)) {
        const executable = await findMainExecutableInFolder(current.dir, path.win32.basename(current.dir));
        if (executable) {
          found.push({
            exePath: executable,
            hintName: deriveFolderHint(current.dir),
            installKey: deriveInstallKey(current.dir, executable),
          });
          continue;
        }
      }
    }
    if (current.depth >= maxDepth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const lower = entry.name.toLowerCase();
      if (lower === 'resources' || isScrubbedDirName(entry.name) || pruneChildNames.has(lower)) continue;
      queue.push({ dir: path.win32.join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }
  return dedupeScannedAppFolders(found);
}

function deriveInstallKey(appFolder: string, exePath: string): string {
  const base = path.win32.basename(appFolder);
  if (VERSIONED_FOLDER_PATTERN.test(base)) {
    return normalizePathForCompare(path.win32.dirname(appFolder));
  }
  return normalizePathForCompare(exePath);
}

function dedupeScannedAppFolders(folders: readonly ScannedAppFolder[]): ScannedAppFolder[] {
  const byInstall = new Map<string, ScannedAppFolder>();
  for (const folder of folders) {
    const existing = byInstall.get(folder.installKey);
    if (!existing || folder.exePath.localeCompare(existing.exePath, undefined, { numeric: true }) > 0) {
      byInstall.set(folder.installKey, folder);
    }
  }
  return [...byInstall.values()];
}

export async function discoverCommonInstallApps(): Promise<DiscoveredApp[]> {
  const roots = commonInstallRoots();
  const found: ScannedAppFolder[] = [];
  const seen = new Set<string>();
  await Promise.all(roots.map(async (root) => {
    const folders = await scanRootForElectronApps(root.rootPath, {
      maxDepth: root.maxDepth,
      pruneChildNames: root.pruneChildNames,
    });
    for (const folder of folders) {
      const key = folder.installKey || normalizePathForCompare(folder.exePath);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      found.push(folder);
    }
  }));
  const canonical = dedupeScannedAppFolders(found);
  if (canonical.length === 0) return [];
  const versions = await readExecutableVersionInfo(canonical.map((folder) => folder.exePath));
  const apps: DiscoveredApp[] = [];
  for (const folder of canonical) {
    if (isExcludedElectronTarget(folder.exePath)) continue;
    const info = versions.get(normalizePathForCompare(folder.exePath));
    apps.push({
      exePath: folder.exePath,
      name: pickAppDisplayName(info?.productName, info?.fileDescription, folder.exePath, folder.hintName),
      source: 'start-menu',
      shortcutArgs: [],
    });
  }
  apps.sort((left, right) => left.name.localeCompare(right.name) || left.exePath.localeCompare(right.exePath));
  return apps;
}
