import type {
  AdCandidate,
  AppEvent,
  AppView,
  BlockedEvent,
  CosmeticRuleInput,
  CosmeticRulePatch,
  DiscoveredApp,
  LayoutRuleInput,
  LayoutRulePatch,
  NetworkRulePatch,
  Settings,
} from '../shared/types';
import type { AppAction, AppTab, Controller, ToastLevel, UiState } from './modules/context';
import { h, clear } from './modules/dom';
import { icon } from './modules/icons';
import { formatNumber, hotkeyLabel, messageOf, normalizeHotkey, plural } from './modules/format';
import { button, spinner } from './modules/primitives';
import { createToastHost } from './modules/toasts';
import { createDialogHost, type DialogHost } from './modules/modal';
import { createSidebar, type SidebarComponent } from './modules/sidebar';
import { createAppView, type AppViewComponent } from './modules/app-view';
import { createSettingsView, type SettingsViewComponent } from './modules/settings-view';
import { openAddAppDialog } from './modules/add-app-dialog';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Renderer root element is missing');
const root = rootEl;

const state: UiState = {
  phase: 'loading',
  settings: null,
  version: null,
  dataDir: '',
  devMode: false,
  packaged: false,
  apps: [],
  selectedAppId: null,
  view: 'app',
  tab: 'overview',
  logs: {},
  logsLoaded: {},
  scan: null,
  picker: null,
};

let appRoot: HTMLElement | null = null;
let mainEl: HTMLElement | null = null;
let sidebar: SidebarComponent | null = null;
let appView: AppViewComponent | null = null;
let settingsView: SettingsViewComponent | null = null;
let toastHost: ReturnType<typeof createToastHost> | null = null;
let dialogs: DialogHost | null = null;
let titlebarContext: HTMLElement | null = null;
let titlebarStatus: HTMLButtonElement | null = null;

function selectedApp(): AppView | null {
  if (!state.selectedAppId) return null;
  return state.apps.find((app) => app.id === state.selectedAppId) ?? null;
}

function findApp(appId: string): AppView | null {
  return state.apps.find((app) => app.id === appId) ?? null;
}

function preferredAppId(apps: AppView[]): string | null {
  const attached = apps.find((app) => app.attached && app.enabled) ?? apps.find((app) => app.attached);
  return (attached ?? apps[0])?.id ?? null;
}

function toast(level: ToastLevel, message: string): void {
  toastHost?.show(level, message);
}

function normalizeApp(view: AppView): AppView {
  return {
    ...view,
    layoutRules: view.layoutRules ?? [],
    layoutEditing: view.layoutEditing ?? false,
  };
}

function upsertApp(view: AppView): void {
  const normalized = normalizeApp(view);
  const index = state.apps.findIndex((item) => item.id === normalized.id);
  if (index >= 0) state.apps[index] = normalized;
  else state.apps.push(normalized);
}

function patchAppState(appId: string, patch: (app: AppView) => AppView): void {
  const index = state.apps.findIndex((item) => item.id === appId);
  if (index < 0) return;
  state.apps[index] = patch(state.apps[index]);
  sidebar?.update();
  if (state.view === 'app' && state.selectedAppId === appId) appView?.update();
  updateTitlebar();
}

function applyApp(view: AppView): void {
  upsertApp(view);
  sidebar?.update();
  if (state.view === 'app' && state.selectedAppId === view.id) appView?.update();
  updateTitlebar();
}

async function callApi<T>(label: string, task: Promise<T>): Promise<T | null> {
  try {
    return await task;
  } catch (error) {
    toast('error', label + ': ' + messageOf(error));
    return null;
  }
}

function updateTitlebar(): void {
  if (!titlebarContext || !titlebarStatus) return;
  const app = selectedApp();
  titlebarContext.textContent = state.view === 'settings' ? 'Settings' : app?.name ?? 'No application';
  const enabled = state.settings?.enabled ?? true;
  titlebarStatus.className = 'titlebar-status' + (enabled ? ' is-on' : ' is-off');
  titlebarStatus.title = enabled
    ? 'Blocking is enabled. Open settings to change it.'
    : 'Blocking is paused. Open settings to resume.';
  titlebarStatus.setAttribute(
    'aria-label',
    enabled ? 'Blocking is enabled. Open settings.' : 'Blocking is paused. Open settings.',
  );
  titlebarStatus.replaceChildren(
    h('span', { class: 'status-dot' }),
    h('span', { class: 'titlebar-status-label', text: enabled ? 'Blocking on' : 'Blocking paused' }),
  );
}

