import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { DiscoveredApp } from '../../src/shared/types';
import {
  buildRunningApps,
  cleanAppDisplayName,
  commonInstallRoots,
  deriveAppHintFromAppPath,
  expandEnvironmentVariables,
  extractAppPathFromCommandLine,
  groupProcessEntriesByExecutable,
  hasElectronCommandLineMarker,
  isAuxiliaryExecutableName,
  isNestedInstallPath,
  isSystemExecutablePath,
  mergeDiscoveredApps,
  parseCimProcessDetails,
  parseDisplayIconPath,
  parseRegistryEntries,
  parseRunningProcessSearch,
  parseVersionInfoOutput,
  pickAppDisplayName,
  pickInstalledExecutable,
  scanRootForElectronApps,
  selectMainProcessEntry,
  type CimProcessEntry,
} from '../../src/main/apps/detection';

function processEntry(overrides: Partial<CimProcessEntry> & { pid: number }): CimProcessEntry {
  return { name: 'App.exe', ...overrides };
}

function discoveredApp(overrides: Partial<DiscoveredApp> & { exePath: string }): DiscoveredApp {
  return { name: 'App', source: 'start-menu', shortcutArgs: [], ...overrides };
}

test('parseCimProcessDetails reads process ids, paths and command lines', () => {
  const output = JSON.stringify([
    { ProcessId: 42, Name: 'OP.GG.exe', ExecutablePath: 'C:\\Apps\\OP.GG\\OP.GG.exe', CommandLine: '"C:\\Apps\\OP.GG\\OP.GG.exe" --type=renderer' },
    { ProcessId: 42, Name: 'duplicate' },
    { ProcessId: 'not-a-pid', Name: 'bad' },
    { ProcessId: 7, Name: 'NoPath.exe', ExecutablePath: '', CommandLine: null },
  ]);
  const entries = parseCimProcessDetails(output);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].pid, 42);
  assert.equal(entries[0].commandLine, '"C:\\Apps\\OP.GG\\OP.GG.exe" --type=renderer');
  assert.equal(entries[1].exePath, undefined);
  assert.equal(parseCimProcessDetails('').length, 0);
});

test('parseRunningProcessSearch splits PROC and VER lines', () => {
  const output = [
    'PROC|' + JSON.stringify([
      { ProcessId: 11, Name: 'App.exe', ExecutablePath: 'C:\\Apps\\App\\App.exe', CommandLine: '--type=renderer' },
      { ProcessId: 12, Name: 'Other.exe', ExecutablePath: 'C:\\Apps\\Other\\Other.exe', CommandLine: 'plain' },
    ]),
    'VER|' + JSON.stringify({ path: 'C:\\Apps\\App\\App.exe', productName: 'App Product', fileDescription: 'App Desc' }),
    'VER|' + JSON.stringify({ path: 'C:\\Apps\\Other\\Other.exe', productName: '', fileDescription: '' }),
  ].join('\r\n');
  const search = parseRunningProcessSearch(output);
  assert.equal(search.processes.length, 2);
  assert.equal(search.versions.size, 1);
  const info = search.versions.get('c:\\apps\\app\\app.exe');
  assert.ok(info);
  assert.equal(info.productName, 'App Product');
});

test('hasElectronCommandLineMarker recognises Electron child processes', () => {
  assert.equal(hasElectronCommandLineMarker('app.exe --type=renderer --lang=en'), true);
  assert.equal(hasElectronCommandLineMarker('app.exe --type=gpu-process'), true);
  assert.equal(hasElectronCommandLineMarker('electron.exe --app-path=C:\\Apps\\Foo'), true);
  assert.equal(hasElectronCommandLineMarker('app.exe "C:\\Apps\\Foo\\resources\\app.asar"'), true);
  assert.equal(hasElectronCommandLineMarker('app.exe "C:/Apps/Foo/resources/app.asar"'), true);
  assert.equal(hasElectronCommandLineMarker('app.exe --type=crashpad-handler'), false);
  assert.equal(hasElectronCommandLineMarker('notepad.exe C:\\notes.txt'), false);
  assert.equal(hasElectronCommandLineMarker(undefined), false);
});

