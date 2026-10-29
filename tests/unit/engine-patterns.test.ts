import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { parseElectronVersion } from '../../src/main/engine/cdp';
import {
  createUrlMatcher,
  matchesUrlFilter,
  matchesUrlPattern,
  matchesUrlPatterns,
  normalizeNetworkPattern,
  normalizeNetworkPatterns,
} from '../../src/main/engine/patterns';
import { probeDebugEndpoint } from '../../src/main/engine/engine';

test('a bare domain becomes anchored scheme, subdomain and port globs', () => {
  const patterns = normalizeNetworkPatterns(['doubleclick.net']);
  assert.deepEqual(patterns, [
    '*://doubleclick.net/*',
    '*://doubleclick.net:*/*',
    '*://*.doubleclick.net/*',
    '*://*.doubleclick.net:*/*',
  ]);
});

test('bare domain globs cover http, https, ws and wss plus subdomains and ports', () => {
  const matcher = createUrlMatcher(normalizeNetworkPatterns(['doubleclick.net']));
  const matches = [
    'http://doubleclick.net/ad.js',
    'https://doubleclick.net/ad.js',
    'ws://doubleclick.net/socket',
    'wss://doubleclick.net/socket',
    'https://ads.doubleclick.net/pixel.png',
    'http://cdn.doubleclick.net:8080/ad.js',
  ];
  for (const url of matches) assert.equal(matcher(url), true, url);
  const misses = [
    'https://notdoubleclick.net/ad.js',
    'https://doubleclick.net.evil.com/ad.js',
    'https://example.com/page?ad=doubleclick.net',
    'file:///C:/page.html',
  ];
  for (const url of misses) assert.equal(matcher(url), false, url);
});

test('explicit ports stay part of the host pattern', () => {
  const patterns = normalizeNetworkPattern('ads.test:8123');
  assert.deepEqual(patterns, ['*://ads.test:8123/*', '*://*.ads.test:8123/*']);
  const matcher = createUrlMatcher(patterns);
  assert.equal(matcher('http://ads.test:8123/ad.js'), true);
  assert.equal(matcher('http://ads.test:9000/ad.js'), false);
  assert.equal(matcher('https://sub.ads.test:8123/ad.js'), true);
});

test('existing URL globs are kept verbatim', () => {
  assert.deepEqual(normalizeNetworkPattern('*://example.com/*'), [
    '*://example.com/*',
    '*://example.com:*/*',
  ]);
  assert.deepEqual(normalizeNetworkPattern('*/ads/*'), ['*/ads/*']);
  assert.deepEqual(normalizeNetworkPattern('/ads/*'), ['*/ads/*']);
  assert.deepEqual(normalizeNetworkPattern('resource://*/ads/*'), ['resource://*/ads/*']);
});

test('explicit URL globs also cover requests carrying an explicit port', () => {
  const patterns = normalizeNetworkPatterns(['*://ads.test/*']);
  assert.ok(patterns.includes('*://ads.test/*'));
  assert.ok(patterns.includes('*://ads.test:*/*'));
  const matcher = createUrlMatcher(patterns);
  assert.equal(matcher('http://ads.test:8123/ad.js'), true);
});

test('explicit ports on URL globs are not duplicated', () => {
  assert.deepEqual(normalizeNetworkPattern('*://ads.test:8123/*'), ['*://ads.test:8123/*']);
});

test('host-only globs expand to anchored URL globs', () => {
  assert.deepEqual(normalizeNetworkPattern('*.doubleclick.net'), [
    '*://*.doubleclick.net/*',
    '*://*.doubleclick.net:*/*',
  ]);
});

test('protocol relative and host/path patterns are normalized', () => {
  assert.deepEqual(normalizeNetworkPattern('//ads.example.com'), [
    '*://ads.example.com/*',
    '*://ads.example.com:*/*',
  ]);
  assert.deepEqual(normalizeNetworkPattern('//ads.example.com/pixel.js'), [
    '*://ads.example.com/pixel.js*',
    '*://ads.example.com:*/pixel.js*',
  ]);
  assert.deepEqual(normalizeNetworkPattern('ads.example.com/pixel.*'), [
    '*://ads.example.com/pixel.*',
    '*://ads.example.com:*/pixel.*',
  ]);
});

