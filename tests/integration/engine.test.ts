import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createEngine } from '../../src/main/engine/engine';
import type {
  AppStats,
  CosmeticRule,
  Engine,
  EngineEvent,
  EngineFilterConfig,
} from '../../src/shared/types';
import { startAdServer, type AdServer } from '../helpers/ad-server';
import { connectToPage, delay, type CdpConnection, type CdpPage } from '../helpers/cdp';
import {
  PROJECT_ROOT,
  isProcessAlive,
  launchFixture,
  listElectronProcessesForFixture,
  waitForNoFixtureProcesses,
} from '../helpers/fixture';

const INJECTED_SCRIPT_PATH = path.join(PROJECT_ROOT, 'build', 'injected.js');
const ENGINE_APP_ID = 'qa-fixture';
const ENGINE_EVENT_TIMEOUT_MS = 8000;

async function loadInjectedScript(): Promise<string> {
  try {
    return await readFile(INJECTED_SCRIPT_PATH, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      'Missing built injected script at ' +
        INJECTED_SCRIPT_PATH +
        '. Run "npm run build" before the integration tests (' +
        detail +
        ').',
    );
  }
}

let ruleCounter = 0;

function cosmeticRule(selector: string, overrides: Partial<CosmeticRule> = {}): CosmeticRule {
  ruleCounter += 1;
  return {
    id: 'qa-rule-' + ruleCounter,
    selector,
    enabled: true,
    source: 'manual',
    createdAt: Date.now(),
    ...overrides,
  };
}

interface EngineHarness {
  engine: Engine;
  config: EngineFilterConfig;
  events: EngineEvent[];
  listeners: Set<(event: EngineEvent) => void>;
}

async function launchEngine(
  port: number,
  overrides: Partial<EngineFilterConfig> = {},
): Promise<EngineHarness> {
  const injectedScript = await loadInjectedScript();
  const config: EngineFilterConfig = {
    enabled: true,
    cosmetic: [],
    networkPatterns: [],
    layout: [],
    ...overrides,
  };
  const events: EngineEvent[] = [];
  const listeners = new Set<(event: EngineEvent) => void>();
  const engine = createEngine({
    appId: ENGINE_APP_ID,
    injectedScript,
    getConfig: () => config,
    onEvent: (event) => {
      events.push(event);
      for (const listener of listeners) listener(event);
    },
  });
  await engine.connect(port);
  await engine.updateFilters();
  return { engine, config, events, listeners };
}

function waitForEngineEvent<T extends EngineEvent['type']>(
  harness: EngineHarness,
  type: T,
  predicate?: (event: Extract<EngineEvent, { type: T }>) => boolean,
  timeoutMs = ENGINE_EVENT_TIMEOUT_MS,
): Promise<Extract<EngineEvent, { type: T }>> {
  type Match = Extract<EngineEvent, { type: T }>;
  const isMatch = (event: EngineEvent): event is Match =>
    event.type === type && (predicate ? predicate(event as Match) : true);

  const existing = harness.events.find(isMatch);
  if (existing) return Promise.resolve(existing);

  return new Promise<Match>((resolve, reject) => {
    const timer = setTimeout(() => {
      harness.listeners.delete(listener);
      reject(new Error('timed out after ' + timeoutMs + 'ms waiting for engine event "' + type + '"'));
    }, timeoutMs);
    const listener = (event: EngineEvent): void => {
      if (!isMatch(event)) return;
      clearTimeout(timer);
      harness.listeners.delete(listener);
      resolve(event);
    };
    harness.listeners.add(listener);
  });
}

async function waitForStats(
  harness: EngineHarness,
  predicate: (stats: AppStats) => boolean,
  timeoutMs = ENGINE_EVENT_TIMEOUT_MS,
): Promise<AppStats> {
  const deadline = Date.now() + timeoutMs;
  let latest = harness.engine.stats();
  while (Date.now() < deadline) {
    latest = harness.engine.stats();
    if (predicate(latest)) return latest;
    await delay(50);
  }
  throw new Error(
    'timed out after ' + timeoutMs + 'ms waiting for engine stats; latest=' + JSON.stringify(latest),
  );
}

