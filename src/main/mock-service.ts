import { DEFAULT_SETTINGS } from '../shared/defaults';
import type {
  AdCandidate,
  AppEvent,
  AppView,
  BlockedEvent,
  BootstrapState,
  CosmeticRule,
  CosmeticRuleInput,
  CosmeticRulePatch,
  NetworkRule,
  NetworkRulePatch,
  Settings,
} from '../shared/types';
import type { ServiceApi, ServiceEnv } from './service-contract';

function view(partial: Partial<AppView> & Pick<AppView, 'id' | 'name' | 'exePath'>): AppView {
  return {
    source: 'start-menu',
    status: 'not-running',
    attached: false,
    enabled: true,
    pages: 0,
    runningProcessCount: 0,
    canAttach: false,
    pickerActive: false,
    stats: { blockedRequests: 0, hiddenElements: 0, pages: 0 },
    cosmeticRules: [],
    networkRules: [],
    ...partial,
  };
}

function cosmeticRule(
  id: string,
  selector: string,
  label: string,
  source: CosmeticRule['source'] = 'picker',
): CosmeticRule {
  return { id, selector, label, enabled: true, source, createdAt: Date.now() };
}

function networkRule(id: string, pattern: string): NetworkRule {
  return { id, pattern, enabled: true, source: 'manual', createdAt: Date.now() };
}

export class MockService implements ServiceApi {
  private sink: (event: AppEvent) => void = () => {};
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private apps: AppView[];
  private log: BlockedEvent[] = [];
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private pickedSinceStart = 0;

  constructor(private readonly env: ServiceEnv) {
    const now = Date.now();
    this.apps = [
      view({
        id: 'opgg',
        name: 'OP.GG',
        exePath: 'C:\\Users\\hoyul\\AppData\\Local\\Programs\\OP.GG\\OP.GG.exe',
        source: 'start-menu',
        status: 'attached',
        attached: true,
        debugPort: 9501,
        electronVersion: '34.3.3',
        pages: 3,
        currentUrl: 'https://www.op.gg/desktop/home',
        runningProcessCount: 16,
        canAttach: true,
        stats: {
          blockedRequests: 248,
          hiddenElements: 6,
          pages: 3,
          lastBlockedAt: now - 9000,
          lastPageUrl: 'https://www.op.gg/desktop/home',
        },
        cosmeticRules: [
          cosmeticRule('r-opgg-1', 'aside[class*="ad"]', 'Right rail ad'),
          cosmeticRule('r-opgg-2', 'div[class*="sponsor"]', 'Sponsored card'),
        ],
        networkRules: [networkRule('n-opgg-1', 'adfit.kakao.com')],
      }),
      view({
        id: 'discord',
        name: 'Discord',
        exePath: 'C:\\Users\\hoyul\\AppData\\Local\\Discord\\Update.exe',
        source: 'running',
        status: 'running',
        runningProcessCount: 1,
        canAttach: false,
        stats: { blockedRequests: 0, hiddenElements: 0, pages: 0, lastPageUrl: 'https://discord.com/app' },
      }),
      view({
        id: 'kimi',
        name: 'Kimi',
        exePath: 'C:\\Users\\hoyul\\AppData\\Local\\Programs\\kimi-desktop\\Kimi.exe',
        source: 'start-menu',
        stats: { blockedRequests: 0, hiddenElements: 0, pages: 0 },
      }),
      view({
        id: 'antigravity',
        name: 'Antigravity',
        exePath: 'C:\\Users\\hoyul\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe',
        source: 'start-menu',
        status: 'running',
        runningProcessCount: 1,
        canAttach: false,
        stats: { blockedRequests: 0, hiddenElements: 0, pages: 0 },
      }),
    ];

    for (let index = 0; index < 9; index += 1) {
      this.log.push({
        appId: 'opgg',
        url: 'https://ad.doubleclick.net/ddm/adj/' + (9000 + index),
        pageUrl: 'https://www.op.gg/desktop/home',
        at: now - index * 6100,
      });
    }

    this.timers.push(
      setInterval(() => {
        const attached = this.apps.find((item) => item.attached);
        if (!attached) return;
        attached.stats.blockedRequests += 1;
        attached.stats.lastBlockedAt = Date.now();
        const entry: BlockedEvent = {
          appId: attached.id,
          url: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle' + Math.floor(Math.random() * 1000),
          pageUrl: attached.currentUrl,
          at: Date.now(),
        };
        this.log.unshift(entry);
        this.log = this.log.slice(0, 200);
        this.emit({ type: 'log', appId: attached.id, entry });
        this.emit({ type: 'app', app: attached });
      }, 5200),
    );
  }

