import { ipcMain, type BrowserWindow } from 'electron';
import type { AdblockApi, AppEvent } from '../shared/types';
import type { ServiceApi } from './service-contract';

export const IPC_CALL = 'adblock:call';
export const IPC_BROWSE = 'adblock:browse';
export const IPC_EVENT = 'adblock:event';

type MethodName = keyof Omit<AdblockApi, 'onEvent'>;

const METHODS: ReadonlyArray<MethodName> = [
  'getBootstrap',
  'refresh',
  'addApp',
  'listDetectedApps',
  'removeApp',
  'launchApp',
  'attachApp',
  'relaunchApp',
  'closeApp',
  'detachApp',
  'setAppEnabled',
  'updateSettings',
  'addCosmeticRule',
  'updateCosmeticRule',
  'removeCosmeticRule',
  'addNetworkRule',
  'updateNetworkRule',
  'removeNetworkRule',
  'resetAppearance',
  'startPicker',
  'stopPicker',
  'scanForAds',
  'startLayoutEditor',
  'stopLayoutEditor',
  'addLayoutRule',
  'updateLayoutRule',
  'removeLayoutRule',
  'getBlockedLog',
  'clearBlockedLog',
];

const METHOD_SET = new Set<string>(METHODS);

export interface IpcHooks {
  beforeCall?: (method: string, args: unknown[]) => void;
  onEvent?: (event: AppEvent) => void;
  browseExecutable?: () => Promise<string | null>;
}

export function registerIpc(
  service: ServiceApi,
  getWindow: () => BrowserWindow | null,
  hooks: IpcHooks = {},
): void {
  service.setEventSink((event) => {
    hooks.onEvent?.(event);
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(IPC_EVENT, event);
  });

  ipcMain.removeHandler(IPC_BROWSE);
  ipcMain.handle(IPC_BROWSE, async () => {
    if (!hooks.browseExecutable) return null;
    return hooks.browseExecutable();
  });

  ipcMain.removeHandler(IPC_CALL);
  ipcMain.handle(IPC_CALL, async (_event, method: unknown, args: unknown) => {
    if (typeof method !== 'string' || !METHOD_SET.has(method)) {
      throw new Error('Unknown IPC method: ' + String(method));
    }
    const callArgs = Array.isArray(args) ? args : [];
    hooks.beforeCall?.(method, callArgs);
    const fn = (service as unknown as Record<string, unknown>)[method];
    if (typeof fn !== 'function') throw new Error('Unsupported IPC method: ' + method);
    return (fn as (...values: unknown[]) => Promise<unknown>).apply(service, callArgs);
  });
}
