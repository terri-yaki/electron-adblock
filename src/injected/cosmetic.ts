// Cosmetic hiding through a constructed stylesheet, with a <style> fallback, plus a
// debounced hidden-element count. All DOM access happens inside methods.
import type { ReportFn } from './messages';
import { isSafeSelector, urlMatchesPattern } from './selector';

const STYLE_ATTRIBUTE = 'data-electron-adblock';
const OBSERVER_DEBOUNCE_MS = 350;

interface CosmeticControllerOptions {
  doc: Document;
  report: ReportFn;
  debounceMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class CosmeticController {
  private readonly doc: Document;
  private readonly report: ReportFn;
  private readonly debounceMs: number;
  private sheet: CSSStyleSheet | null = null;
  private styleElement: HTMLStyleElement | null = null;
  private pendingStyleAppend = false;
  private observer: MutationObserver | null = null;
  private pendingObserverAttach = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private selectors: string[] = [];
  private lastReportedCount = -1;

  constructor(options: CosmeticControllerOptions) {
    this.doc = options.doc;
    this.report = options.report;
    this.debounceMs = options.debounceMs ?? OBSERVER_DEBOUNCE_MS;
  }

  start(): void {
    this.ensureObserver();
  }

  // Applies the payload rules and returns the total number of hidden elements.
  apply(payload: unknown): number {
    this.start();
    this.selectors = this.readSelectors(payload);
    this.writeSheet(this.buildCss(this.selectors));
    const count = this.countHidden();
    this.reportCount(count);
    return count;
  }

  // Optimistic apply used by the picker before the host stores the rule.
  addSelector(selector: string): number {
    this.start();
    const trimmed = typeof selector === 'string' ? selector.trim() : '';
    if (trimmed.length > 0 && isSafeSelector(trimmed) && this.isValidSelector(trimmed) && !this.selectors.includes(trimmed)) {
      this.selectors = [...this.selectors, trimmed];
      this.writeSheet(this.buildCss(this.selectors));
    }
    const count = this.countHidden();
    this.reportCount(count);
    return count;
  }

  dispose(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.observer) {
      try {
        this.observer.disconnect();
      } catch {
        // Observer already inactive.
      }
      this.observer = null;
    }
  }

  private readSelectors(payload: unknown): string[] {
    const entries = this.cosmeticEntries(payload);
    const frameUrl = this.frameUrl();
    const seen = new Set<string>();
    const selectors: string[] = [];
    for (const entry of entries) {
      let selector = '';
      let pattern: string | undefined;
      if (typeof entry === 'string') {
        selector = entry.trim();
      } else if (isRecord(entry)) {
        if (entry.enabled === false) continue;
        selector = typeof entry.selector === 'string' ? entry.selector.trim() : '';
        pattern = typeof entry.urlPattern === 'string' ? entry.urlPattern : undefined;
      }
      if (selector.length === 0 || !isSafeSelector(selector) || seen.has(selector)) continue;
      if (!urlMatchesPattern(frameUrl, pattern)) continue;
      if (!this.isValidSelector(selector)) continue;
      seen.add(selector);
      selectors.push(selector);
    }
    return selectors;
  }

  private cosmeticEntries(payload: unknown): unknown[] {
    if (Array.isArray(payload)) return payload;
    if (isRecord(payload) && Array.isArray(payload.cosmetic)) return payload.cosmetic;
    return [];
  }

  private isValidSelector(selector: string): boolean {
    try {
      this.doc.querySelector(selector);
      return true;
    } catch {
      return false;
    }
  }

  private frameUrl(): string {
    try {
      return this.doc.location?.href ?? '';
    } catch {
      return '';
    }
  }

  private buildCss(selectors: readonly string[]): string {
    return selectors.map((selector) => selector + ' { display: none !important; }').join('\n');
  }

  private writeSheet(css: string): void {
    if (css.length === 0) {
      this.clearSheet();
      return;
    }
    if (this.writeConstructedSheet(css)) return;
    this.writeStyleElement(css);
  }

  // CSP-safe path: rules live in a constructed stylesheet adopted by the document.
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
        this.pendingStyleAppend = false;
      }
      return true;
    } catch {
      this.dropConstructedSheet();
      return false;
    }
  }

  private dropConstructedSheet(): void {
    const sheet = this.sheet;
    this.sheet = null;
    if (!sheet) return;
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

  private clearSheet(): void {
    if (this.sheet) {
      try {
        this.sheet.replaceSync('');
      } catch {
        this.dropConstructedSheet();
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
        style.setAttribute(STYLE_ATTRIBUTE, '');
        this.styleElement = style;
      }
      const style = this.styleElement;
      if (style.textContent !== css) style.textContent = css;
      if (!style.isConnected) this.appendStyleElement(style);
      this.pendingStyleAppend = !style.isConnected;
    } catch {
      // Style fallback is best effort.
    }
  }

  private appendStyleElement(style: HTMLStyleElement): void {
    const parent = this.doc.head ?? this.doc.documentElement;
    if (!parent) {
      this.pendingStyleAppend = true;
      return;
    }
    try {
      parent.appendChild(style);
      this.pendingStyleAppend = false;
    } catch {
      this.pendingStyleAppend = true;
    }
  }

  private flushPendingStyle(): void {
    if (!this.pendingStyleAppend || !this.styleElement) return;
    this.appendStyleElement(this.styleElement);
  }

  private countHidden(): number {
    if (this.selectors.length === 0) return 0;
    const seen = new Set<Element>();
    for (const selector of this.selectors) {
      try {
        const matches = this.doc.querySelectorAll(selector);
        for (const element of matches) seen.add(element);
      } catch {
        // Skip selectors the engine rejects at query time.
      }
    }
    return seen.size;
  }

  private reportCount(count: number): void {
    if (count === this.lastReportedCount) return;
    this.lastReportedCount = count;
    this.report({ type: 'hidden', count });
  }

  private ensureObserver(): void {
    if (this.observer) return;
    if (typeof MutationObserver === 'undefined') return;
    const root = this.doc.documentElement;
    if (root) {
      this.attachObserver(root);
      return;
    }
    if (this.pendingObserverAttach) return;
    this.pendingObserverAttach = true;
    try {
      this.doc.addEventListener(
        'DOMContentLoaded',
        () => {
          this.pendingObserverAttach = false;
          this.flushPendingStyle();
          this.ensureObserver();
          this.scheduleCount();
        },
        { once: true },
      );
    } catch {
      this.pendingObserverAttach = false;
    }
  }

  private attachObserver(root: Element): void {
    try {
      const observer = new MutationObserver(() => {
        this.scheduleCount();
      });
      observer.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          'class',
          'id',
          'style',
          'src',
          'aria-label',
          'data-testid',
          'data-ad',
          'data-ad-slot',
          'data-google-query-id',
        ],
      });
      this.observer = observer;
    } catch {
      this.observer = null;
    }
  }

  // DOM mutations only refresh the reported count; they never rebuild the rules.
  private scheduleCount(): void {
    if (this.selectors.length === 0) return;
    if (typeof setTimeout === 'undefined') return;
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.reportCount(this.countHidden());
    }, this.debounceMs);
  }
}
