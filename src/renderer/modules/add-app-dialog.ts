import type { DiscoveredApp } from '../../shared/types';
import type { Controller } from './context';
import { h } from './dom';
import { icon } from './icons';
import { fileName, truncateMiddle } from './format';
import { button, emptyState, iconButton, letterAvatar, spinner } from './primitives';

function pathKey(exePath: string): string {
  return exePath.trim().toLowerCase();
}

export function openAddAppDialog(ctx: Controller): void {
  let disposed = false;
  const addedThisSession = new Set<string>();
  let detected: DiscoveredApp[] = [];
  let loading = false;
  let error: string | null = null;
  let browsing = false;

  const listEl = h('div', { class: 'detected-list' });
  const refreshBtn = iconButton({ iconName: 'refresh', label: 'Rescan for applications' });
  const browseBtn = button({
    label: 'Browse for .exe',
    iconName: 'folder',
    variant: 'secondary',
    onClick: () => {
      void browse();
    },
  });

  const body = h(
    'div',
    { class: 'add-dialog' },
    h(
      'section',
      { class: 'add-section' },
      h('div', { class: 'modal-label-row' }, h('span', { class: 'eyebrow', text: 'Detected on this PC' }), refreshBtn),
      listEl,
    ),
    h('div', { class: 'modal-divider' }),
    h(
      'section',
      { class: 'browse-section' },
      h(
        'div',
        { class: 'browse-copy' },
        h('div', { class: 'browse-title', text: 'Choose an executable' }),
        h('p', { class: 'browse-desc', text: "Pick another Electron app's .exe file from disk." }),
      ),
      browseBtn,
    ),
  );

  const handle = ctx.dialogs.open({
    title: 'Add application',
    subtitle: 'Detected Electron apps, plus manual selection.',
    body,
    width: 560,
    onClose: () => {
      disposed = true;
    },
  });

  async function browse(): Promise<void> {
    if (browsing) return;
    browsing = true;
    browseBtn.disabled = true;
    try {
      const exePath = await ctx.chooseExecutable();
      if (!exePath || disposed) return;
      const app = await ctx.addAppFromPath(exePath);
      if (app && !disposed) handle.close();
    } finally {
      browsing = false;
      browseBtn.disabled = false;
    }
  }

  function skeleton(): HTMLElement {
    return h(
      'div',
      { class: 'detected-skeleton' },
      h('span', { class: 'skeleton skeleton-avatar' }),
      h(
        'span',
        { class: 'skeleton-lines' },
        h('span', { class: 'skeleton skeleton-line is-wide' }),
        h('span', { class: 'skeleton skeleton-line' }),
      ),
    );
  }

  function render(): void {
    if (disposed) return;
    refreshBtn.disabled = loading;
    refreshBtn.classList.toggle('is-spinning', loading);
    if (loading) {
      listEl.replaceChildren(skeleton(), skeleton());
      return;
    }
    if (error) {
      listEl.replaceChildren(
        h(
          'div',
          { class: 'inline-error' },
          h('span', { class: 'inline-error-icon' }, icon('alert', 16)),
          h('div', { class: 'inline-error-copy' }, h('strong', { text: 'Could not scan for apps' }), h('p', { text: error })),
          button({ label: 'Retry', variant: 'secondary', size: 'sm', onClick: () => void loadDetected() }),
        ),
      );
      return;
    }
    if (detected.length === 0) {
      listEl.replaceChildren(
        emptyState({
          iconName: 'grid',
          title: 'No Electron apps detected',
          body: 'Everything detectable is already managed. Browse for an .exe instead.',
          compact: true,
        }),
      );
      return;
    }
    listEl.replaceChildren(...detected.map((entry) => renderRow(entry)));
  }

  function renderRow(entry: DiscoveredApp): HTMLElement {
    const key = pathKey(entry.exePath);
    const existing = ctx.state.apps.find((app) => pathKey(app.exePath) === key);
    const added = Boolean(existing) || addedThisSession.has(key);
    const action: HTMLElement = added
      ? h('span', { class: 'added-chip' }, icon('check', 12), h('span', { text: 'Added' }))
      : button({
          label: 'Add',
          variant: 'secondary',
          size: 'sm',
          onClick: (event) => {
            const target = event.currentTarget as HTMLButtonElement;
            void add(entry, target);
          },
        });
    return h(
      'div',
      { class: 'detected-row' + (added ? ' is-added' : '') },
      letterAvatar(entry.name, 32),
      h(
        'div',
        { class: 'detected-copy' },
        h('div', { class: 'detected-name', text: entry.name }),
        h('div', { class: 'detected-path mono', title: entry.exePath, text: truncateMiddle(fileName(entry.exePath), 52) }),
      ),
      h('div', { class: 'detected-source' }, h('span', { class: 'detected-source-label', text: sourceLabel(entry.source) })),
      action,
    );
  }

  async function add(entry: DiscoveredApp, btn: HTMLButtonElement): Promise<void> {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.replaceChildren(spinner(12), h('span', { text: 'Adding' }));
    const app = await ctx.addAppFromPath(entry.exePath);
    if (disposed) return;
    if (app) {
      addedThisSession.add(pathKey(entry.exePath));
    }
    render();
  }

  function sourceLabel(source: DiscoveredApp['source']): string {
    switch (source) {
      case 'running':
        return 'Running';
      case 'manual':
        return 'Manual';
      case 'preset':
        return 'Preset';
      default:
        return 'Start menu';
    }
  }

  async function loadDetected(): Promise<void> {
    if (loading || disposed) return;
    loading = true;
    error = null;
    render();
    const apps = await ctx.listDetectedApps();
    if (disposed) return;
    if (apps) detected = apps;
    else error = 'The scan did not complete.';
    loading = false;
    render();
  }

  refreshBtn.addEventListener('click', () => {
    void loadDetected();
  });
  void loadDetected();
}