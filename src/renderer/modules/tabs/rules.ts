import type { AppView, CosmeticRule, NetworkRule } from '../../../shared/types';
import type { Controller } from '../context';
import type { TabFactory, TabView } from '../tab-view';
import { h } from '../dom';
import { icon } from '../icons';
import { formatNumber, plural } from '../format';
import { button, cosmeticSourceTag, emptyState, iconButton, networkSourceTag, toggle } from '../primitives';

function panelHead(
  title: string,
  count: HTMLElement,
  description: string,
  actions: HTMLElement[] = [],
): HTMLElement {
  return h(
    'header',
    { class: 'panel-head' },
    h(
      'div',
      { class: 'panel-heading' },
      h('div', { class: 'panel-title-row' }, h('h2', { class: 'panel-title', text: title }), count),
      h('p', { class: 'panel-desc', text: description }),
    ),
    actions.length > 0 ? h('div', { class: 'panel-actions' }, ...actions) : null,
  );
}

function countPill(): HTMLElement {
  return h('span', { class: 'count-pill' });
}

export const hiddenTab: TabFactory = (ctx: Controller, app: AppView): TabView => {
  const countEl = countPill();
  const listEl = h('div', { class: 'rule-list' });
  const input = h('input', {
    class: 'text-input',
    type: 'text',
    placeholder: 'div[class*="ad"]',
    'aria-label': 'CSS selector to hide',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const addBtn = button({ label: 'Add rule', iconName: 'plus', variant: 'secondary', type: 'submit' });
  const addLabel = addBtn.querySelector('.btn-label') as HTMLElement;
  const form = h('form', { class: 'add-rule-row' }, input, addBtn);
  const resetIcon = iconButton({
    iconName: 'reset',
    label: 'Reset appearance',
    title: 'Remove all hidden elements and layout/layer fixes',
    onClick: () => {
      ctx.requestResetAppearance(app.id);
    },
  });
  const layoutCalloutButton = button({
    label: 'Adjust layout',
    iconName: 'layout',
    variant: 'secondary',
    size: 'sm',
    onClick: () => {
      void ctx.startLayoutEditor(app.id);
    },
  });
  const layoutCallout = h(
    'div',
    { class: 'layout-callout' },
    h('span', { class: 'layout-callout-icon' }, icon('layout', 16)),
    h(
      'div',
      { class: 'layout-callout-copy' },
      h('strong', { text: 'Leftover gap after hiding an ad?' }),
      h('p', { text: 'Layout fixes resize panels or reorder layers around the hole left behind.' }),
    ),
    layoutCalloutButton,
  );
  const el = h(
    'section',
    { class: 'card panel-card rules-panel' },
    panelHead(
      'Hidden elements',
      countEl,
      'CSS selectors applied to pages in ' + app.name + '. Toggle one to pause it without deleting it.',
      [resetIcon],
    ),
    form,
    h('p', {
      class: 'form-hint',
      text: 'Paste a selector, or use Pick element for a visual selection while the app is attached.',
    }),
    listEl,
    layoutCallout,
  );

  let busy = false;

  function setBusy(value: boolean): void {
    busy = value;
    addBtn.disabled = value;
    addLabel.textContent = value ? 'Adding...' : 'Add rule';
  }

  async function addRule(): Promise<void> {
    if (busy) return;
    const selector = input.value.trim();
    if (!selector) {
      ctx.toast('error', 'Enter a CSS selector to hide.');
      input.focus();
      return;
    }
    setBusy(true);
    const ok = await ctx.addCosmeticRule(app.id, { selector, source: 'manual' });
    setBusy(false);
    if (ok) {
      input.value = '';
      input.focus();
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void addRule();
  });

  function renderRule(rule: CosmeticRule): HTMLElement {
    return h(
      'div',
      { class: 'rule-row' + (rule.enabled ? '' : ' is-paused') },
      h('span', { class: 'rule-icon' }, icon('eyeOff', 15)),
      h(
        'div',
        { class: 'rule-main' },
        h('code', { class: 'rule-pattern mono', title: rule.selector, text: rule.selector }),
        h(
          'div',
          { class: 'rule-meta' },
          cosmeticSourceTag(rule.source),
          rule.label ? h('span', { class: 'rule-label', text: rule.label }) : null,
          rule.urlPattern ? h('span', { class: 'rule-scope mono', title: rule.urlPattern, text: rule.urlPattern }) : null,
        ),
      ),
      h(
        'div',
        { class: 'rule-controls' },
        toggle({
          checked: rule.enabled,
          label: 'Enable hidden element ' + rule.selector,
          onChange: (next) => {
            void ctx.updateCosmeticRule(app.id, rule.id, { enabled: next });
          },
        }),
        iconButton({
          iconName: 'trash',
          label: 'Delete hidden element ' + rule.selector,
          title: 'Delete rule',
          className: 'icon-btn-danger',
          onClick: () => {
            void ctx.removeCosmeticRule(app.id, rule.id);
          },
        }),
      ),
    );
  }

  function update(next: AppView): void {
    app = next;
    countEl.textContent = formatNumber(app.cosmeticRules.length);
    const pickerActive = Boolean(ctx.state.picker?.active && ctx.state.picker.appId === app.id);
    const resetCount = app.cosmeticRules.length + app.layoutRules.length;
    resetIcon.title = resetCount > 0 ? 'Remove all hidden elements and layout/layer fixes' : 'Nothing to reset';
    resetIcon.setAttribute('aria-label', resetCount > 0 ? 'Reset appearance' : 'Nothing to reset');
    layoutCallout.hidden = app.cosmeticRules.length === 0;
    layoutCalloutButton.disabled = !app.attached || pickerActive;
    layoutCalloutButton.title = !app.attached
      ? 'Attach ' + app.name + ' to adjust its layout'
      : pickerActive
        ? 'Stop the element picker first'
        : 'Click a panel on the page and resize it';
    if (app.cosmeticRules.length === 0) {
      listEl.replaceChildren(
        emptyState({
          iconName: 'eyeOff',
          title: 'No hidden elements',
          body: 'Pick an element in ' + app.name + ', or add a CSS selector above.',
          compact: true,
        }),
      );
      return;
    }
    listEl.replaceChildren(...app.cosmeticRules.map(renderRule));
  }

  update(app);
  return { el, update };
};

export const networkTab: TabFactory = (ctx: Controller, app: AppView): TabView => {
  const countEl = countPill();
  const listEl = h('div', { class: 'rule-list' });
  const input = h('input', {
    class: 'text-input',
    type: 'text',
    placeholder: 'ads.example.com or *doubleclick*',
    'aria-label': 'Network rule pattern',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const addBtn = button({ label: 'Add domain', iconName: 'plus', variant: 'secondary', type: 'submit' });
  const addLabel = addBtn.querySelector('.btn-label') as HTMLElement;
  const form = h('form', { class: 'add-rule-row' }, input, addBtn);
  const el = h(
    'section',
    { class: 'card panel-card rules-panel' },
    panelHead(
      'Network rules',
      countEl,
      'Requests matching these patterns are dropped before they load in ' + app.name + '.',
    ),
    form,
    h('p', {
      class: 'form-hint',
      text: 'Use * as a wildcard. Built-in ad domains are controlled globally in Settings.',
    }),
    listEl,
  );

  let busy = false;

  function setBusy(value: boolean): void {
    busy = value;
    addBtn.disabled = value;
    addLabel.textContent = value ? 'Adding...' : 'Add domain';
  }

  async function addRule(): Promise<void> {
    if (busy) return;
    const pattern = input.value.trim();
    if (!pattern) {
      ctx.toast('error', 'Enter a domain or glob pattern to block.');
      input.focus();
      return;
    }
    if (/\s/.test(pattern)) {
      ctx.toast('error', 'Patterns cannot contain spaces.');
      input.focus();
      return;
    }
    setBusy(true);
    const ok = await ctx.addNetworkRule(app.id, pattern);
    setBusy(false);
    if (ok) {
      input.value = '';
      input.focus();
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void addRule();
  });

  function renderRule(rule: NetworkRule): HTMLElement {
    return h(
      'div',
      { class: 'rule-row' + (rule.enabled ? '' : ' is-paused') },
      h('span', { class: 'rule-icon' }, icon('shield', 15)),
      h(
        'div',
        { class: 'rule-main' },
        h('code', { class: 'rule-pattern mono', title: rule.pattern, text: rule.pattern }),
        h('div', { class: 'rule-meta' }, networkSourceTag(rule.source)),
      ),
      h(
        'div',
        { class: 'rule-controls' },
        toggle({
          checked: rule.enabled,
          label: 'Enable network rule ' + rule.pattern,
          onChange: (next) => {
            void ctx.updateNetworkRule(app.id, rule.id, { enabled: next });
          },
        }),
        iconButton({
          iconName: 'trash',
          label: 'Delete network rule ' + rule.pattern,
          title: 'Delete rule',
          className: 'icon-btn-danger',
          onClick: () => {
            void ctx.removeNetworkRule(app.id, rule.id);
          },
        }),
      ),
    );
  }

  function update(next: AppView): void {
    app = next;
    countEl.textContent = formatNumber(app.networkRules.length);
    if (app.networkRules.length === 0) {
      listEl.replaceChildren(
        emptyState({
          iconName: 'shield',
          title: 'No network rules',
          body: 'Add an ad domain or a glob pattern to block its requests.',
          compact: true,
        }),
      );
      return;
    }
    listEl.replaceChildren(...app.networkRules.map(renderRule));
  }

  update(app);
  return { el, update };
};