export type AppSource = 'start-menu' | 'running' | 'manual' | 'preset';

export type AppStatus = 'not-running' | 'running' | 'launching' | 'attached' | 'error';

export type CosmeticRuleSource = 'picker' | 'manual' | 'suggestion' | 'preset';

export type NetworkRuleSource = 'manual' | 'preset' | 'default';

export interface CosmeticRule {
  id: string;
  selector: string;
  urlPattern?: string;
  label?: string;
  enabled: boolean;
  source: CosmeticRuleSource;
  createdAt: number;
}

export type LayoutRuleSource = 'layout' | 'manual' | 'preset';

export interface LayoutRule {
  id: string;
  selector: string;
  declarations: Record<string, string>;
  label?: string;
  enabled: boolean;
  source: LayoutRuleSource;
  createdAt: number;
}

export interface LayoutRuleInput {
  selector: string;
  declarations: Record<string, string>;
  label?: string;
  source?: LayoutRuleSource;
}

export interface LayoutRulePatch {
  selector?: string;
  declarations?: Record<string, string>;
  label?: string;
  enabled?: boolean;
}

export interface LayoutReport {
  selector: string;
  declarations: Record<string, string>;
  label: string;
  frameUrl: string;
  matches: number;
}

export interface NetworkRule {
  id: string;
  pattern: string;
  enabled: boolean;
  source: NetworkRuleSource;
  createdAt: number;
}

export interface AppStats {
  blockedRequests: number;
  hiddenElements: number;
  pages: number;
  lastBlockedAt?: number;
  lastPageUrl?: string;
}

export interface BlockedEvent {
  appId: string;
  url: string;
  pageUrl?: string;
  at: number;
}

export interface AdCandidate {
  selector: string;
  tag: string;
  reason: string;
  matchCount: number;
  width: number;
  height: number;
}

export interface AppView {
  id: string;
  name: string;
  exePath: string;
  source: AppSource;
  status: AppStatus;
  attached: boolean;
  enabled: boolean;
  debugPort?: number;
  electronVersion?: string;
  pages: number;
  currentUrl?: string;
  runningProcessCount: number;
  canAttach: boolean;
  pickerActive: boolean;
  lastError?: string;
  stats: AppStats;
  cosmeticRules: CosmeticRule[];
  networkRules: NetworkRule[];
  layoutRules: LayoutRule[];
  layoutEditing: boolean;
  iconDataUrl?: string;
}

export interface Settings {
  enabled: boolean;
  hideKnownAdDomains: boolean;
  blockAnalytics: boolean;
  minimizeToTray: boolean;
  launchAtLogin: boolean;
  closeManagedAppsOnQuit: boolean;
  pickerHotkey: string;
}

export interface VersionInfo {
  app: string;
  electron: string;
  chrome: string;
  node: string;
}

export interface BootstrapState {
  settings: Settings;
  apps: AppView[];
  version: VersionInfo;
  dataDir: string;
  devMode: boolean;
  packaged: boolean;
}

export interface CosmeticRuleInput {
  selector: string;
  urlPattern?: string;
  label?: string;
  source?: CosmeticRuleSource;
}

export interface CosmeticRulePatch {
  selector?: string;
  urlPattern?: string;
  label?: string;
  enabled?: boolean;
}

export interface NetworkRulePatch {
  pattern?: string;
  enabled?: boolean;
}

export type AppEvent =
  | { type: 'apps'; apps: AppView[] }
  | { type: 'app'; app: AppView }
  | { type: 'settings'; settings: Settings }
  | { type: 'picker'; appId: string; active: boolean; picked: number }
  | { type: 'picked'; appId: string; rule: CosmeticRule; matchCount: number }
  | { type: 'layout'; appId: string; active: boolean; rule?: LayoutRule; matches?: number }
  | { type: 'toast'; level: 'info' | 'success' | 'error'; message: string; appId?: string }
  | { type: 'log'; appId: string; entry: BlockedEvent }
  | { type: 'error'; appId?: string; message: string };

