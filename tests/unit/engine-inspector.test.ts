import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { INJECTED_BINDING, INJECTED_GLOBAL } from '../../src/shared/types';
import { normalizeNetworkPatterns } from '../../src/main/engine/patterns';
import {
  buildGlobMatcher,
  createInspectorBootstrapScript,
  INSPECTOR_API_GLOBAL,
  INSPECTOR_BOOTSTRAP_VERSION,
} from '../../src/main/engine/inspector-bootstrap';
import {
  buildInspectorFilterPayload,
  countAttachedInspectorWindows,
  createInspectorEngine,
  findInspectorSocket,
  isInternalInspectorUrl,
  mergeInspectorCandidates,
  parseInjectedPayload,
  parseInspectorBlockedLogs,
  parseInspectorReports,
  parseInspectorWindows,
  selectInspectorPageUrl,
  sumInspectorApplyResults,
} from '../../src/main/engine/inspector-engine';

interface FakeWindowMessage {
  event: unknown;
  method: string;
  params: Record<string, unknown> | undefined;
}

interface FakeWindowCommand {
  method: string;
  params: Record<string, unknown> | undefined;
}

interface FakeWindow {
  id: number;
  getType(): string;
  getURL(): string;
  getTitle(): string;
  isDestroyed(): boolean;
  executeJavaScript(expression: string): Promise<unknown>;
  debugger: {
    attach(version: string): void;
    detach(): void;
    isAttached(): boolean;
    on(event: string, listener: (event: unknown, method: string, params: Record<string, unknown>) => void): void;
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  };
}

interface FakePageFixture {
  window: FakeWindow;
  messages: FakeWindowMessage[];
  commands: FakeWindowCommand[];
  electron: { webContents: { getAllWebContents(): FakeWindow[] } };
}

function createFakePage(): FakePageFixture {
  const messages: FakeWindowMessage[] = [];
  const commands: FakeWindowCommand[] = [];
  const window: FakeWindow = {
    id: 1,
    getType: () => 'window',
    getURL: () => 'tftacademy://./tierlist/comps/set-18',
    getTitle: () => 'Alune AP Fast 9 TFT Comp Guide',
    isDestroyed: () => false,
    executeJavaScript: (expression: string) => {
      if (expression.includes('.scan(')) {
        return Promise.resolve([
          { selector: '#ad-banner', tag: 'div', reason: 'ad class', matchCount: 2, width: 300, height: 250 },
        ]);
      }
      if (expression.includes('.apply(')) return Promise.resolve(2);
      return Promise.resolve(true);
    },
    debugger: {
      attach: () => undefined,
      detach: () => undefined,
      isAttached: () => true,
      on: (_event: string, listener: (event: unknown, method: string, params: Record<string, unknown>) => void) => {
        messagesListeners.push(listener);
      },
      sendCommand: (method: string, params?: Record<string, unknown>) => {
        commands.push({ method, params });
        return Promise.resolve({});
      },
    },
  };
  const messagesListeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
  const electron = { webContents: { getAllWebContents: () => [window] } };
  (window as unknown as { __listeners: typeof messagesListeners }).__listeners = messagesListeners;
  return { window, messages, commands, electron };
}

function createFakePage2(): FakePageFixture {
  const commands: FakeWindowCommand[] = [];
  const messagesListeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void> = [];
  const window: FakeWindow = {
    id: 7,
    getType: () => 'window',
    getURL: () => 'tftacademy://./tierlist',
    getTitle: () => 'TFTAcademy',
    isDestroyed: () => false,
    executeJavaScript: () => Promise.resolve(true),
    debugger: {
      attach: () => undefined,
      detach: () => undefined,
      isAttached: () => true,
      on: (_event: string, listener: (event: unknown, method: string, params: Record<string, unknown>) => void) => {
        messagesListeners.push(listener);
      },
      sendCommand: (method: string, params?: Record<string, unknown>) => {
        commands.push({ method, params });
        return Promise.resolve({});
      },
    },
  };
  const electron = { webContents: { getAllWebContents: () => [window] } };
  (window as unknown as { __listeners: typeof messagesListeners }).__listeners = messagesListeners;
  return { window, messages: [], commands, electron };
}

interface BootstrapHarness {
  api: Record<string, unknown>;
  fixture: FakePageFixture;
  context: vm.Context;
  script: string;
}

