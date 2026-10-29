import { DEFAULT_SETTINGS } from '../shared/defaults';
import type {
  AdCandidate,
  AppEvent,
  AppView,
  BlockedEvent,
  BootstrapState,
  CosmeticRuleInput,
  CosmeticRulePatch,
  NetworkRulePatch,
  Settings,
} from '../shared/types';
import type { ServiceApi, ServiceEnv } from './service-contract';

// Real backend wiring lands here. Left minimal while the engine and app modules are built.
export class AppService implements ServiceApi {
  private sink: (event: AppEvent) => void = () => {};

  constructor(private readonly env: ServiceEnv) {}

  async init(): Promise<void> {}

  async dispose(): Promise<void> {}

  setEventSink(sink: (event: AppEvent) => void): void {
    this.sink = sink;
  }

  getEnv(): ServiceEnv {
    return this.env;
  }

  protected emit(event: AppEvent): void {
    this.sink(event);
  }

  async getBootstrap(): Promise<BootstrapState> {
    return {
      settings: { ...DEFAULT_SETTINGS },
      apps: [],
      version: this.env.version,
      dataDir: this.env.dataDir,
      devMode: this.env.devMode,
      packaged: this.env.packaged,
    };
  }

  async refresh(): Promise<AppView[]> {
    return [];
  }

  async addApp(_exePath: string): Promise<AppView> {
    throw new Error('Backend not wired yet');
  }

  async removeApp(_appId: string): Promise<AppView[]> {
    throw new Error('Backend not wired yet');
  }

  async launchApp(_appId: string): Promise<AppView> {
    throw new Error('Backend not wired yet');
  }

  async attachApp(_appId: string): Promise<AppView> {
    throw new Error('Backend not wired yet');
  }

  async relaunchApp(_appId: string): Promise<AppView> {
    throw new Error('Backend not wired yet');
  }

  async closeApp(_appId: string): Promise<AppView> {
    throw new Error('Backend not wired yet');
  }

  async detachApp(_appId: string): Promise<AppView> {
    throw new Error('Backend not wired yet');
  }

  async setAppEnabled(_appId: string, _enabled: boolean): Promise<AppView> {
    throw new Error('Backend not wired yet');
  }

  async updateSettings(_patch: Partial<Settings>): Promise<Settings> {
    throw new Error('Backend not wired yet');
  }

  async addCosmeticRule(_appId: string, _input: CosmeticRuleInput): Promise<AppView> {
    throw new Error('Backend not wired yet');
  }

  async updateCosmeticRule(
    _appId: string,
    _ruleId: string,
    _patch: CosmeticRulePatch,
  ): Promise<AppView> {
    throw new Error('Backend not wired yet');
  }

  async removeCosmeticRule(_appId: string, _ruleId: string): Promise<AppView> {
    throw new Error('Backend not wired yet');
  }

  async addNetworkRule(_appId: string, _pattern: string): Promise<AppView> {
    throw new Error('Backend not wired yet');
  }

  async updateNetworkRule(
    _appId: string,
    _ruleId: string,
    _patch: NetworkRulePatch,
  ): Promise<AppView> {
    throw new Error('Backend not wired yet');
  }

  async removeNetworkRule(_appId: string, _ruleId: string): Promise<AppView> {
    throw new Error('Backend not wired yet');
  }

  async startPicker(_appId: string): Promise<AppView> {
    throw new Error('Backend not wired yet');
  }

  async stopPicker(_appId: string): Promise<AppView> {
    throw new Error('Backend not wired yet');
  }

  async scanForAds(_appId: string): Promise<AdCandidate[]> {
    throw new Error('Backend not wired yet');
  }

  async getBlockedLog(_appId: string): Promise<BlockedEvent[]> {
    return [];
  }

  async clearBlockedLog(_appId: string): Promise<void> {}
}
