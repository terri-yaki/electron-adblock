// Selector building and the pure matching helpers shared by the injected modules.
// Nothing in this module touches the DOM at import time so unit tests can load it in Node.
import { AD_DOMAINS } from '../shared/default-filters';

const MAX_SELECTOR_LENGTH = 180;
const MAX_CLASS_TOKENS = 2;
const MAX_PATH_DEPTH = 6;
const MAX_ID_LENGTH = 40;
const MAX_ARIA_LENGTH = 40;
const MAX_ATTRIBUTE_VALUE_LENGTH = 60;

const SAFE_IDENT_RE = /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/;
const ALNUM_RE = /^[A-Za-z0-9]+$/;
const DIMENSION_RE = /^\d+x\d+$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const UNSAFE_SELECTOR_RE = /[{;<\u0000-\u001f\u007f]/;

// Classes applied by interaction state, never useful for a persistent rule.
const STATE_CLASS_TOKENS = new Set([
  'active',
  'activedescendant',
  'animating',
  'checked',
  'closed',
  'collapsed',
  'current',
  'disabled',
  'dragging',
  'entered',
  'exiting',
  'expanded',
  'focus',
  'focused',
  'focus-visible',
  'focus-within',
  'highlight',
  'highlighted',
  'hidden',
  'hide',
  'hover',
  'hovered',
  'invisible',
  'loaded',
  'loading',
  'mounted',
  'open',
  'opened',
  'pinned',
  'ready',
  'selected',
  'show',
  'shown',
  'sticky',
  'visible',
]);

const STATE_CLASS_PATTERN = new RegExp(
  '^(?:is|has|are|was)-(?:active|selected|current|open|opened|closed|hidden|shown|visible|hover|hovered|' +
    'focus|focused|loading|loaded|expanded|collapsed|disabled|enabled|sticky|pinned|highlight|highlighted|' +
    'dragging|animating|entered|exiting|mounted)$',
);

// Task descriptions that identify ads, matched one token at a time.
const AD_TOKEN_PATTERN = new RegExp(
  '^(?:' +
    'ads?' +
    '|advert[a-z]*' +
    '|sponsor(?:s|ed|ship|ing|edcontent)?' +
    '|promo(?:s|ted|tion|tions|ting)?' +
    '|(?:ad|ads)(?:slot|unit|container|banner|frame|wrap|box|label|holder|block|zone|space|region|panel|' +
    'area|card|strip|wall|rail|overlay|masthead|leaderboard|sense|bygoogle)s?' +
    '|googleads' +
    '|gptad' +
    ')$',
);

const REGEX_SPECIAL_RE = /[\\^$.*+?()[\]{}|]/g;

function escapeRegExp(text: string): string {
  return text.replace(REGEX_SPECIAL_RE, (character) => '\\' + character);
}

// Glob match against the current frame URL. "*" matches any run of characters;
// a pattern without a wildcard is treated as a plain substring filter.
export function urlMatchesPattern(url: string, pattern?: string | null): boolean {
  const rawPattern = typeof pattern === 'string' ? pattern.trim() : '';
  if (rawPattern.length === 0) return true;
  const target = (typeof url === 'string' ? url : '').toLowerCase();
  const needle = rawPattern.toLowerCase();
  if (!needle.includes('*')) return target.includes(needle);
  const source = escapeRegExp(needle).replace(/\\\*/g, '.*');
  try {
    return new RegExp('^' + source + '$').test(target);
  } catch {
    return target.includes(needle.replace(/\*/g, ''));
  }
}

function caseTransitions(value: string): number {
  let transitions = 0;
  for (let index = 1; index < value.length; index += 1) {
    const previous = value.charCodeAt(index - 1);
    const current = value.charCodeAt(index);
    const previousUpper = previous >= 65 && previous <= 90;
    const currentUpper = current >= 65 && current <= 90;
    if (previousUpper !== currentUpper) transitions += 1;
  }
  return transitions;
}

function isMixedAlnumHash(value: string): boolean {
  if (value.length <= 5 || !ALNUM_RE.test(value)) return false;
  return /[A-Za-z]/.test(value) && /\d/.test(value);
}

// True for generated tokens such as "css-1x2y3z", "styles__item___1a2b3" or "sc-bdVaJa".
export function isHashLikeToken(token: string): boolean {
  if (typeof token !== 'string' || token.length === 0) return true;
  // Sizing classes such as 728x90 describe a slot, not a generated hash.
  if (DIMENSION_RE.test(token)) return false;
  if (isMixedAlnumHash(token)) return true;
  const withoutEdgeSeparators = token.replace(/^[-_]+|[-_]+$/g, '');
  if (withoutEdgeSeparators !== token && isMixedAlnumHash(withoutEdgeSeparators)) return true;
  const segments = token.split(/[-_]+/).filter((segment) => segment.length > 0);
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index] ?? '';
    if (segment.length < 5 || DIMENSION_RE.test(segment)) continue;
    if (/[A-Za-z]/.test(segment) && /\d/.test(segment)) return true;
    if (/[A-Z]/.test(segment) && /[a-z]/.test(segment) && caseTransitions(segment) >= 2) return true;
  }
  return false;
}