interface BootstrapSandboxOptions {
  argv?: string[];
  http?: unknown;
}

interface FakeHttpResponse {
  on(event: string, handler: (value?: unknown) => void): FakeHttpResponse;
}

function createFakeHttp(targetUrls: string[], options: { fail?: boolean } = {}): unknown {
  return {
    get: (_options: unknown, callback: (response: FakeHttpResponse) => void) => {
      const errorHandlers: Array<(error?: unknown) => void> = [];
      const request = {
        on: (event: string, handler: (value?: unknown) => void) => {
          if (event === 'error') errorHandlers.push(handler as (error?: unknown) => void);
          return request;
        },
        destroy: () => undefined,
      };
      if (options.fail) {
        queueMicrotask(() => {
          for (const handler of errorHandlers) handler(new Error('connect ECONNREFUSED'));
        });
        return request;
      }
      const body = JSON.stringify(targetUrls.map((url) => ({ url })));
      const response: FakeHttpResponse = {
        on: (event: string, handler: (value?: unknown) => void) => {
          if (event === 'data') handler(body);
          else if (event === 'end') handler();
          return response;
        },
      };
      callback(response);
      return request;
    },
  };
}

function installBootstrap(
  fixture: FakePageFixture,
  options: BootstrapSandboxOptions = {},
): BootstrapHarness {
  const script = createInspectorBootstrapScript();
  const http = options.http;
  const sandbox: Record<string, unknown> = {
    process: {
      versions: { electron: '42.7.1' },
      argv: options.argv ?? [],
      mainModule: {
        require: (name: string) => (name === 'http' ? http : fixture.electron),
      },
    },
    require: undefined,
    console,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(script, context);
  const api = (context as Record<string, unknown>)[INSPECTOR_API_GLOBAL] as Record<string, unknown>;
  return { api, fixture, context, script };
}

function messagesOf(fixture: FakePageFixture): Array<(event: unknown, method: string, params: Record<string, unknown>) => void> {
  return (fixture.window as unknown as {
    __listeners: Array<(event: unknown, method: string, params: Record<string, unknown>) => void>;
  }).__listeners;
}

test('glob matcher embeds and matches normalized ad patterns', () => {
  const patterns = normalizeNetworkPatterns(['ads.test']);
  const matcher = buildGlobMatcher(patterns);
  assert.equal(matcher('http://ads.test/ad.js'), true);
  assert.equal(matcher('https://ads.test/ad.js'), true);
  assert.equal(matcher('ws://ads.test/socket'), true);
  assert.equal(matcher('wss://ads.test/socket'), true);
  assert.equal(matcher('http://cdn.ads.test:8443/ad.js'), true);
  assert.equal(matcher('https://notads.test/ad.js'), false);
  assert.equal(matcher('https://example.com/page?u=ads.test'), false);
});

test('glob matcher ignores malformed and empty patterns', () => {
  const matcher = buildGlobMatcher(['', '[', '*://example.com/*']);
  assert.equal(matcher('https://example.com/x'), true);
  assert.equal(matcher('https://other.test/x'), false);
  assert.equal(matcher(''), false);
});

test('bootstrap source is valid, versioned and embeds the injected contract', () => {
  const script = createInspectorBootstrapScript();
  assert.ok(script.includes(INSPECTOR_API_GLOBAL));
  assert.ok(script.includes('var API_VERSION = ' + String(INSPECTOR_BOOTSTRAP_VERSION) + ';'));
  assert.ok(script.includes('__electronAdblockReport'));
  assert.ok(script.includes('__electronAdblock'));
  assert.ok(script.includes('Fetch.failRequest'));
  assert.ok(script.includes('BlockedByClient'));
  assert.ok(script.includes('Page.addScriptToEvaluateOnNewDocument'));
  assert.ok(script.includes('Runtime.addBinding'));
  const bootstrapName = '__eadInspectorApi';
  assert.ok(script.includes('globalThis.' + bootstrapName + ' = api;'));
  assert.ok(script.includes('if (existing && existing.version === API_VERSION)'));
  assert.equal(script.split('function buildGlobMatcher').length, 2);
  assert.doesNotThrow(() => {
    new Function(script);
  });
});

test('bootstrap installs once and drives fake hidden windows', async () => {
  const fixture = createFakePage();
  const first = installBootstrap(fixture);
  const secondMarker = vm.runInContext(first.script, first.context) as Record<string, unknown>;
  assert.equal(first.api.version, INSPECTOR_BOOTSTRAP_VERSION);
  assert.equal(secondMarker.fresh, false);
  assert.equal((first.context as Record<string, unknown>)[INSPECTOR_API_GLOBAL], first.api);

  const configured = (await (first.api.configureSource as (source: string) => Promise<Record<string, unknown>>)(
    'window.__testInjected = 1;',
  )) as Record<string, unknown>;
  assert.equal(configured.electron, true);
  assert.equal(configured.electronVersion, '42.7.1');
  const windows = parseInspectorWindows(configured.windows);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].attached, true);
  assert.equal(windows[0].url, 'tftacademy://./tierlist/comps/set-18');

  const applied = await (first.api.apply as (payload: unknown) => Promise<unknown>)({
    cosmetic: [{ selector: '.ad-banner' }],
    layout: [],
  });
  const summary = sumInspectorApplyResults(applied);
  assert.equal(summary.hidden, 2);
  assert.equal(summary.perWindow.get(1), 2);

  const patterns = normalizeNetworkPatterns(['ads.test']);
  const patternResult = (await (first.api.setPatterns as (
    values: string[],
    enabled: boolean,
  ) => Promise<Record<string, unknown>>)(patterns, true)) as Record<string, unknown>;
  assert.equal(patternResult.enabled, true);
  assert.equal(patternResult.patterns, patterns.length);

  const listener = messagesOf(fixture)[0];
  assert.equal(typeof listener, 'function');
  listener({}, 'Runtime.bindingCalled', {
    name: INJECTED_BINDING,
    payload: JSON.stringify({ type: 'ready' }),
  });
  const drain = (await (first.api.drainReports as () => Promise<Record<string, unknown>>)()) as Record<string, unknown>;
  assert.equal(parseInspectorReports(drain.reports).length, 1);
  const report = parseInspectorReports(drain.reports)[0];
  assert.equal(report.windowId, 1);
  assert.equal(parseInjectedPayload(report.payload)?.type, 'ready');

  const shutdown = await (first.api.shutdown as () => Promise<unknown>)();
  assert.equal(shutdown, true);
  assert.ok(
    fixture.commands.some((command) => command.method === 'Fetch.disable'),
    'teardown should restore Fetch for windows the bootstrap attached',
  );
});

