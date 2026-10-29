import type { AppView, CosmeticRuleSource, LayoutRuleSource, NetworkRuleSource } from '../../shared/types';
import { h, type Child } from './dom';
import { icon, type IconName } from './icons';

export type Tone = 'neutral' | 'green' | 'blue' | 'amber' | 'red' | 'accent';

export interface StatusInfo {
  label: string;
  tone: Tone;
  hint: string;
}

export function statusInfo(app: AppView): StatusInfo {
  switch (app.status) {
    case 'attached':
      return { label: 'Attached', tone: 'green', hint: 'Connected to this app and filtering its pages.' };
    case 'running':
      return app.canAttach
        ? { label: 'Running', tone: 'blue', hint: 'Running with a debugging port. Attach to start filtering.' }
        : {
            label: 'Running',
            tone: 'neutral',
            hint: 'Running without a debugging port. Relaunch it through Electron Adblock to attach.',
          };
    case 'launching':
      return { label: 'Launching', tone: 'amber', hint: 'Starting the app with remote debugging enabled.' };
    case 'error':
      return { label: 'Error', tone: 'red', hint: app.lastError ?? 'The last action failed.' };
    default:
      return { label: 'Not running', tone: 'neutral', hint: 'The app is not running.' };
  }
}

export function statusPill(app: AppView): HTMLElement {
  const info = statusInfo(app);
  return h(
    'span',
    { class: 'status-pill tone-' + info.tone + (app.status === 'launching' ? ' is-pulsing' : ''), title: info.hint },
    h('span', { class: 'status-dot' }),
    h('span', { text: info.label }),
  );
}

export function tag(label: string, tone: Tone = 'neutral'): HTMLElement {
  return h('span', { class: 'tag tone-' + tone, text: label });
}

const COSMETIC_SOURCES: Record<CosmeticRuleSource, { label: string; tone: Tone }> = {
  picker: { label: 'Picked', tone: 'accent' },
  manual: { label: 'Manual', tone: 'neutral' },
  suggestion: { label: 'Suggested', tone: 'blue' },
  preset: { label: 'Preset', tone: 'blue' },
};

const NETWORK_SOURCES: Record<NetworkRuleSource, { label: string; tone: Tone }> = {
  manual: { label: 'Manual', tone: 'neutral' },
  preset: { label: 'Preset', tone: 'blue' },
  default: { label: 'Built-in', tone: 'blue' },
};

const LAYOUT_SOURCES: Record<LayoutRuleSource, { label: string; tone: Tone }> = {
  layout: { label: 'Layout', tone: 'accent' },
  manual: { label: 'Manual', tone: 'neutral' },
  preset: { label: 'Preset', tone: 'blue' },
};

export function cosmeticSourceTag(source: CosmeticRuleSource): HTMLElement {
  const info = COSMETIC_SOURCES[source] ?? COSMETIC_SOURCES.manual;
  return tag(info.label, info.tone);
}

export function networkSourceTag(source: NetworkRuleSource): HTMLElement {
  const info = NETWORK_SOURCES[source] ?? NETWORK_SOURCES.manual;
  return tag(info.label, info.tone);
}

export function layoutSourceTag(source: LayoutRuleSource): HTMLElement {
  const info = LAYOUT_SOURCES[source] ?? LAYOUT_SOURCES.manual;
  return tag(info.label, info.tone);
}

export function kbd(label: string): HTMLElement {
  return h('kbd', { class: 'kbd', text: label });
}

export interface ButtonOptions {
  label: string;
  iconName?: IconName;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'ghost-danger';
  size?: 'sm' | 'md';
  onClick?: (event: MouseEvent) => void;
  title?: string;
  disabled?: boolean;
  ariaLabel?: string;
  shortcut?: string;
  className?: string;
  type?: 'button' | 'submit';
}