function renderShell(): void {
  clear(root);
  titlebarContext = h('span', { class: 'titlebar-context' });
  titlebarStatus = h('button', {
    class: 'titlebar-status',
    type: 'button',
    onclick: () => openSettings(),
  });
  const titlebar = h(
    'header',
    { class: 'titlebar' },
    h(
      'div',
      { class: 'titlebar-brand' },
      h('span', { class: 'brand-mark' }, icon('logo', 18)),
      h('span', { class: 'brand-name', text: 'Electron Adblock' }),
    ),
    h('span', { class: 'titlebar-divider', 'aria-hidden': 'true' }),
    titlebarContext,
    h('div', { class: 'titlebar-right' }, titlebarStatus),
  );
  mainEl = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  const sidebarHost = h('div', { class: 'sidebar-host' });
  appRoot = h('div', { class: 'app' }, titlebar, h('div', { class: 'shell' }, sidebarHost, mainEl));
  const toastEl = h('div', { class: 'toast-root' });
  const modalEl = h('div', { class: 'modal-root' });
  root.append(appRoot, toastEl, modalEl);
  toastHost = createToastHost(toastEl);
  dialogs = createDialogHost(modalEl, appRoot);
  sidebar = createSidebar(controller);
  sidebarHost.append(sidebar.el);
  updateTitlebar();
}

function renderMain(): void {
  if (!mainEl) return;
  appView?.dispose();
  appView = null;
  settingsView = null;
  clear(mainEl);
  if (state.view === 'settings') {
    settingsView = createSettingsView(controller);
    mainEl.append(settingsView.el);
  } else {
    const app = selectedApp();
    if (app) {
      appView = createAppView(controller);
      mainEl.append(appView.el);
      if (state.tab === 'scan') ensureScan(app);
    } else {
      mainEl.append(noAppsView());
    }
  }
  mainEl.scrollTop = 0;
  sidebar?.update();
  updateTitlebar();
}

function noAppsView(): HTMLElement {
  return h(
    'div',
    { class: 'empty-page' },
    h(
      'div',
      { class: 'empty-page-inner' },
      h('span', { class: 'empty-page-mark' }, icon('logo', 28)),
      h('p', { class: 'eyebrow', text: 'Getting started' }),
      h('h1', { class: 'empty-page-title', text: 'No applications yet' }),
      h('p', {
        class: 'empty-page-copy',
        text: 'Electron Adblock filters any Electron app by attaching to its remote debugging port. Add one to get started.',
      }),
      h(
        'div',
        { class: 'empty-page-actions' },
        button({
          label: 'Add application',
          iconName: 'plus',
          variant: 'primary',
          onClick: () => addApplication(),
        }),
        button({
          label: 'Refresh',
          iconName: 'refresh',
          variant: 'ghost',
          onClick: () => {
            void refreshApplications();
          },
        }),
      ),
      h(
        'ol',
        { class: 'empty-steps' },
        emptyStep('1', 'Add an app', 'Choose a detected Electron app or browse for its .exe.'),
        emptyStep('2', 'Launch or attach', 'Electron Adblock restarts the app with a debugging port, or attaches to one.'),
        emptyStep('3', 'Filter and pick', 'Domains, CSS selectors and the visual picker do the rest.'),
      ),
    ),
  );
}

function emptyStep(index: string, title: string, body: string): HTMLElement {
  return h(
    'li',
    {},
    h('span', { class: 'step-index', text: index }),
    h('div', { class: 'step-copy' }, h('strong', { text: title }), h('p', { text: body })),
  );
}

function openSettings(): void {
  if (state.view === 'settings') return;
  state.view = 'settings';
  renderMain();
}

function openAppView(): void {
  if (state.view === 'app') return;
  state.view = 'app';
  renderMain();
}