test('bootstrap never steals a debugger already attached by another client', async () => {
  const commands: FakeWindowCommand[] = [];
  let detachCalls = 0;
  let attachCalls = 0;
  const window: FakeWindow = {
    id: 11,
    getType: () => 'window',
    getURL: () => 'https://www.op.gg/desktop/home',
    getTitle: () => 'OP.GG',
    isDestroyed: () => false,
    executeJavaScript: () => Promise.resolve(true),
    debugger: {
      attach: () => {
        attachCalls += 1;
        throw new Error('Debugger is already attached to the target');
      },
      detach: () => {
        detachCalls += 1;
      },
      isAttached: () => false,
      on: () => undefined,
      sendCommand: (method: string, params?: Record<string, unknown>) => {
        commands.push({ method, params });
        return Promise.resolve({});
      },
    },
  };
  const fixture: FakePageFixture = {
    window,
    messages: [],
    commands,
    electron: { webContents: { getAllWebContents: () => [window] } },
  };
  const harness = installBootstrap(fixture);
  const configured = (await (harness.api.configureSource as (
    source: string,
  ) => Promise<Record<string, unknown>>)('window.__x = 1;')) as Record<string, unknown>;
  const windows = parseInspectorWindows(configured.windows);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].attached, false);
  assert.match(String(windows[0].error), /already attached/i);
  assert.equal(attachCalls, 1);
  (harness.api.sync as () => unknown)();
  assert.equal(attachCalls, 1, 'attach backoff must prevent poll churn on foreign windows');
  for (const method of [
    'Page.enable',
    'Runtime.enable',
    'Runtime.addBinding',
    'Page.addScriptToEvaluateOnNewDocument',
    'Fetch.enable',
  ]) {
    assert.ok(
      !commands.some((command) => command.method === method),
      'must not drive a foreign debugger session: ' + method,
    );
  }
  await (harness.api.shutdown as () => Promise<unknown>)();
  assert.equal(detachCalls, 0, 'teardown must never detach a debugger it did not attach');
  assert.ok(!commands.some((command) => command.method === 'Fetch.disable'));
});