test('normalization de-duplicates and ignores unusable entries', () => {
  const patterns = normalizeNetworkPatterns([
    'doubleclick.net',
    'doubleclick.net',
    '  ',
    '',
    '!comment',
    'not a host',
    '127.0.0.1:4700',
  ]);
  assert.equal(patterns.filter((entry) => entry === '*://doubleclick.net/*').length, 1);
  assert.ok(patterns.includes('*://127.0.0.1:4700/*'));
  assert.ok(!patterns.some((entry) => entry.includes('comment')));
  assert.ok(!patterns.some((entry) => entry.includes('not a host')));
});

test('wildcard glob matching supports ? and is case insensitive', () => {
  assert.equal(matchesUrlPattern('https://example.com/ads.js', '*://example.com/ads.?s'), true);
  assert.equal(matchesUrlPattern('https://example.com/ads.png', '*://example.com/ads.?s'), false);
  assert.equal(matchesUrlPattern('HTTPS://EXAMPLE.COM/ADS.JS', '*://example.com/ads.*'), true);
  assert.equal(matchesUrlPattern('', '*://example.com/*'), false);
});

test('URL filters scope cosmetic rules by frame URL', () => {
  assert.equal(matchesUrlFilter('https://www.op.gg/desktop/home', 'op.gg'), true);
  assert.equal(matchesUrlFilter('https://op.gg:8443/desktop', 'op.gg'), true);
  assert.equal(matchesUrlFilter('https://example.com/x', 'op.gg'), false);
  assert.equal(matchesUrlFilter('https://www.op.gg/desktop/home', '*://*.op.gg/*'), true);
  assert.equal(matchesUrlFilter('https://www.op.gg/desktop/home', undefined), true);
});

test('electron version parsing accepts CDP version payloads', () => {
  assert.equal(
    parseElectronVersion({
      Browser: 'Chrome/140.0.7339.133',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Electron/44.1.1 Chrome/140.0.7339.133 Safari/537.36',
    }),
    '44.1.1',
  );
  assert.equal(
    parseElectronVersion({
      product: 'Chrome/140.0.7339.133',
      userAgent: 'Mozilla/5.0 Electron/30.0.0 Chrome/124.0.0.0 Safari/537.36',
    }),
    '30.0.0',
  );
  assert.equal(parseElectronVersion('Electron/22.3.27 Chrome/108.0.0.0'), '22.3.27');
  assert.equal(parseElectronVersion('44.1.1'), '44.1.1');
  assert.equal(parseElectronVersion({ electronVersion: '33.4.5' }), '33.4.5');
  assert.equal(parseElectronVersion('Electron/44.1.1-beta.2 Chrome/140.0.0.0'), '44.1.1-beta.2');
});

test('electron version parsing does not invent a version', () => {
  assert.equal(
    parseElectronVersion({
      Browser: 'Chrome/140.0.7339.133',
      'User-Agent': 'Mozilla/5.0 Chrome/140.0.7339.133 Safari/537.36',
    }),
    undefined,
  );
  assert.equal(parseElectronVersion(null), undefined);
  assert.equal(parseElectronVersion(42), undefined);
});

async function startFakeDebugServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    if (request.url === '/json/version') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          Browser: 'Chrome/140.0.7339.133',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Electron/44.1.1 Chrome/140.0.7339.133 Safari/537.36',
          webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/fake',
        }),
      );
      return;
    }
    if (request.url === '/json/list') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([{ id: 'page-1' }, { id: 'page-2' }]));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve the fake server address');
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

test('probeDebugEndpoint reads the electron version and target count', async () => {
  const fake = await startFakeDebugServer();
  try {
    const info = await probeDebugEndpoint(fake.port, 1000);
    assert.deepEqual(info, { port: fake.port, electronVersion: '44.1.1', targetCount: 2 });
  } finally {
    await fake.close();
  }
});

test('probeDebugEndpoint returns null when no endpoint is listening', async () => {
  const fake = await startFakeDebugServer();
  const port = fake.port;
  await fake.close();
  assert.equal(await probeDebugEndpoint(port, 400), null);
  assert.equal(await probeDebugEndpoint(0), null);
  assert.equal(await probeDebugEndpoint(-1), null);
});
