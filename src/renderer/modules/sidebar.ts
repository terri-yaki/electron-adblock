import type { AppView } from '../../shared/types';
import type { Controller } from './context';
import { h } from './dom';
import { icon } from './icons';
import { formatNumber } from './format';
import { appAvatar, iconButton, statusInfo } from './primitives';

interface RowRefs {
  root: HTMLButtonElement;
  avatar: HTMLElement;
  name: HTMLElement;
  badge: HTMLElement;
  dot: HTMLElement;
  status: HTMLElement;
  blocked: HTMLElement;
  blockedValue: HTMLElement;
}

export interface SidebarComponent {
  el: HTMLElement;
  update(): void;
}

export function createSidebar(ctx: Controller): SidebarComponent {
  const countEl = h('span', { class: 'sidebar-count' });
  const refreshBtn = iconButton({ iconName: 'refresh', label: 'Refresh applications', variant: 'ghost' });
  const addBtn = iconButton({ iconName: 'plus', label: 'Add application', variant: 'secondary' });
  const listEl = h('div', { class: 'app-list' });
  const emptyEl = h(
    'div',
    { class: 'sidebar-empty' },
    h('p', { text: 'No applications yet.' }),
    h(
      'button',
      { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => ctx.addApplication() },
      h('span', { class: 'btn-label', text: 'Add application' }),
    ),
  );
  const settingsBtn = h(
    'button',
    { class: 'nav-settings', type: 'button', onclick: () => ctx.openSettings() },
    h('span', { class: 'nav-icon' }, icon('settings', 16)),
    h('span', { class: 'nav-label', text: 'Settings' }),
    h('span', { class: 'nav-chevron' }, icon('chevronRight', 14)),
  );
  const versionEl = h('span', { class: 'sidebar-version' });
  const el = h(
    'aside',
    { class: 'sidebar', 'aria-label': 'Application list' },
    h(
      'div',
      { class: 'sidebar-head' },
      h('span', { class: 'section-label', text: 'Applications' }),
      countEl,
      h('div', { class: 'sidebar-head-actions' }, refreshBtn, addBtn),
    ),
    listEl,
    h('div', { class: 'sidebar-foot' }, settingsBtn, versionEl),
  );

  const rows = new Map<string, RowRefs>();

  function buildRow(app: AppView): RowRefs {
    const avatar = appAvatar(app, 30);
    const name = h('span', { class: 'row-name' });
    const badge = h('span', { class: 'row-badge', text: 'Attached' });
    const dot = h('span', { class: 'row-dot' });
    const status = h('span', { class: 'row-status' });
    const blockedValue = h('span', { class: 'row-blocked-value' });
    const blocked = h('span', { class: 'row-blocked' }, icon('shield', 11), blockedValue);
    const root = h(
      'button',
      {
        class: 'app-row',
        type: 'button',
        onclick: () => ctx.selectApp(app.id),
      },
      h('span', { class: 'row-avatar' }, avatar),
      h(
        'span',
        { class: 'row-text' },
        h('span', { class: 'row-name-line' }, name, badge),
        h('span', { class: 'row-sub' }, dot, status),
      ),
      blocked,
    );
    return { root, avatar, name, badge, dot, status, blocked, blockedValue };
  }

  function updateRow(refs: RowRefs, app: AppView, selected: boolean): void {
    const info = statusInfo(app);
    refs.name.textContent = app.name;
    refs.status.textContent = app.attached ? 'Live filtering' : info.label;
    refs.dot.className = 'row-dot tone-' + info.tone;
    refs.badge.hidden = !app.attached;
    refs.blocked.hidden = false;
    refs.blockedValue.textContent = formatNumber(app.stats.blockedRequests);
    refs.blocked.classList.toggle('is-zero', app.stats.blockedRequests === 0);
    refs.root.classList.toggle('is-active', selected);
    refs.root.classList.toggle('is-disabled', !app.enabled);
    refs.root.title = app.name + ' - ' + info.label + ' - ' + formatNumber(app.stats.blockedRequests) + ' blocked';
    refs.root.setAttribute('aria-current', selected ? 'page' : 'false');
    refs.root.setAttribute(
      'aria-label',
      app.name + ', ' + info.label + ', ' + formatNumber(app.stats.blockedRequests) + ' blocked requests',
    );
  }

  function update(): void {
    const state = ctx.state;
    countEl.textContent = String(state.apps.length);
    if (versionEl.textContent !== 'v' + (state.version?.app ?? '')) {
      versionEl.textContent = state.version ? 'v' + state.version.app : '';
    }
    settingsBtn.classList.toggle('is-active', state.view === 'settings');
    const selectedId = state.view === 'app' ? state.selectedAppId : null;
    const known = new Set(state.apps.map((app) => app.id));
    for (const [id, refs] of rows) {
      if (!known.has(id)) {
        refs.root.remove();
        rows.delete(id);
      }
    }
    const ordered: HTMLElement[] = [];
    for (const app of state.apps) {
      let refs = rows.get(app.id);
      if (!refs) {
        refs = buildRow(app);
        rows.set(app.id, refs);
      }
      updateRow(refs, app, app.id === selectedId);
      ordered.push(refs.root);
    }
    ordered.forEach((node, index) => {
      if (listEl.children[index] !== node) {
        listEl.insertBefore(node, listEl.children[index] ?? null);
      }
    });
    if (state.apps.length === 0) {
      if (!emptyEl.isConnected) listEl.append(emptyEl);
    } else if (emptyEl.isConnected) {
      emptyEl.remove();
    }
  }

  refreshBtn.addEventListener('click', () => {
    if (refreshBtn.disabled) return;
    refreshBtn.disabled = true;
    refreshBtn.classList.add('is-spinning');
    void ctx.refreshApplications().finally(() => {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('is-spinning');
    });
  });
  addBtn.addEventListener('click', () => ctx.addApplication());

  update();
  return { el, update };
}