test('bootstrap skips windows visible in the Chromium CDP target list', async () => {
  const fixture = createFakePage();
  const http = createFakeHttp(['tftacademy://./tierlist/comps/set-18/']);
  const harness = installBootstrap(fixture, {
    argv: ['electron', '--remote-debugging-port=9333'],
    http,
  });
  const refresh = (await (harness.api.refreshCdpTargets as () => Promise<Record<string, unknown>>)()) as Record<
    string,
    unknown
  >;
  assert.equal(refresh.port, 9333);
  assert.equal(refresh.targets, 1);
  const configured = (await (harness.api.configureSource as (
    source: string,
  ) => Promise<Record<string, unknown>>)('window.__x = 1;')) as Record<string, unknown>;
  const windows = parseInspectorWindows(configured.windows);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].attached, false);
  assert.match(String(windows[0].error), /CDP/);
  for (const method of [
    'Page.enable',
    'Runtime.enable',
    'Runtime.addBinding',
    'Page.addScriptToEvaluateOnNewDocument',
    'Fetch.enable',
  ]) {
    assert.ok(
      !fixture.commands.some((command) => command.method === method),
      'CDP-owned window must not be driven: ' + method,
    );
  }
});

test('bootstrap still attaches hidden windows when the CDP list only has other pages', async () => {
  const fixture = createFakePage();
  const http = createFakeHttp(['https://www.overwolf.com/monsdk/electron/latest/adview.html']);
  const harness = installBootstrap(fixture, {
    argv: ['electron', '--remote-debugging-port=9333'],
    http,
  });
  await (harness.api.refreshCdpTargets as () => Promise<unknown>)();
  const configured = (await (harness.api.configureSource as (
    source: string,
  ) => Promise<Record<string, unknown>>)('window.__x = 1;')) as Record<string, unknown>;
  const windows = parseInspectorWindows(configured.windows);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].attached, true);
  assert.ok(fixture.commands.some((command) => command.method === 'Page.enable'));
  assert.ok(fixture.commands.some((command) => command.method === 'Runtime.addBinding'));
});

test('bootstrap keeps windows when the CDP target list never responds', async () => {
  const fixture = createFakePage();
  const http = createFakeHttp([], { fail: true });
  const harness = installBootstrap(fixture, {
    argv: ['electron', '--remote-debugging-port=9333'],
    http,
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await (harness.api.refreshCdpTargets as () => Promise<unknown>)();
  }
  const configured = (await (harness.api.configureSource as (
    source: string,
  ) => Promise<Record<string, unknown>>)('window.__x = 1;')) as Record<string, unknown>;
  const windows = parseInspectorWindows(configured.windows);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].attached, true);
});

test('bootstrap fails matching Fetch requests and continues others', async () => {
  const fixture = createFakePage2();
  const harness = installBootstrap(fixture);
  await (harness.api.configureSource as (source: string) => Promise<unknown>)('window.__testInjected = 1;');
  const patterns = normalizeNetworkPatterns(['ads.test']);
  await (harness.api.setPatterns as (values: string[], enabled: boolean) => Promise<unknown>)(
    patterns,
    true,
  );
  const listener = messagesOf(fixture)[0];
  listener({}, 'Fetch.requestPaused', {
    requestId: 'req-ad',
    request: { url: 'http://ads.test:8080/ad.js' },
  });
  listener({}, 'Fetch.requestPaused', {
    requestId: 'req-page',
    request: { url: 'https://www.op.gg/desktop/home' },
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  const methods = fixture.commands.map((command) => command.method);
  assert.ok(methods.includes('Fetch.failRequest'));
  assert.ok(methods.includes('Fetch.continueRequest'));
  const failCommand = fixture.commands.find((command) => command.method === 'Fetch.failRequest');
  assert.equal(failCommand?.params?.errorReason, 'BlockedByClient');
  const drain = (await (harness.api.drainReports as () => Promise<Record<string, unknown>>)()) as Record<
    string,
    unknown
  >;
  assert.equal(drain.blockedCount, 1);
  const blocked = parseInspectorBlockedLogs(drain.blockedLogs);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].url, 'http://ads.test:8080/ad.js');
  assert.equal(blocked[0].pageUrl, 'tftacademy://./tierlist');
});