function selectApp(appId: string): void {
  if (!state.apps.some((app) => app.id === appId)) return;
  const sameTarget = state.view === 'app' && state.selectedAppId === appId;
  state.selectedAppId = appId;
  state.view = 'app';
  if (sameTarget) {
    sidebar?.update();
    updateTitlebar();
    return;
  }
  renderMain();
  void loadLogs(appId);
}

function setTab(tab: AppTab): void {
  if (state.view === 'app' && state.tab === tab) return;
  state.tab = tab;
  state.view = 'app';
  const app = selectedApp();
  if (!app) {
    renderMain();
    return;
  }
  if (appView) {
    appView.setTab(tab);
    if (mainEl && mainEl.scrollTop > 0) mainEl.scrollTop = 0;
  } else {
    renderMain();
  }
  sidebar?.update();
  updateTitlebar();
  if (tab === 'scan') ensureScan(app);
}

async function refreshApplications(): Promise<void> {
  const apps = await callApi('Could not refresh applications', window.adblock.refresh());
  if (!apps) return;
  state.apps = apps;
  if (!state.selectedAppId || !apps.some((app) => app.id === state.selectedAppId)) {
    state.selectedAppId = preferredAppId(apps);
    if (state.selectedAppId) void loadLogs(state.selectedAppId);
  }
  if (state.view === 'settings') sidebar?.update();
  else renderMain();
}

function addApplication(): void {
  openAddAppDialog(controller);
}

async function chooseExecutable(): Promise<string | null> {
  try {
    return await window.adblock.browseForExecutable();
  } catch (error) {
    toast('error', 'Could not open the file picker: ' + messageOf(error));
    return null;
  }
}

async function addAppFromPath(exePath: string): Promise<AppView | null> {
  const app = await callApi('Could not add application', window.adblock.addApp(exePath));
  if (!app) return null;
  upsertApp(app);
  state.selectedAppId = app.id;
  state.view = 'app';
  state.tab = 'overview';
  renderMain();
  sidebar?.update();
  updateTitlebar();
  void loadLogs(app.id);
  return app;
}

async function listDetectedApps(): Promise<DiscoveredApp[] | null> {
  try {
    return await window.adblock.listDetectedApps();
  } catch (error) {
    toast('error', 'Could not scan for applications: ' + messageOf(error));
    return null;
  }
}

function removeApplication(target: AppView): void {
  const ruleCount = target.cosmeticRules.length + target.networkRules.length;
  dialogs?.confirm({
    title: 'Remove ' + target.name + '?',
    message:
      'This removes ' +
      target.name +
      ' from Electron Adblock' +
      (ruleCount > 0
        ? ', together with ' + formatNumber(ruleCount) + ' ' + plural(ruleCount, 'custom rule') + '.'
        : '.') +
      ' The application itself is not affected.',
    confirmLabel: 'Remove application',
    danger: true,
    onConfirm: async () => {
      const apps = await callApi('Could not remove ' + target.name, window.adblock.removeApp(target.id));
      if (!apps) return;
      state.apps = apps;
      delete state.logs[target.id];
      delete state.logsLoaded[target.id];
      if (state.scan?.appId === target.id) state.scan = null;
      if (state.picker?.appId === target.id) state.picker = null;
      if (state.selectedAppId === target.id) state.selectedAppId = preferredAppId(apps);
      renderMain();
      sidebar?.update();
      updateTitlebar();
      if (state.selectedAppId) void loadLogs(state.selectedAppId);
      toast('success', target.name + ' removed');
    },
  });
}

async function appAction(appId: string, action: AppAction): Promise<void> {
  const app = findApp(appId);
  if (!app) return;
  let task: Promise<AppView>;
  let verb: string;
  switch (action) {
    case 'launch':
      task = window.adblock.launchApp(appId);
      verb = 'launch';
      break;
    case 'relaunch':
      task = window.adblock.relaunchApp(appId);
      verb = 'relaunch';
      break;
    case 'attach':
      task = window.adblock.attachApp(appId);
      verb = 'attach';
      break;
    case 'detach':
      task = window.adblock.detachApp(appId);
      verb = 'detach';
      break;
    default:
      task = window.adblock.closeApp(appId);
      verb = 'close';
      break;
  }
  const updated = await callApi('Could not ' + verb + ' ' + app.name, task);
  if (updated) applyApp(updated);
  else appView?.update();
}

