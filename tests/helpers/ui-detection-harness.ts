// QA read-only harness for Electron app detection and listDetectedApps.
// Runs the real discovery functions plus a real-mode app instance with an isolated profile.
//   node --import tsx tests/helpers/ui-detection-harness.ts
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  discoverInstalledApps,
  discoverRunningApps,
  listProcesses,
} from '../../src/main/apps/discovery';
import { mergeDiscoveredApps } from '../../src/main/apps/detection';
import type { AppView, DiscoveredApp } from '../../src/shared/types';
import { connectToPage } from './cdp';
import { PROJECT_ROOT, launchBuiltApp } from './fixture';

const REPORT_PATH = path.join(PROJECT_ROOT, '_shots', 'qa-detection-report.json');
const OPGG_EXE = 'C:\\Users\\hoyul\\AppData\\Local\\Programs\\OP.GG\\OP.GG.exe';

interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

const checks: CheckResult[] = [];

function check(name: string, pass: boolean, detail = ''): void {
  checks.push({ name, pass: Boolean(pass), detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : ''));
}

function paths(apps: readonly DiscoveredApp[]): string[] {
  return apps.map((app) => path.resolve(app.exePath).toLowerCase());
}

function hasDuplicatePaths(apps: readonly DiscoveredApp[]): boolean {
  const seen = new Set<string>();
  for (const value of paths(apps)) {
    if (seen.has(value)) return true;
    seen.add(value);
  }
  return false;
}

function includesPath(apps: readonly DiscoveredApp[], target: string): boolean {
  const wanted = path.resolve(target).toLowerCase();
  return paths(apps).includes(wanted);
}

function isSelfPath(exePath: string): boolean {
  const lower = path.resolve(exePath).toLowerCase();
  return lower.includes(path.resolve(PROJECT_ROOT).toLowerCase());
}

async function discover(): Promise<{ installed: DiscoveredApp[]; running: DiscoveredApp[]; durationMs: number; processes: number }> {
  const started = Date.now();
  const [installed, running, processes] = await Promise.all([
    discoverInstalledApps(),
    discoverRunningApps(),
    listProcesses(),
  ]);
  return { installed, running, durationMs: Date.now() - started, processes: processes.length };
}

async function main(): Promise<void> {
  let passed = 0;
  let app: Awaited<ReturnType<typeof launchBuiltApp>> | null = null;
  try {
    const discovery = await discover();
    console.log(
      'discovery: installed=' +
        String(discovery.installed.length) +
        ' running=' +
        String(discovery.running.length) +
        ' processes=' +
        String(discovery.processes) +
        ' in ' +
        String(discovery.durationMs) +
        'ms',
    );
    console.log('installed names: ' + discovery.installed.slice(0, 12).map((entry) => entry.name).join(', '));
    console.log('running names: ' + discovery.running.map((entry) => entry.name).join(', '));

    check('installed discovery returns candidates', discovery.installed.length > 0, 'count=' + String(discovery.installed.length));
    check('installed discovery finds OP.GG', includesPath(discovery.installed, OPGG_EXE));

    const opggRunning = discovery.running.some((entry) => path.resolve(entry.exePath).toLowerCase() === path.resolve(OPGG_EXE).toLowerCase());
    check('running discovery finds the running OP.GG', opggRunning, 'running=' + String(discovery.running.length));
    check(
      'running discovery finds other Electron apps too',
      discovery.running.some((entry) => !path.resolve(entry.exePath).toLowerCase().endsWith('op.gg.exe')),
      'names=' + discovery.running.map((entry) => entry.name).join(', '),
    );
    check('installed discovery has no duplicate exe paths', !hasDuplicatePaths(discovery.installed));
    check('running discovery has no duplicate exe paths', !hasDuplicatePaths(discovery.running));

    const merged = mergeDiscoveredApps([discovery.installed, discovery.running]);
    check('merged installed+running keeps unique exe paths', !hasDuplicatePaths(merged), 'count=' + String(merged.length));
    check(
      'merged list excludes this QA project path',
      !merged.some((entry) => isSelfPath(entry.exePath)),
    );

    // --- listDetectedApps through the real service in a throwaway profile.
    app = await launchBuiltApp();
    const { connection, page } = await connectToPage(app.port, { timeoutMs: 45000 });
    try {
      await page.waitFor('!document.querySelector(".boot-screen")', {
        timeoutMs: 45000,
        description: 'real-mode shell',
      });
      const fatal = await page.evaluate<string>('document.querySelector(".fatal-title")?.textContent ?? ""');
      check('real-mode app boots without a fatal screen', fatal.length === 0, fatal);

      const detected = await page.evaluate<DiscoveredApp[]>(
        '(async () => await window.adblock.listDetectedApps())()',
      );
      console.log('listDetectedApps: ' + String(detected.length) + ' entries: ' + detected.slice(0, 12).map((entry) => entry.name).join(', '));
      check('listDetectedApps returns entries', detected.length > 0, 'count=' + String(detected.length));
      check('listDetectedApps includes OP.GG', includesPath(detected, OPGG_EXE));
      check('listDetectedApps has no duplicate exe paths', !hasDuplicatePaths(detected));
      check('listDetectedApps excludes this project path', !detected.some((entry) => isSelfPath(entry.exePath)));

      const target = detected.find((entry) => includesPath([entry], OPGG_EXE)) ?? detected[0];
      check('a detected app is available to add', target !== undefined, target?.name ?? '');
      if (target) {
        const added = await page.evaluate<AppView>(
          '(async () => await window.adblock.addApp(' + JSON.stringify(target.exePath) + '))()',
        );
        check('addApp returns the new app', added !== null && Boolean(added.exePath), added?.name ?? '');
        const afterAdd = await page.evaluate<DiscoveredApp[]>(
          '(async () => await window.adblock.listDetectedApps())()',
        );
        check(
          'listDetectedApps excludes the already-added path',
          !includesPath(afterAdd, target.exePath),
          'added=' + target.exePath,
        );
        check('listDetectedApps stays deduplicated after adding', !hasDuplicatePaths(afterAdd));
        await page.waitFor('document.querySelectorAll(".app-row").length === 1', {
          timeoutMs: 6000,
          description: 'added app in the sidebar',
        });
        check('added app appears in the sidebar', true);
      }
    } finally {
      await connection.close();
    }
  } catch (error) {
    console.error('HARNESS FAILURE: ' + (error instanceof Error ? (error.stack ?? error.message) : String(error)));
    console.error('--- app output tail ---\n' + (app?.output().slice(-3000) ?? ''));
    process.exitCode = 2;
  } finally {
    if (app) await app.close();
    passed = checks.filter((item) => item.pass).length;
    console.log('RESULT ' + String(passed) + '/' + String(checks.length) + ' checks passed');
    await writeFile(REPORT_PATH, JSON.stringify({ checks, passed, total: checks.length }, null, 2), 'utf8').catch(
      () => undefined,
    );
    if (checks.some((item) => !item.pass) && process.exitCode === undefined) process.exitCode = 1;
  }
}

void main();
