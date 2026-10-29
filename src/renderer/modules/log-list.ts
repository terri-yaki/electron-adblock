import type { BlockedEvent } from '../../shared/types';
import { h } from './dom';
import { clockSeconds, hostOf, pageLabel, pathOf } from './format';
import { emptyState, spinner } from './primitives';

export interface LogListOptions {
  emptyTitle: string;
  emptyBody: string;
  compact?: boolean;
  max?: number;
}

export interface LogList {
  el: HTMLElement;
  update(entries: BlockedEvent[], loading?: boolean): void;
}

export function createLogList(options: LogListOptions): LogList {
  const max = options.max ?? 200;
  const el = h('div', { class: 'log-list' + (options.compact ? ' log-list-compact' : '') });
  let newestSeen = 0;
  let hasRendered = false;

  function row(entry: BlockedEvent, isNew: boolean): HTMLElement {
    const fullUrl = entry.url;
    const page = entry.pageUrl;
    return h(
      'div',
      { class: 'log-row' + (isNew ? ' is-new' : '') },
      h('span', { class: 'log-glyph' }, h('span', { class: 'log-dot' })),
      h(
        'div',
        { class: 'log-main' },
        h(
          'div',
          { class: 'log-url', title: fullUrl },
          h('span', { class: 'log-host', text: hostOf(fullUrl) }),
          h('span', { class: 'log-path', text: pathOf(fullUrl) }),
        ),
        h('div', { class: 'log-page', title: page ?? '', text: page ? 'on ' + pageLabel(page) : 'No page context' }),
      ),
      h(
        'time',
        {
          class: 'log-time',
          datetime: new Date(entry.at).toISOString(),
          title: new Date(entry.at).toLocaleString(),
          text: clockSeconds(entry.at),
        },
      ),
    );
  }

  function update(entries: BlockedEvent[], loading = false): void {
    const list = entries.slice(0, max);
    if (loading && list.length === 0) {
      el.replaceChildren(
        h(
          'div',
          { class: 'log-loading' },
          spinner(14),
          h('span', { text: 'Loading activity...' }),
        ),
      );
      return;
    }
    if (list.length === 0) {
      el.replaceChildren(
        emptyState({
          iconName: 'shield',
          title: options.emptyTitle,
          body: options.emptyBody,
          compact: true,
        }),
      );
      return;
    }
    const newest = list[0].at;
    const previousNewest = newestSeen;
    newestSeen = Math.max(newestSeen, newest);
    el.replaceChildren(...list.map((entry) => row(entry, hasRendered && entry.at > previousNewest)));
    hasRendered = true;
  }

  return { el, update };
}
