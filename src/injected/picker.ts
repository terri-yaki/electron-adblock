// Element picker overlay: blocks page interaction, highlights the hovered element,
// reports picks and applies them optimistically. Listener state is fully torn down on stop.
import type { PickReport } from '../shared/types';
import type { ReportFn } from './messages';
import { buildSelector, describeElement, elementTagName } from './selector';

const OVERLAY_ATTRIBUTE = 'data-electron-adblock';
const PICKER_ATTRIBUTE = 'data-electron-adblock-picker';
const MAX_Z_INDEX = '2147483647';
const HINT_TEXT = 'click to hide | Alt+click parent | Esc to finish';
const MAX_LABEL_SELECTOR_LENGTH = 90;

export interface PickerOptions {
  excludeSelectors?: string[];
}

export interface PickerDeps {
  report: ReportFn;
  onPick: (selector: string) => void;
}

interface BoundListener {
  type: string;
  handler: EventListener;
  capture: boolean;
}

type StyleMap = Record<string, string>;

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'picker: unknown error';
}

function applyStyles(element: HTMLElement, styles: StyleMap): void {
  const style = element.style as unknown as Record<string, string>;
  for (const property of Object.keys(styles)) {
    const value = styles[property];
    if (typeof value !== 'string') continue;
    try {
      style[property] = value;
    } catch {
      // Unsupported property, keep going.
    }
  }
}

function px(value: number): string {
  return Math.round(value) + 'px';
}

function clamp(value: number, min: number, max: number): number {
  const upper = Math.max(min, max);
  return Math.min(Math.max(value, min), upper);
}

export class ElementPicker {
  private readonly doc: Document;
  private readonly deps: PickerDeps;
  private readonly listeners: BoundListener[] = [];
  private options: PickerOptions = {};
  private root: HTMLDivElement | null = null;
  private highlight: HTMLDivElement | null = null;
  private label: HTMLDivElement | null = null;
  private active = false;
  private picked = 0;
  private pointerX = -1;
  private pointerY = -1;
  private hovered: Element | null = null;
  private rafId: number | null = null;

  constructor(deps: PickerDeps, doc: Document) {
    this.deps = deps;
    this.doc = doc;
  }

  get isActive(): boolean {
    return this.active;
  }

  start(options?: PickerOptions): void {
    if (this.active) {
      this.requestHighlight();
      return;
    }
    this.options = options && typeof options === 'object' ? options : {};
    this.active = true;
    this.picked = 0;
    this.pointerX = -1;
    this.pointerY = -1;
    this.hovered = null;
    try {
      this.createOverlay();
      this.bindListeners();
    } catch (error) {
      this.active = false;
      this.teardown();
      this.deps.report({ type: 'error', message: messageOf(error) });
      return;
    }
    this.deps.report({ type: 'picker-state', active: true, picked: 0 });
  }

  stop(): void {
    this.active = false;
    this.teardown();
    this.deps.report({ type: 'picker-state', active: false, picked: this.picked });
  }

  private createOverlay(): void {
    const parent = this.doc.documentElement ?? this.doc.body;
    if (!parent) throw new Error('picker: document root unavailable');

    const root = this.doc.createElement('div');
    root.setAttribute(OVERLAY_ATTRIBUTE, '');
    root.setAttribute(PICKER_ATTRIBUTE, '');
    root.setAttribute('aria-hidden', 'true');
    applyStyles(root, {
      all: 'initial',
      position: 'fixed',
      top: '0',
      left: '0',
      right: '0',
      bottom: '0',
      width: '100%',
      height: '100%',
      margin: '0',
      padding: '0',
      border: '0',
      background: 'transparent',
      pointerEvents: 'none',
      zIndex: MAX_Z_INDEX,
      display: 'block',
      overflow: 'visible',
    });

    const highlight = this.doc.createElement('div');
    applyStyles(highlight, {
      all: 'initial',
      position: 'fixed',
      display: 'none',
      pointerEvents: 'none',
      zIndex: MAX_Z_INDEX,
      boxSizing: 'border-box',
      border: '2px solid #ff5a5f',
      borderRadius: '2px',
      background: 'rgba(255, 90, 95, 0.16)',
      boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.35)',
      margin: '0',
      padding: '0',
    });