async function setAppEnabled(appId: string, enabled: boolean): Promise<void> {
  const app = findApp(appId);
  if (!app) return;
  const updated = await callApi(
    'Could not update protection for ' + app.name,
    window.adblock.setAppEnabled(appId, enabled),
  );
  if (updated) applyApp(updated);
  else appView?.update();
}

async function startPicker(appId: string): Promise<void> {
  const app = findApp(appId);
  if (!app) return;
  state.picker = { appId, active: true, picked: state.picker?.picked ?? 0 };
  appView?.update();
  const updated = await callApi('Could not start the picker', window.adblock.startPicker(appId));
  if (updated) {
    applyApp(updated);
  } else {
    state.picker = { appId, active: false, picked: 0 };
    appView?.update();
  }
}

async function stopPicker(appId: string): Promise<void> {
  const previous = state.picker;
  state.picker = { appId, active: false, picked: previous?.picked ?? 0 };
  appView?.update();
  const updated = await callApi('Could not stop the picker', window.adblock.stopPicker(appId));
  if (updated) applyApp(updated);
  else {
    state.picker = previous;
    appView?.update();
  }
}

function ensureScan(app: AppView): void {
  if (state.tab !== 'scan' || !app.attached) return;
  const scan = state.scan;
  if (scan && scan.appId === app.id && (scan.status === 'ready' || scan.status === 'loading')) return;
  void runScan(app.id);
}

async function runScan(appId: string): Promise<void> {
  const app = findApp(appId);
  if (!app) return;
  if (!app.attached) {
    toast('info', 'Attach ' + app.name + ' before scanning its pages.');
    return;
  }
  const existing = state.scan?.appId === appId ? state.scan : null;
  const base = {
    appId,
    hiddenSelectors: existing?.hiddenSelectors ?? [],
    candidates: existing?.candidates ?? [],
    startedAt: Date.now(),
  };
  state.scan = { ...base, status: 'loading' };
  appView?.update();
  try {
    const candidates = await window.adblock.scanForAds(appId);
    state.scan = { ...base, status: 'ready', candidates, startedAt: Date.now() };
  } catch (error) {
    const message = messageOf(error);
    state.scan = { ...base, status: 'error', error: message, startedAt: Date.now() };
    toast('error', 'Page scan failed: ' + message);
  }
  appView?.update();
}

async function hideCandidate(appId: string, candidate: AdCandidate): Promise<void> {
  const app = findApp(appId);
  if (!app) return;
  const updated = await callApi(
    'Could not hide that element',
    window.adblock.addCosmeticRule(appId, {
      selector: candidate.selector,
      label: candidate.reason,
      source: 'suggestion',
    }),
  );
  if (!updated) return;
  applyApp(updated);
  const scan = state.scan;
  if (scan && scan.appId === appId && !scan.hiddenSelectors.includes(candidate.selector)) {
    scan.hiddenSelectors = [...scan.hiddenSelectors, candidate.selector];
  }
  appView?.update();
}

async function addCosmeticRule(appId: string, input: CosmeticRuleInput): Promise<boolean> {
  const updated = await callApi('Could not add rule', window.adblock.addCosmeticRule(appId, input));
  if (!updated) return false;
  applyApp(updated);
  return true;
}

async function updateCosmeticRule(appId: string, ruleId: string, patch: CosmeticRulePatch): Promise<void> {
  const updated = await callApi(
    'Could not update rule',
    window.adblock.updateCosmeticRule(appId, ruleId, patch),
  );
  if (updated) applyApp(updated);
  else appView?.update();
}

async function removeCosmeticRule(appId: string, ruleId: string): Promise<void> {
  const updated = await callApi(
    'Could not delete rule',
    window.adblock.removeCosmeticRule(appId, ruleId),
  );
  if (updated) applyApp(updated);
  else appView?.update();
}

async function addNetworkRule(appId: string, pattern: string): Promise<boolean> {
  const updated = await callApi('Could not add network rule', window.adblock.addNetworkRule(appId, pattern));
  if (!updated) return false;
  applyApp(updated);
  return true;
}

