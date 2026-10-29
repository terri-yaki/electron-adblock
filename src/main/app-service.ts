import { app as electronApp } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AD_DOMAINS, ANALYTICS_DOMAINS } from '../shared/default-filters';
import type {
  AdCandidate,
  AppEvent,
  AppStats,
  AppStatus,
  AppView,
  BlockedEvent,
  BootstrapState,
  CosmeticRule,
  CosmeticRuleInput,
  CosmeticRulePatch,
  DiscoveredApp,
  Engine,
  EngineEvent,
  LayoutReport,
  LayoutRule,
  LayoutRuleInput,
  LayoutRulePatch,
  NetworkRule,
  NetworkRulePatch,
  PersistedApp,
  PickReport,
  ProcessInfo,
  Settings,
} from '../shared/types';
import type { ServiceApi, ServiceEnv } from './service-contract';
import { AppStore } from './store';
import {
  closeProcesses,
  discoverCommonInstallApps,
  discoverInstalledApps,
  discoverRegistryApps,
  discoverRunningApps,
  discoverStartMenuApps,
  exeNameForPath,
  listProcesses,
  listProcessesForExecutable,
} from './apps/discovery';
import { mergeDiscoveredApps } from './apps/detection';
import {
  allocateDebugPort,
  findDebugPortForApp,
  launchExecutable,
  waitForDebugEndpoint,
} from './apps/launcher';
import { createEngine, probeDebugEndpoint } from './engine/engine';
import { createCombinedEngine } from './engine/combined-engine';

function isNormalCdpPageUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (lower === 'about:blank') return false;
  return !(
    lower.includes('overwolf.com/monsdk') ||
    lower.includes('/adview') ||
    lower.includes('ow-cmp') ||
    lower.includes('offline.html') ||
    lower.includes('offline_overlay') ||
    lower.startsWith('owepm://')
  );
}

interface Runtime {
  app: PersistedApp;
  engine: Engine | null;
  launchedByUs: boolean;
  status: AppStatus;
  pages: number;
  currentUrl?: string;
  electronVersion?: string;
  pickerActive: boolean;
  lastError?: string;
  stats: AppStats;
  runningProcessCount: number;
  canAttach: boolean;
  iconDataUrl?: string;
  managedPid?: number;
  effectiveExePath?: string;
  pendingPicked: number;
  layoutEditing: boolean;
}

const MAX_LOG = 200;
const MAX_SELECTOR = 500;
const MAX_PATTERN = 300;
const LAUNCH_TIMEOUT_MS = 30_000;
const MAX_LAYOUT_DECLARATIONS = 20;
const MAX_LAYOUT_VALUE = 120;
const LAYOUT_PROPERTIES = new Set<string>([
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'flex',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'flex-direction',
  'flex-wrap',
  'align-self',
  'justify-self',
  'order',
  'gap',
  'row-gap',
  'column-gap',
  'overflow',
  'overflow-x',
  'overflow-y',
  'grid-column',
  'grid-row',
  'grid-area',
  'top',
  'right',
  'bottom',
  'left',
  'inset',
  'border-radius',
  'box-sizing',
  'max-inline-size',
  'min-inline-size',
  'position',
  'z-index',
]);

function isValidLayoutValue(property: string, value: string): boolean {
  if (property === 'z-index') {
    if (!/^-?\d{1,10}$/.test(value)) return false;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= -2147483648 && numeric <= 2147483647;
  }
  if (property === 'position') {
    return ['static', 'relative', 'absolute', 'fixed', 'sticky'].includes(value);
  }
  return true;
}