test('bootstrap replaces a stale API version and cleans up its windows', () => {
  const script = createInspectorBootstrapScript();
  let shutdownCalls = 0;
  const stale = {
    version: INSPECTOR_BOOTSTRAP_VERSION - 1,
    shutdown: () => {
      shutdownCalls += 1;
      return Promise.resolve(true);
    },
  };
  const sandbox: Record<string, unknown> = {
    process: {
      versions: { electron: '42.7.1' },
      mainModule: { require: () => ({ webContents: { getAllWebContents: () => [] } }) },
    },
    require: undefined,
    console,
  };
  const context = vm.createContext(sandbox);
  (context as Record<string, unknown>)[INSPECTOR_API_GLOBAL] = stale;
  const marker = vm.runInContext(script, context) as Record<string, unknown>;
  assert.equal(marker.fresh, true);
  assert.equal(shutdownCalls, 1);
  const installed = (context as Record<string, unknown>)[INSPECTOR_API_GLOBAL] as Record<string, unknown>;
  assert.notEqual(installed, stale);
  assert.equal(installed.version, INSPECTOR_BOOTSTRAP_VERSION);
});

test('reports, windows and blocked logs are parsed defensively', () => {
  assert.deepEqual(parseInspectorReports(null), []);
  assert.deepEqual(parseInspectorReports([{}]), []);
  assert.deepEqual(parseInspectorReports([{ windowId: 1, payload: '' }]), []);
  const reports = parseInspectorReports([{ windowId: 3, payload: '{"type":"ready"}', at: 5 }]);
  assert.deepEqual(reports, [{ windowId: 3, payload: '{"type":"ready"}', at: 5 }]);

  assert.deepEqual(parseInspectorWindows('nope'), []);
  const windows = parseInspectorWindows([
    { id: 1, url: 'tftacademy://./tierlist', title: 'TFTAcademy', attached: true },
    { id: 2, url: 'owepm://index.html/', title: 'internal', attached: true, error: 'no debugger' },
  ]);
  assert.equal(windows.length, 2);
  assert.equal(windows[1].error, 'no debugger');

  assert.deepEqual(parseInspectorBlockedLogs([{}]), []);
  const blocked = parseInspectorBlockedLogs([
    { windowId: 3, url: 'https://ad.test/x', pageUrl: 'tftacademy://./x', at: 12 },
  ]);
  assert.deepEqual(blocked, [
    { windowId: 3, url: 'https://ad.test/x', pageUrl: 'tftacademy://./x', at: 12 },
  ]);
});

test('injected payload parser accepts only known report types', () => {
  assert.equal(parseInjectedPayload('') , null);
  assert.equal(parseInjectedPayload('not json'), null);
  assert.equal(parseInjectedPayload('42'), null);
  assert.equal(parseInjectedPayload('{"type":"unknown"}'), null);
  const ready = parseInjectedPayload('{"type":"ready"}');
  assert.equal(ready?.type, 'ready');
  const pick = parseInjectedPayload(
    '{"type":"pick","payload":{"selector":"#ad","label":"Ad","matchCount":1,"frameUrl":"tftacademy://./x","tag":"div","width":10,"height":20}}',
  );
  assert.equal(pick?.type, 'pick');
  const layout = parseInjectedPayload(
    '{"type":"layout","payload":{"selector":".x","declarations":{"z-index":"1"},"label":"","frameUrl":"tftacademy://./x","matches":1}}',
  );
  assert.equal(layout?.type, 'layout');
});

test('apply results and scan candidates are merged defensively', () => {
  const summary = sumInspectorApplyResults([
    { windowId: 1, hidden: 2, ok: true },
    { windowId: 2, hidden: 3, ok: true },
    { windowId: 1, hidden: 9, ok: true },
    { windowId: 'bad', hidden: 5 },
  ]);
  assert.equal(summary.hidden, 14);
  assert.equal(summary.perWindow.get(1), 9);
  assert.equal(summary.perWindow.get(2), 3);
  assert.deepEqual(sumInspectorApplyResults(undefined), { hidden: 0, perWindow: new Map() });

  const candidates = mergeInspectorCandidates([
    { selector: '.ad', tag: 'div', reason: 'ad class', matchCount: 2, width: 10, height: 20 },
    { selector: '.ad', tag: 'div', reason: 'duplicate', matchCount: 5, width: 1, height: 1 },
    { selector: '  ', tag: 'div' },
    { selector: '#sponsor', matchCount: 0 },
    'garbage',
  ]);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].selector, '.ad');
  assert.equal(candidates[0].matchCount, 2);
  assert.equal(candidates[1].selector, '#sponsor');
  assert.equal(candidates[1].matchCount, 1);
});