async function updateNetworkRule(appId: string, ruleId: string, patch: NetworkRulePatch): Promise<void> {
  const updated = await callApi(
    'Could not update network rule',
    window.adblock.updateNetworkRule(appId, ruleId, patch),
  );
  if (updated) applyApp(updated);
  else appView?.update();
}

async function removeNetworkRule(appId: string, ruleId: string): Promise<void> {
  const updated = await callApi(
    'Could not delete network rule',
    window.adblock.removeNetworkRule(appId, ruleId),
  );
  if (updated) applyApp(updated);
  else appView?.update();
}

async function startLayoutEditor(appId: string): Promise<void> {
  const app = findApp(appId);
  if (!app) return;
  if (!app.attached) {
    toast('info', 'Attach ' + app.name + ' before adjusting its layout.');
    return;
  }
  if (typeof window.adblock.startLayoutEditor !== 'function') {
    toast('error', 'Layout mode is not available in this build.');
    return;
  }
  patchAppState(appId, (item) => ({ ...item, layoutEditing: true }));
  const updated = await callApi('Could not start layout mode', window.adblock.startLayoutEditor(appId));
  if (updated) applyApp(updated);
  else patchAppState(appId, (item) => ({ ...item, layoutEditing: false }));
}

async function stopLayoutEditor(appId: string): Promise<void> {
  const app = findApp(appId);
  if (!app) return;
  patchAppState(appId, (item) => ({ ...item, layoutEditing: false }));
  if (typeof window.adblock.stopLayoutEditor !== 'function') return;
  const updated = await callApi('Could not stop layout mode', window.adblock.stopLayoutEditor(appId));
  if (updated) applyApp(updated);
  else patchAppState(appId, (item) => ({ ...item, layoutEditing: true }));
}

async function addLayoutRule(appId: string, input: LayoutRuleInput): Promise<boolean> {
  if (typeof window.adblock.addLayoutRule !== 'function') {
    toast('error', 'Layout fixes are not available in this build.');
    return false;
  }
  const updated = await callApi('Could not add layout fix', window.adblock.addLayoutRule(appId, input));
  if (!updated) return false;
  applyApp(updated);
  return true;
}

async function updateLayoutRule(appId: string, ruleId: string, patch: LayoutRulePatch): Promise<void> {
  if (typeof window.adblock.updateLayoutRule !== 'function') {
    toast('error', 'Layout fixes are not available in this build.');
    return;
  }
  const updated = await callApi('Could not update layout fix', window.adblock.updateLayoutRule(appId, ruleId, patch));
  if (updated) applyApp(updated);
  else appView?.update();
}

async function removeLayoutRule(appId: string, ruleId: string): Promise<void> {
  if (typeof window.adblock.removeLayoutRule !== 'function') {
    toast('error', 'Layout fixes are not available in this build.');
    return;
  }
  const updated = await callApi('Could not delete layout fix', window.adblock.removeLayoutRule(appId, ruleId));
  if (updated) applyApp(updated);
  else appView?.update();
}

async function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<boolean> {
  const patch = { [key]: value } as Partial<Settings>;
  const settings = await callApi('Could not save settings', window.adblock.updateSettings(patch));
  if (!settings) {
    settingsView?.update();
    appView?.update();
    return false;
  }
  state.settings = settings;
  settingsView?.update();
  appView?.update();
  updateTitlebar();
  return true;
}

async function savePickerHotkey(value: string): Promise<boolean> {
  const normalized = normalizeHotkey(value);
  if (!normalized) {
    toast('error', 'Shortcut needs a modifier and a key, for example Ctrl+Shift+E.');
    return false;
  }
  const ok = await updateSetting('pickerHotkey', normalized);
  if (ok) toast('info', 'Picker shortcut set to ' + hotkeyLabel(normalized) + '.');
  return ok;
}

async function clearActivity(appId: string): Promise<void> {
  const app = findApp(appId);
  if (!app) return;
  try {
    await window.adblock.clearBlockedLog(appId);
    state.logs[appId] = [];
    state.logsLoaded[appId] = true;
    appView?.update();
    sidebar?.update();
    toast('success', 'Activity cleared');
  } catch (error) {
    toast('error', 'Could not clear activity: ' + messageOf(error));
  }
}