test('extractAppPathFromCommandLine reads app-path variants', () => {
  assert.equal(extractAppPathFromCommandLine('electron.exe --app-path=C:\\Apps\\Foo'), 'C:\\Apps\\Foo');
  assert.equal(extractAppPathFromCommandLine('electron.exe --app-path="C:\\Program Files\\Foo"'), 'C:\\Program Files\\Foo');
  assert.equal(extractAppPathFromCommandLine("electron.exe --app-path='C:\\Apps\\Bar'"), 'C:\\Apps\\Bar');
  assert.equal(extractAppPathFromCommandLine('electron.exe --app-path C:\\Apps\\Baz'), 'C:\\Apps\\Baz');
  assert.equal(extractAppPathFromCommandLine('app.exe --type=renderer'), null);
});

test('selectMainProcessEntry prefers processes without a --type flag', () => {
  const main = processEntry({ pid: 90, exePath: 'C:\\App\\App.exe', commandLine: '"C:\\App\\App.exe"' });
  const renderer = processEntry({ pid: 20, exePath: 'C:\\App\\App.exe', commandLine: '"C:\\App\\App.exe" --type=renderer' });
  assert.equal(selectMainProcessEntry([renderer, main]), main);
  assert.equal(selectMainProcessEntry([renderer]), renderer);
  assert.equal(selectMainProcessEntry([]), null);
});

test('groupProcessEntriesByExecutable groups case-insensitive paths', () => {
  const entries = [
    processEntry({ pid: 1, exePath: 'C:\\Apps\\App\\App.exe' }),
    processEntry({ pid: 2, exePath: 'c:\\apps\\app\\APP.EXE' }),
    processEntry({ pid: 3, exePath: '' }),
  ];
  const groups = groupProcessEntriesByExecutable(entries);
  assert.equal(groups.size, 1);
  assert.equal(groups.get('c:\\apps\\app\\app.exe')?.length, 2);
});

test('buildRunningApps detects electron groups and applies exclusions', () => {
  const entries: CimProcessEntry[] = [
    processEntry({ pid: 100, exePath: 'C:\\Apps\\Foo\\Foo.exe', commandLine: '"C:\\Apps\\Foo\\Foo.exe"' }),
    processEntry({
      pid: 101,
      exePath: 'C:\\Apps\\Foo\\Foo.exe',
      commandLine: '"C:\\Apps\\Foo\\Foo.exe" --type=renderer --app-path=C:\\Apps\\Foo\\resources\\app.asar',
    }),
    processEntry({ pid: 102, exePath: 'C:\\Apps\\Bar\\Bar.exe', commandLine: '"C:\\Apps\\Bar\\Bar.exe"' }),
    processEntry({ pid: 103, exePath: 'C:\\Apps\\Plain\\Plain.exe', commandLine: '"C:\\Apps\\Plain\\Plain.exe"' }),
    processEntry({ pid: 104, exePath: 'C:\\Windows\\System32\\notepad.exe', commandLine: 'notepad.exe' }),
    processEntry({ pid: 105, exePath: 'C:\\Dev\\node_modules\\electron\\dist\\electron.exe', commandLine: 'electron.exe --type=renderer' }),
    processEntry({ pid: 106, exePath: 'C:\\Apps\\Crash\\Crash.exe', commandLine: '"C:\\Apps\\Crash\\Crash.exe" --type=crashpad-handler' }),
  ];
  const apps = buildRunningApps(entries, {
    hasAppAsar: (exePath) => exePath.toLowerCase() === 'c:\\apps\\bar\\bar.exe',
    versionInfo: (exePath) => {
      if (exePath.toLowerCase() === 'c:\\apps\\foo\\foo.exe') return { productName: 'Foo Product' };
      if (exePath.toLowerCase() === 'c:\\apps\\bar\\bar.exe') return { productName: 'Bar Product' };
      return undefined;
    },
    ownExePath: 'C:\\Program Files\\Electron Adblock\\Electron Adblock.exe',
    systemRoot: 'C:\\Windows',
  });
  assert.deepEqual(apps.map((app) => app.name), ['Bar Product', 'Foo Product']);
  for (const app of apps) {
    assert.equal(app.source, 'running');
    assert.deepEqual(app.shortcutArgs, []);
  }
});