test('pages only count windows the inspector attached itself', () => {
  const windows = parseInspectorWindows([
    { id: 1, url: 'tftacademy://./tierlist', title: '', attached: true },
    { id: 2, url: 'owepm://index.html/', title: '', attached: true },
    { id: 3, url: 'https://www.op.gg/desktop/home', title: '', attached: false, error: 'already attached' },
  ]);
  assert.equal(countAttachedInspectorWindows(windows), 2);
  assert.equal(countAttachedInspectorWindows([]), 0);
});

test('window URL selection skips internal Overwolf pages and keeps history', () => {
  assert.equal(isInternalInspectorUrl('owepm://index.html/'), true);
  assert.equal(isInternalInspectorUrl('about:blank'), true);
  assert.equal(isInternalInspectorUrl('devtools://devtools/bundled/x'), true);
  assert.equal(isInternalInspectorUrl('tftacademy://./tierlist'), false);
  assert.equal(isInternalInspectorUrl('https://www.op.gg/desktop/home'), false);
  const windows = [
    { id: 2, url: 'owepm://index.html/', title: '', attached: true },
    { id: 1, url: 'tftacademy://./tierlist', title: '', attached: true },
  ];
  assert.equal(selectInspectorPageUrl(windows), 'tftacademy://./tierlist');
  assert.equal(
    selectInspectorPageUrl([windows[0]], 'https://previous.example/home'),
    'https://previous.example/home',
  );
  assert.equal(selectInspectorPageUrl([], undefined), undefined);
});

test('inspector socket is located from the /json/list payload', () => {
  assert.equal(findInspectorSocket(null), undefined);
  assert.equal(findInspectorSocket([{ type: 'page', webSocketDebuggerUrl: 'ws://page' }]), undefined);
  assert.equal(
    findInspectorSocket([
      { type: 'page', webSocketDebuggerUrl: 'ws://page' },
      { type: 'node', webSocketDebuggerUrl: 'ws://node' },
    ]),
    'ws://node',
  );
});

test('filter payload only carries enabled cosmetic and layout rules', () => {
  const payload = buildInspectorFilterPayload({
    enabled: true,
    cosmetic: [
      {
        id: 'c1',
        selector: '.ad',
        urlPattern: 'tftacademy://*',
        enabled: true,
        source: 'manual',
        createdAt: 0,
      },
      { id: 'c2', selector: '.paused', enabled: false, source: 'manual', createdAt: 0 },
    ],
    networkPatterns: ['ads.test'],
    layout: [
      {
        id: 'l1',
        selector: '#panel',
        declarations: { width: '100px', 'z-index': '2' },
        enabled: true,
        source: 'layout',
        createdAt: 0,
      },
      {
        id: 'l2',
        selector: '#paused',
        declarations: { width: '1px' },
        enabled: false,
        source: 'layout',
        createdAt: 0,
      },
    ],
  });
  assert.deepEqual(payload.cosmetic, [{ selector: '.ad', urlPattern: 'tftacademy://*' }]);
  assert.deepEqual(payload.layout, [{ selector: '#panel', declarations: { width: '100px', 'z-index': '2' } }]);
  assert.deepEqual(
    buildInspectorFilterPayload({
      enabled: false,
      cosmetic: [{ id: 'c', selector: '.ad', enabled: true, source: 'manual', createdAt: 0 }],
      networkPatterns: [],
      layout: [],
    }),
    { cosmetic: [], layout: [] },
  );
});

test('inspector engine is importable and safe while disconnected', async () => {
  const engine = createInspectorEngine({
    appId: 'inspector-test',
    injectedScript: '',
    inspectorPort: 0,
    getConfig: () => ({ enabled: true, cosmetic: [], networkPatterns: [], layout: [] }),
    onEvent: () => undefined,
  });
  assert.equal(engine.connected, false);
  assert.deepEqual(engine.stats(), { blockedRequests: 0, hiddenElements: 0, pages: 0 });
  await assert.rejects(engine.connect(0), /Invalid inspector port/);
  await engine.stopPicker();
  await assert.rejects(engine.scanForAds(), /not connected/);
  await engine.disconnect();
  assert.equal(engine.connected, false);
});
