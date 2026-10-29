import type { AppView } from '../../../shared/types';
import type { Controller } from '../context';
import type { TabFactory, TabView } from '../tab-view';
import { h } from '../dom';
import { icon } from '../icons';
import { formatNumber, hotkeyLabel } from '../format';
import { button, kbd } from '../primitives';
import { createLogList } from '../log-list';

export const overviewTab: TabFactory = (ctx: Controller, app: AppView): TabView => {
  const heroState = h('span', { class: 'hero-state' });
  const heroDesc = h('p', { class: 'hero-desc' });
  const heroActions = h('div', { class: 'hero-actions' });
  const heroFoot = h('div', { class: 'hero-foot' });
  const hero = h(
    'section',
    { class: 'card hero-card' },
    h(
      'div',
      { class: 'hero-eyebrow-row' },
      h('span', { class: 'hero-icon' }, icon('picker', 16)),
      h('span', { class: 'eyebrow', text: 'Element picker' }),
      heroState,
    ),
    h('h2', { class: 'hero-title', text: 'Remove ads visually' }),
    heroDesc,
    heroActions,
    heroFoot,
  );

  const hiddenCount = h('span', { class: 'summary-count' });
  const networkCount = h('span', { class: 'summary-count' });
  const layoutCount = h('span', { class: 'summary-count' });
  const scanBtn = button({
    label: 'Scan page',
    iconName: 'scan',
    variant: 'secondary',
    size: 'sm',
    onClick: () => ctx.setTab('scan'),
  });
  const scanCard = h(
    'section',
    { class: 'card quick-card' },
    h('div', { class: 'quick-head' }, h('span', { class: 'quick-icon' }, icon('scan', 15)), h('h2', { class: 'quick-title', text: 'Page scan' })),
    h('p', { class: 'quick-desc', text: 'Find likely ad containers on the current page and hide them in one click.' }),
    h('div', { class: 'quick-foot' }, scanBtn),
  );

  function summaryRow(iconName: 'eyeOff' | 'shield' | 'layout', label: string, count: HTMLElement, onClick: () => void): HTMLElement {
    return h(
      'button',
      { class: 'summary-row', type: 'button', onclick: onClick },
      h('span', { class: 'summary-icon' }, icon(iconName, 15)),
      h('span', { class: 'summary-label', text: label }),
      count,
      h('span', { class: 'summary-chevron' }, icon('chevronRight', 14)),
    );
  }

  const summaryCard = h(
    'section',
    { class: 'card rule-summary-card' },
    summaryRow('eyeOff', 'Hidden elements', hiddenCount, () => ctx.setTab('hidden')),
    h('div', { class: 'summary-divider' }),
    summaryRow('shield', 'Network rules', networkCount, () => ctx.setTab('network')),
    h('div', { class: 'summary-divider' }),
    summaryRow('layout', 'Layout fixes', layoutCount, () => ctx.setTab('layout')),
  );

  const preview = createLogList({
    compact: true,
    max: 6,
    emptyTitle: 'No blocked requests yet',
    emptyBody: 'Filtered requests will appear here live.',
  });
  const activityCard = h(
    'section',
    { class: 'card activity-preview-card' },
    h(
      'header',
      { class: 'card-head' },
      h(
        'div',
        { class: 'card-head-main' },
        h('h2', { class: 'card-title', text: 'Recent activity' }),
        h('span', { class: 'live-pill' }, h('span', { class: 'live-dot' }), h('span', { text: 'Live' })),
      ),
      button({
        label: 'View all',
        variant: 'ghost',
        size: 'sm',
        iconName: 'arrowRight',
        onClick: () => ctx.setTab('activity'),
      }),
    ),
    preview.el,
  );

  const el = h(
    'div',
    { class: 'overview' },
    h('div', { class: 'overview-grid' }, hero, h('div', { class: 'overview-rail' }, scanCard, summaryCard)),
    activityCard,
  );

  function renderHero(): void {
    const pickerState = ctx.state.picker;
    const active = Boolean(pickerState?.active && pickerState.appId === app.id);
    hero.classList.toggle('is-active', active);
    heroState.textContent = active ? 'Picker active' : '';
    const hotkey = ctx.state.settings?.pickerHotkey ?? '';
    heroDesc.textContent = app.attached
      ? 'Click any element in ' + app.name + ' to hide it with a single click. Rules apply instantly.'
      : 'Attach ' + app.name + ' to start hiding elements visually.';
    if (active) {
      heroActions.replaceChildren(
        h(
          'span',
          { class: 'hero-active-note' },
          h('span', { class: 'hero-active-dot' }),
          h('span', { text: 'Picker is running in ' + app.name }),
        ),
      );
      heroFoot.replaceChildren(
        kbd('Esc'),
        h('span', { class: 'hero-foot-note', text: 'Press Esc or use the banner to stop' }),
      );
      return;
    }
    const primary = button({
      label: 'Start picker',
      iconName: 'picker',
      variant: 'primary',
      disabled: !app.attached,
      title: app.attached ? 'Pick an element on the page' : 'Attach ' + app.name + ' to use the picker',
      onClick: () => {
        void ctx.startPicker(app.id);
      },
    });
    heroActions.replaceChildren(primary);
    heroFoot.replaceChildren(
      kbd(hotkeyLabel(hotkey)),
      h('span', {
        class: 'hero-foot-note',
        text: app.attached ? 'Global shortcut' : 'Attach the app first',
      }),
    );
  }

  function update(next: AppView): void {
    app = next;
    renderHero();
    hiddenCount.textContent = formatNumber(app.cosmeticRules.length);
    networkCount.textContent = formatNumber(app.networkRules.length);
    layoutCount.textContent = formatNumber(app.layoutRules.length);
    scanBtn.disabled = !app.attached;
    scanBtn.title = app.attached ? 'Scan the current page for ad containers' : 'Attach ' + app.name + ' to scan';
    preview.update(ctx.state.logs[app.id] ?? [], !ctx.state.logsLoaded[app.id]);
  }

  update(app);
  return { el, update };
};