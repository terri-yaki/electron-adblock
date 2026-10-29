// DOM-free unit tests for the injected helpers that do not require a browser document.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adHostForUrl,
  adKeywords,
  escapeIdent,
  filterStableClasses,
  hasAdKeyword,
  isHashLikeToken,
  isSafeSelector,
  isVolatileClassToken,
  urlMatchesPattern,
} from '../../src/injected/selector';
import {
  declarationsToCss,
  isSafeLayoutProperty,
  isSafeLayoutValue,
  isSafePositionValue,
  isSafeZIndexValue,
  layoutRuleCss,
  sanitizeDeclarations,
  sanitizeLayoutRules,
} from '../../src/injected/layout';

test('urlMatchesPattern treats a missing pattern as match-all', () => {
  assert.equal(urlMatchesPattern('https://www.op.gg/desktop/home', undefined), true);
  assert.equal(urlMatchesPattern('https://www.op.gg/desktop/home', ''), true);
  assert.equal(urlMatchesPattern('https://www.op.gg/desktop/home', '   '), true);
});

test('urlMatchesPattern without wildcards is a case-insensitive substring filter', () => {
  assert.equal(urlMatchesPattern('https://www.op.gg/desktop/home', 'op.gg'), true);
  assert.equal(urlMatchesPattern('https://www.op.gg/desktop/home', 'OP.GG'), true);
  assert.equal(urlMatchesPattern('https://www.op.gg/desktop/home', '/desktop/'), true);
  assert.equal(urlMatchesPattern('https://www.op.gg/desktop/home', 'youtube.com'), false);
});

test('urlMatchesPattern supports * globs across the whole URL', () => {
  assert.equal(urlMatchesPattern('https://www.op.gg/desktop/home', '*'), true);
  assert.equal(urlMatchesPattern('https://www.op.gg/desktop/home', '*://*.op.gg/*'), true);
  assert.equal(urlMatchesPattern('https://op.gg/desktop', '*://*.op.gg/*'), false);
  assert.equal(urlMatchesPattern('https://www.op.gg/desktop/home', '*op.gg*'), true);
  assert.equal(urlMatchesPattern('https://www.op.gg/desktop/home', 'https://www.op.gg/*'), true);
  assert.equal(urlMatchesPattern('https://www.op.gg/desktop/home', 'https://www.op.gg/ads/*'), false);
});

test('urlMatchesPattern matches literally for regex characters and query strings', () => {
  const url = 'https://example.com/watch?v=1&x=(2)';
  assert.equal(urlMatchesPattern(url, 'https://example.com/watch?v=1&x=(2)'), true);
  assert.equal(urlMatchesPattern(url, 'example.com/watch?a'), false);
  assert.equal(urlMatchesPattern(url, '*watch?v=1*'), true);
  assert.equal(urlMatchesPattern('https://example.com/aaa', 'https://example.com/a+'), false);
});

test('isVolatileClassToken rejects state, hashed and unsafe class names', () => {
  for (const token of ['active', 'selected', 'is-open', 'hover', 'loading', 'disabled']) {
    assert.equal(isVolatileClassToken(token), true, token);
  }
  for (const token of ['css-1x2y3z', 'styles__adBanner___1a2b3', 'sc-bdVaJa', 'x9f2a1c', '_1a2b3c']) {
    assert.equal(isVolatileClassToken(token), true, token);
  }
  assert.equal(isVolatileClassToken('hover:bg-red-500'), true);
  assert.equal(isVolatileClassToken('w-1/2'), true);
  assert.equal(isVolatileClassToken('a'.repeat(41)), true);
  assert.equal(isVolatileClassToken('12345'), true);
  assert.equal(isVolatileClassToken(''), true);
});

test('isVolatileClassToken keeps ordinary semantic class names', () => {
  for (const token of ['ad', 'ads', 'ad-slot', 'ad-container', 'adContainer', 'sponsor-card', 'header', 'google_ads']) {
    assert.equal(isVolatileClassToken(token), false, token);
  }
});

test('isHashLikeToken only flags generated tokens', () => {
  assert.equal(isHashLikeToken('1a2b3c'), true);
  assert.equal(isHashLikeToken('css-1x2y3z'), true);
  assert.equal(isHashLikeToken('sc-bdVaJa'), true);
  assert.equal(isHashLikeToken('ad-slot'), false);
  assert.equal(isHashLikeToken('header'), false);
  assert.equal(isHashLikeToken('ad-banner-728x90'), false);
});

test('filterStableClasses removes volatile tokens, duplicates and keeps order', () => {
  const classes = ['ad-slot', 'active', 'ad-slot', 'css-1x2y3z', 'sponsor-card', 'header', 'is-open'];
  assert.deepEqual(filterStableClasses(classes), ['ad-slot', 'sponsor-card', 'header']);
  assert.deepEqual(filterStableClasses([]), []);
  assert.deepEqual(filterStableClasses(['', '   ']), []);
});

