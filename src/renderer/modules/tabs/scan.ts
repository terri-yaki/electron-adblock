import type { AppView } from '../../../shared/types';
import type { Controller } from '../context';
import type { TabFactory, TabView } from '../tab-view';
import { h } from '../dom';
import { icon } from '../icons';
import { formatNumber, pageLabel, plural } from '../format';
import { button, emptyState, spinner, tag } from '../primitives';

function skeletonRow(): HTMLElement {
  return h(
    'div',
    { class: 'scan-skeleton' },
    h(
      'div',
      { class: 'scan-skeleton-main' },
      h('span', { class: 'skeleton skeleton-line is-wide' }),
      h('span', { class: 'skeleton skeleton-line' }),
    ),
    h('span', { class: 'skeleton skeleton-button' }),
  );
}

export const scanTab: TabFactory = (ctx: Controller, app: AppView): TabView => {
  const statusEl = h('span', { class: 'scan-status' });
  const panelActions = h('div', { class: 'panel-actions' });
  const metaEl = h('div', { class: 'scan-meta' });
  const resultsEl = h('div', { class: 'scan-results' });
  const el = h(
    'section',
    { class: 'card panel-card scan-panel' },
    h(
      'header',
      { class: 'panel-head' },
      h(
        'div',
        { class: 'panel-heading' },
        h('div', { class: 'panel-title-row' }, h('h2', { class: 'panel-title', text: 'Page scan' }), statusEl),
        h('p', {
          class: 'panel-desc',
          text: 'Scans the page for containers that look like ad slots and gives you a one-click hide.',
        }),
      ),
      panelActions,
    ),
    metaEl,
    resultsEl,
    h('p', {
      class: 'panel-note',
      text: 'Candidates are heuristics only. Hiding an element adds a cosmetic rule you can remove at any time.',
    }),
  );

  function currentScan() {
    return ctx.state.scan && ctx.state.scan.appId === app.id ? ctx.state.scan : null;
  }

  function renderButton(): void {
    const scan = currentScan();
    const loading = scan?.status === 'loading';
    const label = loading ? 'Scanning...' : scan?.status === 'ready' ? 'Scan again' : 'Scan page';
    panelActions.replaceChildren(
      button({
        label,
        iconName: 'scan',
        variant: 'secondary',
        disabled: !app.attached || loading,
        title: app.attached ? 'Scan the current page' : 'Attach ' + app.name + ' to scan',
        onClick: () => {
          void ctx.scan(app.id);
        },
      }),
    );
  }

  function renderResults(): void {
    const scan = currentScan();
    if (!app.attached) {
      statusEl.className = 'scan-status';
      statusEl.textContent = 'Not attached';
      metaEl.textContent = '';
      resultsEl.replaceChildren(
        emptyState({
          iconName: 'plug',
          title: 'Attach to scan this app',
          body: 'Page scan needs a live debugging connection to ' + app.name + '.',
          action: button({
            label: 'Attach ' + app.name,
            iconName: 'plug',
            variant: 'secondary',
            onClick: () => {
              void ctx.appAction(app.id, 'attach');
            },
          }),
        }),
      );
      return;
    }
    if (scan?.status === 'loading') {
      statusEl.className = 'scan-status is-loading';
      statusEl.replaceChildren(spinner(11), h('span', { text: 'Scanning' }));
      metaEl.textContent = app.currentUrl ? 'Scanning ' + pageLabel(app.currentUrl) : 'Scanning the current page';
      resultsEl.replaceChildren(skeletonRow(), skeletonRow(), skeletonRow());
      return;
    }
    statusEl.className = 'scan-status';
    statusEl.textContent = scan?.status === 'ready' ? formatNumber(scan.candidates.length) + ' found' : '';
    metaEl.textContent = app.currentUrl ? 'Current page: ' + pageLabel(app.currentUrl) : 'No page has been reported yet.';
    if (scan?.status === 'error') {
      resultsEl.replaceChildren(
        h(
          'div',
          { class: 'inline-error' },
          h('span', { class: 'inline-error-icon' }, icon('alert', 16)),
          h(
            'div',
            { class: 'inline-error-copy' },
            h('strong', { text: 'Page scan failed' }),
            h('p', { text: scan.error ?? 'The scan did not complete.' }),
          ),
          button({
            label: 'Try again',
            variant: 'secondary',
            size: 'sm',
            onClick: () => {
              void ctx.scan(app.id);
            },
          }),
        ),
      );
      return;
    }
    if (!scan || scan.status !== 'ready') {
      resultsEl.replaceChildren(
        emptyState({
          iconName: 'scan',
          title: 'Ready to scan',
          body: 'Look for advertisement containers on the current page.',
          action: button({
            label: 'Scan page',
            iconName: 'scan',
            variant: 'secondary',
            onClick: () => {
              void ctx.scan(app.id);
            },
          }),
        }),
      );
      return;
    }
    if (scan.candidates.length === 0) {
      resultsEl.replaceChildren(
        emptyState({
          iconName: 'check',
          title: 'No obvious ad containers',
          body: 'This page looks clean to the scanner. Try again after navigating or scrolling.',
        }),
      );
      return;
    }
    resultsEl.replaceChildren(...scan.candidates.map((candidate) => renderCandidate(candidate)));
  }

  function renderCandidate(candidate: { selector: string; tag: string; reason: string; matchCount: number; width: number; height: number }): HTMLElement {
    const scan = currentScan();
    const hidden = Boolean(scan?.hiddenSelectors.includes(candidate.selector));
    const action = hidden
      ? h('span', { class: 'hidden-chip' }, icon('check', 12), h('span', { text: 'Hidden' }))
      : button({
          label: 'Hide',
          iconName: 'eyeOff',
          variant: 'secondary',
          size: 'sm',
          onClick: () => {
            void ctx.hideCandidate(app.id, candidate);
          },
        });
    return h(
      'div',
      { class: 'scan-row' + (hidden ? ' is-hidden' : '') },
      h(
        'div',
        { class: 'scan-selector' },
        h('code', { class: 'mono scan-code', title: candidate.selector, text: candidate.selector }),
        h(
          'div',
          { class: 'scan-reason' },
          tag(candidate.tag, 'neutral'),
          h('span', { class: 'scan-reason-text', text: candidate.reason }),
        ),
      ),
      h(
        'div',
        { class: 'scan-dimensions' },
        h('span', { text: formatNumber(candidate.matchCount) + ' ' + plural(candidate.matchCount, 'match', 'matches') }),
        h('span', { class: 'mono', text: candidate.width + ' x ' + candidate.height }),
      ),
      action,
    );
  }

  function update(next: AppView): void {
    app = next;
    renderButton();
    renderResults();
  }

  update(app);
  return { el, update };
};