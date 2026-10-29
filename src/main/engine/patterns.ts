// URL pattern normalization and matching for network blocking and URL-scoped cosmetic rules.
//
// A bare host such as "doubleclick.net" becomes anchored URL globs that match http, https,
// ws and wss URLs, with and without a port, for the apex host and its subdomains.

const SCHEME_WILDCARD = '*';
const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*(?::\d{1,5})?$/i;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?$/;
const COMMENT_PATTERN = /^[!#]/;
const ANGLE_BRACKETS = /^<+|>+$/g;

export type UrlMatcher = (url: string) => boolean;

function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? '\\' + char : char;
}

/** Compiles a CDP-style URL glob (wildcards '*' and '?', backslash escapes) into a RegExp. */
export function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\' && index + 1 < pattern.length) {
      index += 1;
      source += escapeRegExpChar(pattern[index]);
      continue;
    }
    if (char === '*') {
      source += '.*';
      continue;
    }
    if (char === '?') {
      source += '.';
      continue;
    }
    source += escapeRegExpChar(char);
  }
  return new RegExp(source + '$', 'i');
}

/** True when a full request URL matches a single CDP-style URL glob. */
export function matchesUrlPattern(url: string, pattern: string): boolean {
  if (!url || !pattern) return false;
  try {
    return globToRegExp(pattern).test(url);
  } catch {
    return false;
  }
}

/** True when a full request URL matches any of the supplied URL globs. */
export function matchesUrlPatterns(url: string, patterns: readonly string[]): boolean {
  return createUrlMatcher(patterns)(url);
}

/** Precompiles URL globs into a reusable matcher (used for Fetch.requestPaused confirmations). */
export function createUrlMatcher(patterns: readonly string[]): UrlMatcher {
  const regexes: RegExp[] = [];
  for (const pattern of patterns) {
    if (!pattern) continue;
    try {
      regexes.push(globToRegExp(pattern));
    } catch {
      // Invalid globs are ignored instead of breaking the engine.
    }
  }
  return (url: string): boolean => {
    if (!url) return false;
    for (const regex of regexes) {
      if (regex.test(url)) return true;
    }
    return false;
  };
}

/**
 * Keeps a URL glob and, when its authority has no port or authority wildcard, adds a
 * port-wildcard variant so hosts reached through an explicit port are still matched.
 */
function addPortVariants(patterns: readonly string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  const push = (pattern: string): void => {
    const key = pattern.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    output.push(pattern);
  };
  for (const pattern of patterns) {
    push(pattern);
    const match = /^([a-z*][a-z0-9+.-]*:\/\/)([^/]+)(\/.*)$/i.exec(pattern);
    if (!match) continue;
    const authority = match[2];
    if (authority === '*' || authority.includes(':')) continue;
    if (authority.includes('*') && !authority.startsWith('*.')) continue;
    push(match[1] + authority + ':*' + match[3]);
  }
  return output;
}

function stripHostDecorations(raw: string): string {
  let value = raw.trim().replace(ANGLE_BRACKETS, '').trim();
  if (value.startsWith('||')) value = value.slice(2);
  if (value.endsWith('^')) value = value.slice(0, -1);
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

function hostPatterns(host: string): string[] {
  const patterns: string[] = [];
  const bareHost = host.replace(/^\.+/, '');
  const [namePart, portPart] = splitHostPort(bareHost);
  if (!namePart) return patterns;
  const portSuffix = portPart ? ':' + portPart : '';
  const portWildcard = portPart ? '' : ':*';
  const base = SCHEME_WILDCARD + '://';
  patterns.push(base + namePart + portSuffix + '/*');
  if (isSubdomainable(namePart)) {
    patterns.push(base + '*.' + namePart + portSuffix + '/*');
  }
  if (!portPart) {
    patterns.push(base + namePart + portWildcard + '/*');
    if (isSubdomainable(namePart)) {
      patterns.push(base + '*.' + namePart + portWildcard + '/*');
    }
  }
  return patterns;
}

function splitHostPort(host: string): [string, string | undefined] {
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(host);
  if (bracketed) return [bracketed[1], bracketed[2]];
  const match = /^(.*?):(\d{1,5})$/.exec(host);
  if (match) return [match[1], match[2]];
  return [host, undefined];
}

function isSubdomainable(hostName: string): boolean {
  if (!hostName.includes('.')) return false;
  if (IPV4_PATTERN.test(hostName)) return false;
  if (hostName.includes(':')) return false;
  return HOST_PATTERN.test(hostName);
}

function isHostLike(value: string): boolean {
  const [namePart, portPart] = splitHostPort(value);
  if (!namePart) return false;
  if (portPart && !/^\d{1,5}$/.test(portPart)) return false;
  if (!HOST_PATTERN.test(namePart) && !IPV4_PATTERN.test(namePart)) {
    // Hostname without a dot (localhost) and bracketed IPv6 are allowed.
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(namePart) || namePart.includes(':');
  }
  return true;
}

/**
 * Normalizes one configured network pattern into CDP Fetch URL globs.
 * Bare hosts expand to anchored scheme/subdomain/port globs; existing URL globs are kept.
 */
export function normalizeNetworkPattern(raw: string): string[] {
  return addPortVariants(normalizeNetworkPatternBase(raw));
}

function normalizeNetworkPatternBase(raw: string): string[] {
  if (typeof raw !== 'string') return [];
  const value = raw.trim().replace(ANGLE_BRACKETS, '').trim();
  if (!value || COMMENT_PATTERN.test(value)) return [];

  const decorated = stripHostDecorations(value);
  if (!decorated) return [];

  // A scheme or protocol-relative URL is already a URL glob: keep it verbatim.
  if (decorated.includes('://')) return [value];
  if (value.startsWith('//')) {
    const rest = value.slice(2);
    if (!rest) return [];
    if (/[*?]/.test(rest)) return ['*://' + rest];
    return ['*://' + rest + (rest.includes('/') ? '*' : '/*')];
  }

  // A bare path glob such as /ads/* matches any host.
  if (value.startsWith('/')) return ['*' + value];

  if (/[*?]/.test(decorated)) {
    // Host-only globs (for example *.doubleclick.net) expand to anchored URL globs.
    if (!decorated.includes('/')) {
      return ['*://' + decorated + '/*', '*://' + decorated + ':*/*'];
    }
    // Leading wildcard path globs are kept verbatim.
    if (decorated.startsWith('*') || decorated.startsWith('?')) return [decorated];
    return ['*://' + decorated];
  }

  if (decorated.includes('/')) {
    // Host plus path without a scheme behaves as a path-prefix URL glob.
    return ['*://' + decorated + '*'];
  }

  if (!isHostLike(decorated)) return [];
  return hostPatterns(decorated);
}

/** Normalizes and de-duplicates many configured network patterns. */
export function normalizeNetworkPatterns(patterns: readonly string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(patterns)) return output;
  for (const pattern of patterns) {
    let normalized: string[];
    try {
      normalized = normalizeNetworkPattern(pattern);
    } catch {
      normalized = [];
    }
    for (const entry of normalized) {
      const key = entry.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(entry);
    }
  }
  return output;
}

/** True when a frame URL matches a configured URL filter; an absent filter matches everything. */
export function matchesUrlFilter(url: string, filter: string | undefined): boolean {
  if (!filter) return true;
  return matchesUrlPatterns(url, normalizeNetworkPattern(filter));
}