export function isVolatileClassToken(token: string): boolean {
  if (typeof token !== 'string') return true;
  const value = token.trim();
  if (value.length === 0) return true;
  if (value.length > 40) return true;
  // Utility variant syntax (hover:bg-...), slashes and brackets cannot be persisted safely.
  if (/[:/\[\]%#]/.test(value)) return true;
  if (!SAFE_IDENT_RE.test(value)) return true;
  const lower = value.toLowerCase();
  if (STATE_CLASS_TOKENS.has(lower) || STATE_CLASS_PATTERN.test(lower)) return true;
  return isHashLikeToken(value);
}

export function filterStableClasses(classes: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of classes) {
    const value = typeof token === 'string' ? token.trim() : '';
    if (value.length === 0 || isVolatileClassToken(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function tokenizeForKeywords(text: string): string[] {
  // Split camelCase before punctuation so "adSlot" still reads as "ad slot".
  const spaced = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

export function isAdKeywordToken(token: string): boolean {
  return typeof token === 'string' && AD_TOKEN_PATTERN.test(token);
}

export function adKeywords(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const matched: string[] = [];
  const seen = new Set<string>();
  for (const token of tokenizeForKeywords(text)) {
    if (seen.has(token) || !isAdKeywordToken(token)) continue;
    seen.add(token);
    matched.push(token);
    if (matched.length >= 4) break;
  }
  return matched;
}

export function hasAdKeyword(text: string): boolean {
  return adKeywords(text).length > 0;
}

const AD_DOMAIN_SET: ReadonlySet<string> = new Set(AD_DOMAINS.map((domain) => domain.toLowerCase()));

function parseHostname(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
      ? trimmed
      : 'https://' + trimmed.replace(/^\/\//, '');
    return new URL(absolute).hostname.toLowerCase();
  } catch {
    const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(trimmed);
    const authority = match?.[1] ?? trimmed.replace(/^\/\//, '').split(/[/?#]/)[0] ?? '';
    return (authority.split('@').pop() ?? authority).split(':')[0]?.toLowerCase() ?? '';
  }
}

export function hostFromUrl(url: string, base?: string): string {
  const trimmed = typeof url === 'string' ? url.trim() : '';
  if (trimmed.length === 0) return '';
  if (typeof base === 'string' && base.length > 0) {
    try {
      return new URL(trimmed, base).hostname.toLowerCase();
    } catch {
      // Fall through to the standalone parser.
    }
  }
  return parseHostname(trimmed);
}

// Returns the matching curated ad domain for a URL, or null.
export function adHostForUrl(url: string, base?: string): string | null {
  const host = hostFromUrl(url, base);
  if (host.length === 0) return null;
  for (const domain of AD_DOMAIN_SET) {
    if (host === domain || host.endsWith('.' + domain)) return domain;
  }
  return null;
}

export function escapeAttributeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\a ')
    .replace(/\r/g, '\\d ')
    .replace(/\f/g, '\\c ');
}

function fallbackEscapeIdent(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const character = value.charAt(index);
    if (code === 0) {
      result += '\uFFFD';
      continue;
    }
    if ((code >= 1 && code <= 31) || code === 127) {
      result += '\\' + code.toString(16) + ' ';
      continue;
    }
    if (index === 0 && code >= 48 && code <= 57) {
      result += '\\' + code.toString(16) + ' ';
      continue;
    }
    if (index === 1 && code >= 48 && code <= 57 && value.charCodeAt(0) === 45) {
      result += '\\' + code.toString(16) + ' ';
      continue;
    }
    if (
      code >= 128 ||
      code === 45 ||
      code === 95 ||
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122)
    ) {
      result += character;
      continue;
    }
    result += '\\' + character;
  }
  return result;
}

export function escapeIdent(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS;
  if (css && typeof css.escape === 'function') {
    try {
      return css.escape(value);
    } catch {
      // Fall through to the local implementation.
    }
  }
  return fallbackEscapeIdent(value);
}

// Rejects selector text that could break out of the generated rule or smuggle markup.
export function isSafeSelector(selector: string): boolean {
  if (typeof selector !== 'string') return false;
  const value = selector.trim();
  if (value.length === 0 || value.length > 500) return false;
  return !UNSAFE_SELECTOR_RE.test(value);
}

export function elementTagName(element: Element): string {
  return element.tagName.toLowerCase();
}

export function elementClassTokens(element: Element): string[] {
  const raw = element.getAttribute('class') ?? '';
  return raw.split(/\s+/).filter((token) => token.length > 0);
}

export function stableClassTokens(element: Element): string[] {
  return filterStableClasses(elementClassTokens(element));
}

export interface BuiltSelector {
  selector: string;
  matchCount: number;
}

function countMatches(documentRef: Document, selector: string): number {
  if (!isSafeSelector(selector)) return 0;
  try {
    return documentRef.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

function matchesElement(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

function attributeSelector(element: Element, attribute: string): string | null {
  const raw = element.getAttribute(attribute);
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_ATTRIBUTE_VALUE_LENGTH || CONTROL_CHAR_RE.test(value)) return null;
  return '[' + attribute + '="' + escapeAttributeValue(value) + '"]';
}

function stableId(element: Element): string | null {
  const raw = element.getAttribute('id');
  if (raw === null) return null;
  const id = raw.trim();
  if (id.length === 0 || id.length > MAX_ID_LENGTH) return null;
  if (CONTROL_CHAR_RE.test(id) || /[\s"'{}<>]/.test(id)) return null;
  if (/^\d+$/.test(id)) return null;
  if (isHashLikeToken(id)) return null;
  return id;
}

function ariaSelector(element: Element): string | null {
  const raw = element.getAttribute('aria-label');
  if (raw === null) return null;
  const value = raw.trim().replace(/\s+/g, ' ');
  if (value.length === 0 || value.length > MAX_ARIA_LENGTH) return null;
  if (CONTROL_CHAR_RE.test(value) || isHashLikeToken(value)) return null;
  return '[aria-label="' + escapeAttributeValue(value) + '"]';
}

function nthOfType(element: Element): number {
  let index = 1;
  let sibling = element.previousElementSibling;
  while (sibling) {
    if (sibling.tagName === element.tagName) index += 1;
    sibling = sibling.previousElementSibling;
  }
  return index;
}

function anchorSelector(element: Element): string | null {
  for (const attribute of ['data-testid', 'data-qa', 'data-ad', 'data-slot']) {
    const candidate = attributeSelector(element, attribute);
    if (candidate) return candidate;
  }
  const id = stableId(element);
  return id ? '#' + escapeIdent(id) : null;
}

// Capped nth-of-type chain anchored on the nearest stable ancestor (or body/html).
function nthOfTypePath(element: Element, documentRef: Document): string {
  const segments: string[] = [];
  let node: Element | null = element;
  let depth = 0;
  while (node && depth < MAX_PATH_DEPTH) {
    const parent: Element | null = node.parentElement;
    if (!parent) return '';
    segments.unshift(elementTagName(node) + ':nth-of-type(' + nthOfType(node) + ')');
    depth += 1;
    node = parent;
    const anchor = anchorSelector(node);
    if (anchor) {
      segments.unshift(anchor);
      return segments.join(' > ');
    }
    if (node === documentRef.body || node === documentRef.documentElement) {
      segments.unshift(elementTagName(node));
      return segments.join(' > ');
    }
  }
  return segments.join(' > ');
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, Math.max(0, maxLength - 3)) + '...';
}

// Short human label shown by the picker and stored on the rule.
export function describeElement(element: Element): string {
  const tag = elementTagName(element);
  const id = stableId(element);
  if (id) return truncateText(tag + '#' + id, 60);
  const classes = stableClassTokens(element);
  const primary = classes.find((token) => hasAdKeyword(token)) ?? classes[0];
  if (primary) return truncateText(tag + '.' + primary, 60);
  const aria = element.getAttribute('aria-label')?.trim();
  if (aria) return truncateText(tag + ' "' + aria + '"', 60);
  return tag;
}

// Builds a verified CSS selector: stable attributes first, then id, ad class, ad iframe,
// tag plus classes, and finally a capped nth-of-type path.
export function buildSelector(element: Element, documentRef?: Document): BuiltSelector {
  const doc = documentRef ?? element.ownerDocument;
  const tag = elementTagName(element);
  const candidates: string[] = [];
  const push = (candidate: string | null): void => {
    if (candidate) candidates.push(candidate);
  };

  for (const attribute of ['data-testid', 'data-qa', 'data-ad', 'data-ad-slot', 'data-adunit', 'data-slot', 'data-google-query-id']) {
    push(attributeSelector(element, attribute));
  }
  push(ariaSelector(element));

  const id = stableId(element);
  if (id) push('#' + escapeIdent(id));

  const classes = stableClassTokens(element);
  for (const token of classes.filter((classToken) => hasAdKeyword(classToken))) {
    push('.' + escapeIdent(token));
  }

  if (tag === 'iframe') {
    const src = element.getAttribute('src');
    const host = src ? adHostForUrl(src, doc.baseURI) : null;
    if (host) push('iframe[src*="' + escapeAttributeValue(host) + '"]');
  }

  const plainClasses = classes.filter((token) => !hasAdKeyword(token)).slice(0, MAX_CLASS_TOKENS);
  const [firstClass, secondClass] = plainClasses;
  if (firstClass && secondClass) {
    push(tag + '.' + escapeIdent(firstClass) + '.' + escapeIdent(secondClass));
  }
  if (firstClass) push(tag + '.' + escapeIdent(firstClass));
  push(nthOfTypePath(element, doc));

  for (const candidate of candidates) {
    if (candidate.length > MAX_SELECTOR_LENGTH) continue;
    if (!isSafeSelector(candidate)) continue;
    if (!matchesElement(element, candidate)) continue;
    const matchCount = countMatches(doc, candidate);
    if (matchCount < 1) continue;
    return { selector: candidate, matchCount };
  }

  return { selector: tag, matchCount: countMatches(doc, tag) };
}
