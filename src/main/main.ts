import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  nativeImage,
  Tray,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppEvent, Settings } from '../shared/types';
import { AppService } from './app-service';
import { registerIpc } from './ipc';
import { MockService } from './mock-service';
import type { ServiceApi, ServiceEnv } from './service-contract';

const shotPath = process.env.EAB_SHOT ?? '';
const shotDelay = Number(process.env.EAB_SHOT_DELAY_MS ?? '1600');
const windowWidth = Number(process.env.EAB_WINDOW_WIDTH ?? '1240');
const windowHeight = Number(process.env.EAB_WINDOW_HEIGHT ?? '820');
const mockMode = process.env.EAB_MOCK === '1';
const wantDevTools = process.argv.includes('--dev');
const shotMode = shotPath.length > 0;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let service: ServiceApi | null = null;
let quitting = false;
let settings: Settings | null = null;
let lastPickerAppId: string | null = null;

function assetPath(name: string): string {
  return path.join(__dirname, 'assets', name);
}

function dataDir(): string {
  return process.env.EAB_DATA_DIR ?? path.join(app.getPath('userData'), 'electron-adblock');
}

function showWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0d10',
    title: 'Electron Adblock',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0b0d10',
      symbolColor: '#e8ebee',
      height: 44,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  mainWindow = win;
  Menu.setApplicationMenu(null);

  const iconFile = assetPath('icon.png');
  if (fs.existsSync(iconFile)) win.setIcon(nativeImage.createFromPath(iconFile));

  win.on('close', (event) => {
    if (quitting || shotMode) return;
    if (settings?.minimizeToTray) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  win.once('ready-to-show', () => {
    if (!shotMode) win.show();
  });

  if (shotMode) {
    win.setPosition(-4000, 0);
    win.once('ready-to-show', () => win.showInactive());
  }

  win.webContents.once('did-finish-load', () => {
    if (shotMode) {
      setTimeout(() => {
        void (async () => {
          try {
            if (mainWindow && !mainWindow.isDestroyed()) {
              const image = await mainWindow.webContents.capturePage();
              fs.mkdirSync(path.dirname(shotPath), { recursive: true });
              fs.writeFileSync(shotPath, image.toPNG());
            }
          } catch (error) {
            console.error('screenshot failed', error);
          }
          app.exit(0);
        })();
      }, shotDelay);
    } else if (wantDevTools && !app.isPackaged) {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  });

  void win.loadFile(path.join(__dirname, 'index.html'));
}

function updateTrayMenu(): void {
  if (!tray) return;
  const enabled = settings?.enabled ?? true;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Electron Adblock', click: showWindow },
      { type: 'separator' },
      {
        label: 'Blocking enabled',
        type: 'checkbox',
        checked: enabled,
        click: () => {
          void (async () => {
            if (!service) return;
            await service.updateSettings({ enabled: !enabled });
          })();
        },
      },
      {
        label: 'Pick element on last app',
        click: () => {
          void triggerPicker();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.quit();
        },
      },
    ]),
  );
}

function setupTray(): void {
  if (shotMode) return;
  const trayFile = assetPath('tray-32.png');
  if (!fs.existsSync(trayFile)) return;
  const image = nativeImage.createFromPath(trayFile);
  if (image.isEmpty()) return;
  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip('Electron Adblock');
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  updateTrayMenu();
}

function applySettings(next: Settings): void {
  settings = next;
  try {
    app.setLoginItemSettings({
      openAtLogin: next.launchAtLogin,
      path: process.execPath,
      args: app.isPackaged ? [] : [app.getAppPath()],
    });
  } catch (error) {
    console.error('login item failed', error);
  }

  globalShortcut.unregisterAll();
  if (next.pickerHotkey) {
    try {
      const registered = globalShortcut.register(next.pickerHotkey, () => {
        void triggerPicker();
      });
      if (!registered) console.error('hotkey not registered: ' + next.pickerHotkey);
    } catch (error) {
      console.error('hotkey failed', error);
    }
  }
  updateTrayMenu();
}

async function triggerPicker(): Promise<void> {
  if (!service) return;
  try {
    let apps = await service.refresh();
    let appId = lastPickerAppId;
    if (appId) {
      const match = apps.find((item) => item.id === appId && item.attached && item.enabled);
      if (!match) appId = null;
    }
    if (!appId) appId = apps.find((item) => item.attached && item.enabled)?.id ?? null;
    if (!appId) {
      showWindow();
      return;
    }
    lastPickerAppId = appId;
    await service.startPicker(appId);
  } catch (error) {
    console.error('picker failed', error);
  }
}

function handleEvent(event: AppEvent): void {
  if (event.type === 'settings') applySettings(event.settings);
  if (event.type === 'picker') {
    if (event.active) {
      if (!shotMode && mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    } else if (!shotMode && mainWindow && !mainWindow.isDestroyed()) {
      showWindow();
    }
  }
}

async function start(): Promise<void> {
  const env: ServiceEnv = {
    dataDir: dataDir(),
    version: {
      app: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? '',
    },
    devMode: wantDevTools || !app.isPackaged,
    packaged: app.isPackaged,
  };

  service = mockMode ? new MockService(env) : new AppService(env);
  await service.init();
  const bootstrap = await service.getBootstrap();
  applySettings(bootstrap.settings);

  registerIpc(service, () => mainWindow, {
    beforeCall: (method, args) => {
      if (method === 'startPicker' && typeof args[0] === 'string') {
        lastPickerAppId = args[0];
      }
    },
    onEvent: handleEvent,
  });

  createWindow();
  setupTray();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());
  app.on('window-all-closed', () => {
    app.quit();
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    globalShortcut.unregisterAll();
    void (async () => {
      try {
        await service?.dispose();
      } catch (error) {
        console.error('dispose failed', error);
      }
      app.quit();
    })();
  });

  app.setAppUserModelId('com.terriyaki.electronadblock');
  void app.whenReady().then(start).catch((error) => {
    console.error('startup failed', error);
    app.exit(1);
  });
}
