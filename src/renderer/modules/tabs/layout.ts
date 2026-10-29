import type { AppView, LayoutRule } from '../../../shared/types';
import type { Controller } from '../context';
import type { TabFactory, TabView } from '../tab-view';
import { h } from '../dom';
import { icon } from '../icons';
import { formatNumber } from '../format';
import { button, emptyState, iconButton, layoutSourceTag, tag, toggle } from '../primitives';

export interface ParsedDeclarations {
  declarations: Record<string, string>;
  error?: string;
}

const PROPERTY_PATTERN = /^-{0,2}[a-zA-Z][a-zA-Z0-9-]*$/;
const LAYER_PROPERTIES = new Set([
  'z-index',
  'position',
  'order',
  'inset',
  'top',
  'right',
  'bottom',
  'left',
  'transform',
  'isolation',
  'mix-blend-mode',
]);

function isLayerProperty(property: string): boolean {
  return LAYER_PROPERTIES.has(property.toLowerCase());
}

export function parseDeclarations(input: string): ParsedDeclarations {
  const text = input.trim();
  if (!text)
    return {
      declarations: {},
      error: 'Add at least one declaration, for example z-index: 5; position: relative.',
    };
  const declarations: Record<string, string> = {};
  for (const chunk of text.split(';')) {
    const part = chunk.trim();
    if (!part) continue;
    const colon = part.indexOf(':');
    if (colon <= 0) {
      return { declarations: {}, error: 'Use CSS declarations such as z-index: 5; position: relative.' };
    }
    const property = part.slice(0, colon).trim();
    const value = part.slice(colon + 1).trim();
    if (!property || !value) {
      return { declarations: {}, error: 'Every declaration needs a property and a value.' };
    }
    if (!PROPERTY_PATTERN.test(property)) {
      return { declarations: {}, error: 'Invalid CSS property: ' + property };
    }
    if (value.length > 200) {
      return { declarations: {}, error: 'Declaration values must be 200 characters or fewer.' };
    }
    declarations[property] = value;
  }
  const count = Object.keys(declarations).length;
  if (count === 0)
    return {
      declarations: {},
      error: 'Add at least one declaration, for example z-index: 5; position: relative.',
    };
  if (count > 20) return { declarations: {}, error: 'Use 20 declarations or fewer.' };
  return { declarations };
}

export function formatDeclarations(declarations: Record<string, string>): string {
  return Object.entries(declarations)
    .map(([property, value]) => property + ': ' + value)
    .join('; ');
}

function countPill(): HTMLElement {
  return h('span', { class: 'count-pill' });
}