test('adKeywords finds ad semantics on token boundaries', () => {
  assert.deepEqual(adKeywords('ad'), ['ad']);
  assert.deepEqual(adKeywords('ads'), ['ads']);
  assert.deepEqual(adKeywords('ad-banner'), ['ad']);
  assert.deepEqual(adKeywords('ad-container'), ['ad']);
  assert.deepEqual(adKeywords('banner-ad'), ['ad']);
  assert.deepEqual(adKeywords('adslot'), ['adslot']);
  assert.deepEqual(adKeywords('google_ads'), ['ads']);
  assert.deepEqual(adKeywords('div-gpt-ad'), ['ad']);
  assert.deepEqual(adKeywords('sponsored-card'), ['sponsored']);
  assert.deepEqual(adKeywords('advertisement-top'), ['advertisement']);
  assert.deepEqual(adKeywords('promo-banner'), ['promo']);
  assert.deepEqual(adKeywords('adsbygoogle'), ['adsbygoogle']);
});

test('adKeywords ignores ordinary words that merely contain "ad"', () => {
  for (const text of ['header', 'download', 'shadow', 'adaptive', 'address', 'admin', 'gradient', 'badge', 'read-more']) {
    assert.deepEqual(adKeywords(text), [], text);
  }
  assert.deepEqual(adKeywords(''), []);
});

test('hasAdKeyword handles camelCase and attribute-like text', () => {
  assert.equal(hasAdKeyword('adSlotLeft'), true);
  assert.equal(hasAdKeyword('data-ad-slot'), true);
  assert.equal(hasAdKeyword('Sponsored'), true);
  assert.equal(hasAdKeyword('Advertorial'), true);
  assert.equal(hasAdKeyword('AdminPanel'), false);
});

test('adHostForUrl matches curated ad domains and their subdomains', () => {
  assert.equal(adHostForUrl('https://pagead2.googlesyndication.com/pagead/js'), 'googlesyndication.com');
  assert.equal(adHostForUrl('https://ad.doubleclick.net/ddm/adj/1'), 'doubleclick.net');
  assert.equal(adHostForUrl('https://ads.youtube.com/x'), 'ads.youtube.com');
  assert.equal(adHostForUrl('https://example.com/ad/slot'), null);
  assert.equal(adHostForUrl('', null as unknown as string), null);
});

test('adHostForUrl resolves relative and protocol-relative iframe sources', () => {
  assert.equal(adHostForUrl('//pagead2.googlesyndication.com/pagead'), 'googlesyndication.com');
  assert.equal(adHostForUrl('/pagead/js', 'https://ad.doubleclick.net/frame'), 'doubleclick.net');
  assert.equal(adHostForUrl('/images/banner.png', 'https://example.com/page'), null);
});

test('isSafeSelector rejects rule-breaking selector text', () => {
  assert.equal(isSafeSelector('.ad-slot'), true);
  assert.equal(isSafeSelector('div[data-ad="1"] > span'), true);
  assert.equal(isSafeSelector('body > div:nth-of-type(2)'), true);
  assert.equal(isSafeSelector('a { display: none }'), false);
  assert.equal(isSafeSelector('div; color: red'), false);
  assert.equal(isSafeSelector('<script>'), false);
  assert.equal(isSafeSelector(''), false);
  assert.equal(isSafeSelector('x'.repeat(501)), false);
});

test('escapeIdent falls back to CSS.escape compatible escaping without a CSS global', () => {
  assert.equal(escapeIdent('ad-slot'), 'ad-slot');
  assert.equal(escapeIdent('a b'), 'a\\ b');
  assert.match(escapeIdent('1col'), /^\\31 /);
});


test('isSafeLayoutProperty only allows layout-move properties', () => {
  const allowed = [
    'width',
    'height',
    'min-width',
    'min-height',
    'max-width',
    'max-height',
    'margin',
    'margin-top',
    'margin-left',
    'padding',
    'padding-bottom',
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
    'z-index',
    'position',
    'grid-template-columns',
    'grid-column',
    'grid-row',
    'grid-area',
  ];
  for (const property of allowed) assert.equal(isSafeLayoutProperty(property), true, property);
  const rejected = [
    'color',
    'background',
    'background-image',
    'display',
    'font-size',
    'behavior',
    '--custom',
    'grid',
    'url(x)',
    '',
  ];
  for (const property of rejected) assert.equal(isSafeLayoutProperty(property), false, property);
});

test('isSafeLayoutValue accepts normal CSS lengths and rejects injection payloads', () => {
  const accepted = [
    '100%',
    '320px',
    'auto',
    'none',
    '1 1 auto',
    '0',
    '-12px',
    '1fr',
    'calc(100% - 24px)',
    'fit-content(20em)',
    'minmax(0, 1fr)',
    'repeat(2, 1fr)',
    'stretch',
  ];
  for (const value of accepted) assert.equal(isSafeLayoutValue(value), true, value);
  const rejected = [
    'url(https://example.com/a.png)',
    'URL (x)',
    'expression(alert(1))',
    'javascript:alert(1)',
    '100%; color: red',
    '100%}',
    'a{b}',
    '<script>',
    '100% !important',
    '/* comment */',
    '',
    'x'.repeat(121),
    42,
  ];
  for (const value of rejected) assert.equal(isSafeLayoutValue(value), false, String(value));
});