  async init(): Promise<void> {}

  async dispose(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  setEventSink(sink: (event: AppEvent) => void): void {
    this.sink = sink;
  }

  getEnv(): ServiceEnv {
    return this.env;
  }

  private emit(event: AppEvent): void {
    this.sink(event);
  }

  private find(appId: string): AppView {
    const app = this.apps.find((item) => item.id === appId);
    if (!app) throw new Error('Unknown app: ' + appId);
    return app;
  }

  async getBootstrap(): Promise<BootstrapState> {
    return {
      settings: { ...this.settings },
      apps: this.apps,
      version: this.env.version,
      dataDir: this.env.dataDir,
      devMode: this.env.devMode,
      packaged: this.env.packaged,
    };
  }

  async refresh(): Promise<AppView[]> {
    return this.apps;
  }

  async addApp(exePath: string): Promise<AppView> {
    const name = exePath.split('\\').pop()?.replace(/\.exe$/i, '') ?? 'App';
    const app = view({
      id: 'app-' + Date.now(),
      name,
      exePath,
      source: 'manual',
      enabled: true,
    });
    this.apps.push(app);
    this.emit({ type: 'apps', apps: this.apps });
    this.emit({ type: 'toast', level: 'success', message: name + ' added' });
    return app;
  }

  async removeApp(appId: string): Promise<AppView[]> {
    this.apps = this.apps.filter((item) => item.id !== appId);
    this.emit({ type: 'apps', apps: this.apps });
    return this.apps;
  }

  async launchApp(appId: string): Promise<AppView> {
    const app = this.find(appId);
    app.status = 'launching';
    app.lastError = undefined;
    this.emit({ type: 'app', app });
    setTimeout(() => {
      app.status = 'attached';
      app.attached = true;
      app.canAttach = true;
      app.debugPort = 9501;
      app.electronVersion = '44.1.1';
      app.pages = 2;
      app.runningProcessCount = 5;
      app.currentUrl = 'https://example.com/home';
      app.stats.pages = 2;
      app.stats.lastPageUrl = app.currentUrl;
      this.emit({ type: 'app', app });
      this.emit({ type: 'toast', level: 'success', message: app.name + ' attached', appId });
    }, 1200);
    return app;
  }

  async attachApp(appId: string): Promise<AppView> {
    const app = this.find(appId);
    if (!app.canAttach) {
      app.lastError = 'No remote debugging endpoint found. Relaunch the app through Electron Adblock.';
      app.status = 'running';
      this.emit({ type: 'app', app });
      return app;
    }
    app.status = 'attached';
    app.attached = true;
    app.debugPort = app.debugPort ?? 9501;
    app.pages = app.pages || 1;
    this.emit({ type: 'app', app });
    this.emit({ type: 'toast', level: 'success', message: app.name + ' attached', appId });
    return app;
  }

  async relaunchApp(appId: string): Promise<AppView> {
    const app = this.find(appId);
    app.status = 'launching';
    app.attached = false;
    this.emit({ type: 'app', app });
    return this.launchApp(appId);
  }

  async closeApp(appId: string): Promise<AppView> {
    const app = this.find(appId);
    app.status = 'not-running';
    app.attached = false;
    app.pages = 0;
    app.runningProcessCount = 0;
    app.pickerActive = false;
    this.emit({ type: 'app', app });
    return app;
  }

  async detachApp(appId: string): Promise<AppView> {
    const app = this.find(appId);
    app.attached = false;
    app.status = 'running';
    app.pages = 0;
    app.pickerActive = false;
    this.emit({ type: 'app', app });
    return app;
  }

  async setAppEnabled(appId: string, enabled: boolean): Promise<AppView> {
    const app = this.find(appId);
    app.enabled = enabled;
    this.emit({ type: 'app', app });
    return app;
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    this.settings = { ...this.settings, ...patch };
    this.emit({ type: 'settings', settings: this.settings });
    return this.settings;
  }

  async addCosmeticRule(appId: string, input: CosmeticRuleInput): Promise<AppView> {
    const app = this.find(appId);
    app.cosmeticRules.push({
      id: 'rule-' + Date.now(),
      selector: input.selector,
      urlPattern: input.urlPattern,
      label: input.label,
      enabled: true,
      source: input.source ?? 'manual',
      createdAt: Date.now(),
    });
    this.emit({ type: 'app', app });
    this.emit({ type: 'toast', level: 'success', message: 'Rule saved', appId });
    return app;
  }

  async updateCosmeticRule(
    appId: string,
    ruleId: string,
    patch: CosmeticRulePatch,
  ): Promise<AppView> {
    const app = this.find(appId);
    const rule = app.cosmeticRules.find((item) => item.id === ruleId);
    if (!rule) throw new Error('Unknown rule: ' + ruleId);
    Object.assign(rule, patch);
    this.emit({ type: 'app', app });
    return app;
  }

  async removeCosmeticRule(appId: string, ruleId: string): Promise<AppView> {
    const app = this.find(appId);
    app.cosmeticRules = app.cosmeticRules.filter((item) => item.id !== ruleId);
    this.emit({ type: 'app', app });
    return app;
  }

  async addNetworkRule(appId: string, pattern: string): Promise<AppView> {
    const app = this.find(appId);
    app.networkRules.push(networkRule('net-' + Date.now(), pattern));
    this.emit({ type: 'app', app });
    return app;
  }

  async updateNetworkRule(
    appId: string,
    ruleId: string,
    patch: NetworkRulePatch,
  ): Promise<AppView> {
    const app = this.find(appId);
    const rule = app.networkRules.find((item) => item.id === ruleId);
    if (!rule) throw new Error('Unknown network rule: ' + ruleId);
    Object.assign(rule, patch);
    this.emit({ type: 'app', app });
    return app;
  }

  async removeNetworkRule(appId: string, ruleId: string): Promise<AppView> {
    const app = this.find(appId);
    app.networkRules = app.networkRules.filter((item) => item.id !== ruleId);
    this.emit({ type: 'app', app });
    return app;
  }

  async startPicker(appId: string): Promise<AppView> {
    const app = this.find(appId);
    if (!app.attached) throw new Error(app.name + ' is not attached');
    app.pickerActive = true;
    this.pickedSinceStart = 0;
    this.emit({ type: 'app', app });
    this.emit({ type: 'picker', appId, active: true, picked: 0 });
    this.emit({
      type: 'toast',
      level: 'info',
      message: 'Click an element in ' + app.name + ' to hide it. Esc to finish.',
      appId,
    });
    setTimeout(() => {
      if (!app.pickerActive) return;
      const rule: CosmeticRule = {
        id: 'pick-' + Date.now(),
        selector: 'div[class*="ad-slot"]',
        label: 'Picked element',
        enabled: true,
        source: 'picker',
        createdAt: Date.now(),
      };
      app.cosmeticRules.push(rule);
      app.stats.hiddenElements += 2;
      this.pickedSinceStart += 1;
      this.emit({ type: 'picked', appId, rule, matchCount: 2 });
      this.emit({ type: 'app', app });
      this.emit({ type: 'picker', appId, active: true, picked: this.pickedSinceStart });
    }, 2600);
    return app;
  }

  async stopPicker(appId: string): Promise<AppView> {
    const app = this.find(appId);
    app.pickerActive = false;
    this.emit({ type: 'app', app });
    this.emit({ type: 'picker', appId, active: false, picked: this.pickedSinceStart });
    return app;
  }

  async scanForAds(appId: string): Promise<AdCandidate[]> {
    this.find(appId);
    return [
      {
        selector: 'aside[class*="ad"]',
        tag: 'aside',
        reason: 'class contains "ad"',
        matchCount: 2,
        width: 300,
        height: 250,
      },
      {
        selector: 'div[class*="sponsor"]',
        tag: 'div',
        reason: 'class contains "sponsor"',
        matchCount: 1,
        width: 728,
        height: 90,
      },
      {
        selector: 'iframe[src*="doubleclick.net"]',
        tag: 'iframe',
        reason: 'iframe points at an ad domain',
        matchCount: 1,
        width: 300,
        height: 250,
      },
    ];
  }

  async getBlockedLog(appId: string): Promise<BlockedEvent[]> {
    return this.log.filter((entry) => entry.appId === appId).slice(0, 200);
  }

  async clearBlockedLog(_appId: string): Promise<void> {
    this.log = [];
  }
}
