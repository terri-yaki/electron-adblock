export type Child = Node | string | number | null | undefined | false;

export interface ElementProps {
  class?: string;
  text?: string;
  /** Static trusted markup only. Never pass user or API data. */
  html?: string;
  dataset?: Record<string, string>;
  [key: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElementProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyProps(el, props);
  appendChildren(el, children);
  return el;
}

function applyProps(el: HTMLElement, props: ElementProps): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') {
      el.className = String(value);
      continue;
    }
    if (key === 'text') {
      el.textContent = String(value);
      continue;
    }
    if (key === 'html') {
      el.innerHTML = String(value);
      continue;
    }
    if (key === 'dataset' && typeof value === 'object') {
      Object.assign(el.dataset, value as Record<string, string>);
      continue;
    }
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      continue;
    }
    if (key === 'value' && 'value' in el) {
      (el as unknown as { value: string }).value = String(value);
      continue;
    }
    if (key === 'checked' && 'checked' in el) {
      (el as HTMLInputElement).checked = Boolean(value);
      continue;
    }
    if (key === 'disabled') {
      (el as HTMLButtonElement).disabled = Boolean(value);
      continue;
    }
    el.setAttribute(key, value === true ? '' : String(value));
  }
}

export function appendChildren(parent: ParentNode, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(parent, child);
      continue;
    }
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el: Element): void {
  el.replaceChildren();
}

export function frag(...children: Child[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  appendChildren(fragment, children);
  return fragment;
}

export function text(value: string | number | null | undefined, className?: string): HTMLSpanElement {
  const el = h('span', className ? { class: className } : {});
  el.textContent = value === null || value === undefined ? '' : String(value);
  return el;
}

/** Runs an async task without ever leaving an unhandled rejection. */
export function guard(task: Promise<unknown>, onError: (error: unknown) => void): void {
  void task.catch(onError);
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}