export function button(options: ButtonOptions): HTMLButtonElement {
  const size = options.size ?? 'md';
  const children: Child[] = [];
  if (options.iconName) children.push(h('span', { class: 'btn-icon' }, icon(options.iconName, size === 'sm' ? 13 : 14)));
  children.push(h('span', { class: 'btn-label', text: options.label }));
  if (options.shortcut) children.push(kbd(options.shortcut));
  const className = ['btn', 'btn-' + (options.variant ?? 'secondary'), 'btn-' + size, options.className ?? '']
    .filter(Boolean)
    .join(' ');
  const el = h(
    'button',
    {
      class: className,
      type: options.type ?? 'button',
      title: options.title,
      disabled: options.disabled,
      'aria-label': options.ariaLabel,
    },
    ...children,
  );
  if (options.onClick) el.addEventListener('click', options.onClick);
  return el;
}

export function iconButton(options: {
  iconName: IconName;
  label: string;
  onClick?: (event: MouseEvent) => void;
  title?: string;
  disabled?: boolean;
  className?: string;
  variant?: 'ghost' | 'secondary';
}): HTMLButtonElement {
  const el = h(
    'button',
    {
      class: ['icon-btn', options.variant === 'secondary' ? 'icon-btn-bordered' : '', options.className ?? '']
        .filter(Boolean)
        .join(' '),
      type: 'button',
      'aria-label': options.label,
      title: options.title ?? options.label,
      disabled: options.disabled,
    },
    icon(options.iconName, 15),
  );
  if (options.onClick) el.addEventListener('click', options.onClick);
  return el;
}

export function toggle(options: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}): HTMLButtonElement {
  const el = h(
    'button',
    {
      class: 'toggle' + (options.checked ? ' is-on' : ''),
      type: 'button',
      role: 'switch',
      'aria-checked': String(options.checked),
      'aria-label': options.label,
      disabled: options.disabled,
    },
    h('span', { class: 'toggle-knob' }),
  );
  el.addEventListener('click', () => {
    if (el.disabled) return;
    const next = el.getAttribute('aria-checked') !== 'true';
    syncToggle(el, next);
    options.onChange(next);
  });
  return el;
}

export function syncToggle(el: HTMLButtonElement, checked: boolean): void {
  el.setAttribute('aria-checked', String(checked));
  el.classList.toggle('is-on', checked);
}

export function spinner(size = 14, className = ''): HTMLElement {
  const el = h('span', { class: 'spinner ' + className, 'aria-hidden': 'true' });
  el.style.width = String(size) + 'px';
  el.style.height = String(size) + 'px';
  return el;
}

export function eyebrow(label: string): HTMLElement {
  return h('p', { class: 'eyebrow', text: label });
}

function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return (words[0].slice(0, 1) + words[1].slice(0, 1)).toUpperCase();
}

export function letterAvatar(name: string, size = 32): HTMLElement {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  const el = h('span', {
    class: 'avatar avatar-tone-' + String(hash % 5),
    'aria-hidden': 'true',
  });
  el.style.width = String(size) + 'px';
  el.style.height = String(size) + 'px';
  el.style.fontSize = String(Math.max(10, Math.round(size * 0.32))) + 'px';
  el.textContent = initials(name);
  return el;
}

export function appAvatar(app: AppView, size = 32): HTMLElement {
  if (!app.iconDataUrl) return letterAvatar(app.name, size);
  const wrap = h('span', { class: 'avatar avatar-image', 'aria-hidden': 'true' });
  wrap.style.width = String(size) + 'px';
  wrap.style.height = String(size) + 'px';
  wrap.append(h('img', { src: app.iconDataUrl, alt: '', draggable: 'false' }));
  return wrap;
}

export interface EmptyStateOptions {
  iconName: IconName;
  title: string;
  body: string;
  action?: HTMLElement;
  compact?: boolean;
  className?: string;
}

export function emptyState(options: EmptyStateOptions): HTMLElement {
  const el = h(
    'div',
    { class: ['empty', options.compact ? 'empty-compact' : '', options.className ?? ''].filter(Boolean).join(' ') },
    h('span', { class: 'empty-icon' }, icon(options.iconName, options.compact ? 16 : 20)),
    h('h3', { class: 'empty-title', text: options.title }),
    h('p', { class: 'empty-body', text: options.body }),
  );
  if (options.action) el.append(options.action);
  return el;
}

export function toneDot(tone: Tone): HTMLElement {
  return h('span', { class: 'dot tone-' + tone });
}

export function fieldLabel(label: string, forId?: string): HTMLLabelElement {
  return h('label', { class: 'field-label', for: forId, text: label });
}