export interface AdblockApi {
  getBootstrap(): Promise<BootstrapState>;
  refresh(): Promise<AppView[]>;
  browseForExecutable(): Promise<string | null>;
  listDetectedApps(): Promise<DiscoveredApp[]>;
  addApp(exePath: string): Promise<AppView>;
  removeApp(appId: string): Promise<AppView[]>;
  launchApp(appId: string): Promise<AppView>;
  attachApp(appId: string): Promise<AppView>;
  relaunchApp(appId: string): Promise<AppView>;
  closeApp(appId: string): Promise<AppView>;
  detachApp(appId: string): Promise<AppView>;
  setAppEnabled(appId: string, enabled: boolean): Promise<AppView>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  addCosmeticRule(appId: string, input: CosmeticRuleInput): Promise<AppView>;
  updateCosmeticRule(appId: string, ruleId: string, patch: CosmeticRulePatch): Promise<AppView>;
  removeCosmeticRule(appId: string, ruleId: string): Promise<AppView>;
  addNetworkRule(appId: string, pattern: string): Promise<AppView>;
  updateNetworkRule(appId: string, ruleId: string, patch: NetworkRulePatch): Promise<AppView>;
  removeNetworkRule(appId: string, ruleId: string): Promise<AppView>;
  startPicker(appId: string): Promise<AppView>;
  stopPicker(appId: string): Promise<AppView>;
  scanForAds(appId: string): Promise<AdCandidate[]>;
  startLayoutEditor(appId: string): Promise<AppView>;
  stopLayoutEditor(appId: string): Promise<AppView>;
  addLayoutRule(appId: string, input: LayoutRuleInput): Promise<AppView>;
  updateLayoutRule(appId: string, ruleId: string, patch: LayoutRulePatch): Promise<AppView>;
  removeLayoutRule(appId: string, ruleId: string): Promise<AppView>;
  getBlockedLog(appId: string): Promise<BlockedEvent[]>;
  clearBlockedLog(appId: string): Promise<void>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}

export interface DiscoveredApp {
  exePath: string;
  name: string;
  source: AppSource;
  shortcutArgs: string[];
}

export interface ProcessInfo {
  pid: number;
  name: string;
  exePath?: string;
}

export interface PersistedApp {
  id: string;
  name: string;
  exePath: string;
  shortcutArgs: string[];
  source: AppSource;
  enabled: boolean;
  debugPort?: number;
  addedAt: number;
  lastOpenedAt?: number;
  cosmeticRules: CosmeticRule[];
  networkRules: NetworkRule[];
  layoutRules: LayoutRule[];
}

export interface PersistedState {
  schemaVersion: 1;
  settings: Settings;
  apps: PersistedApp[];
}

export interface DebugEndpointInfo {
  port: number;
  electronVersion?: string;
  targetCount: number;
}

export interface EngineConnectResult {
  electronVersion?: string;
  pages: number;
}

export interface EngineFilterConfig {
  enabled: boolean;
  cosmetic: CosmeticRule[];
  networkPatterns: string[];
  layout: LayoutRule[];
}

export interface PickReport {
  selector: string;
  label: string;
  matchCount: number;
  frameUrl: string;
  tag: string;
  width: number;
  height: number;
}

export type EngineEvent =
  | { type: 'connected'; port: number; electronVersion?: string; pages: number }
  | { type: 'disconnected'; reason?: string }
  | { type: 'stats'; stats: AppStats }
  | { type: 'blocked'; entry: BlockedEvent }
  | { type: 'page'; url: string; pages: number }
  | { type: 'picker'; active: boolean; picked: number }
  | { type: 'picked'; report: PickReport }
  | { type: 'layout'; report: LayoutReport }
  | { type: 'layout-editor'; active: boolean }
  | { type: 'error'; message: string };

export interface EngineOptions {
  appId: string;
  injectedScript: string;
  getConfig: () => EngineFilterConfig;
  onEvent: (event: EngineEvent) => void;
}

export interface Engine {
  readonly connected: boolean;
  connect(port: number): Promise<EngineConnectResult>;
  disconnect(): Promise<void>;
  updateFilters(): Promise<void>;
  startPicker(): Promise<void>;
  stopPicker(): Promise<void>;
  scanForAds(): Promise<AdCandidate[]>;
  startLayoutEditor(): Promise<void>;
  stopLayoutEditor(): Promise<void>;
  stats(): AppStats;
}

export const INJECTED_BINDING = '__electronAdblockReport';
export const INJECTED_GLOBAL = '__electronAdblock';
