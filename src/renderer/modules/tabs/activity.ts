import type { AppView } from '../../../shared/types';
import type { Controller } from '../context';
import type { TabFactory, TabView } from '../tab-view';
import { h } from '../dom';
import { formatNumber, plural } from '../format';
import { button } from '../primitives';
import { createLogList } from '../log-list';

export const activityTab: TabFactory = (ctx: Controller, app: AppView): TabView => {
  const list = createLogList({
    emptyTitle: 'No blocked requests yet',
    emptyBody: 'Requests filtered for ' + app.name + ' appear here in real time.',
  });
  const countEl = h('span', { class: 'count-pill' });
  const clearBtn = button({
    label: 'Clear',
    iconName: 'trash',
    variant: 'ghost',
    size: 'sm',
    title: 'Clear activity log',
  });
  const el = h(
    'section',
    { class: 'card panel-card activity-panel' },
    h(
      'header',
      { class: 'panel-head' },
      h(
        'div',
        { class: 'panel-heading' },
        h(
          'div',
          { class: 'panel-title-row' },
          h('h2', { class: 'panel-title', text: 'Blocked activity' }),
          h('span', { class: 'live-pill' }, h('span', { class: 'live-dot' }), h('span', { text: 'Live' })),
          countEl,
        ),
        h('p', { class: 'panel-desc', text: 'Live log of requests filtered for ' + app.name + '. Newest first.' }),
      ),
      h('div', { class: 'panel-actions' }, clearBtn),
    ),
    list.el,
  );

  let busy = false;

  async function clear(): Promise<void> {
    if (busy) return;
    busy = true;
    update(app);
    await ctx.clearActivity(app.id);
    busy = false;
    update(app);
  }

  clearBtn.addEventListener('click', () => {
    void clear();
  });

  function update(next: AppView): void {
    app = next;
    const logs = ctx.state.logs[app.id] ?? [];
    countEl.textContent = formatNumber(logs.length) + ' ' + plural(logs.length, 'event');
    clearBtn.disabled = busy || logs.length === 0;
    list.update(logs, !ctx.state.logsLoaded[app.id]);
  }

  update(app);
  return { el, update };
};