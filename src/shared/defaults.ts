import type { PersistedState, Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  hideKnownAdDomains: true,
  blockAnalytics: false,
  minimizeToTray: true,
  launchAtLogin: false,
  closeManagedAppsOnQuit: false,
  pickerHotkey: 'CommandOrControl+Shift+E',
};

export function createDefaultState(): PersistedState {
  return {
    schemaVersion: 1,
    settings: { ...DEFAULT_SETTINGS },
    apps: [],
  };
}
