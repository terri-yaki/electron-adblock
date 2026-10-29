import { contextBridge, ipcRenderer } from 'electron';
import type { AdblockApi, AppEvent } from '../shared/types';

const IPC_CALL = 'adblock:call';
const IPC_EVENT = 'adblock:event';

function call<T>(method: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(IPC_CALL, method, args) as Promise<T>;
}

const api: AdblockApi = {
  getBootstrap: () => call('getBootstrap'),
  refresh: () => call('refresh'),
  addApp: (exePath) => call('addApp', exePath),
  removeApp: (appId) => call('removeApp', appId),
  launchApp: (appId) => call('launchApp', appId),
  attachApp: (appId) => call('attachApp', appId),
  relaunchApp: (appId) => call('relaunchApp', appId),
  closeApp: (appId) => call('closeApp', appId),
  detachApp: (appId) => call('detachApp', appId),
  setAppEnabled: (appId, enabled) => call('setAppEnabled', appId, enabled),
  updateSettings: (patch) => call('updateSettings', patch),
  addCosmeticRule: (appId, input) => call('addCosmeticRule', appId, input),
  updateCosmeticRule: (appId, ruleId, patch) => call('updateCosmeticRule', appId, ruleId, patch),
  removeCosmeticRule: (appId, ruleId) => call('removeCosmeticRule', appId, ruleId),
  addNetworkRule: (appId, pattern) => call('addNetworkRule', appId, pattern),
  updateNetworkRule: (appId, ruleId, patch) => call('updateNetworkRule', appId, ruleId, patch),
  removeNetworkRule: (appId, ruleId) => call('removeNetworkRule', appId, ruleId),
  startPicker: (appId) => call('startPicker', appId),
  stopPicker: (appId) => call('stopPicker', appId),
  scanForAds: (appId) => call('scanForAds', appId),
  getBlockedLog: (appId) => call('getBlockedLog', appId),
  clearBlockedLog: (appId) => call('clearBlockedLog', appId),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, event: AppEvent) => listener(event);
    ipcRenderer.on(IPC_EVENT, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENT, handler);
    };
  },
};

contextBridge.exposeInMainWorld('adblock', api);