async function waitForServerCount(
  server: AdServer,
  pathname: string,
  minimum: number,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.count(pathname) >= minimum) return;
    await delay(50);
  }
  throw new Error(
    'expected at least ' +
      minimum +
      ' request(s) to ' +
      pathname +
      '; counts=' +
      JSON.stringify(server.counts()),
  );
}

function trackCleanup(t: TestContext, steps: Array<() => Promise<void> | void>): void {
  t.after(async () => {
    for (const step of steps) {
      try {
        await step();
      } catch (error) {
        process.stderr.write(
          '[integration cleanup] ' + (error instanceof Error ? error.message : String(error)) + '\n',
        );
      }
    }
  });
}

test(
  'network blocking stops ad requests and ad script side effects',
  { timeout: 120_000 },
  async (t) => {
    const server = await startAdServer();
    const fixture = await launchFixture({ url: 'about:blank', cleanup: [server] });
    const { connection, page } = await connectToPage(fixture.port);

    let harness: EngineHarness | null = null;
    trackCleanup(t, [
      async () => {
        if (harness) await harness.engine.disconnect();
      },
      async () => {
        await page.close();
      },
      async () => {
        await connection.close();
      },
      async () => {
        await fixture.close();
      },
      async () => {
        await server.close();
      },
    ]);

    // Control run: without filters the fake ad host resolves and the endpoints are reached.
    await page.navigate(server.pageUrl);
    await page.waitFor('window.__pageReady === "page1" && document.readyState === "complete"', {
      timeoutMs: 15000,
      description: 'page1 load',
    });
    await page.waitFor('window.__adScriptLoaded === true', {
      timeoutMs: 10000,
      description: 'ad script execution',
    });
    await waitForServerCount(server, '/ad.js', 1);
    await waitForServerCount(server, '/pixel.png', 1);

    server.resetCounts();
    harness = await launchEngine(fixture.port, { networkPatterns: ['ads.test'] });
    const blockedBefore = harness.engine.stats().blockedRequests;

    await page.reload({ ignoreCache: true });
    await page.waitFor('window.__pageReady === "page1"', {
      timeoutMs: 15000,
      description: 'page1 reload',
    });

    const stats = await waitForStats(harness, (current) => current.blockedRequests > blockedBefore, 8000);
    assert.ok(
      stats.blockedRequests > blockedBefore,
      'blockedRequests should grow after the reload (before=' + blockedBefore + ')',
    );

    const adScriptLoaded = await page.evaluate<boolean>('window.__adScriptLoaded');
    assert.equal(adScriptLoaded, false, 'the blocked ad script must not execute');
    const adScriptAttribute = await page.evaluate<boolean>(
      'document.documentElement.hasAttribute("data-ad-script")',
    );
    assert.equal(adScriptAttribute, false, 'the blocked ad script must not mutate the document');
    assert.equal(server.count('/ad.js'), 0, 'blocked /ad.js must never reach the ad server');
    assert.equal(server.count('/pixel.png'), 0, 'blocked /pixel.png must never reach the ad server');

    // updateFilters must reflect network rule changes at runtime. The port-aware glob
    // form covers the fixture's ephemeral ad port.
    const blockedWithHostPattern = stats.blockedRequests;
    harness.config.networkPatterns = ['*://ads.test:*/*'];
    await harness.engine.updateFilters();
    await page.reload({ ignoreCache: true });
    await page.waitFor('window.__pageReady === "page1"', {
      timeoutMs: 15000,
      description: 'page1 reload with wildcard pattern',
    });
    const wildcardStats = await waitForStats(
      harness,
      (current) => current.blockedRequests > blockedWithHostPattern,
      8000,
    );
    assert.ok(
      wildcardStats.blockedRequests > blockedWithHostPattern,
      'the wildcard network pattern must block requests too',
    );
    assert.equal(
      await page.evaluate<boolean>('window.__adScriptLoaded'),
      false,
      'the ad script must stay blocked with the wildcard pattern',
    );
    assert.equal(server.count('/ad.js'), 0, 'wildcard blocking must keep /ad.js off the ad server');
    assert.equal(server.count('/pixel.png'), 0, 'wildcard blocking must keep /pixel.png off the ad server');

    // Removing every network rule through updateFilters must unblock the requests again.
    server.resetCounts();
    harness.config.networkPatterns = [];
    await harness.engine.updateFilters();
    await page.reload({ ignoreCache: true });
    await page.waitFor('window.__pageReady === "page1"', {
      timeoutMs: 15000,
      description: 'page1 reload without network rules',
    });
    await page.waitFor('window.__adScriptLoaded === true', {
      timeoutMs: 10000,
      description: 'ad script execution after removing network rules',
    });
    await waitForServerCount(server, '/ad.js', 1);
    await waitForServerCount(server, '/pixel.png', 1);
  },
);