function sanitizeLayoutDeclarations(
  raw: Record<string, string> | undefined,
): Record<string, string> {
  const output: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return output;
  for (const [key, value] of Object.entries(raw)) {
    const property = String(key).trim().toLowerCase();
    if (!LAYOUT_PROPERTIES.has(property)) continue;
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (!text || text.length > MAX_LAYOUT_VALUE) continue;
    if (/[;{}<>\\]/.test(text)) continue;
    if (/url\s*\(|expression\s*\(|@import/i.test(text)) continue;
    if (!isValidLayoutValue(property, text)) continue;
    output[property] = text;
    if (Object.keys(output).length >= MAX_LAYOUT_DECLARATIONS) break;
  }
  return output;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function samePath(left: string, right: string): boolean {
  try {
    return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
  } catch {
    return left.toLowerCase() === right.toLowerCase();
  }
}

export class AppService implements ServiceApi {
  private readonly store: AppStore;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly logs = new Map<string, BlockedEvent[]>();
  private readonly emitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly portProbeCache = new Map<string, { at: number; ok: boolean }>();
  private sink: (event: AppEvent) => void = () => {};
  private injectedScriptCache: string | null = null;
  private detectedCache: { at: number; apps: DiscoveredApp[] } | null = null;
  private runningAppsCache: { at: number; apps: DiscoveredApp[] } | null = null;
  private detectedPromise: Promise<DiscoveredApp[]> | null = null;
  private runningPromise: Promise<DiscoveredApp[]> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshPromise: Promise<AppView[]> | null = null;
  private disposed = false;

  constructor(private readonly env: ServiceEnv) {
    this.store = new AppStore(env.dataDir);
  }

  async init(): Promise<void> {
    await this.store.load();
    for (const app of this.store.data.apps) this.runtimes.set(app.id, this.makeRuntime(app));
    setTimeout(() => {
      void this.detectedApps().catch(() => undefined);
    }, 2000);
    this.refreshTimer = setInterval(() => {
      void this.refresh()
        .then((apps) => this.emit({ type: 'apps', apps }))
        .catch(() => undefined);
    }, 5000);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    for (const timer of this.emitTimers.values()) clearTimeout(timer);
    this.emitTimers.clear();
    const closeManaged = this.store.data.settings.closeManagedAppsOnQuit;
    for (const runtime of this.runtimes.values()) {
      await this.detachEngine(runtime);
      if (closeManaged && runtime.launchedByUs) {
        try {
          const processes = await this.processesForRuntime(runtime);
          if (processes.length > 0) {
            await closeProcesses(
              processes.map((process) => process.pid),
              5000,
            );
          }
        } catch {
          // Ignore shutdown errors.
        }
      }
    }
    try {
      await this.store.save();
    } catch {
      // Ignore save errors on quit.
    }
  }

  setEventSink(sink: (event: AppEvent) => void): void {
    this.sink = sink;
  }

  getEnv(): ServiceEnv {
    return this.env;
  }

  private get settings(): Settings {
    return this.store.data.settings;
  }

  private emit(event: AppEvent): void {
    try {
      this.sink(event);
    } catch {
      // Renderer may be gone.
    }
  }

  private emitApp(runtime: Runtime): void {
    this.emit({ type: 'app', app: this.toView(runtime) });
  }

  private scheduleApp(runtime: Runtime): void {
    const appId = runtime.app.id;
    if (this.emitTimers.has(appId)) return;
    const timer = setTimeout(() => {
      this.emitTimers.delete(appId);
      this.emitApp(runtime);
    }, 400);
    this.emitTimers.set(appId, timer);
  }

  private makeRuntime(app: PersistedApp): Runtime {
    if (!this.logs.has(app.id)) this.logs.set(app.id, []);
    return {
      app,
      engine: null,
      launchedByUs: false,
      status: 'not-running',
      pages: 0,
      pickerActive: false,
      stats: { blockedRequests: 0, hiddenElements: 0, pages: 0 },
      runningProcessCount: 0,
      canAttach: false,
      pendingPicked: 0,
      layoutEditing: false,
    };
  }

  private getRuntime(appId: string): Runtime {
    const runtime = this.runtimes.get(appId);
    if (!runtime) throw new Error('Unknown application: ' + appId);
    return runtime;
  }

  private toView(runtime: Runtime): AppView {
    const app = runtime.app;
    return {
      id: app.id,
      name: app.name,
      exePath: app.exePath,
      source: app.source,
      status: runtime.status,
      attached: runtime.engine?.connected === true,
      enabled: app.enabled,
      debugPort: app.debugPort,
      electronVersion: runtime.electronVersion,
      pages: runtime.pages,
      currentUrl: runtime.currentUrl,
      runningProcessCount: runtime.runningProcessCount,
      canAttach: runtime.canAttach,
      pickerActive: runtime.pickerActive,
      lastError: runtime.lastError,
      stats: { ...runtime.stats },
      cosmeticRules: app.cosmeticRules.map((rule) => ({ ...rule })),
      networkRules: app.networkRules.map((rule) => ({ ...rule })),
      layoutRules: app.layoutRules.map((rule) => ({
        ...rule,
        declarations: { ...rule.declarations },
      })),
      layoutEditing: runtime.layoutEditing,
      iconDataUrl: runtime.iconDataUrl,
    };
  }

  private async persist(): Promise<void> {
    await this.store.save();
  }

  private async ensureIcon(runtime: Runtime): Promise<void> {
    if (runtime.iconDataUrl) return;
    try {
      const image = await electronApp.getFileIcon(runtime.app.exePath, { size: 'normal' });
      if (!image.isEmpty()) runtime.iconDataUrl = image.toDataURL();
    } catch {
      // Missing icons are fine.
    }
  }

  private async processesFor(exePath: string): Promise<ProcessInfo[]> {
    try {
      return await listProcessesForExecutable(exePath);
    } catch {
      return [];
    }
  }

  private async processesForRuntime(runtime: Runtime): Promise<ProcessInfo[]> {
    const primary = runtime.effectiveExePath ?? runtime.app.exePath;
    let processes = await this.processesFor(primary);
    if (processes.length === 0 && !samePath(primary, runtime.app.exePath)) {
      processes = await this.processesFor(runtime.app.exePath);
    }
    return processes;
  }

  private async waitForNoRuntimeProcesses(runtime: Runtime, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if ((await this.processesForRuntime(runtime)).length === 0) return true;
      await sleep(250);
    }
    return false;
  }

  private async waitForNoProcesses(exePath: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const processes = await this.processesFor(exePath);
      if (processes.length === 0) return true;
      await sleep(250);
    }
    return false;
  }

  private async waitForInspectorPort(port: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1200);
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: controller.signal });
        if (response.ok) {
          const list = await response.json();
          if (Array.isArray(list) && list.length > 0) return true;
        }
      } catch {
        // Inspector not up yet.
      } finally {
        clearTimeout(timer);
      }
      await sleep(300);
    }
    return false;
  }

  private async probeKnownPort(runtime: Runtime): Promise<boolean> {
    const port = runtime.app.debugPort;
    if (!port) return false;
    const key = runtime.app.id + ':' + port;
    const cached = this.portProbeCache.get(key);
    const now = Date.now();
    if (cached && now - cached.at < 4000) return cached.ok;
    let ok = false;
    try {
      ok = (await probeDebugEndpoint(port, 400)) !== null;
    } catch {
      ok = false;
    }
    this.portProbeCache.set(key, { at: now, ok });
    return ok;
  }

  async getBootstrap(): Promise<BootstrapState> {
    const apps = [...this.runtimes.values()].map((runtime) => this.toView(runtime));
    void this.refresh()
      .then((updated) => this.emit({ type: 'apps', apps: updated }))
      .catch(() => undefined);
    return {
      settings: { ...this.settings },
      apps,
      version: this.env.version,
      dataDir: this.env.dataDir,
      devMode: this.env.devMode,
      packaged: this.env.packaged,
    };
  }

  async refresh(): Promise<AppView[]> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async doRefresh(): Promise<AppView[]> {
    let processes: ProcessInfo[] = [];
    try {
      processes = await listProcesses();
    } catch {
      processes = [];
    }
    const runningApps = await this.runningApps();

    const views: AppView[] = [];
    for (const runtime of this.runtimes.values()) {
      const exeName = exeNameForPath(runtime.app.exePath).toLowerCase();
      let matches = processes.filter((process) => {
        if (process.name.toLowerCase() === exeName) return true;
        if (process.exePath && samePath(process.exePath, runtime.app.exePath)) return true;
        return false;
      });
      let effectiveExePath = runtime.app.exePath;
      if (matches.length === 0) {
        const running =
          runningApps.find((app) => samePath(app.exePath, runtime.app.exePath)) ??
          runningApps.find((app) => app.name.toLowerCase() === runtime.app.name.toLowerCase());
        if (running) {
          effectiveExePath = running.exePath;
          matches = [
            {
              pid: 0,
              name: path.basename(running.exePath),
              exePath: running.exePath,
            },
          ];
        }
      }
      runtime.effectiveExePath = effectiveExePath;
      runtime.runningProcessCount = matches.length;
      await this.ensureIcon(runtime);

      if (runtime.engine?.connected) {
        runtime.status = 'attached';
        runtime.canAttach = true;
      } else if (runtime.status === 'launching' && matches.length === 0) {
        runtime.canAttach = false;
      } else if (matches.length > 0) {
        runtime.status = runtime.lastError ? 'error' : 'running';
        runtime.canAttach = await this.probeKnownPort(runtime);
      } else {
        runtime.status = runtime.lastError ? 'error' : 'not-running';
        runtime.canAttach = false;
        runtime.pages = 0;
        runtime.currentUrl = undefined;
        runtime.pickerActive = false;
        runtime.layoutEditing = false;
      }
      views.push(this.toView(runtime));
    }
    return views;
  }

  private isSelfExe(exePath: string): boolean {
    const lower = exePath.toLowerCase();
    if (samePath(exePath, process.execPath)) return true;
    if (lower.includes('electron-adblock') || lower.includes('electron adblock')) return true;
    if (!electronApp.isPackaged && path.basename(lower) === 'electron.exe') return true;
    return false;
  }

  private async runningApps(): Promise<DiscoveredApp[]> {
    const now = Date.now();
    if (this.runningAppsCache && now - this.runningAppsCache.at < 10_000) {
      return this.runningAppsCache.apps;
    }
    if (this.runningPromise) return this.runningPromise;
    this.runningPromise = (async () => {
      let apps: DiscoveredApp[] = [];
      try {
        apps = await discoverRunningApps();
      } catch {
        return this.runningAppsCache?.apps ?? [];
      }
      const filtered = apps.filter((app) => !this.isSelfExe(app.exePath));
      this.runningAppsCache = { at: now, apps: filtered };
      return filtered;
    })().finally(() => {
      this.runningPromise = null;
    });
    return this.runningPromise;
  }

  private async detectedApps(): Promise<DiscoveredApp[]> {
    const now = Date.now();
    if (this.detectedCache && now - this.detectedCache.at < 60_000) return this.detectedCache.apps;
    if (this.detectedPromise) return this.detectedPromise;
    this.detectedPromise = (async () => {
      let apps: DiscoveredApp[] = [];
      try {
        apps = await discoverInstalledApps();
      } catch {
        const started = Date.now();
        const settled = await Promise.allSettled([
          discoverStartMenuApps(),
          discoverRegistryApps(),
          discoverCommonInstallApps(),
        ]);
        const successful: DiscoveredApp[][] = [];
        const diagnostic: Array<Record<string, unknown>> = [];
        for (const [index, entry] of settled.entries()) {
          if (entry.status === 'fulfilled') {
            successful.push(entry.value);
            diagnostic.push({ source: ['start-menu', 'registry', 'filesystem'][index], count: entry.value.length });
          } else {
            diagnostic.push({
              source: ['start-menu', 'registry', 'filesystem'][index],
              error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
            });
          }
        }
        try {
          fs.writeFileSync(
            path.join(this.env.dataDir, 'detection-diagnostic.json'),
            JSON.stringify({ at: new Date().toISOString(), ms: Date.now() - started, diagnostic }, null, 2),
          );
        } catch {
          // Diagnostics must never break detection.
        }
        apps = successful.length > 0 ? mergeDiscoveredApps(successful) : [];
      }
      const filtered = apps.filter((app) => !this.isSelfExe(app.exePath));
      this.detectedCache = { at: now, apps: filtered };
      return filtered;
    })().finally(() => {
      this.detectedPromise = null;
    });
    return this.detectedPromise;
  }

  private async findDiscovered(exePath: string): Promise<DiscoveredApp | undefined> {
    const apps = [...(await this.detectedApps()), ...(await this.runningApps())];
    return apps.find((app) => samePath(app.exePath, exePath));
  }

  async browseForExecutable(): Promise<string | null> {
    throw new Error('Executable browsing is handled by the main process');
  }

  async listDetectedApps(): Promise<DiscoveredApp[]> {
    const installed = await this.detectedApps();
    const running = await this.runningApps();
    const apps = [...installed, ...running];
    const existing = new Set(
      this.store.data.apps.map((app) => path.resolve(app.exePath).toLowerCase()),
    );
    const seen = new Set<string>();
    const result: DiscoveredApp[] = [];
    for (const app of apps) {
      const key = path.resolve(app.exePath).toLowerCase();
      if (existing.has(key) || seen.has(key)) continue;
      seen.add(key);
      result.push(app);
    }
    result.sort((left, right) => left.name.localeCompare(right.name));
    return result;
  }

  async addApp(exePath: string): Promise<AppView> {
    const cleaned = exePath.trim();
    if (!cleaned || !/\.exe$/i.test(cleaned)) throw new Error('Choose a Windows .exe file');
    if (this.isSelfExe(cleaned)) throw new Error('That is Electron Adblock itself');
    const existing = [...this.runtimes.values()].find((runtime) =>
      samePath(runtime.app.exePath, cleaned),
    );
    if (existing) return this.toView(existing);

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cleaned);
    } catch {
      throw new Error('File not found: ' + cleaned);
    }
    if (!stat.isFile()) throw new Error('Not a file: ' + cleaned);

    const discovered = await this.findDiscovered(cleaned);
    const app: PersistedApp = {
      id: crypto.createHash('sha1').update(cleaned.toLowerCase()).digest('hex').slice(0, 12),
      name: discovered?.name ?? path.basename(cleaned, path.extname(cleaned)),
      exePath: cleaned,
      shortcutArgs: discovered?.shortcutArgs ?? [],
      source: discovered?.source ?? 'manual',
      enabled: true,
      addedAt: Date.now(),
      cosmeticRules: [],
      networkRules: [],
      layoutRules: [],
    };
    this.store.data.apps.push(app);
    const runtime = this.makeRuntime(app);
    this.runtimes.set(app.id, runtime);
    await this.persist();
    await this.ensureIcon(runtime);
    this.emit({ type: 'apps', apps: await this.refresh() });
    this.emit({ type: 'toast', level: 'success', message: app.name + ' added' });
    return this.toView(runtime);
  }

  async removeApp(appId: string): Promise<AppView[]> {
    const runtime = this.getRuntime(appId);
    await this.detachEngine(runtime);
    this.runtimes.delete(appId);
    this.store.data.apps = this.store.data.apps.filter((app) => app.id !== appId);
    this.logs.delete(appId);
    const timer = this.emitTimers.get(appId);
    if (timer) clearTimeout(timer);
    this.emitTimers.delete(appId);
    await this.persist();
    const apps = await this.refresh();
    this.emit({ type: 'apps', apps });
    return apps;
  }

  private injectedScript(): string {
    if (this.injectedScriptCache) return this.injectedScriptCache;
    const file = path.join(__dirname, 'injected.js');
    try {
      this.injectedScriptCache = fs.readFileSync(file, 'utf8');
      return this.injectedScriptCache;
    } catch {
      throw new Error('injected.js is missing. Run npm run build first.');
    }
  }

  private configFor(appId: string): {
    enabled: boolean;
    cosmetic: CosmeticRule[];
    networkPatterns: string[];
    layout: LayoutRule[];
  } {
    const runtime = this.runtimes.get(appId);
    if (!runtime) return { enabled: false, cosmetic: [], networkPatterns: [], layout: [] };
    const enabled = this.settings.enabled && runtime.app.enabled;
    const patterns: string[] = [];
    if (enabled) {
      if (this.settings.hideKnownAdDomains) patterns.push(...AD_DOMAINS);
      if (this.settings.blockAnalytics) patterns.push(...ANALYTICS_DOMAINS);
      for (const rule of runtime.app.networkRules) {
        if (rule.enabled) patterns.push(rule.pattern);
      }
    }
    const cosmetic = enabled
      ? runtime.app.cosmeticRules.filter((rule) => rule.enabled).map((rule) => ({ ...rule }))
      : [];
    const layout = enabled
      ? runtime.app.layoutRules.filter((rule) => rule.enabled).map((rule) => ({
          ...rule,
          declarations: { ...rule.declarations },
        }))
      : [];
    return { enabled, cosmetic, networkPatterns: patterns, layout };
  }

  private async probeInspectorEndpoint(port: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1200);
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/json/list', {
          signal: controller.signal,
        });
        if (response.ok) {
          const list = await response.json();
          if (Array.isArray(list) && list.length > 0) return true;
        }
      } catch {
        // Inspector not reachable yet.
      } finally {
        clearTimeout(timer);
      }
      await sleep(200);
    }
    return false;
  }

  private async cdpCoversVisibleWindow(debugPort: number): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1800);
    try {
      const response = await fetch('http://127.0.0.1:' + debugPort + '/json/list', {
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const list = await response.json();
      if (!Array.isArray(list)) return false;
      return list.some(
        (target) =>
          target &&
          target.type === 'page' &&
          isNormalCdpPageUrl(String(target.url ?? '')),
      );
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async connectEngine(runtime: Runtime, port: number): Promise<void> {
    let inspectorPort: number | undefined;
    if (runtime.app.inspectPort !== undefined) {
      const covered = await this.cdpCoversVisibleWindow(port);
      if (!covered && (await this.probeInspectorEndpoint(runtime.app.inspectPort, 1500))) {
        inspectorPort = runtime.app.inspectPort;
      }
    }
    const engineOptions = {
      appId: runtime.app.id,
      injectedScript: this.injectedScript(),
      getConfig: () => this.configFor(runtime.app.id),
      onEvent: (event: EngineEvent) => this.handleEngineEvent(runtime, event),
    };
    const engine = inspectorPort !== undefined
      ? createCombinedEngine({ ...engineOptions, inspectorPort })
      : createEngine(engineOptions);
    try {
      const info = await engine.connect(port);
      runtime.engine = engine;
      runtime.electronVersion = info.electronVersion;
      runtime.pages = info.pages;
      runtime.status = 'attached';
      runtime.lastError = undefined;
      runtime.canAttach = true;
    } catch (error) {
      try {
        await engine.disconnect();
      } catch {
        // Ignore cleanup errors.
      }
      throw error;
    }
    try {
      await engine.updateFilters();
    } catch {
      // Filters can be applied on the next event.
    }
  }

  private async tryAttach(runtime: Runtime): Promise<boolean> {
    const candidates: number[] = [];
    if (runtime.app.debugPort) candidates.push(runtime.app.debugPort);
    try {
      const found = await findDebugPortForApp(runtime.effectiveExePath ?? runtime.app.exePath);
      if (found) candidates.push(found);
    } catch {
      // No listening endpoint found.
    }
    const unique = [...new Set(candidates)];
    for (const port of unique) {
      try {
        const info = await probeDebugEndpoint(port, 800);
        if (!info) continue;
        runtime.app.debugPort = port;
        await this.persist();
        await this.connectEngine(runtime, port);
        return true;
      } catch {
        // Try the next candidate port.
      }
    }
    return false;
  }

  async launchApp(appId: string): Promise<AppView> {
    const runtime = this.getRuntime(appId);
    if (runtime.engine?.connected) return this.toView(runtime);

    const existing = await this.processesForRuntime(runtime);
    if (existing.length > 0) {
      const attached = await this.tryAttach(runtime);
      if (attached) {
        this.emitApp(runtime);
        return this.toView(runtime);
      }
      runtime.lastError =
        'This app is already running. Use Relaunch to restart it with ad blocking.';
      runtime.status = 'error';
      this.emitApp(runtime);
      throw new Error(runtime.lastError);
    }

    runtime.status = 'launching';
    runtime.lastError = undefined;
    this.emitApp(runtime);

    let port: number;
    try {
      port = await allocateDebugPort(runtime.app.debugPort);
    } catch (error) {
      runtime.status = 'error';
      runtime.lastError = 'Could not find a free debugging port.';
      this.emitApp(runtime);
      throw new Error(runtime.lastError);
    }
    runtime.app.debugPort = port;
    let inspectPort: number | undefined;
    try {
      inspectPort = await allocateDebugPort(port + 1);
    } catch {
      inspectPort = undefined;
    }
    if (inspectPort !== undefined) runtime.app.inspectPort = inspectPort;
    await this.persist();

    const launchArgs = [...runtime.app.shortcutArgs];
    if (inspectPort !== undefined) launchArgs.push('--inspect=' + String(inspectPort));

    try {
      runtime.managedPid = await launchExecutable(
        runtime.app.exePath,
        launchArgs,
        port,
      );
    } catch (error) {
      runtime.status = 'error';
      runtime.lastError =
        'Could not launch ' + runtime.app.name + ': ' + (error instanceof Error ? error.message : String(error));
      this.emitApp(runtime);
      throw new Error(runtime.lastError);
    }
    runtime.launchedByUs = true;
    runtime.app.lastOpenedAt = Date.now();
    await this.persist();

    const ready = await waitForDebugEndpoint(port, LAUNCH_TIMEOUT_MS);
    if (inspectPort !== undefined) await this.waitForInspectorPort(inspectPort, 12_000);
    if (!ready) {
      runtime.status = 'error';
      runtime.lastError =
        runtime.app.name + ' did not expose a debugging port within 30 seconds.';
      this.emitApp(runtime);
      throw new Error(runtime.lastError);
    }

    try {
      await this.connectEngine(runtime, port);
    } catch (error) {
      runtime.status = 'error';
      runtime.lastError =
        'Could not attach to ' + runtime.app.name + ': ' + (error instanceof Error ? error.message : String(error));
      this.emitApp(runtime);
      throw new Error(runtime.lastError);
    }

    this.emitApp(runtime);
    this.emit({
      type: 'toast',
      level: 'success',
      message: runtime.app.name + ' attached with ad blocking',
      appId,
    });
    return this.toView(runtime);
  }

  async attachApp(appId: string): Promise<AppView> {
    const runtime = this.getRuntime(appId);
    if (runtime.engine?.connected) return this.toView(runtime);
    const attached = await this.tryAttach(runtime);
    if (!attached) {
      const processes = await this.processesFor(runtime.app.exePath);
      runtime.status = processes.length > 0 ? 'running' : 'not-running';
      runtime.lastError =
        'No remote debugging endpoint found. Relaunch ' + runtime.app.name + ' through Electron Adblock.';
      this.emitApp(runtime);
      throw new Error(runtime.lastError);
    }
    this.emitApp(runtime);
    this.emit({ type: 'toast', level: 'success', message: runtime.app.name + ' attached', appId });
    return this.toView(runtime);
  }

  async relaunchApp(appId: string): Promise<AppView> {
    const runtime = this.getRuntime(appId);
    await this.detachEngine(runtime);
    const processes = await this.processesForRuntime(runtime);
    if (processes.length > 0) {
      try {
        await closeProcesses(
          processes.map((process) => process.pid),
          6500,
        );
      } catch {
        // Fall through to the launch attempt.
      }
      await this.waitForNoRuntimeProcesses(runtime, 7000);
    }
    runtime.launchedByUs = false;
    runtime.managedPid = undefined;
    return this.launchApp(appId);
  }

  async closeApp(appId: string): Promise<AppView> {
    const runtime = this.getRuntime(appId);
    await this.detachEngine(runtime);
    const processes = await this.processesForRuntime(runtime);
    if (processes.length > 0) {
      try {
        await closeProcesses(
          processes.map((process) => process.pid),
          5000,
        );
      } catch {
        // Ignore close errors.
      }
      await this.waitForNoRuntimeProcesses(runtime, 6000);
    }
    runtime.status = 'not-running';
    runtime.runningProcessCount = 0;
    runtime.pages = 0;
    runtime.currentUrl = undefined;
    runtime.pickerActive = false;
    runtime.lastError = undefined;
    runtime.launchedByUs = false;
    runtime.managedPid = undefined;
    this.emitApp(runtime);
    return this.toView(runtime);
  }

  async detachApp(appId: string): Promise<AppView> {
    const runtime = this.getRuntime(appId);
    await this.detachEngine(runtime);
    const processes = await this.processesForRuntime(runtime);
    runtime.runningProcessCount = processes.length;
    runtime.status = processes.length > 0 ? 'running' : 'not-running';
    runtime.pages = 0;
    runtime.currentUrl = undefined;
    runtime.pickerActive = false;
    this.emitApp(runtime);
    return this.toView(runtime);
  }

  private async detachEngine(runtime: Runtime): Promise<void> {
    const engine = runtime.engine;
    runtime.engine = null;
    runtime.pickerActive = false;
    runtime.layoutEditing = false;
    runtime.canAttach = false;
    if (!engine) return;
    try {
      await engine.disconnect();
    } catch {
      // Ignore disconnect failures.
    }
  }

  async setAppEnabled(appId: string, enabled: boolean): Promise<AppView> {
    const runtime = this.getRuntime(appId);
    runtime.app.enabled = enabled;
    await this.persist();
    await this.updateEngineFilters(runtime);
    this.emitApp(runtime);
    return this.toView(runtime);
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    this.store.data.settings = { ...this.settings, ...patch };
    await this.persist();
    const settings = { ...this.settings };
    this.emit({ type: 'settings', settings });
    for (const runtime of this.runtimes.values()) await this.updateEngineFilters(runtime);
    return settings;
  }

  private async updateEngineFilters(runtime: Runtime): Promise<void> {
    if (!runtime.engine?.connected) return;
    try {
      await runtime.engine.updateFilters();
    } catch (error) {
      runtime.lastError =
        'Could not update filters: ' + (error instanceof Error ? error.message : String(error));
      this.scheduleApp(runtime);
    }
  }

  private newRuleId(prefix: string): string {
    return prefix + '-' + crypto.randomBytes(4).toString('hex');
  }

  async addCosmeticRule(appId: string, input: CosmeticRuleInput): Promise<AppView> {
    const runtime = this.getRuntime(appId);
    const selector = String(input.selector ?? '').trim();
    if (!selector) throw new Error('Selector cannot be empty');
    if (selector.length > MAX_SELECTOR) throw new Error('Selector is too long');
    const existing = runtime.app.cosmeticRules.find((rule) => rule.selector === selector);
    if (existing) {
      existing.enabled = true;
      await this.persist();
      await this.updateEngineFilters(runtime);
      this.emitApp(runtime);
      return this.toView(runtime);
    }
    const rule: CosmeticRule = {
      id: this.newRuleId('cr'),
      selector,
      urlPattern: input.urlPattern?.trim() || undefined,
      label: input.label?.trim() || undefined,
      enabled: true,
      source: input.source ?? 'manual',
      createdAt: Date.now(),
    };
    runtime.app.cosmeticRules.push(rule);
    await this.persist();
    await this.updateEngineFilters(runtime);
    this.emitApp(runtime);
    this.emit({ type: 'toast', level: 'success', message: 'Hide rule added', appId });
    return this.toView(runtime);
  }

  async updateCosmeticRule(
    appId: string,
    ruleId: string,
    patch: CosmeticRulePatch,
  ): Promise<AppView> {
    const runtime = this.getRuntime(appId);
    const rule = runtime.app.cosmeticRules.find((item) => item.id === ruleId);
    if (!rule) throw new Error('Unknown hide rule: ' + ruleId);
    if (patch.selector !== undefined) {
      const selector = patch.selector.trim();
      if (!selector) throw new Error('Selector cannot be empty');
      if (selector.length > MAX_SELECTOR) throw new Error('Selector is too long');
      rule.selector = selector;
    }
    if (patch.urlPattern !== undefined) {
      rule.urlPattern = patch.urlPattern.trim() || undefined;
    }
    if (patch.label !== undefined) rule.label = patch.label.trim() || undefined;
    if (patch.enabled !== undefined) rule.enabled = patch.enabled;
    await this.persist();
    await this.updateEngineFilters(runtime);
    this.emitApp(runtime);
    return this.toView(runtime);
  }

  async removeCosmeticRule(appId: string, ruleId: string): Promise<AppView> {
    const runtime = this.getRuntime(appId);
    runtime.app.cosmeticRules = runtime.app.cosmeticRules.filter((rule) => rule.id !== ruleId);
    await this.persist();
    await this.updateEngineFilters(runtime);
    this.emitApp(runtime);
    return this.toView(runtime);
  }

  async addNetworkRule(appId: string, pattern: string): Promise<AppView> {
    const runtime = this.getRuntime(appId);
    const cleaned = String(pattern ?? '').trim();
    if (!cleaned) throw new Error('Pattern cannot be empty');
    if (cleaned.length > MAX_PATTERN) throw new Error('Pattern is too long');
    if (/\s/.test(cleaned)) throw new Error('Pattern cannot contain spaces');
    const existing = runtime.app.networkRules.find((rule) => rule.pattern === cleaned);
    if (existing) {
      existing.enabled = true;
    } else {
      const rule: NetworkRule = {
        id: this.newRuleId('nr'),
        pattern: cleaned,
        enabled: true,
        source: 'manual',
        createdAt: Date.now(),
      };
      runtime.app.networkRules.push(rule);
    }
    await this.persist();
    await this.updateEngineFilters(runtime);
    this.emitApp(runtime);
    return this.toView(runtime);
  }

  async updateNetworkRule(
    appId: string,
    ruleId: string,
    patch: NetworkRulePatch,
  ): Promise<AppView> {
    const runtime = this.getRuntime(appId);
    const rule = runtime.app.networkRules.find((item) => item.id === ruleId);
    if (!rule) throw new Error('Unknown network rule: ' + ruleId);
    if (patch.pattern !== undefined) {
      const cleaned = patch.pattern.trim();
      if (!cleaned) throw new Error('Pattern cannot be empty');
      if (cleaned.length > MAX_PATTERN) throw new Error('Pattern is too long');
      rule.pattern = cleaned;
    }
    if (patch.enabled !== undefined) rule.enabled = patch.enabled;
    await this.persist();
    await this.updateEngineFilters(runtime);
    this.emitApp(runtime);
    return this.toView(runtime);
  }

  async removeNetworkRule(appId: string, ruleId: string): Promise<AppView> {
    const runtime = this.getRuntime(appId);
    runtime.app.networkRules = runtime.app.networkRules.filter((rule) => rule.id !== ruleId);
    await this.persist();
    await this.updateEngineFilters(runtime);
    this.emitApp(runtime);
    return this.toView(runtime);
  }

  async startPicker(appId: string): Promise<AppView> {
    const runtime = this.getRuntime(appId);
    if (!runtime.engine?.connected) {
      throw new Error('Attach ' + runtime.app.name + ' before picking elements');
    }
    const engine = runtime.engine;
    runtime.pickerActive = true;
    runtime.pendingPicked = 0;
    this.emitApp(runtime);
    this.emit({ type: 'picker', appId, active: true, picked: 0 });
    try {
      await engine.startPicker();
    } catch (error) {
      runtime.pickerActive = false;
      this.emitApp(runtime);
      this.emit({ type: 'picker', appId, active: false, picked: 0 });
      throw error;
    }
    return this.toView(runtime);
  }

  async stopPicker(appId: string): Promise<AppView> {
    const runtime = this.getRuntime(appId);
    const engine = runtime.engine;
    runtime.pickerActive = false;
    if (engine?.connected) {
      try {
        await engine.stopPicker();
      } catch {
        // Ignore stop failures.
      }
    }
    this.emitApp(runtime);
    this.emit({ type: 'picker', appId, active: false, picked: runtime.pendingPicked });
    return this.toView(runtime);
  }

  async scanForAds(appId: string): Promise<AdCandidate[]> {
    const runtime = this.getRuntime(appId);
    if (!runtime.engine?.connected) {
      throw new Error('Attach ' + runtime.app.name + ' before scanning for ads');
    }
    return runtime.engine.scanForAds();
  }

  async resetAppearance(appId: string): Promise<AppView> {
    const runtime = this.getRuntime(appId);
    const engine = runtime.engine;
    if (runtime.layoutEditing && engine?.connected) {
      try {
        await engine.stopLayoutEditor();
      } catch {
        // Ignore stop failures before reset.
      }
    }
    if (runtime.pickerActive && engine?.connected) {
      try {
        await engine.stopPicker();
      } catch {
        // Ignore stop failures before reset.
      }
    }
    runtime.layoutEditing = false;
    runtime.pickerActive = false;
    const removed = runtime.app.cosmeticRules.length + runtime.app.layoutRules.length;
    runtime.app.cosmeticRules = [];
    runtime.app.layoutRules = [];
    await this.persist();
    await this.updateEngineFilters(runtime);
    this.emitApp(runtime);
    this.emit({
      type: 'toast',
      level: 'success',
      message:
        removed === 0
          ? 'Nothing to reset in ' + runtime.app.name
          : 'Restored original appearance in ' + runtime.app.name + ' (' + removed + ' rule' + (removed === 1 ? '' : 's') + ' removed)',
      appId,
    });
    return this.toView(runtime);
  }

  async startLayoutEditor(appId: string): Promise<AppView> {
    const runtime = this.getRuntime(appId);
    if (!runtime.engine?.connected) {
      throw new Error('Attach ' + runtime.app.name + ' before adjusting its layout');
    }
    const engine = runtime.engine;
    runtime.layoutEditing = true;
    this.emitApp(runtime);
    this.emit({ type: 'layout', appId, active: true });
    try {
      await engine.startLayoutEditor();
    } catch (error) {
      runtime.layoutEditing = false;
      this.emitApp(runtime);
      this.emit({ type: 'layout', appId, active: false });
      throw error;
    }
    return this.toView(runtime);
  }

  async stopLayoutEditor(appId: string): Promise<AppView> {
    const runtime = this.getRuntime(appId);
    const engine = runtime.engine;
    runtime.layoutEditing = false;
    if (engine?.connected) {
      try {
        await engine.stopLayoutEditor();
      } catch {
        // Ignore stop failures.
      }
    }
    this.emitApp(runtime);
    this.emit({ type: 'layout', appId, active: false });
    return this.toView(runtime);
  }

  private findLayoutRule(runtime: Runtime, selector: string): LayoutRule | undefined {
    return runtime.app.layoutRules.find((rule) => rule.selector === selector);
  }

  async addLayoutRule(appId: string, input: LayoutRuleInput): Promise<AppView> {
    const runtime = this.getRuntime(appId);
    const selector = String(input.selector ?? '').trim();
    if (!selector) throw new Error('Selector cannot be empty');
    if (selector.length > MAX_SELECTOR) throw new Error('Selector is too long');
    const declarations = sanitizeLayoutDeclarations(input.declarations);
    if (Object.keys(declarations).length === 0) {
      throw new Error('Add at least one supported CSS declaration');
    }
    const existing = this.findLayoutRule(runtime, selector);
    if (existing) {
      existing.declarations = { ...existing.declarations, ...declarations };
      existing.enabled = true;
    } else {
      const rule: LayoutRule = {
        id: this.newRuleId('lr'),
        selector,
        declarations,
        label: input.label?.trim() || undefined,
        enabled: true,
        source: input.source ?? 'manual',
        createdAt: Date.now(),
      };
      runtime.app.layoutRules.push(rule);
    }
    await this.persist();
    await this.updateEngineFilters(runtime);
    this.emitApp(runtime);
    this.emit({ type: 'toast', level: 'success', message: 'Layout rule saved', appId });
    return this.toView(runtime);
  }

  async updateLayoutRule(
    appId: string,
    ruleId: string,
    patch: LayoutRulePatch,
  ): Promise<AppView> {
    const runtime = this.getRuntime(appId);
    const rule = runtime.app.layoutRules.find((item) => item.id === ruleId);
    if (!rule) throw new Error('Unknown layout rule: ' + ruleId);
    if (patch.selector !== undefined) {
      const selector = patch.selector.trim();
      if (!selector) throw new Error('Selector cannot be empty');
      if (selector.length > MAX_SELECTOR) throw new Error('Selector is too long');
      rule.selector = selector;
    }
    if (patch.declarations !== undefined) {
      const declarations = sanitizeLayoutDeclarations(patch.declarations);
      if (Object.keys(declarations).length === 0) {
        throw new Error('Add at least one supported CSS declaration');
      }
      rule.declarations = declarations;
    }
    if (patch.label !== undefined) rule.label = patch.label.trim() || undefined;
    if (patch.enabled !== undefined) rule.enabled = patch.enabled;
    await this.persist();
    await this.updateEngineFilters(runtime);
    this.emitApp(runtime);
    return this.toView(runtime);
  }

  async removeLayoutRule(appId: string, ruleId: string): Promise<AppView> {
    const runtime = this.getRuntime(appId);
    runtime.app.layoutRules = runtime.app.layoutRules.filter((rule) => rule.id !== ruleId);
    await this.persist();
    await this.updateEngineFilters(runtime);
    this.emitApp(runtime);
    return this.toView(runtime);
  }

  private async handleLayoutReport(runtime: Runtime, report: LayoutReport): Promise<void> {
    const selector = String(report.selector ?? '').trim();
    if (!selector || selector.length > MAX_SELECTOR) return;
    const declarations = sanitizeLayoutDeclarations(report.declarations);
    if (Object.keys(declarations).length === 0) return;
    let rule = this.findLayoutRule(runtime, selector);
    if (rule) {
      rule.declarations = { ...rule.declarations, ...declarations };
      rule.enabled = true;
    } else {
      rule = {
        id: this.newRuleId('lr'),
        selector,
        declarations,
        label: report.label ? report.label.slice(0, 120) : undefined,
        enabled: true,
        source: 'layout',
        createdAt: Date.now(),
      };
      runtime.app.layoutRules.push(rule);
    }
    runtime.layoutEditing = false;
    await this.persist();
    await this.updateEngineFilters(runtime);
    const matches = Math.max(1, report.matches || 1);
    this.emit({ type: 'layout', appId: runtime.app.id, active: false, rule: { ...rule }, matches });
    this.emit({
      type: 'toast',
      level: 'success',
      message: 'Layout adjusted for ' + matches + ' element(s) in ' + runtime.app.name,
      appId: runtime.app.id,
    });
    this.scheduleApp(runtime);
  }

  async getBlockedLog(appId: string): Promise<BlockedEvent[]> {
    return (this.logs.get(appId) ?? []).slice(0, MAX_LOG);
  }

  async clearBlockedLog(appId: string): Promise<void> {
    this.logs.set(appId, []);
  }

  private recordBlocked(runtime: Runtime, entry: BlockedEvent): void {
    const log = this.logs.get(runtime.app.id) ?? [];
    log.unshift({ ...entry, appId: runtime.app.id });
    if (log.length > MAX_LOG) log.length = MAX_LOG;
    this.logs.set(runtime.app.id, log);
    runtime.stats.lastBlockedAt = entry.at;
    this.emit({ type: 'log', appId: runtime.app.id, entry: { ...entry, appId: runtime.app.id } });
    this.scheduleApp(runtime);
  }

  private async handlePick(runtime: Runtime, report: PickReport): Promise<void> {
    const selector = String(report.selector ?? '').trim();
    if (!selector || selector.length > MAX_SELECTOR) return;
    let rule = runtime.app.cosmeticRules.find((item) => item.selector === selector);
    if (rule) {
      rule.enabled = true;
    } else {
      rule = {
        id: this.newRuleId('cr'),
        selector,
        label: report.label ? report.label.slice(0, 120) : undefined,
        enabled: true,
        source: 'picker',
        createdAt: Date.now(),
      };
      runtime.app.cosmeticRules.push(rule);
    }
    await this.persist();
    await this.updateEngineFilters(runtime);
    const matchCount = Math.max(1, report.matchCount || 1);
    this.emit({ type: 'picked', appId: runtime.app.id, rule: { ...rule }, matchCount });
    this.emit({
      type: 'toast',
      level: 'success',
      message: 'Hidden ' + matchCount + ' element(s) in ' + runtime.app.name,
      appId: runtime.app.id,
    });
    this.scheduleApp(runtime);
  }

  private notePageUrl(runtime: Runtime, url: string | undefined): void {
    if (!url) return;
    const lower = url.toLowerCase();
    if (
      lower.includes('/adview') ||
      lower.includes('overwolf.com/monsdk') ||
      lower.includes('ow-cmp') ||
      lower.includes('offline.html') ||
      lower.includes('offline_overlay') ||
      lower === 'about:blank'
    ) {
      return;
    }
    runtime.currentUrl = url;
  }

  private isTransientEngineError(message: string): boolean {
    return /no target with given id|target closed|no session with given id|session with given id not found|cannot find context|detached from target|could not attach to page target/i.test(
      message,
    );
  }

  private handleEngineEvent(runtime: Runtime, event: EngineEvent): void {
    switch (event.type) {
      case 'stats':
        runtime.stats = { ...event.stats };
        runtime.pages = event.stats.pages;
        if (event.stats.lastPageUrl) this.notePageUrl(runtime, event.stats.lastPageUrl);
        this.scheduleApp(runtime);
        break;
      case 'blocked':
        this.recordBlocked(runtime, event.entry);
        break;
      case 'page':
        runtime.pages = event.pages;
        this.notePageUrl(runtime, event.url);
        this.scheduleApp(runtime);
        break;
      case 'picker':
        runtime.pickerActive = event.active;
        runtime.pendingPicked = event.picked;
        this.emit({
          type: 'picker',
          appId: runtime.app.id,
          active: event.active,
          picked: event.picked,
        });
        if (!event.active) this.scheduleApp(runtime);
        break;
      case 'picked':
        void this.handlePick(runtime, event.report);
        break;
      case 'layout':
        void this.handleLayoutReport(runtime, event.report);
        break;
      case 'layout-editor':
        runtime.layoutEditing = event.active;
        this.emit({ type: 'layout', appId: runtime.app.id, active: event.active });
        this.scheduleApp(runtime);
        break;
      case 'connected':
        runtime.status = 'attached';
        runtime.canAttach = true;
        this.scheduleApp(runtime);
        break;
      case 'disconnected':
        runtime.pickerActive = false;
        runtime.layoutEditing = false;
        runtime.pages = 0;
        runtime.status = runtime.runningProcessCount > 0 ? 'running' : 'not-running';
        this.scheduleApp(runtime);
        break;
      case 'error':
        if (!this.isTransientEngineError(event.message)) {
          runtime.lastError = event.message;
          this.emit({ type: 'toast', level: 'error', message: event.message, appId: runtime.app.id });
          this.scheduleApp(runtime);
        }
        break;
      default:
        break;
    }
  }
}