test('buildRunningApps ignores renderer markers without Electron confirmation by default', () => {
  const entries: CimProcessEntry[] = [
    processEntry({ pid: 70, exePath: 'C:\\Browsers\\Chrome\\chrome.exe', commandLine: '"C:\\Browsers\\Chrome\\chrome.exe" --type=renderer' }),
    processEntry({ pid: 71, exePath: 'C:\\Browsers\\Chrome\\chrome.exe', commandLine: '"C:\\Browsers\\Chrome\\chrome.exe" --type=gpu-process' }),
  ];
  assert.deepEqual(buildRunningApps(entries), []);
  const trusted = buildRunningApps(entries, { trustRendererMarkers: true });
  assert.equal(trusted.length, 1);
});

test('buildRunningApps excludes the adblocker itself', () => {
  const ownExe = 'C:\\Program Files\\Electron Adblock\\Electron Adblock.exe';
  const apps = buildRunningApps(
    [processEntry({ pid: 50, exePath: ownExe, commandLine: ownExe + ' --type=renderer' })],
    { ownExePath: ownExe },
  );
  assert.deepEqual(apps, []);
});

test('buildRunningApps falls back to app-path and exe names', () => {
  const apps = buildRunningApps(
    [
      processEntry({
        pid: 60,
        exePath: 'C:\\Dev\\electron.exe',
        commandLine: 'electron.exe --app-path=C:\\Apps\\CoolApp',
      }),
    ],
    { versionInfo: () => ({ productName: 'Electron' }) },
  );
  assert.equal(apps.length, 1);
  assert.equal(apps[0].name, 'CoolApp');
});

test('parseRegistryEntries filters entries without a display name', () => {
  const output = [
    JSON.stringify({ displayName: 'App One', installLocation: 'C:\\Apps\\One', displayIcon: 'C:\\Apps\\One\\One.exe,0', hive: 'HKLM' }),
    JSON.stringify({ installLocation: 'C:\\Apps\\NoName' }),
    JSON.stringify({ displayName: 'App One', installLocation: 'C:\\Apps\\One' }),
    'not json',
  ].join('\r\n');
  const entries = parseRegistryEntries(output);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].displayName, 'App One');
  assert.equal(entries[0].installLocation, 'C:\\Apps\\One');
  assert.equal(entries[0].displayIcon, 'C:\\Apps\\One\\One.exe,0');
});

test('parseDisplayIconPath handles quoted paths and icon indexes', () => {
  assert.equal(parseDisplayIconPath('"C:\\Program Files\\App\\app.exe",0'), 'C:\\Program Files\\App\\app.exe');
  assert.equal(parseDisplayIconPath('C:\\Apps\\App\\app.exe,0'), 'C:\\Apps\\App\\app.exe');
  assert.equal(parseDisplayIconPath('"C:\\Apps\\App\\app.exe"'), 'C:\\Apps\\App\\app.exe');
  assert.equal(parseDisplayIconPath('C:\\Apps\\App\\icon.ico'), null);
  assert.equal(parseDisplayIconPath('app.dll,1'), null);
  assert.equal(parseDisplayIconPath(undefined), null);
  assert.equal(parseDisplayIconPath(''), null);
});