test(
  'cosmetic filters hide elements, apply new rules live and survive navigation',
  { timeout: 120_000 },
  async (t) => {
    const server = await startAdServer();
    const fixture = await launchFixture({ url: server.pageUrl, cleanup: [server] });
    const { connection, page } = await connectToPage(fixture.port);

    let harness: EngineHarness | null = null;
    trackCleanup(t, [
      async () => {
        if (harness) await harness.engine.disconnect();
      },
      async () => {
        await page.close();
      },
      async () => {
        await connection.close();
      },
      async () => {
        await fixture.close();
      },
      async () => {
        await server.close();
      },
    ]);

    await page.waitFor('window.__pageReady === "page1" && document.readyState === "complete"', {
      timeoutMs: 15000,
      description: 'page1 load',
    });
    await page.waitFor('document.querySelector("#ad-banner") !== null', { timeoutMs: 10000 });

    harness = await launchEngine(fixture.port, {
      cosmetic: [cosmeticRule('.ad-banner')],
      networkPatterns: [],
    });

    await page.waitFor('getComputedStyle(document.querySelector("#ad-banner")).display === "none"', {
      timeoutMs: 8000,
      description: '.ad-banner hidden',
    });

    // A rule added after connect must apply without reloading the page.
    harness.config.cosmetic = [
      ...harness.config.cosmetic,
      cosmeticRule('aside.sponsor-slot'),
    ];
    await harness.engine.updateFilters();
    await page.waitFor(
      'getComputedStyle(document.querySelector("aside.sponsor-slot")).display === "none"',
      { timeoutMs: 8000, description: 'aside.sponsor-slot hidden after live rule update' },
    );

    // Cosmetic rules must be applied again on the next document.
    await page.navigate(server.page2Url);
    await page.waitFor('window.__pageReady === "page2" && document.readyState === "complete"', {
      timeoutMs: 15000,
      description: 'page2 load',
    });
    await page.waitFor('document.querySelector(".ad-banner") !== null', { timeoutMs: 10000 });
    await page.waitFor('getComputedStyle(document.querySelector(".ad-banner")).display === "none"', {
      timeoutMs: 8000,
      description: '.ad-banner hidden after navigation',
    });

    // Layout rules must apply through updateFilters and be removable again at runtime.
    const initialWidth = await page.evaluate<string>(
      'getComputedStyle(document.querySelector(".content")).width',
    );
    assert.notEqual(initialWidth, '123px');
    harness.config.layout = [
      {
        id: 'lr-test',
        selector: '.content',
        declarations: { width: '123px' },
        enabled: true,
        source: 'layout',
        createdAt: Date.now(),
      },
    ];
    await harness.engine.updateFilters();
    await page.waitFor('getComputedStyle(document.querySelector(".content")).width === "123px"', {
      timeoutMs: 8000,
      description: 'layout rule width applied',
    });

    harness.config.layout = [];
    await harness.engine.updateFilters();
    await page.waitFor(
      'getComputedStyle(document.querySelector(".content")).width === ' + JSON.stringify(initialWidth),
      { timeoutMs: 8000, description: 'layout width restored after clearing layout rules' },
    );
  },
);