test('sanitizeDeclarations keeps only safe allowlisted pairs', () => {
  const clean = sanitizeDeclarations({
    width: ' 100% ',
    'max-width': 'none',
    flex: '1 1 auto',
    color: 'red',
    'background-image': 'url(https://example.com/a.png)',
    height: '100%; color: red',
    position: 'absolute',
    'grid-template-columns': 'repeat(2, 1fr)',
  });
  assert.deepEqual(clean, {
    width: '100%',
    'max-width': 'none',
    flex: '1 1 auto',
    position: 'absolute',
    'grid-template-columns': 'repeat(2, 1fr)',
  });
  assert.deepEqual(sanitizeDeclarations({ WIDTH: '50%' }), { width: '50%' });
  assert.deepEqual(sanitizeDeclarations(null), {});
  assert.deepEqual(sanitizeDeclarations('width: 100%'), {});
  assert.deepEqual(sanitizeDeclarations([]), {});
});

test('declarationsToCss forces !important and layoutRuleCss builds one rule', () => {
  assert.equal(declarationsToCss({ width: '100%', height: '320px' }), 'width: 100% !important; height: 320px !important;');
  assert.equal(declarationsToCss({}), '');
  assert.equal(layoutRuleCss('.panel', { width: '100%' }), '.panel { width: 100% !important; }');
  assert.equal(layoutRuleCss('.panel', {}), '');
});

test('sanitizeLayoutRules filters, dedupes and keeps the last rule per selector', () => {
  const rules = sanitizeLayoutRules({
    layout: [
      { selector: '.panel', declarations: { width: '100%', color: 'red' } },
      { selector: 'div{', declarations: { width: '50%' } },
      { selector: '.empty', declarations: { color: 'red' } },
      { selector: '.disabled', declarations: { width: '10px' }, enabled: false },
      { selector: '.panel', declarations: { height: '200px' } },
    ],
  });
  assert.deepEqual(rules, [{ selector: '.panel', declarations: { height: '200px' } }]);
  assert.deepEqual(sanitizeLayoutRules([{ selector: 'div.x', declarations: { 'grid-template-columns': 'repeat(2, 1fr)' } }]), [
    { selector: 'div.x', declarations: { 'grid-template-columns': 'repeat(2, 1fr)' } },
  ]);
  assert.deepEqual(sanitizeLayoutRules(null), []);
  assert.deepEqual(sanitizeLayoutRules({}), []);
});

test('z-index values must be integers inside the 32-bit CSS range', () => {
  for (const value of ['0', '5', '-3', ' 42 ', '2147483647', '-2147483648']) {
    assert.equal(isSafeZIndexValue(value), true, value);
    assert.equal(isSafeLayoutValue(value, 'z-index'), true, value);
  }
  for (const value of ['auto', '5.5', '1e3', '2147483648', '-2147483649', '5px', '', '+5', '1 2', 5]) {
    assert.equal(isSafeZIndexValue(value), false, String(value));
    assert.equal(isSafeLayoutValue(value, 'z-index'), false, String(value));
  }
});

test('position values are limited to the safe positioning keywords', () => {
  for (const value of ['static', 'relative', 'absolute', 'fixed', 'sticky', ' RELATIVE ']) {
    assert.equal(isSafePositionValue(value), true, value);
    assert.equal(isSafeLayoutValue(value, 'position'), true, value);
  }
  for (const value of ['none', 'inherit', 'absolute;', '1', 'url(x)', '', 'relative !important']) {
    assert.equal(isSafePositionValue(value), false, String(value));
    assert.equal(isSafeLayoutValue(value, 'position'), false, String(value));
  }
});

test('sanitizeDeclarations keeps layer pairs and drops invalid z-index or position', () => {
  const clean = sanitizeDeclarations({ 'z-index': '7', position: 'relative', width: '320px' });
  assert.deepEqual(clean, { 'z-index': '7', position: 'relative', width: '320px' });
  assert.deepEqual(sanitizeDeclarations({ 'z-index': '9999999999', position: 'absolute;', width: '300px' }), {
    width: '300px',
  });
  assert.deepEqual(sanitizeDeclarations({ position: 'fixed', 'z-index': 'auto' }), { position: 'fixed' });
  assert.deepEqual(sanitizeDeclarations({ 'z-index': '5', position: 'relative' }), { 'z-index': '5', position: 'relative' });
});

test('declarationsToCss forces !important for layer declarations', () => {
  assert.equal(
    declarationsToCss({ position: 'relative', 'z-index': '-3' }),
    'position: relative !important; z-index: -3 !important;',
  );
  assert.equal(layoutRuleCss('.panel', { 'z-index': '5' }), '.panel { z-index: 5 !important; }');
});
