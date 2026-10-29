import type {
  AdCandidate,
  AppView,
  BlockedEvent,
  DiscoveredApp,
  CosmeticRuleInput,
  CosmeticRulePatch,
  LayoutRuleInput,
  LayoutRulePatch,
  NetworkRulePatch,
  Settings,
  VersionInfo,
} from '../../shared/types';
import type { DialogHost } from './modal';

export type AppTab = 'overview' | 'scan' | 'hidden' | 'network' | 'layout' | 'activity';
export const APP_TABS: ReadonlyArray<AppTab> = ['overview', 'scan', 'hidden', 'network', 'layout', 'activity'];
export const TAB_LABELS: Record<AppTab, string> = {
  overview: 'Overview',
  scan: 'Page scan',
  hidden: 'Hidden elements',
  network: 'Network rules',
  layout: 'Layout',
  activity: 'Activity',
};
export type ToastLevel = 'info' | 'success' | 'error';
export type AppAction = 'launch' | 'relaunch' | 'attach' | 'detach' | 'close';

export interface ScanState {
  appId: string;
  status: 'loading' | 'ready' | 'error';
  candidates: AdCandidate[];
  hiddenSelectors: string[];
  error?: string;
  startedAt: number;
}

export interface PickerState {
  appId: string;
  active: boolean;
  picked: number;
}

export interface UiState {
  phase: 'loading' | 'ready' | 'error';
  errorMessage?: string;
  settings: Settings | null;
  version: VersionInfo | null;
  dataDir: string;
  devMode: boolean;
  packaged: boolean;
  apps: AppView[];
  selectedAppId: string | null;
  view: 'app' | 'settings';
  tab: AppTab;
  logs: Record<string, BlockedEvent[]>;
  logsLoaded: Record<string, boolean>;
  scan: ScanState | null;
  picker: PickerState | null;
}

export interface Controller {
  state: UiState;
  dialogs: DialogHost;
  toast(level: ToastLevel, message: string): void;
  selectedApp(): AppView | null;
  selectApp(appId: string): void;
  setTab(tab: AppTab): void;
  openSettings(): void;
  openAppView(): void;
  refreshApplications(): Promise<void>;
  addApplication(): void;
  chooseExecutable(): Promise<string | null>;
  addAppFromPath(exePath: string): Promise<AppView | null>;
  listDetectedApps(): Promise<DiscoveredApp[] | null>;
  removeApplication(app: AppView): void;
  appAction(appId: string, action: AppAction): Promise<void>;
  setAppEnabled(appId: string, enabled: boolean): Promise<void>;
  startPicker(appId: string): Promise<void>;
  stopPicker(appId: string): Promise<void>;
  ensureScan(app: AppView): void;
  scan(appId: string): Promise<void>;
  hideCandidate(appId: string, candidate: AdCandidate): Promise<void>;
  addCosmeticRule(appId: string, input: CosmeticRuleInput): Promise<boolean>;
  updateCosmeticRule(appId: string, ruleId: string, patch: CosmeticRulePatch): Promise<void>;
  removeCosmeticRule(appId: string, ruleId: string): Promise<void>;
  addNetworkRule(appId: string, pattern: string): Promise<boolean>;
  updateNetworkRule(appId: string, ruleId: string, patch: NetworkRulePatch): Promise<void>;
  removeNetworkRule(appId: string, ruleId: string): Promise<void>;
  startLayoutEditor(appId: string): Promise<void>;
  stopLayoutEditor(appId: string): Promise<void>;
  addLayoutRule(appId: string, input: LayoutRuleInput): Promise<boolean>;
  updateLayoutRule(appId: string, ruleId: string, patch: LayoutRulePatch): Promise<void>;
  removeLayoutRule(appId: string, ruleId: string): Promise<void>;
  updateSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<boolean>;
  savePickerHotkey(value: string): Promise<boolean>;
  clearActivity(appId: string): Promise<void>;
  copyText(value: string): Promise<void>;
  loadLogs(appId: string): Promise<void>;
}