test('expandEnvironmentVariables expands known tokens case-insensitively', () => {
  const env: NodeJS.ProcessEnv = { LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local', ProgramFiles: 'C:\\Program Files' };
  assert.equal(
    expandEnvironmentVariables('%LOCALAPPDATA%\\Programs\\App', env),
    'C:\\Users\\Test\\AppData\\Local\\Programs\\App',
  );
  assert.equal(expandEnvironmentVariables('%ProgramFiles(x86)%\\App', env), '%ProgramFiles(x86)%\\App');
  assert.equal(expandEnvironmentVariables('%localappdata%\\x', env), 'C:\\Users\\Test\\AppData\\Local\\x');
});

test('pickInstalledExecutable prefers names that match the hint', () => {
  const paths = [
    'C:\\Apps\\Discord\\Update.exe',
    'C:\\Apps\\Discord\\Uninstall Discord.exe',
    'C:\\Apps\\Discord\\Discord.exe',
  ];
  assert.equal(pickInstalledExecutable(paths, 'Discord'), 'C:\\Apps\\Discord\\Discord.exe');
  assert.equal(pickInstalledExecutable(['C:\\A\\Update.exe', 'C:\\A\\Uninstall.exe'], 'App'), null);
  assert.equal(pickInstalledExecutable(['C:\\A\\Other.exe'], 'CompletelyDifferent'), 'C:\\A\\Other.exe');
  assert.equal(pickInstalledExecutable([], 'App'), null);
});

test('isAuxiliaryExecutableName filters updaters and handlers', () => {
  assert.equal(isAuxiliaryExecutableName('Update.exe'), true);
  assert.equal(isAuxiliaryExecutableName('Uninstall App.exe'), true);
  assert.equal(isAuxiliaryExecutableName('chrome_crashpad_handler.exe'), true);
  assert.equal(isAuxiliaryExecutableName('notification_helper.exe'), true);
  assert.equal(isAuxiliaryExecutableName('Discord.exe'), false);
  assert.equal(isAuxiliaryExecutableName('OP.GG.exe'), false);
});

test('mergeDiscoveredApps dedupes by path and prefers earlier entries', () => {
  const startMenu = [
    discoveredApp({
      exePath: 'C:\\Apps\\App\\App.exe',
      name: 'App From Start Menu',
      shortcutArgs: ['--profile', 'main'],
      source: 'start-menu',
    }),
  ];
  const registry = [
    discoveredApp({ exePath: 'c:\\apps\\app\\app.exe', name: 'Registry Name' }),
    discoveredApp({ exePath: 'C:\\Apps\\Other\\Other.exe', name: 'Other', source: 'start-menu' }),
  ];
  const filesystem = [
    discoveredApp({ exePath: 'C:\\Apps\\App\\App.exe', name: 'Filesystem Name' }),
    discoveredApp({ exePath: 'C:\\Apps\\Third\\Third.exe', name: 'Third' }),
  ];
  const merged = mergeDiscoveredApps([startMenu, registry, filesystem]);
  assert.equal(merged.length, 3);
  const app = merged.find((entry) => entry.exePath.toLowerCase() === 'c:\\apps\\app\\app.exe');
  assert.ok(app);
  assert.equal(app.name, 'App From Start Menu');
  assert.deepEqual(app.shortcutArgs, ['--profile', 'main']);
  assert.deepEqual(merged.map((entry) => entry.name), ['App From Start Menu', 'Other', 'Third']);
});

test('mergeDiscoveredApps collapses tray helpers into the main install', () => {
  const merged = mergeDiscoveredApps([
    [discoveredApp({ exePath: 'C:\\Program Files\\LGHUB\\system_tray\\lghub_system_tray.exe', name: 'Logitech G HUB' })],
    [discoveredApp({ exePath: 'C:\\Program Files\\LGHUB\\lghub.exe', name: 'Logitech G HUB' })],
    [discoveredApp({ exePath: 'C:\\Program Files\\LGHUB\\lghub.exe', name: 'LGHUB' })],
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].exePath.toLowerCase(), 'c:\\program files\\lghub\\system_tray\\lghub_system_tray.exe');
});

test('isNestedInstallPath only matches executables in one install tree', () => {
  assert.equal(isNestedInstallPath('C:\\Apps\\App\\App.exe', 'C:\\Apps\\App\\bin\\App.exe'), true);
  assert.equal(isNestedInstallPath('C:\\Apps\\App\\App.exe', 'C:\\Apps\\App\\App.exe'), true);
  assert.equal(isNestedInstallPath('C:\\Apps\\One\\One.exe', 'C:\\Apps\\Two\\Two.exe'), false);
});

test('mergeDiscoveredApps fills missing shortcut arguments from later sources', () => {
  const merged = mergeDiscoveredApps([
    [discoveredApp({ exePath: 'C:\\Apps\\App\\App.exe', name: 'App' })],
    [discoveredApp({ exePath: 'C:\\Apps\\App\\App.exe', name: 'App', shortcutArgs: ['--flag'] })],
  ]);
  assert.deepEqual(merged[0].shortcutArgs, ['--flag']);
});

test('pickAppDisplayName prefers products and rejects generic Electron names', () => {
  assert.equal(pickAppDisplayName('OP.GG', 'OP.GG', 'C:\\Apps\\OP.GG\\OP.GG.exe'), 'OP.GG');
  assert.equal(pickAppDisplayName('Electron', 'My App', 'C:\\Apps\\MyApp\\MyApp.exe'), 'My App');
  assert.equal(pickAppDisplayName('', '', 'C:\\Apps\\MyApp\\MyApp.exe'), 'MyApp');
  assert.equal(pickAppDisplayName('Electron', undefined, 'C:\\Apps\\MyApp\\MyApp.exe', 'C:\\Apps\\FromHint'), 'FromHint');
});

test('cleanAppDisplayName removes registry version suffixes', () => {
  assert.equal(cleanAppDisplayName('OP.GG 2.0.0'), 'OP.GG');
  assert.equal(cleanAppDisplayName('DeepSeek Harness 0.2.1-rc.3'), 'DeepSeek Harness');
  assert.equal(cleanAppDisplayName('Antigravity 2.26.0'), 'Antigravity');
  assert.equal(cleanAppDisplayName('App - 1.2.3'), 'App');
  assert.equal(cleanAppDisplayName('App v1.2'), 'App');
  assert.equal(cleanAppDisplayName('Logitech G HUB'), 'Logitech G HUB');
  assert.equal(cleanAppDisplayName('ReasonLabs Secure Client UI Container'), 'ReasonLabs Secure Client UI Container');
  assert.equal(cleanAppDisplayName(''), '');
});

test('deriveAppHintFromAppPath names the app folder', () => {
  assert.equal(deriveAppHintFromAppPath('C:\\Apps\\Foo\\resources\\app.asar'), 'Foo');
  assert.equal(deriveAppHintFromAppPath('C:\\Apps\\Bar'), 'Bar');
  assert.equal(deriveAppHintFromAppPath('C:\\Apps\\Baz\\'), 'Baz');
  assert.equal(deriveAppHintFromAppPath(null), undefined);
  assert.equal(deriveAppHintFromAppPath(''), undefined);
});

test('isSystemExecutablePath protects the Windows directory tree', () => {
  assert.equal(isSystemExecutablePath('C:\\Windows\\System32\\notepad.exe', 'C:\\Windows'), true);
  assert.equal(isSystemExecutablePath('c:\\windows\\explorer.exe', 'C:\\Windows'), true);
  assert.equal(isSystemExecutablePath('C:\\Program Files\\App\\App.exe', 'C:\\Windows'), false);
  assert.equal(isSystemExecutablePath('', 'C:\\Windows'), false);
});

test('parseVersionInfoOutput maps normalised executable paths', () => {
  const output = JSON.stringify([
    { path: 'C:\\Apps\\App\\App.exe', productName: 'App Product', fileDescription: 'App Description' },
    { path: 'C:\\Apps\\Other\\Other.exe', productName: '', fileDescription: '' },
  ]);
  const versions = parseVersionInfoOutput(output);
  assert.equal(versions.size, 1);
  const info = versions.get('c:\\apps\\app\\app.exe');
  assert.ok(info);
  assert.equal(info.fileDescription, 'App Description');
});

test('commonInstallRoots derives roots from the supplied environment', () => {
  const roots = commonInstallRoots({
    LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  } as NodeJS.ProcessEnv);
  const paths = roots.map((root) => root.rootPath.toLowerCase());
  assert.deepEqual(paths, [
    'c:\\users\\test\\appdata\\local\\programs',
    'c:\\program files',
    'c:\\program files (x86)',
    'c:\\users\\test\\appdata\\local',
  ]);
  assert.ok(roots[3].pruneChildNames?.has('programs'));
  assert.deepEqual(commonInstallRoots({} as NodeJS.ProcessEnv), []);
});

test('scanRootForElectronApps finds app.asar folders at limited depth', async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'eab-scan-'));
  try {
    const directApp = path.join(rootDir, 'DirectApp');
    await mkdir(path.join(directApp, 'resources'), { recursive: true });
    await writeFile(path.join(directApp, 'resources', 'app.asar'), '');
    await writeFile(path.join(directApp, 'DirectApp.exe'), '');

    const olderVersion = path.join(rootDir, 'Vendor', 'VersionedApp', 'app-1.0.9');
    await mkdir(path.join(olderVersion, 'resources'), { recursive: true });
    await writeFile(path.join(olderVersion, 'resources', 'app.asar'), '');
    await writeFile(path.join(olderVersion, 'VersionedApp.exe'), '');

    const newerVersion = path.join(rootDir, 'Vendor', 'VersionedApp', 'app-1.0.11');
    await mkdir(path.join(newerVersion, 'resources'), { recursive: true });
    await writeFile(path.join(newerVersion, 'resources', 'app.asar'), '');
    await writeFile(path.join(newerVersion, 'VersionedApp.exe'), '');

    const plainApp = path.join(rootDir, 'Vendor', 'PlainApp');
    await mkdir(plainApp, { recursive: true });
    await writeFile(path.join(plainApp, 'PlainApp.exe'), '');

    const cacheApp = path.join(rootDir, 'cache', 'CachedApp');
    await mkdir(path.join(cacheApp, 'resources'), { recursive: true });
    await writeFile(path.join(cacheApp, 'resources', 'app.asar'), '');
    await writeFile(path.join(cacheApp, 'CachedApp.exe'), '');

    const updaterCopy = path.join(rootDir, 'blitz-delta-updater', 'SkippedApp');
    await mkdir(path.join(updaterCopy, 'resources'), { recursive: true });
    await writeFile(path.join(updaterCopy, 'resources', 'app.asar'), '');
    await writeFile(path.join(updaterCopy, 'SkippedApp.exe'), '');

    const clientOlder = path.join(rootDir, 'ReasonLabs', 'Client', 'v1.4.2');
    await mkdir(path.join(clientOlder, 'resources'), { recursive: true });
    await writeFile(path.join(clientOlder, 'resources', 'app.asar'), '');
    await writeFile(path.join(clientOlder, 'ClientUI.exe'), '');

    const clientNewer = path.join(rootDir, 'ReasonLabs', 'Client', 'v1.6.0');
    await mkdir(path.join(clientNewer, 'resources'), { recursive: true });
    await writeFile(path.join(clientNewer, 'resources', 'app.asar'), '');
    await writeFile(path.join(clientNewer, 'ClientUI.exe'), '');

    const tooDeepApp = path.join(rootDir, 'A', 'B', 'C', 'DeepApp');
    await mkdir(path.join(tooDeepApp, 'resources'), { recursive: true });
    await writeFile(path.join(tooDeepApp, 'resources', 'app.asar'), '');
    await writeFile(path.join(tooDeepApp, 'DeepApp.exe'), '');

    const found = await scanRootForElectronApps(rootDir, { maxDepth: 3 });
    const names = found.map((entry) => path.basename(entry.exePath)).sort();
    assert.deepEqual(names, ['ClientUI.exe', 'DirectApp.exe', 'VersionedApp.exe']);
    assert.equal(found.some((entry) => entry.exePath.endsWith('SkippedApp.exe')), false);
    const versioned = found.find((entry) => entry.exePath.endsWith('VersionedApp.exe'));
    assert.ok(versioned);
    assert.equal(versioned.hintName, 'VersionedApp');
    assert.match(versioned.exePath, /app-1\.0\.11[\\/]VersionedApp\.exe$/);
    assert.equal(versioned.installKey, path.join(rootDir, 'Vendor', 'VersionedApp').toLowerCase());
    const client = found.find((entry) => entry.exePath.endsWith('ClientUI.exe'));
    assert.ok(client);
    assert.match(client.exePath, /v1\.6\.0[\\/]ClientUI\.exe$/);
    assert.equal(client.hintName, 'Client');
    assert.equal(client.installKey, path.join(rootDir, 'ReasonLabs', 'Client').toLowerCase());
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