function fallbackCopy(value: string): void {
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('Clipboard copy was rejected');
}

async function copyText(value: string): Promise<void> {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(value);
    else fallbackCopy(value);
    toast('success', 'Copied to clipboard');
  } catch (error) {
    console.error('copy failed', error);
    toast('error', 'Could not copy to clipboard.');
  }
}

async function loadLogs(appId: string): Promise<void> {
  if (state.logsLoaded[appId]) return;
  state.logsLoaded[appId] = true;
  try {
    state.logs[appId] = await window.adblock.getBlockedLog(appId);
  } catch (error) {
    state.logsLoaded[appId] = false;
    toast('error', 'Could not load activity: ' + messageOf(error));
  }
  if (state.selectedAppId === appId) {
    appView?.update();
    sidebar?.update();
  }
}

function handleEvent(event: AppEvent): void {
  try {
    switch (event.type) {
      case 'apps': {
        const apps = event.apps.map(normalizeApp);
        const selectionMissing = !state.selectedAppId || !apps.some((app) => app.id === state.selectedAppId);
        state.apps = apps;
        if (selectionMissing) {
          state.selectedAppId = preferredAppId(event.apps);
          if (state.selectedAppId) void loadLogs(state.selectedAppId);
          if (state.view === 'app') {
            renderMain();
            return;
          }
        }
        sidebar?.update();
        appView?.update();
        updateTitlebar();
        break;
      }
      case 'app': {
        upsertApp(event.app);
        sidebar?.update();
        if (state.view === 'app' && state.selectedAppId === event.app.id) appView?.update();
        updateTitlebar();
        break;
      }
      case 'settings': {
        state.settings = event.settings;
        settingsView?.update();
        appView?.update();
        updateTitlebar();
        break;
      }
      case 'picker': {
        state.picker = { appId: event.appId, active: event.active, picked: event.picked };
        if (state.view === 'app' && state.selectedAppId === event.appId) appView?.update();
        break;
      }
      case 'picked': {
        sidebar?.update();
        if (state.selectedAppId === event.appId) appView?.update();
        break;
      }
      case 'layout': {
        const rule = event.rule;
        patchAppState(event.appId, (item) => {
          let rules = item.layoutRules;
          if (rule) {
            const index = rules.findIndex((entry) => entry.id === rule.id);
            rules = index >= 0 ? rules.map((entry) => (entry.id === rule.id ? rule : entry)) : [...rules, rule];
          }
          return { ...item, layoutEditing: event.active, layoutRules: rules };
        });
        // The service emits its own success toast when a layout fix is saved.
        break;
      }
      case 'toast': {
        toastHost?.show(event.level, event.message);
        break;
      }
      case 'log': {
        const entries: BlockedEvent[] = state.logs[event.appId] ?? [];
        entries.unshift(event.entry);
        state.logs[event.appId] = entries.slice(0, 200);
        state.logsLoaded[event.appId] = true;
        if (state.selectedAppId === event.appId) {
          appView?.update();
          sidebar?.update();
        }
        break;
      }
      case 'error': {
        toastHost?.show('error', event.message);
        break;
      }
    }
  } catch (error) {
    console.error('event handling failed', error);
    toast('error', messageOf(error));
  }
}

function onGlobalKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const picker = state.picker;
  if (picker?.active) {
    void stopPicker(picker.appId);
    return;
  }
  const app = selectedApp();
  if (app?.layoutEditing) void stopLayoutEditor(app.id);
}

function refreshTimestamps(): void {
  if (state.view === 'app') appView?.update();
}

function bindEvents(): void {
  window.adblock.onEvent(handleEvent);
  document.addEventListener('keydown', onGlobalKeyDown);
  window.addEventListener('unhandledrejection', (event) => {
    event.preventDefault();
    console.error('unhandled rejection', event.reason);
    toast('error', messageOf(event.reason));
  });
  window.addEventListener('error', (event) => {
    console.error('renderer error', event.error ?? event.message);
  });
  window.setInterval(refreshTimestamps, 15000);
}

