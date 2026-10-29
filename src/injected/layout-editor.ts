// Layout editor overlay: pick a panel, resize it with 8 handles, apply presets, then
// Save. Listener state and the temporary preview stylesheet are fully torn down on exit.
import type { LayoutReport } from '../shared/types';
import type { ReportFn } from './messages';
import { LayoutStyles } from './layout';
import { buildSelector, describeElement, elementTagName } from './selector';

const ROOT_ATTR = 'data-eab-layout-root';
const BOX_ATTR = 'data-eab-layout-box';
const HANDLE_ATTR = 'data-eab-layout-handle';
const ACTION_ATTR = 'data-eab-layout-action';
const TOOLBAR_ATTR = 'data-eab-layout-toolbar';
const HOVER_ATTR = 'data-eab-layout-hover';
const LABEL_ATTR = 'data-eab-layout-label';
const PREVIEW_ATTR = 'data-electron-adblock-layout-preview';
const MAX_Z_INDEX = '2147483647';
const HANDLE_SIZE = 12;
const MIN_SIZE = 24;
const HINT_TEXT = 'Click a panel to adjust it, drag the handles, then Save | Esc cancels';

const HANDLE_DIRECTIONS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
type HandleDirection = (typeof HANDLE_DIRECTIONS)[number];

const HANDLE_CURSORS: Record<HandleDirection, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

const HANDLE_POSITIONS: Record<HandleDirection, StyleMap> = {
  n: { top: '-' + HANDLE_SIZE / 2 + 'px', left: '50%', transform: 'translateX(-50%)' },
  s: { bottom: '-' + HANDLE_SIZE / 2 + 'px', left: '50%', transform: 'translateX(-50%)' },
  e: { right: '-' + HANDLE_SIZE / 2 + 'px', top: '50%', transform: 'translateY(-50%)' },
  w: { left: '-' + HANDLE_SIZE / 2 + 'px', top: '50%', transform: 'translateY(-50%)' },
  ne: { top: '-' + HANDLE_SIZE / 2 + 'px', right: '-' + HANDLE_SIZE / 2 + 'px' },
  nw: { top: '-' + HANDLE_SIZE / 2 + 'px', left: '-' + HANDLE_SIZE / 2 + 'px' },
  se: { bottom: '-' + HANDLE_SIZE / 2 + 'px', right: '-' + HANDLE_SIZE / 2 + 'px' },
  sw: { bottom: '-' + HANDLE_SIZE / 2 + 'px', left: '-' + HANDLE_SIZE / 2 + 'px' },
};

const PRESET_FILL_WIDTH: Record<string, string> = {
  width: '100%',
  'max-width': 'none',
  flex: '1 1 auto',
};
const PRESET_FILL_HEIGHT: Record<string, string> = { height: '100%' };
const PRESET_AUTO: Record<string, string> = { width: 'auto', height: 'auto', flex: '0 0 auto' };

const TOOLBAR_ACTIONS: ReadonlyArray<{ action: string; label: string; primary?: boolean }> = [
  { action: 'fill-width', label: 'Fill width' },
  { action: 'fill-height', label: 'Fill height' },
  { action: 'auto', label: 'Auto' },
  { action: 'reset', label: 'Reset' },
  { action: 'save', label: 'Save', primary: true },
  { action: 'cancel', label: 'Cancel' },
];

type StyleMap = Record<string, string>;

interface SelectionState {
  element: Element;
  selector: string;
  label: string;
  matches: number;
  declarations: Record<string, string>;
}

interface DragState {
  handle: HandleDirection;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
}

interface BoundListener {
  type: string;
  handler: EventListener;
  capture: boolean;
}

export interface LayoutEditorDeps {
  report: ReportFn;
  onSave: (report: LayoutReport) => void;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'layout-editor: unknown error';
}

