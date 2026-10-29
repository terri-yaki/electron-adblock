// Layout adjustment rules: declaration allowlist sanitizer and the second constructed
// stylesheet that applies them with !important. DOM access stays inside methods.
import { isSafeSelector } from './selector';

export interface LayoutCssRule {
  selector: string;
  declarations: Record<string, string>;
}

// Only properties that can move or resize a panel are accepted, never paint or behavior.
const PROPERTY_ALLOWLIST: ReadonlySet<string> = new Set([
  'width',
  'height',
  'min-width',
  'min-height',
  'max-width',
  'max-height',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'flex',
  'flex-basis',
  'flex-grow',
  'flex-shrink',
  'flex-direction',
  'flex-wrap',
  'align-self',
  'order',
  'gap',
  'row-gap',
  'column-gap',
  'overflow',
  'overflow-x',
  'overflow-y',
  'top',
  'right',
  'bottom',
  'left',
  'border-radius',
]);

const GRID_PREFIX = 'grid-';
const GRID_PROPERTY_RE = /^grid-[a-z-]+$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const UNSAFE_VALUE_RE = /[;{}<>\\!]/;
const UNSAFE_FUNCTION_RE = /(?:url|expression|javascript|image-set|cross-fade|paint|element)\s*\(/i;
const UNSAFE_PROTOCOL_RE = /javascript\s*:/i;
const COMMENT_RE = /\/\*/;
const MAX_PROPERTY_LENGTH = 48;
const MAX_VALUE_LENGTH = 120;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isSafeLayoutProperty(property: string): boolean {
  if (typeof property !== 'string') return false;
  const name = property.trim().toLowerCase();
  if (name.length === 0 || name.length > MAX_PROPERTY_LENGTH) return false;
  if (name.startsWith(GRID_PREFIX)) return GRID_PROPERTY_RE.test(name);
  return PROPERTY_ALLOWLIST.has(name);
}

export function isSafeLayoutValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_VALUE_LENGTH) return false;
  if (CONTROL_CHAR_RE.test(text)) return false;
  if (UNSAFE_VALUE_RE.test(text)) return false;
  if (UNSAFE_FUNCTION_RE.test(text)) return false;
  if (UNSAFE_PROTOCOL_RE.test(text)) return false;
  if (COMMENT_RE.test(text)) return false;
  return true;
}

export function sanitizeDeclarations(input: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!isRecord(input)) return result;
  for (const [rawProperty, rawValue] of Object.entries(input)) {
    const property = rawProperty.trim().toLowerCase();
    if (!isSafeLayoutProperty(property) || !isSafeLayoutValue(rawValue)) continue;
    result[property] = (rawValue as string).trim();
  }
  return result;
}

export function declarationsToCss(declarations: Record<string, string>): string {
  return Object.entries(declarations)
    .map(([property, value]) => property + ': ' + value + ' !important;')
    .join(' ');
}

export function layoutRuleCss(selector: string, declarations: Record<string, string>): string {
  const body = declarationsToCss(declarations);
  if (body.length === 0) return '';
  return selector + ' { ' + body + ' }';
}

function readLayoutEntries(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.layout)) return payload.layout;
  return [];
}

export function sanitizeLayoutRules(payload: unknown): LayoutCssRule[] {
  const rules = new Map<string, LayoutCssRule>();
  for (const entry of readLayoutEntries(payload)) {
    if (!isRecord(entry)) continue;
    if (entry.enabled === false) continue;
    const selector = typeof entry.selector === 'string' ? entry.selector.trim() : '';
    if (selector.length === 0 || !isSafeSelector(selector)) continue;
    const declarations = sanitizeDeclarations(entry.declarations);
    if (Object.keys(declarations).length === 0) continue;
    rules.set(selector, { selector, declarations });
  }
  return [...rules.values()];
}

// One constructed stylesheet for the engine-applied layout rules; the editor also uses a
// second instance as its temporary preview sheet.
export class LayoutStyles {
  private readonly doc: Document;
  private readonly styleAttribute: string;
  private sheet: CSSStyleSheet | null = null;
  private styleElement: HTMLStyleElement | null = null;
  private deferredAttach = false;
  private pendingAppend = false;
  private rules: LayoutCssRule[] = [];

  constructor(doc: Document, styleAttribute = 'data-electron-adblock-layout') {
    this.doc = doc;
    this.styleAttribute = styleAttribute;
  }

