import type { AppView } from '../../shared/types';
import type { AppAction, AppTab, Controller } from './context';
import { APP_TABS, TAB_LABELS } from './context';
import { h, type Child } from './dom';
import { icon, type IconName } from './icons';
import { fileName, formatNumber, hotkeyLabel, pageLabel, plural, relativeTime } from './format';
import { appAvatar, button, iconButton, kbd, statusPill, syncToggle, tag, toggle } from './primitives';
import type { TabFactory, TabView } from './tab-view';
import { overviewTab } from './tabs/overview';
import { scanTab } from './tabs/scan';
import { hiddenTab, networkTab } from './tabs/rules';
import { layoutTab } from './tabs/layout';
import { activityTab } from './tabs/activity';

const TAB_FACTORIES: Record<AppTab, TabFactory> = {
  overview: overviewTab,
  scan: scanTab,
  hidden: hiddenTab,
  network: networkTab,
  layout: layoutTab,
  activity: activityTab,
};

export interface AppViewComponent {
  el: HTMLElement;
  update(): void;
  setTab(tab: AppTab): void;
  dispose(): void;
}

interface StatCardRefs {
  el: HTMLElement;
  value: HTMLElement;
  sub: HTMLElement;
}

export function createAppView(ctx: Controller): AppViewComponent {
  const initialApp = ctx.selectedApp();
  if (!initialApp) throw new Error('No application is selected');
  let app: AppView = initialApp;

  let currentTab: TabView | null = null;
  let protectionToggle: HTMLButtonElement | null = null;
  let lastHeaderKey = '';
  let lastToolbarKey = '';
  let lastNoticeKey = '';
  let menuOpen = false;
  let menuDocHandler: ((event: Event) => void) | null = null;
  let menuKeyHandler: ((event: KeyboardEvent) => void) | null = null;

  const hotkey = (): string => ctx.state.settings?.pickerHotkey ?? '';

  // Header
  const headerRoot = h('div', { class: 'app-head-wrap' });

  function headerKey(target: AppView): string {
    return [
      target.name,
      target.status,
      target.attached,
      target.canAttach,
      target.enabled,
      target.lastError ?? '',
      target.debugPort ?? '',
      target.electronVersion ?? '',
      target.exePath,
      target.source,
    ].join('|');
  }

  function renderHeader(): void {
    protectionToggle = toggle({
      checked: app.enabled,
      label: 'Enable protection for ' + app.name,
      onChange: (next) => {
        void ctx.setAppEnabled(app.id, next);
      },
    });
    const meta: Child[] = [
      h('span', { class: 'app-exe mono', title: app.exePath, text: fileName(app.exePath) }),
      h('span', { class: 'meta-sep', text: '/' }),
      h('span', {
        text: app.electronVersion ? 'Electron ' + app.electronVersion : sourceLabel(app.source),
      }),
    ];
    if (app.debugPort) {
      meta.push(h('span', { class: 'meta-sep', text: '/' }), h('span', { text: 'Port ' + String(app.debugPort) }));
    }
    const header = h(
      'header',
      { class: 'app-head' + (app.enabled ? '' : ' is-disabled') },
      h(
        'div',
        { class: 'app-identity' },
        appAvatar(app, 46),
        h(
          'div',
          { class: 'app-titles' },
          h('div', { class: 'app-title-row' }, h('h1', { class: 'app-name', text: app.name }), statusPill(app)),
          h('div', { class: 'app-meta' }, ...meta),
        ),
      ),
      h(
        'div',
        { class: 'app-protection' },
        h('span', { class: 'protection-label', text: 'Protection' }),
        protectionToggle,
      ),
    );
    headerRoot.replaceChildren(header);
  }

  function sourceLabel(source: AppView['source']): string {
    switch (source) {
      case 'running':
        return 'Running process';
      case 'manual':
        return 'Added manually';
      case 'preset':
        return 'Preset';
      default:
        return 'Start menu';
    }
  }

  // Toolbar
  const toolbarRoot = h('div', { class: 'toolbar-wrap' });

  function toolbarKey(target: AppView): string {
    return [
      target.status,
      target.attached,
      target.canAttach,
      target.enabled,
      target.layoutEditing,
      ctx.state.picker?.active ?? false,
      ctx.state.picker?.appId ?? '',
      ctx.state.settings?.pickerHotkey ?? '',
    ].join('|');
  }

  function actionButton(action: AppAction, label: string, iconName: IconName, disabled = false, title?: string): HTMLButtonElement {
    return button({
      label,
      iconName,
      variant: 'secondary',
      disabled,
      title,
      onClick: () => {
        void ctx.appAction(app.id, action);
      },
    });
  }

  function renderToolbar(): void {
    disposeMenuRef();
    const picker = ctx.state.picker;
    const pickerActive = Boolean(picker?.active && picker.appId === app.id);
    const primary = pickerActive
      ? button({
          label: 'Stop picker',
          iconName: 'stop',
          variant: 'secondary',
          onClick: () => {
            void ctx.stopPicker(app.id);
          },
        })
      : button({
          label: 'Pick element',
          iconName: 'picker',
          variant: 'primary',
          disabled: !app.attached || app.layoutEditing,
          title: !app.attached
            ? 'Attach ' + app.name + ' to use the picker'
            : app.layoutEditing
              ? 'Stop layout mode first'
              : 'Pick an element on the page to hide it',
          shortcut: hotkeyLabel(hotkey()),
          onClick: () => {
            void ctx.startPicker(app.id);
          },
        });
    const layoutAction = app.layoutEditing
      ? button({
          label: 'Stop layout',
          iconName: 'stop',
          variant: 'secondary',
          onClick: () => {
            void ctx.stopLayoutEditor(app.id);
          },
        })
      : button({
          label: 'Adjust layout',
          iconName: 'layout',
          variant: 'secondary',
          disabled: !app.attached || pickerActive,
          title: !app.attached
            ? 'Attach ' + app.name + ' to adjust its layout'
            : pickerActive
              ? 'Stop the element picker first'
              : 'Click a panel on the page and resize it',
          onClick: () => {
            void ctx.startLayoutEditor(app.id);
          },
        });

    const actions: HTMLButtonElement[] = [];
    if (app.status === 'launching') {
      actions.push(button({ label: 'Launching...', iconName: 'refresh', variant: 'secondary', disabled: true, className: 'is-spinning-icon' }));
    } else if (app.status === 'not-running') {
      actions.push(actionButton('launch', 'Launch', 'play'));
    } else {
      actions.push(actionButton('relaunch', 'Relaunch', 'refresh'));
    }
    if (app.attached) {
      actions.push(actionButton('detach', 'Detach', 'unplug'));
    } else if (app.status === 'running' || app.status === 'error') {
      actions.push(
        actionButton(
          'attach',
          'Attach',
          'plug',
          !app.canAttach,
          app.canAttach
            ? 'Attach to the remote debugging port'
            : 'No debugging port found. Relaunch ' + app.name + ' through Electron Adblock.',
        ),
      );
    }
    if (app.status !== 'not-running') {
      actions.push(actionButton('close', 'Close', 'power', app.status === 'launching', 'Close the managed app'));
    }

    const menuBtn = iconButton({ iconName: 'more', label: 'Application options' });
    const menu = h('div', { class: 'menu', role: 'menu', hidden: true });
    const copyItem = menuItem('Copy executable path', 'copy', () => {
      closeMenu();
      void ctx.copyText(app.exePath);
    });
    const removeItem = menuItem('Remove application', 'trash', () => {
      closeMenu();
      ctx.removeApplication(app);
    }, true);
    menu.append(copyItem, h('div', { class: 'menu-sep' }), removeItem);

    function closeMenu(): void {
      menuOpen = false;
      menu.hidden = true;
      menuBtn.setAttribute('aria-expanded', 'false');
      if (menuDocHandler) {
        document.removeEventListener('mousedown', menuDocHandler, true);
        menuDocHandler = null;
      }
      if (menuKeyHandler) {
        document.removeEventListener('keydown', menuKeyHandler, true);
        menuKeyHandler = null;
      }
    }

    function onMenuKey(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || !menuOpen) return;
      event.stopPropagation();
      closeMenu();
      menuBtn.focus();
    }

    function openMenu(): void {
      menuOpen = true;
      menu.hidden = false;
      menuBtn.setAttribute('aria-expanded', 'true');
      menuDocHandler = (event: Event) => {
        const target = event.target;
        if (!(target instanceof Node)) return;
        if (menu.contains(target) || menuBtn.contains(target)) return;
        closeMenu();
      };
      menuKeyHandler = onMenuKey;
      document.addEventListener('mousedown', menuDocHandler, true);
      document.addEventListener('keydown', menuKeyHandler, true);
      (menu.querySelector('.menu-item') as HTMLElement | null)?.focus();
    }

    menuBtn.setAttribute('aria-haspopup', 'menu');
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.addEventListener('click', () => {
      if (menuOpen) closeMenu();
      else openMenu();
    });

    const menuWrap = h('div', { class: 'menu-wrap' }, menuBtn, menu);
    toolbarRoot.replaceChildren(
      h(
        'div',
        { class: 'toolbar' },
        primary,
        layoutAction,
        h('span', { class: 'toolbar-sep', 'aria-hidden': 'true' }),
        ...actions,
        h('span', { class: 'toolbar-spacer' }),
        menuWrap,
      ),
    );
  }

  function menuItem(label: string, iconName: IconName, onClick: () => void, danger = false): HTMLButtonElement {
    const el = h(
      'button',
      {
        class: 'menu-item' + (danger ? ' is-danger' : ''),
        type: 'button',
        role: 'menuitem',
        tabindex: '-1',
        onclick: onClick,
      },
      icon(iconName, 14),
      h('span', { text: label }),
    );
    return el;
  }

  let disposeMenuRef = (): void => {};

  function disposeMenu(): void {
    if (menuDocHandler) {
      document.removeEventListener('mousedown', menuDocHandler, true);
      menuDocHandler = null;
    }
    if (menuKeyHandler) {
      document.removeEventListener('keydown', menuKeyHandler);
      menuKeyHandler = null;
    }
    menuOpen = false;
  }
  disposeMenuRef = disposeMenu;

  // Notices
  const noticeRoot = h('div', { class: 'notice-stack' });

  function notice(tone: 'warn' | 'danger', title: string, message: string, action?: HTMLElement): HTMLElement {
    return h(
      'div',
      { class: 'notice notice-' + tone, role: tone === 'danger' ? 'alert' : 'status' },
      h('span', { class: 'notice-icon' }, icon('alert', 16)),
      h('div', { class: 'notice-copy' }, h('strong', { text: title }), h('span', { text: message })),
      action ?? null,
    );
  }

  function pickerBanner(picked: number): HTMLElement {
    const pickedText = picked > 0 ? ' ' + formatNumber(picked) + ' ' + plural(picked, 'element') + ' hidden.' : '';
    return h(
      'div',
      { class: 'picker-banner', role: 'status' },
      h('span', { class: 'picker-live-dot', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'picker-banner-copy' },
        h('strong', { text: 'Picker active' }),
        h('span', { text: 'Click any element in ' + app.name + ' to hide it.' + pickedText }),
      ),
      h(
        'div',
        { class: 'picker-banner-actions' },
        kbd('Esc'),
        button({
          label: 'Stop picker',
          iconName: 'stop',
          variant: 'secondary',
          size: 'sm',
          onClick: () => {
            void ctx.stopPicker(app.id);
          },
        }),
      ),
    );
  }

  function layoutBanner(): HTMLElement {
    return h(
      'div',
      { class: 'picker-banner is-layout', role: 'status' },
      h('span', { class: 'picker-live-dot', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'picker-banner-copy' },
        h('strong', { text: 'Layout mode active' }),
        h('span', { text: 'Click a panel in ' + app.name + ', drag its handles, then press Save.' }),
      ),
      h(
        'div',
        { class: 'picker-banner-actions' },
        kbd('Esc'),
        button({
          label: 'Stop layout',
          iconName: 'stop',
          variant: 'secondary',
          size: 'sm',
          onClick: () => {
            void ctx.stopLayoutEditor(app.id);
          },
        }),
      ),
    );
  }

  function renderNotices(): void {
    const settings = ctx.state.settings;
    const picker = ctx.state.picker;
    const pickerActive = Boolean(picker?.active && picker.appId === app.id);
    const key = [settings?.enabled, app.lastError ?? '', pickerActive, picker?.picked ?? 0, app.layoutEditing].join('|');
    if (key === lastNoticeKey) return;
    lastNoticeKey = key;
    const nodes: HTMLElement[] = [];
    if (settings && !settings.enabled) {
      nodes.push(
        notice(
          'warn',
          'Global blocking is paused',
          'No network or cosmetic rules are applied while blocking is disabled.',
          button({
            label: 'Resume blocking',
            variant: 'secondary',
            size: 'sm',
            onClick: () => {
              void ctx.updateSetting('enabled', true);
            },
          }),
        ),
      );
    }
    if (app.lastError) {
      nodes.push(
        notice(
          'danger',
          'Action needed',
          app.lastError,
          button({
            label: 'Relaunch',
            iconName: 'refresh',
            variant: 'secondary',
            size: 'sm',
            onClick: () => {
              void ctx.appAction(app.id, 'relaunch');
            },
          }),
        ),
      );
    }
    if (pickerActive) nodes.push(pickerBanner(picker?.picked ?? 0));
    if (app.layoutEditing) nodes.push(layoutBanner());
    noticeRoot.replaceChildren(...nodes);
    noticeRoot.hidden = nodes.length === 0;
  }

  // Stats
  const statsEl = h('div', { class: 'stats-grid' });

  function statCard(options: {
    iconName: IconName;
    label: string;
    valueClass?: string;
    onClick?: () => void;
    title?: string;
  }): StatCardRefs {
    const value = h('span', { class: 'stat-value ' + (options.valueClass ?? '') });
    const sub = h('span', { class: 'stat-sub' });
    const content: Child[] = [
      h('span', { class: 'stat-label' }, icon(options.iconName, 12), h('span', { text: options.label })),
      value,
      sub,
    ];
    const el = options.onClick
      ? h('button', { class: 'stat-card is-link', type: 'button', title: options.title, onclick: options.onClick }, ...content)
      : h('div', { class: 'stat-card', title: options.title }, ...content);
    return { el, value, sub };
  }

  const blockedCard = statCard({
    iconName: 'shield',
    label: 'Blocked requests',
    onClick: () => ctx.setTab('activity'),
    title: 'Open blocked activity',
  });
  const hiddenCard = statCard({
    iconName: 'eyeOff',
    label: 'Hidden elements',
    onClick: () => ctx.setTab('hidden'),
    title: 'Open hidden elements',
  });
  const pagesCard = statCard({ iconName: 'layers', label: 'Pages' });
  const currentPageCard = statCard({ iconName: 'globe', label: 'Current page', valueClass: 'stat-value-url' });
  statsEl.append(blockedCard.el, hiddenCard.el, pagesCard.el, currentPageCard.el);

  function updateStats(): void {
    blockedCard.value.textContent = formatNumber(app.stats.blockedRequests);
    blockedCard.sub.textContent = app.stats.lastBlockedAt
      ? 'last blocked ' + relativeTime(app.stats.lastBlockedAt)
      : 'no requests blocked yet';
    hiddenCard.value.textContent = formatNumber(app.stats.hiddenElements);
    hiddenCard.sub.textContent =
      formatNumber(app.cosmeticRules.length) + ' ' + plural(app.cosmeticRules.length, 'rule') + ' configured';
    pagesCard.value.textContent = formatNumber(app.stats.pages);
    pagesCard.sub.textContent = app.attached ? 'pages seen this session' : 'attach to track pages';
    currentPageCard.value.textContent = pageLabel(app.currentUrl);
    currentPageCard.value.title = app.currentUrl ?? '';
    currentPageCard.sub.textContent =
      app.pages > 0
        ? formatNumber(app.pages) + ' open ' + plural(app.pages, 'page')
        : app.attached
          ? 'waiting for a page'
          : 'not attached';
  }

  // Tabs
  const tabbarEl = h('div', { class: 'tabbar', role: 'tablist', 'aria-label': 'Application views' });
  const tabButtons = new Map<AppTab, HTMLButtonElement>();
  const tabCounts = new Map<AppTab, HTMLElement>();

  APP_TABS.forEach((tab) => {
    const count = h('span', { class: 'tab-count' });
    const buttonEl = h(
      'button',
      {
        class: 'tab',
        type: 'button',
        role: 'tab',
        id: 'tab-' + tab,
        'aria-controls': 'panel-' + tab,
        'aria-selected': 'false',
        tabindex: '-1',
      },
      h('span', { class: 'tab-label', text: TAB_LABELS[tab] }),
      count,
    );
    buttonEl.addEventListener('click', () => ctx.setTab(tab));
    buttonEl.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = APP_TABS.indexOf(tab);
      let nextIndex = index;
      if (event.key === 'ArrowLeft') nextIndex = (index - 1 + APP_TABS.length) % APP_TABS.length;
      else if (event.key === 'ArrowRight') nextIndex = (index + 1) % APP_TABS.length;
      else if (event.key === 'Home') nextIndex = 0;
      else nextIndex = APP_TABS.length - 1;
      const next = APP_TABS[nextIndex];
      ctx.setTab(next);
      tabButtons.get(next)?.focus();
    });
    tabButtons.set(tab, buttonEl);
    tabCounts.set(tab, count);
    tabbarEl.append(buttonEl);
  });

  function tabCount(tab: AppTab): number {
    switch (tab) {
      case 'hidden':
        return app.cosmeticRules.length;
      case 'network':
        return app.networkRules.length;
      case 'layout':
        return app.layoutRules.length;
      case 'activity':
        return (ctx.state.logs[app.id] ?? []).length;
      case 'scan': {
        const scan = ctx.state.scan;
        return scan && scan.appId === app.id ? scan.candidates.length : 0;
      }
      default:
        return 0;
    }
  }

  function updateTabbar(): void {
    const active = ctx.state.tab;
    for (const [tab, tabButton] of tabButtons) {
      const selected = tab === active;
      tabButton.classList.toggle('is-active', selected);
      tabButton.setAttribute('aria-selected', String(selected));
      tabButton.tabIndex = selected ? 0 : -1;
      const count = tabCounts.get(tab);
      if (!count) continue;
      const value = tabCount(tab);
      count.textContent = value > 0 ? formatNumber(value) : '';
      count.hidden = value <= 0;
    }
  }

  const panelRoot = h('div', {
    class: 'tab-panel',
    role: 'tabpanel',
    id: 'panel-' + ctx.state.tab,
    'aria-labelledby': 'tab-' + ctx.state.tab,
  });

  function renderTab(): void {
    const factory = TAB_FACTORIES[ctx.state.tab];
    currentTab = factory(ctx, app);
    panelRoot.id = 'panel-' + ctx.state.tab;
    panelRoot.setAttribute('aria-labelledby', 'tab-' + ctx.state.tab);
    panelRoot.replaceChildren(currentTab.el);
    updateTabbar();
  }

  const el = h(
    'div',
    { class: 'page app-page' },
    headerRoot,
    toolbarRoot,
    noticeRoot,
    statsEl,
    tabbarEl,
    panelRoot,
  );

  renderHeader();
  lastHeaderKey = headerKey(app);
  renderToolbar();
  lastToolbarKey = toolbarKey(app);
  renderNotices();
  lastNoticeKey = [ctx.state.settings?.enabled, app.lastError ?? '', Boolean(ctx.state.picker?.active && ctx.state.picker.appId === app.id), ctx.state.picker?.picked ?? 0, app.layoutEditing].join('|');
  updateStats();
  renderTab();
  noticeRoot.hidden = noticeRoot.children.length === 0;

  function update(): void {
    const next = ctx.selectedApp();
    if (!next) return;
    app = next;
    const nextHeaderKey = headerKey(app);
    if (nextHeaderKey !== lastHeaderKey) {
      lastHeaderKey = nextHeaderKey;
      renderHeader();
    } else if (protectionToggle) {
      syncToggle(protectionToggle, app.enabled);
      headerRoot.querySelector('.app-head')?.classList.toggle('is-disabled', !app.enabled);
    }
    const nextToolbarKey = toolbarKey(app);
    if (nextToolbarKey !== lastToolbarKey) {
      lastToolbarKey = nextToolbarKey;
      renderToolbar();
    }
    renderNotices();
    updateStats();
    updateTabbar();
    currentTab?.update(app);
  }

  function setTab(tab: AppTab): void {
    if (ctx.state.tab !== tab) return;
    renderTab();
  }

  return {
    el,
    update,
    setTab,
    dispose: disposeMenu,
  };
}