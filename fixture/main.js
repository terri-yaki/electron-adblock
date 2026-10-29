// Minimal Electron app used by the integration tests. CJS on purpose: Electron loads it as-is.
const { app, BrowserWindow } = require('electron');

const targetUrl = process.env.FIXTURE_URL || 'about:blank';
const WATCHDOG_MS = 1500;
let mainWindow = null;

function log(message) {
  process.stderr.write('[fixture] ' + message + '\n');
}

// Quit when the test runner disappears so a crashed suite never leaves Electron behind.
function startParentWatchdog() {
  const parentPid = process.ppid;
  if (!parentPid) return;
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      log('parent process ' + parentPid + ' is gone, quitting');
      app.exit(0);
    }
  }, WATCHDOG_MS);
  timer.unref();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  const contents = mainWindow.webContents;
  contents.on('did-fail-load', (event, code, description, url, isMainFrame) => {
    if (isMainFrame) log('did-fail-load ' + code + ' ' + description + ' ' + url);
  });
  contents.on('render-process-gone', (event, details) => {
    log('render-process-gone ' + details.reason);
  });
  contents.on('console-message', (event, level, message) => {
    if (level >= 2) log('renderer console: ' + message);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  contents.loadURL(targetUrl).catch((error) => {
    log('loadURL failed for ' + targetUrl + ': ' + (error && error.message ? error.message : error));
  });
}

app.on('window-all-closed', () => app.quit());

startParentWatchdog();

app
  .whenReady()
  .then(createWindow)
  .catch((error) => {
    log('startup failed: ' + (error && error.stack ? error.stack : error));
    app.exit(1);
  });