function isHandleDirection(value: string | null): value is HandleDirection {
  if (value === null) return false;
  return (HANDLE_DIRECTIONS as readonly string[]).indexOf(value) >= 0;
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

function matchesText(count: number): string {
  return count === 1 ? '1 match' : count + ' matches';
}

export class LayoutEditor {
  private readonly doc: Document;
  private readonly deps: LayoutEditorDeps;
  private readonly listeners: BoundListener[] = [];
  private readonly handles = new Map<HandleDirection, HTMLDivElement>();
  private readonly preview: LayoutStyles;
  private root: HTMLDivElement | null = null;
  private hoverBox: HTMLDivElement | null = null;
  private box: HTMLDivElement | null = null;
  private toolbar: HTMLDivElement | null = null;
  private label: HTMLDivElement | null = null;
  private active = false;
  private selection: SelectionState | null = null;
  private drag: DragState | null = null;
  private hovered: Element | null = null;
  private hoverInfo = '';
  private pointerX = -1;
  private pointerY = -1;
  private rafId: number | null = null;
  private savedCursor: string | null = null;
  private ignoreNextClick = false;

  constructor(deps: LayoutEditorDeps, doc: Document) {
    this.deps = deps;
    this.doc = doc;
    this.preview = new LayoutStyles(doc, PREVIEW_ATTR);
  }

  get isActive(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.selection = null;
    this.drag = null;
    this.hovered = null;
    this.hoverInfo = '';
    this.pointerX = -1;
    this.pointerY = -1;
    this.ignoreNextClick = false;
    try {
      this.createChrome();
      this.bindListeners();
    } catch (error) {
      this.active = false;
      this.teardown();
      this.deps.report({ type: 'error', message: messageOf(error) });
      return;
    }
    this.updateLabel();
    this.deps.report({ type: 'layout-editor', active: true });
  }

  stop(): void {
    const wasActive = this.active;
    this.active = false;
    this.teardown();
    if (wasActive) this.deps.report({ type: 'layout-editor', active: false });
  }

  private createChrome(): void {
    const parent = this.doc.documentElement ?? this.doc.body;
    if (!parent) throw new Error('layout-editor: document root unavailable');

    const root = this.doc.createElement('div');
    root.setAttribute(ROOT_ATTR, '');
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

    const hoverBox = this.doc.createElement('div');
    hoverBox.setAttribute(HOVER_ATTR, '');
    applyStyles(hoverBox, {
      all: 'initial',
      position: 'fixed',
      display: 'none',
      pointerEvents: 'none',
      zIndex: MAX_Z_INDEX,
      boxSizing: 'border-box',
      border: '1px dashed rgba(120, 170, 255, 0.95)',
      background: 'rgba(76, 141, 255, 0.1)',
      margin: '0',
      padding: '0',
    });

    const box = this.doc.createElement('div');
    box.setAttribute(BOX_ATTR, '');
    applyStyles(box, {
      all: 'initial',
      position: 'fixed',
      display: 'none',
      pointerEvents: 'none',
      zIndex: MAX_Z_INDEX,
      boxSizing: 'border-box',
      border: '2px solid #4c8dff',
      background: 'transparent',
      margin: '0',
      padding: '0',
    });

    for (const direction of HANDLE_DIRECTIONS) {
      const handle = this.doc.createElement('div');
      handle.setAttribute(HANDLE_ATTR, direction);
      applyStyles(handle, {
        all: 'initial',
        position: 'absolute',
        pointerEvents: 'auto',
        width: HANDLE_SIZE + 'px',
        height: HANDLE_SIZE + 'px',
        background: '#f4f6f8',
        border: '1px solid #2f6bff',
        borderRadius: '2px',
        boxSizing: 'border-box',
        margin: '0',
        padding: '0',
        cursor: HANDLE_CURSORS[direction],
        zIndex: MAX_Z_INDEX,
      });
      applyStyles(handle, HANDLE_POSITIONS[direction]);
      box.appendChild(handle);
      this.handles.set(direction, handle);
    }

    const toolbar = this.doc.createElement('div');
    toolbar.setAttribute(TOOLBAR_ATTR, '');
    applyStyles(toolbar, {
      all: 'initial',
      position: 'fixed',
      display: 'none',
      pointerEvents: 'auto',
      zIndex: MAX_Z_INDEX,
      boxSizing: 'border-box',
      alignItems: 'center',
      gap: '6px',
      margin: '0',
      padding: '6px',
      border: '1px solid #2c3340',
      borderRadius: '8px',
      background: '#12151c',
      boxShadow: '0 6px 20px rgba(0, 0, 0, 0.45)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: '12px',
      lineHeight: '1.3',
      whiteSpace: 'nowrap',
      color: '#f4f6f8',
    });

    for (const item of TOOLBAR_ACTIONS) {
      const button = this.doc.createElement('button');
      button.setAttribute(ACTION_ATTR, item.action);
      button.setAttribute('type', 'button');
      button.textContent = item.label;
      applyStyles(button, {
        all: 'initial',
        pointerEvents: 'auto',
        boxSizing: 'border-box',
        display: 'inline-block',
        margin: '0',
        padding: '4px 9px',
        border: '1px solid ' + (item.primary ? '#2f6bff' : '#39404d'),
        borderRadius: '4px',
        background: item.primary ? '#2f6bff' : '#1d222c',
        color: item.primary ? '#ffffff' : '#f4f6f8',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: '12px',
        fontWeight: '500',
        lineHeight: '1.3',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      });
      toolbar.appendChild(button);
    }

    const label = this.doc.createElement('div');
    label.setAttribute(LABEL_ATTR, '');
    applyStyles(label, {
      all: 'initial',
      position: 'fixed',
      top: '10px',
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'block',
      pointerEvents: 'none',
      zIndex: MAX_Z_INDEX,
      boxSizing: 'border-box',
      margin: '0',
      padding: '5px 10px',
      border: '0',
      borderRadius: '5px',
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

    root.appendChild(hoverBox);
    root.appendChild(box);
    root.appendChild(toolbar);
    root.appendChild(label);
    parent.appendChild(root);
    this.root = root;
    this.hoverBox = hoverBox;
    this.box = box;
    this.toolbar = toolbar;
    this.label = label;
  }

  private bindListeners(): void {
    this.addListener('mousedown', (event) => this.handleMouseDown(event), { passive: false });
    this.addListener('mouseup', (event) => this.handleMouseUp(event), { passive: false });
    this.addListener('click', (event) => this.handleClick(event), { passive: false });
    this.addListener('keydown', (event) => this.handleKeyDown(event), { passive: false });
    this.addListener('contextmenu', (event) => this.block(event), { passive: false });
    this.addListener('dblclick', (event) => this.block(event), { passive: false });
    this.addListener('pointerdown', (event) => this.swallow(event), { passive: true });
    this.addListener('pointerup', (event) => this.swallow(event), { passive: true });
    this.addListener('pointermove', (event) => this.swallow(event), { passive: true });
    this.addListener('mousemove', (event) => this.handleMouseMove(event), { passive: true });
    // Wheel scrolling is intentionally left untouched; scroll only refreshes the chrome.
    this.addListener('scroll', () => this.requestSync(), { passive: true });
    this.addListener('resize', () => this.requestSync(), { passive: true });
  }

  private addListener(type: string, handler: (event: Event) => void, options: AddEventListenerOptions = {}): void {
    try {
      window.addEventListener(type, handler, { capture: true, ...options });
      this.listeners.push({ type, handler: handler as EventListener, capture: true });
    } catch {
      // Ignore listeners the frame rejects.
    }
  }

  private block(event: Event): void {
    if (!this.active && event.type !== 'scroll') return;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  private swallow(event: Event): void {
    if (!this.active) return;
    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  private handleMouseDown(event: Event): void {
    if (!this.active) return;
    this.block(event);
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const handleElement = target.closest('[' + HANDLE_ATTR + ']');
    const direction = handleElement ? handleElement.getAttribute(HANDLE_ATTR) : null;
    if (isHandleDirection(direction) && this.selection && event instanceof MouseEvent) {
      this.beginDrag(direction, event);
      this.ignoreNextClick = true;
    }
  }

  private handleMouseUp(event: Event): void {
    if (!this.active) return;
    this.block(event);
    if (this.drag) {
      this.finishDrag();
      this.ignoreNextClick = true;
    }
  }

  private handleMouseMove(event: Event): void {
    if (!this.active) return;
    this.swallow(event);
    if (!(event instanceof MouseEvent)) return;
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    if (this.drag) {
      this.updateDrag(event);
      return;
    }
    this.requestSync();
  }

  private handleClick(event: Event): void {
    if (!this.active) return;
    this.block(event);
    if (this.ignoreNextClick) {
      this.ignoreNextClick = false;
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    if (target) {
      const actionElement = target.closest('[' + ACTION_ATTR + ']');
      const action = actionElement ? actionElement.getAttribute(ACTION_ATTR) : null;
      if (action) {
        this.runAction(action);
        return;
      }
      if (target.closest('[' + BOX_ATTR + ']') || target.closest('[' + TOOLBAR_ATTR + ']')) return;
    }
    if (!(event instanceof MouseEvent)) return;
    const element = this.elementAt(event.clientX, event.clientY);
    if (element) this.select(element);
  }

  private handleKeyDown(event: Event): void {
    if (!this.active) return;
    const isEscape =
      event instanceof KeyboardEvent && (event.key === 'Escape' || event.key === 'Esc' || event.code === 'Escape');
    this.block(event);
    if (isEscape) this.stop();
  }

  private beginDrag(handle: HandleDirection, event: MouseEvent): void {
    if (!this.selection) return;
    const rect = this.selection.element.getBoundingClientRect();
    this.drag = {
      handle,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: rect.width,
      startHeight: rect.height,
    };
    this.setDragCursor(handle);
    if (this.hoverBox) this.hoverBox.style.display = 'none';
    this.updateLabel();
  }

  private updateDrag(event: MouseEvent): void {
    if (!this.drag || !this.selection) return;
    const deltaX = event.clientX - this.drag.startX;
    const deltaY = event.clientY - this.drag.startY;
    const direction = this.drag.handle;
    const declarations: Record<string, string> = { ...this.selection.declarations };
    let width = this.drag.startWidth;
    let height = this.drag.startHeight;
    if (direction.indexOf('e') >= 0) width += deltaX;
    if (direction.indexOf('w') >= 0) width -= deltaX;
    if (direction.indexOf('s') >= 0) height += deltaY;
    if (direction.indexOf('n') >= 0) height -= deltaY;
    if (direction.indexOf('e') >= 0 || direction.indexOf('w') >= 0) {
      declarations.width = px(Math.max(MIN_SIZE, width));
    }
    if (direction.indexOf('n') >= 0 || direction.indexOf('s') >= 0) {
      declarations.height = px(Math.max(MIN_SIZE, height));
    }
    this.selection.declarations = declarations;
    this.renderPreview();
    this.renderSelection();
    this.updateLabel();
  }

  private finishDrag(): void {
    this.drag = null;
    this.restoreCursor();
    this.requestSync();
  }

  private setDragCursor(direction: HandleDirection): void {
    try {
      const style = this.doc.documentElement.style;
      if (this.savedCursor === null) this.savedCursor = style.cursor;
      style.cursor = HANDLE_CURSORS[direction];
    } catch {
      // Cursor hints are best effort.
    }
  }

  private restoreCursor(): void {
    if (this.savedCursor === null) return;
    try {
      this.doc.documentElement.style.cursor = this.savedCursor;
    } catch {
      // Cursor hints are best effort.
    }
    this.savedCursor = null;
  }

  private select(rawElement: Element): void {
    const element = this.toDocumentElement(rawElement);
    if (!element || !this.isSelectable(element)) return;
    const built = buildSelector(element, this.doc);
    if (built.selector.length === 0) return;
    this.selection = {
      element,
      selector: built.selector,
      label: describeElement(element),
      matches: built.matchCount,
      declarations: {},
    };
    this.preview.clear();
    this.renderSelection();
    this.updateLabel();
  }

  private runAction(action: string | null): void {
    switch (action) {
      case 'fill-width':
        this.applyPreset(PRESET_FILL_WIDTH);
        break;
      case 'fill-height':
        this.applyPreset(PRESET_FILL_HEIGHT);
        break;
      case 'auto':
        this.applyPreset(PRESET_AUTO);
        break;
      case 'reset':
        this.resetDeclarations();
        break;
      case 'save':
        this.save();
        break;
      case 'cancel':
        this.stop();
        break;
      default:
        break;
    }
  }

  private applyPreset(preset: Record<string, string>): void {
    if (!this.selection) return;
    this.selection.declarations = { ...this.selection.declarations, ...preset };
    this.renderPreview();
    this.renderSelection();
    this.updateLabel();
  }

  private resetDeclarations(): void {
    if (!this.selection) return;
    this.selection.declarations = {};
    this.preview.clear();
    this.renderSelection();
    this.updateLabel();
  }

  private renderPreview(): void {
    if (!this.selection) {
      this.preview.clear();
      return;
    }
    const declarations = this.selection.declarations;
    if (Object.keys(declarations).length === 0) {
      this.preview.clear();
      return;
    }
    this.preview.setSingle(this.selection.selector, declarations);
  }

  private save(): void {
    const selection = this.selection;
    if (!selection) {
      this.stop();
      return;
    }
    if (Object.keys(selection.declarations).length === 0) {
      this.stop();
      return;
    }
    const payload: LayoutReport = {
      selector: selection.selector,
      declarations: selection.declarations,
      label: selection.label,
      frameUrl: this.frameUrl(),
      matches: selection.matches,
    };
    this.active = false;
    this.teardown();
    try {
      this.deps.onSave(payload);
    } catch (error) {
      this.deps.report({ type: 'error', message: messageOf(error) });
    }
    this.deps.report({ type: 'layout-editor', active: false });
  }

  private requestSync(): void {
    if (!this.active || this.rafId !== null) return;
    try {
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this.syncPositions();
      });
    } catch {
      this.rafId = null;
      this.syncPositions();
    }
  }

  private syncPositions(): void {
    if (!this.active) return;
    if (!this.drag) this.updateHover();
    this.renderSelection();
  }

  private updateHover(): void {
    if (!this.active || this.drag || !this.hoverBox) return;
    const raw = this.elementAt(this.pointerX, this.pointerY);
    const element = raw ? this.toDocumentElement(raw) : null;
    if (!element || !this.isSelectable(element) || (this.selection && element === this.selection.element)) {
      if (this.hovered !== null || this.hoverBox.style.display !== 'none') {
        this.hovered = null;
        this.hoverInfo = '';
        this.hoverBox.style.display = 'none';
        this.updateLabel();
      }
      return;
    }
    if (element !== this.hovered) {
      this.hovered = element;
      const built = buildSelector(element, this.doc);
      this.hoverInfo =
        elementTagName(element) + ' ' + built.selector + ' | ' + matchesText(built.matchCount);
      this.updateLabel();
    }
    const rect = element.getBoundingClientRect();
    this.hoverBox.style.display = 'block';
    this.hoverBox.style.left = px(rect.left);
    this.hoverBox.style.top = px(rect.top);
    this.hoverBox.style.width = px(Math.max(0, rect.width));
    this.hoverBox.style.height = px(Math.max(0, rect.height));
  }

  private renderSelection(): void {
    if (!this.box || !this.toolbar) return;
    if (!this.selection) {
      this.box.style.display = 'none';
      this.toolbar.style.display = 'none';
      return;
    }
    const rect = this.selection.element.getBoundingClientRect();
    this.box.style.display = 'block';
    this.box.style.left = px(rect.left);
    this.box.style.top = px(rect.top);
    this.box.style.width = px(Math.max(0, rect.width));
    this.box.style.height = px(Math.max(0, rect.height));

    this.toolbar.style.display = 'flex';
    const toolbarWidth = this.toolbar.offsetWidth;
    const toolbarHeight = this.toolbar.offsetHeight;
    const view = this.doc.defaultView;
    const viewportWidth = view ? view.innerWidth : 0;
    const viewportHeight = view ? view.innerHeight : 0;
    let top = rect.top - toolbarHeight - 12;
    if (top < 4) top = rect.bottom + 12;
    const maxTop = Math.max(4, viewportHeight - toolbarHeight - 4);
    const maxLeft = Math.max(4, viewportWidth - toolbarWidth - 4);
    this.toolbar.style.top = px(clamp(top, 4, maxTop));
    this.toolbar.style.left = px(clamp(rect.left, 4, maxLeft));
  }

  private updateLabel(): void {
    if (!this.label) return;
    let text = HINT_TEXT;
    if (this.drag) {
      text = HINT_TEXT + ' | resizing ' + this.drag.handle;
    } else if (this.hovered && this.hoverInfo) {
      text = HINT_TEXT + ' | hover: ' + this.hoverInfo;
    } else if (this.selection) {
      text =
        HINT_TEXT +
        ' | selected: ' +
        this.selection.label +
        ' ' +
        this.selection.selector +
        ' | ' +
        matchesText(this.selection.matches);
    }
    this.label.textContent = text;
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

  private toDocumentElement(element: Element): Element | null {
    let current: Element | null = element;
    while (current && current.getRootNode() !== this.doc) {
      const root = current.getRootNode();
      current = typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot ? (root.host as Element) : null;
    }
    return current;
  }

  private isSelectable(element: Element): boolean {
    const tag = elementTagName(element);
    if (tag === 'html' || tag === 'body' || tag === 'head') return false;
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') return false;
    if (this.root && this.root.contains(element)) return false;
    if (element.hasAttribute(ROOT_ATTR) || element.hasAttribute(BOX_ATTR) || element.hasAttribute(TOOLBAR_ATTR)) {
      return false;
    }
    return true;
  }

  private frameUrl(): string {
    try {
      return this.doc.location?.href ?? '';
    } catch {
      return '';
    }
  }

  private teardown(): void {
    if (this.rafId !== null) {
      try {
        cancelAnimationFrame(this.rafId);
      } catch {
        // Animation frame already gone.
      }
      this.rafId = null;
    }
    this.restoreCursor();
    for (const listener of this.listeners) {
      try {
        window.removeEventListener(listener.type, listener.handler, { capture: listener.capture });
      } catch {
        // Listener already gone.
      }
    }
    this.listeners.length = 0;
    try {
      this.preview.clear();
    } catch {
      // Preview sheet is best effort.
    }
    if (this.root) {
      try {
        this.root.remove();
      } catch {
        // Overlay already detached.
      }
    }
    this.root = null;
    this.hoverBox = null;
    this.box = null;
    this.toolbar = null;
    this.label = null;
    this.handles.clear();
    this.selection = null;
    this.drag = null;
    this.hovered = null;
    this.hoverInfo = '';
    this.pointerX = -1;
    this.pointerY = -1;
    this.ignoreNextClick = false;
  }
}