test(
  'picker returns a selector that hides the picked element',
  { timeout: 120_000 },
  async (t) => {
    const server = await startAdServer();
    const fixture = await launchFixture({ url: server.pageUrl, cleanup: [server] });
    const { connection, page } = await connectToPage(fixture.port);

    let harness: EngineHarness | null = null;
    trackCleanup(t, [
      async () => {
        if (harness) await harness.engine.disconnect();
      },
      async () => {
        await page.close();
      },
      async () => {
        await connection.close();
      },
      async () => {
        await fixture.close();
      },
      async () => {
        await server.close();
      },
    ]);

    await page.waitFor('window.__pageReady === "page1" && document.readyState === "complete"', {
      timeoutMs: 15000,
      description: 'page1 load',
    });

    harness = await launchEngine(fixture.port, {
      cosmetic: [cosmeticRule('.ad-banner')],
      networkPatterns: [],
    });
    // Make sure the injected script is active before the picker starts.
    await page.waitFor('getComputedStyle(document.querySelector("#ad-banner")).display === "none"', {
      timeoutMs: 8000,
      description: 'engine filters active',
    });

    const rect = await page.boundingRect('#pick-target');
    assert.ok(rect, '#pick-target must exist on the fixture page');
    const targetX = rect.x + rect.width / 2;
    const targetY = rect.y + rect.height / 2;

    const pickedEvent = waitForEngineEvent(harness, 'picked');
    await harness.engine.startPicker();
    await delay(150);
    await page.click(targetX, targetY);
    const picked = await pickedEvent;
    assert.ok(picked.report.selector.length > 0, 'the picker must report a selector');
    assert.ok(picked.report.matchCount >= 1, 'the reported selector must match at least one element');

    const matches = await page.evaluate<number>(
      'document.querySelectorAll(' + JSON.stringify(picked.report.selector) + ').length',
    );
    assert.ok(matches >= 1, 'the reported selector must match the fixture DOM');

    await harness.engine.stopPicker();
    harness.config.cosmetic = [...harness.config.cosmetic, cosmeticRule(picked.report.selector)];
    await harness.engine.updateFilters();
    await page.waitFor(
      'getComputedStyle(document.querySelector(' +
        JSON.stringify(picked.report.selector) +
        ')).display === "none"',
      { timeoutMs: 8000, description: 'picked element hidden by its selector' },
    );

    // The stored rule must be applied again on a fresh document.
    await page.navigate(server.page2Url);
    await page.waitFor('window.__pageReady === "page2" && document.readyState === "complete"', {
      timeoutMs: 15000,
      description: 'page2 load after picking',
    });
    await page.waitFor('document.querySelector("#pick-target") !== null', { timeoutMs: 10000 });
    await page.waitFor(
      'getComputedStyle(document.querySelector("#pick-target")).display === "none"',
      { timeoutMs: 8000, description: 'picked selector applied after navigation' },
    );
  },
);

test(
  'disconnect is idempotent and teardown leaves no fixture processes',
  { timeout: 120_000 },
  async (t) => {
    const server = await startAdServer();
    const fixture = await launchFixture({ url: server.pageUrl, cleanup: [server] });

    let harness: EngineHarness | null = null;
    trackCleanup(t, [
      async () => {
        if (harness) await harness.engine.disconnect();
      },
      async () => {
        await fixture.close();
      },
      async () => {
        await server.close();
      },
    ]);

    harness = await launchEngine(fixture.port);
    assert.equal(harness.engine.connected, true, 'engine should be connected after connect()');

    await harness.engine.disconnect();
    assert.equal(harness.engine.connected, false, 'engine should be disconnected after disconnect()');
    await harness.engine.disconnect();
    assert.equal(harness.engine.connected, false, 'disconnect() must be idempotent');

    const pid = fixture.pid;
    await fixture.close();
    assert.equal(isProcessAlive(pid), false, 'the fixture Electron process must be killed');
    await waitForNoFixtureProcesses();
    assert.deepEqual(
      await listElectronProcessesForFixture(),
      [],
      'no fixture Electron process may remain',
    );

    // Disconnecting after teardown must stay safe.
    await harness.engine.disconnect();
    assert.equal(harness.engine.connected, false);
  },
);
