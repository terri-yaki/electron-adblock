// Heuristic ad candidates for the dashboard scan action. Fast, bounded and failure tolerant.
import type { AdCandidate } from '../shared/types';
import {
  adHostForUrl,
  buildSelector,
  elementClassTokens,
  elementTagName,
  hasAdKeyword,
} from './selector';

const CANDIDATE_SELECTOR = [
  'ins.adsbygoogle',
  'iframe[src]',
  '[data-ad]',
  '[data-ad-slot]',
  '[data-ad-unit]',
  '[data-adunit]',
  '[data-google-query-id]',
  '[data-ad-client]',
  '[data-ad-region]',
  '[class*="ad" i]',
  '[id*="ad" i]',
  '[class*="sponsor" i]',
  '[id*="sponsor" i]',
  '[class*="advert" i]',
  '[id*="advert" i]',
  '[class*="promo" i]',
  '[id*="promo" i]',
  '[data-testid*="ad" i]',
  '[data-testid*="sponsor" i]',
  '[aria-label*="advert" i]',
  '[aria-label*="sponsor" i]',
].join(',');

const AD_ATTRIBUTES = [
  'data-ad',
  'data-ad-slot',
  'data-ad-unit',
  'data-adunit',
  'data-google-query-id',
  'data-ad-client',
  'data-ad-region',
];

const MIN_SIZE = 24;
const MAX_CANDIDATES = 25;
const MAX_SCANNED_ELEMENTS = 4000;

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, Math.max(0, maxLength - 3)) + '...';
}

function isExcluded(element: Element): boolean {
  const tag = elementTagName(element);
  if (tag === 'html' || tag === 'body' || tag === 'head') return true;
  if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') return true;
  try {
    if (element.closest('[data-electron-adblock]')) return true;
  } catch {
    return true;
  }
  return false;
}

function reasonFor(element: Element, doc: Document): string | null {
  const classes = elementClassTokens(element);
  for (const token of classes) {
    if (hasAdKeyword(token)) return 'class "' + truncate(token, 40) + '"';
  }
  const id = element.getAttribute('id')?.trim();
  if (id && hasAdKeyword(id)) return 'id "' + truncate(id, 40) + '"';
  for (const attribute of AD_ATTRIBUTES) {
    if (element.hasAttribute(attribute)) return attribute;
  }
  const testId = element.getAttribute('data-testid')?.trim();
  if (testId && hasAdKeyword(testId)) return 'data-testid "' + truncate(testId, 40) + '"';
  const ariaLabel = element.getAttribute('aria-label')?.trim();
  if (ariaLabel && hasAdKeyword(ariaLabel)) return 'aria-label "' + truncate(ariaLabel, 40) + '"';
  if (elementTagName(element) === 'iframe') {
    const src = element.getAttribute('src') ?? '';
    if (src.length > 0) {
      const host = adHostForUrl(src, doc.baseURI);
      if (host) return 'ad iframe (' + host + ')';
    }
  }
  return null;
}

export function scanAdCandidates(doc: Document = document): AdCandidate[] {
  try {
    const scope = doc.body ?? doc.documentElement;
    if (!scope) return [];

    const elements = Array.from(scope.querySelectorAll(CANDIDATE_SELECTOR)).slice(0, MAX_SCANNED_ELEMENTS);
    const found = new Map<Element, string>();
    for (const element of elements) {
      if (!element.isConnected || isExcluded(element)) continue;
      const reason = reasonFor(element, doc);
      if (reason) found.set(element, reason);
    }

    // Keep the outermost candidate only.
    for (const element of Array.from(found.keys())) {
      let parent = element.parentElement;
      while (parent) {
        if (found.has(parent)) {
          found.delete(element);
          break;
        }
        parent = parent.parentElement;
      }
    }

    const candidates: AdCandidate[] = [];
    for (const [element, reason] of found) {
      if (candidates.length >= MAX_CANDIDATES) break;
      const rect = element.getBoundingClientRect();
      if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) continue;
      const built = buildSelector(element, doc);
      candidates.push({
        selector: built.selector,
        tag: elementTagName(element),
        reason,
        matchCount: built.matchCount,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }
    return candidates;
  } catch {
    return [];
  }
}