  get count(): number {
    return this.rules.length;
  }

  applyLayout(payload: unknown): number {
    this.rules = sanitizeLayoutRules(payload);
    this.render();
    return this.rules.length;
  }

  upsert(selector: string, declarations: Record<string, string>): void {
    const cleanSelector = typeof selector === 'string' ? selector.trim() : '';
    if (cleanSelector.length === 0 || !isSafeSelector(cleanSelector)) return;
    const cleanDeclarations = sanitizeDeclarations(declarations);
    if (Object.keys(cleanDeclarations).length === 0) return;
    const next = this.rules.filter((rule) => rule.selector !== cleanSelector);
    next.push({ selector: cleanSelector, declarations: cleanDeclarations });
    this.rules = next;
    this.render();
  }

  setSingle(selector: string, declarations: Record<string, string>): void {
    const cleanSelector = typeof selector === 'string' ? selector.trim() : '';
    const cleanDeclarations = sanitizeDeclarations(declarations);
    if (cleanSelector.length === 0 || !isSafeSelector(cleanSelector) || Object.keys(cleanDeclarations).length === 0) {
      this.clear();
      return;
    }
    this.rules = [{ selector: cleanSelector, declarations: cleanDeclarations }];
    this.render();
  }

  clear(): void {
    this.rules = [];
    this.render();
  }

  private render(): void {
    const css = this.rules
      .map((rule) => layoutRuleCss(rule.selector, rule.declarations))
      .filter((rule) => rule.length > 0)
      .join('\n');
    if (css.length === 0) {
      this.clearSheet();
      return;
    }
    if (this.writeConstructedSheet(css)) return;
    this.writeStyleElement(css);
  }

  private writeConstructedSheet(css: string): boolean {
    try {
      if (!this.sheet) {
        if (typeof CSSStyleSheet === 'undefined' || typeof CSSStyleSheet.prototype.replaceSync !== 'function') {
          return false;
        }
        if (!('adoptedStyleSheets' in this.doc)) return false;
        const sheet = new CSSStyleSheet();
        this.doc.adoptedStyleSheets = [...this.doc.adoptedStyleSheets, sheet];
        this.sheet = sheet;
      }
      this.sheet.replaceSync(css);
      if (this.styleElement) {
        this.styleElement.remove();
        this.styleElement = null;
        this.pendingAppend = false;
      }
      return true;
    } catch {
      const sheet = this.sheet;
      this.sheet = null;
      if (sheet) {
        try {
          sheet.replaceSync('');
        } catch {
          // Sheet already rejected the rules.
        }
        try {
          this.doc.adoptedStyleSheets = this.doc.adoptedStyleSheets.filter((candidate) => candidate !== sheet);
        } catch {
          // Old engines keep a read-only adoptedStyleSheets list.
        }
      }
      return false;
    }
  }

  private clearSheet(): void {
    if (this.sheet) {
      try {
        this.sheet.replaceSync('');
      } catch {
        this.sheet = null;
      }
    }
    if (this.styleElement) {
      try {
        this.styleElement.textContent = '';
      } catch {
        // Style element already detached.
      }
    }
  }

  private writeStyleElement(css: string): void {
    try {
      if (!this.styleElement) {
        const style = this.doc.createElement('style');
        style.setAttribute(this.styleAttribute, '');
        this.styleElement = style;
      }
      const style = this.styleElement;
      if (style.textContent !== css) style.textContent = css;
      if (!style.isConnected) this.appendStyleElement(style);
    } catch {
      // Style fallback is best effort.
    }
  }

  private appendStyleElement(style: HTMLStyleElement): void {
    const parent = this.doc.head ?? this.doc.documentElement;
    if (!parent) {
      this.pendingAppend = true;
      this.ensureDeferredAppend();
      return;
    }
    try {
      parent.appendChild(style);
      this.pendingAppend = false;
    } catch {
      this.pendingAppend = true;
    }
  }

  private ensureDeferredAppend(): void {
    if (this.deferredAttach) return;
    this.deferredAttach = true;
    try {
      this.doc.addEventListener(
        'DOMContentLoaded',
        () => {
          this.deferredAttach = false;
          if (this.pendingAppend && this.styleElement && !this.styleElement.isConnected) {
            this.appendStyleElement(this.styleElement);
          }
        },
        { once: true },
      );
    } catch {
      this.deferredAttach = false;
    }
  }
}