export const layoutTab: TabFactory = (ctx: Controller, app: AppView): TabView => {
  const countEl = countPill();
  const headerActions = h('div', { class: 'panel-actions' });
  const listEl = h('div', { class: 'rule-list' });
  const selectorInput = h('input', {
    id: 'layout-selector-input',
    class: 'text-input',
    type: 'text',
    placeholder: 'div[class*="left-rail"]',
    'aria-label': 'Layout rule selector',
    spellcheck: 'false',
    autocomplete: 'off',
  });
  const declarationsInput = h('textarea', {
    id: 'layout-declarations-input',
    class: 'text-input layout-decl-input',
    rows: '2',
    placeholder: 'z-index: 5; position: relative',
    'aria-label': 'Layout declarations',
    spellcheck: 'false',
  });
  const addBtn = button({ label: 'Add fix', iconName: 'plus', variant: 'secondary', type: 'submit' });
  const addLabel = addBtn.querySelector('.btn-label') as HTMLElement;
  const form = h(
    'form',
    { class: 'layout-add-row' },
    h(
      'div',
      { class: 'layout-field' },
      h('label', { class: 'layout-field-label', for: 'layout-selector-input', text: 'Selector' }),
      selectorInput,
    ),
    h(
      'div',
      { class: 'layout-field' },
      h('label', { class: 'layout-field-label', for: 'layout-declarations-input', text: 'Declarations' }),
      declarationsInput,
    ),
    addBtn,
  );
  const el = h(
    'section',
    { class: 'card panel-card layout-panel' },
    h(
      'header',
      { class: 'panel-head' },
      h(
        'div',
        { class: 'panel-heading' },
        h('div', { class: 'panel-title-row' }, h('h2', { class: 'panel-title', text: 'Layout fixes' }), countEl),
        h('p', {
          class: 'panel-desc',
          text: 'Hiding an ad can leave empty space. Resize the panels around it, or reorder overlapping layers.',
        }),
      ),
      headerActions,
    ),
    form,
    h('p', {
      class: 'form-hint',
      text: 'Examples: height: auto closes a gap; z-index: 5; position: relative reorders a layer. Layer declarations are highlighted blue.',
    }),
    listEl,
    h('p', {
      class: 'panel-note',
      text: 'Adjust layout opens the visual editor with resize handles and layer controls. Or declare size and z-index by hand; rules apply to every page in ' + app.name + '.',
    }),
  );

  let busy = false;

  function setBusy(value: boolean): void {
    busy = value;
    addBtn.disabled = value;
    addLabel.textContent = value ? 'Adding...' : 'Add fix';
  }

  async function addRule(): Promise<void> {
    if (busy) return;
    const selector = selectorInput.value.trim();
    if (!selector) {
      ctx.toast('error', 'Enter a selector for the panel you want to adjust.');
      selectorInput.focus();
      return;
    }
    const parsed = parseDeclarations(declarationsInput.value);
    if (parsed.error) {
      ctx.toast('error', parsed.error);
      declarationsInput.focus();
      return;
    }
    setBusy(true);
    const ok = await ctx.addLayoutRule(app.id, { selector, declarations: parsed.declarations, source: 'manual' });
    setBusy(false);
    if (ok) {
      selectorInput.value = '';
      declarationsInput.value = '';
      selectorInput.focus();
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void addRule();
  });

  function renderHeaderAction(): void {
    const pickerActive = Boolean(ctx.state.picker?.active && ctx.state.picker.appId === app.id);
    const resetButton = button({
      label: 'Reset appearance',
      iconName: 'reset',
      variant: 'secondary',
      size: 'sm',
      title: 'Remove all hidden elements and layout/layer fixes for ' + app.name,
      onClick: () => {
        ctx.requestResetAppearance(app.id);
      },
    });
    if (app.layoutEditing) {
      headerActions.replaceChildren(tag('Editing on page', 'blue'), resetButton);
      return;
    }
    headerActions.replaceChildren(
      resetButton,
      button({
        label: 'Adjust layout',
        iconName: 'layout',
        variant: 'primary',
        disabled: !app.attached || pickerActive,
        title: !app.attached
          ? 'Attach ' + app.name + ' to adjust its layout'
          : pickerActive
            ? 'Stop the element picker first'
            : 'Click a panel on the page and resize it',
        onClick: () => {
          void ctx.startLayoutEditor(app.id);
        },
      }),
    );
  }

  function declarationChips(rule: LayoutRule): HTMLElement[] {
    const entries = Object.entries(rule.declarations);
    if (entries.length === 0) return [h('span', { class: 'decl-chip mono', text: 'no declarations' })];
    return entries.map(([property, value]) => {
      const layer = isLayerProperty(property);
      return h('span', {
        class: 'decl-chip mono' + (layer ? ' is-layer' : ''),
        title: property + ': ' + value + (layer ? ' (layer order)' : ''),
        text: property + ': ' + value,
      });
    });
  }

  function renderRule(rule: LayoutRule): HTMLElement {
    return h(
      'div',
      { class: 'rule-row layout-rule-row' + (rule.enabled ? '' : ' is-paused') },
      h('span', { class: 'rule-icon' }, icon('layout', 15)),
      h(
        'div',
        { class: 'rule-main' },
        h('code', { class: 'rule-pattern mono', title: rule.selector, text: rule.selector }),
        h(
          'div',
          { class: 'rule-meta' },
          h('span', { class: 'decl-chips' }, ...declarationChips(rule)),
          layoutSourceTag(rule.source),
          rule.label ? h('span', { class: 'rule-label', text: rule.label }) : null,
        ),
      ),
      h(
        'div',
        { class: 'rule-controls' },
        toggle({
          checked: rule.enabled,
          label: 'Enable layout fix ' + rule.selector,
          onChange: (next) => {
            void ctx.updateLayoutRule(app.id, rule.id, { enabled: next });
          },
        }),
        iconButton({
          iconName: 'trash',
          label: 'Delete layout fix ' + rule.selector,
          title: 'Delete fix',
          className: 'icon-btn-danger',
          onClick: () => {
            void ctx.removeLayoutRule(app.id, rule.id);
          },
        }),
      ),
    );
  }

  function update(next: AppView): void {
    app = next;
    countEl.textContent = formatNumber(app.layoutRules.length);
    renderHeaderAction();
    if (app.layoutRules.length === 0) {
      listEl.replaceChildren(
        emptyState({
          iconName: 'layout',
          title: 'No layout fixes yet',
          body: 'Hiding an ad can leave a gap. Use Adjust layout, or declare size and layer rules below.',
          compact: true,
        }),
      );
      return;
    }
    listEl.replaceChildren(...app.layoutRules.map(renderRule));
  }

  update(app);
  return { el, update };
};