    const label = this.doc.createElement('div');
    applyStyles(label, {
      all: 'initial',
      position: 'fixed',
      display: 'none',
      pointerEvents: 'none',
      zIndex: MAX_Z_INDEX,
      boxSizing: 'border-box',
      margin: '0',
      padding: '4px 8px',
      border: '0',
      borderRadius: '4px',
      background: '#111318',
      color: '#f4f6f8',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: '12px',
      fontWeight: '500',
      lineHeight: '1.4',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      maxWidth: '92vw',
      boxShadow: '0 2px 10px rgba(0, 0, 0, 0.45)',
    });

    root.appendChild(highlight);
    root.appendChild(label);
    parent.appendChild(root);
    this.root = root;
    this.highlight = highlight;
    this.label = label;
  }

  private bindListeners(): void {
    this.addListener('mousedown', (event) => this.handleMouseDown(event), { passive: false });
    this.addListener('mouseup', (event) => this.blockMouse(event), { passive: false });
    this.addListener('click', (event) => this.handleClick(event), { passive: false });
    this.addListener('keydown', (event) => this.handleKeyDown(event), { passive: false });
    this.addListener('contextmenu', (event) => this.blockMouse(event), { passive: false });
    this.addListener('dblclick', (event) => this.blockMouse(event), { passive: false });
    this.addListener('pointerdown', (event) => this.swallow(event), { passive: true });
    this.addListener('pointerup', (event) => this.swallow(event), { passive: true });
    this.addListener('pointermove', (event) => this.swallow(event), { passive: true });
    this.addListener('mousemove', (event) => this.handleMouseMove(event), { passive: true });
    this.addListener('scroll', () => this.requestHighlight(), { passive: true });
    this.addListener('resize', () => this.requestHighlight(), { passive: true });
  }

  private addListener(type: string, handler: (event: Event) => void, options: AddEventListenerOptions = {}): void {
    try {
      window.addEventListener(type, handler, { capture: true, ...options });
      this.listeners.push({ type, handler: handler as EventListener, capture: true });
    } catch {
      // Ignore listeners the frame rejects.
    }
  }

  private blockMouse(event: Event): void {
    if (!this.active) return;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  // Pointer events are swallowed without preventDefault so click generation stays intact.
  private swallow(event: Event): void {
    if (!this.active) return;
    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  private trackPointer(event: Event): void {
    if (!(event instanceof MouseEvent)) return;
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    this.requestHighlight();
  }

  private handleMouseDown(event: Event): void {
    this.trackPointer(event);
    this.blockMouse(event);
  }

  private handleMouseMove(event: Event): void {
    this.trackPointer(event);
  }

  private handleKeyDown(event: Event): void {
    if (!this.active) return;
    const isEscape =
      event instanceof KeyboardEvent && (event.key === 'Escape' || event.key === 'Esc' || event.code === 'Escape');
    if (isEscape) {
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      this.stop();
      return;
    }
    this.blockMouse(event);
  }

  private handleClick(event: Event): void {
    if (!this.active) return;
    this.blockMouse(event);
    if (event instanceof MouseEvent) this.applyPick(event);
  }

  private applyPick(event: MouseEvent): void {
    const hovered = this.elementAt(event.clientX, event.clientY);
    if (!hovered) return;
    const rawTarget = event.altKey ? hovered.parentElement : hovered;
    if (!rawTarget) return;
    const target = this.toDocumentElement(rawTarget);
    if (!target || !this.isPickable(target)) return;

    const built = buildSelector(target, this.doc);
    if (built.selector.length === 0) return;
    const rect = target.getBoundingClientRect();
    const payload: PickReport = {
      selector: built.selector,
      label: describeElement(target),
      matchCount: built.matchCount,
      frameUrl: this.frameUrl(),
      tag: elementTagName(target),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };

    this.picked += 1;
    try {
      this.deps.onPick(built.selector);
    } catch {
      // Keep the picker usable even if the optimistic apply fails.
    }
    this.deps.report({ type: 'pick', payload });
    this.deps.report({ type: 'picker-state', active: true, picked: this.picked });
    this.requestHighlight();
  }

  private toDocumentElement(element: Element): Element | null {
    let current: Element | null = element;
    while (current && current.getRootNode() !== this.doc) {
      const root = current.getRootNode();
      current =
        typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot ? (root.host as Element) : null;
    }
    return current;
  }

  private elementAt(x: number, y: number): Element | null {
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return null;
    try {
      const element = this.doc.elementFromPoint(x, y);
      if (!element) return null;
      if (this.root && this.root.contains(element)) return null;
      return element;
    } catch {
      return null;
    }
  }

  private isPickable(element: Element): boolean {
    const tag = elementTagName(element);
    if (tag === 'html' || tag === 'body') return false;
    if (this.root && this.root.contains(element)) return false;
    if (element.hasAttribute(PICKER_ATTRIBUTE)) return false;
    const excluded = this.options.excludeSelectors ?? [];
    for (const selector of excluded) {
      try {
        if (element.matches(selector)) return false;
      } catch {
        // Ignore invalid exclusion selectors.
      }
    }
    return true;
  }

  private formatLabel(element: Element, selector: string, matchCount: number): string {
    const tag = elementTagName(element);
    const selectorText =
      selector.length > MAX_LABEL_SELECTOR_LENGTH
        ? selector.slice(0, MAX_LABEL_SELECTOR_LENGTH - 3) + '...'
        : selector;
    const matchText = matchCount === 1 ? '1 match' : matchCount + ' matches';
    return tag + ' | ' + selectorText + ' | ' + matchText + ' | ' + HINT_TEXT;
  }

  private requestHighlight(): void {
    if (!this.active || this.rafId !== null) return;
    try {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this.updateHighlight();
      });
    } catch {
      this.rafId = null;
      this.updateHighlight();
    }
  }

  private cancelHighlight(): void {
    if (this.rafId === null) return;
    try {
      cancelAnimationFrame(this.rafId);
    } catch {
      // Animation frame already gone.
    }
    this.rafId = null;
  }

  // Recomputes the highlight from the last pointer position (scroll, resize, pick).
  private updateHighlight(): void {
    if (!this.active || !this.highlight || !this.label) return;
    const element = this.elementAt(this.pointerX, this.pointerY);
    const target = element ? this.toDocumentElement(element) : null;
    if (!target || !this.isPickable(target)) {
      this.hideHighlight();
      this.hovered = null;
      return;
    }
    if (target !== this.hovered) {
      this.hovered = target;
      const built = buildSelector(target, this.doc);
      this.label.textContent = this.formatLabel(target, built.selector, built.matchCount);
    }

    const view = this.doc.defaultView;
    const viewportWidth = view ? view.innerWidth : 0;
    const viewportHeight = view ? view.innerHeight : 0;
    const rect = target.getBoundingClientRect();
    this.highlight.style.display = 'block';
    this.highlight.style.left = px(rect.left);
    this.highlight.style.top = px(rect.top);
    this.highlight.style.width = px(Math.max(0, rect.width));
    this.highlight.style.height = px(Math.max(0, rect.height));

    this.label.style.display = 'block';
    const labelWidth = this.label.offsetWidth;
    const labelHeight = this.label.offsetHeight;
    let labelTop = rect.top - labelHeight - 6;
    if (labelTop < 4) labelTop = rect.bottom + 6;
    const maxTop = Math.max(4, viewportHeight - labelHeight - 4);
    const maxLeft = Math.max(4, viewportWidth - labelWidth - 4);
    this.label.style.top = px(clamp(labelTop, 4, maxTop));
    this.label.style.left = px(clamp(rect.left, 4, maxLeft));
  }

  private hideHighlight(): void {
    if (this.highlight) this.highlight.style.display = 'none';
    if (this.label) this.label.style.display = 'none';
  }

  private frameUrl(): string {
    try {
      return this.doc.location?.href ?? '';
    } catch {
      return '';
    }
  }

  private teardown(): void {
    this.cancelHighlight();
    for (const listener of this.listeners) {
      try {
        window.removeEventListener(listener.type, listener.handler, { capture: listener.capture });
      } catch {
        // Listener already gone.
      }
    }
    this.listeners.length = 0;
    if (this.root) {
      try {
        this.root.remove();
      } catch {
        // Overlay already detached.
      }
    }
    this.root = null;
    this.highlight = null;
    this.label = null;
    this.hovered = null;
    this.pointerX = -1;
    this.pointerY = -1;
  }
}