interface StageConfig {
  view?: 'app' | 'settings';
  tab?: AppTab;
  picker?: boolean;
  add?: boolean;
  layoutEditor?: boolean;
}

function parseStage(): StageConfig {
  const stage = (new URLSearchParams(location.search).get('stage') ?? '').toLowerCase();
  switch (stage) {
    case 'settings':
      return { view: 'settings' };
    case 'overview':
      return { tab: 'overview' };
    case 'scan':
      return { tab: 'scan' };
    case 'hidden':
      return { tab: 'hidden' };
    case 'network':
      return { tab: 'network' };
    case 'layout':
      return { tab: 'layout' };
    case 'layout-editor':
      return { tab: 'layout', layoutEditor: true };
    case 'activity':
      return { tab: 'activity' };
    case 'picker':
      return { picker: true };
    case 'add':
      return { add: true };
    default:
      return {};
  }
}

function renderBootScreen(): void {
  clear(root);
  root.append(
    h(
      'div',
      { class: 'boot-screen', role: 'status', 'aria-live': 'polite' },
      h('span', { class: 'boot-mark' }, icon('logo', 26)),
      h('div', { class: 'boot-title', text: 'Electron Adblock' }),
      h('div', { class: 'boot-status' }, spinner(14), h('span', { text: 'Loading protection state' })),
    ),
  );
}

function renderFatal(title: string, message: string): void {
  clear(root);
  root.append(
    h(
      'div',
      { class: 'fatal-screen', role: 'alert' },
      h('span', { class: 'fatal-mark' }, icon('alert', 24)),
      h('p', { class: 'eyebrow', text: 'Startup error' }),
      h('h1', { class: 'fatal-title', text: title }),
      h('p', { class: 'fatal-message', text: message }),
      button({
        label: 'Reload',
        iconName: 'refresh',
        variant: 'secondary',
        onClick: () => location.reload(),
      }),
    ),
  );
}

function boot(): void {
  renderBootScreen();
  if (!window.adblock) {
    state.phase = 'error';
    renderFatal('Electron bridge unavailable', 'The window.adblock API is missing. Run this window from the Electron shell.');
    return;
  }
  const stage = parseStage();
  window.adblock
    .getBootstrap()
    .then((bootstrap) => {
      state.phase = 'ready';
      state.settings = bootstrap.settings;
      state.version = bootstrap.version;
      state.dataDir = bootstrap.dataDir;
      state.devMode = bootstrap.devMode;
      state.packaged = bootstrap.packaged;
      state.apps = bootstrap.apps.map(normalizeApp);
      state.selectedAppId = preferredAppId(bootstrap.apps);
      if (stage.view) state.view = stage.view;
      if (stage.tab) state.tab = stage.tab;
      renderShell();
      bindEvents();
      renderMain();
      if (state.selectedAppId) void loadLogs(state.selectedAppId);
      if (stage.picker) {
        const app = selectedApp();
        if (app && app.attached) void startPicker(app.id);
      }
      if (stage.layoutEditor) {
        const app = selectedApp();
        if (app && app.attached) void startLayoutEditor(app.id);
      }
      if (stage.add) addApplication();
    })
    .catch((error: unknown) => {
      state.phase = 'error';
      state.errorMessage = messageOf(error);
      renderFatal('Could not start Electron Adblock', messageOf(error));
    });
}

const controller: Controller = {
  state,
  get dialogs(): DialogHost {
    return dialogs as DialogHost;
  },
  toast,
  selectedApp,
  selectApp,
  setTab,
  openSettings,
  openAppView,
  refreshApplications,
  addApplication,
  chooseExecutable,
  addAppFromPath,
  listDetectedApps,
  removeApplication,
  appAction,
  setAppEnabled,
  startPicker,
  stopPicker,
  ensureScan,
  scan: runScan,
  hideCandidate,
  addCosmeticRule,
  updateCosmeticRule,
  removeCosmeticRule,
  addNetworkRule,
  updateNetworkRule,
  removeNetworkRule,
  startLayoutEditor,
  stopLayoutEditor,
  addLayoutRule,
  updateLayoutRule,
  removeLayoutRule,
  updateSetting,
  savePickerHotkey,
  clearActivity,
  copyText,
  loadLogs,
};


boot();