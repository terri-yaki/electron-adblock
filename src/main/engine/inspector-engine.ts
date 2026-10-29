import type {
  AdCandidate,
  AppStats,
  BlockedEvent,
  CosmeticRule,
  Engine,
  EngineConnectResult,
  EngineEvent,
  EngineFilterConfig,
  EngineOptions,
  LayoutReport,
  LayoutRule,
  PickReport,
} from '../../shared/types';
import type { InjectedMessage } from '../../injected/messages';
import { asNumber, asRecord, asString, CdpClient, fetchJson, unrefTimer } from './cdp';
import { normalizeNetworkPatterns } from './patterns';
import {
  createInspectorBootstrapScript,
  INSPECTOR_API_GLOBAL,
  INSPECTOR_BOOTSTRAP_VERSION,
  type InspectorDrainPayload,
  type InspectorSyncPayload,
  type InspectorWindowSnapshot,
} from './inspector-bootstrap';

const CONNECT_TIMEOUT_MS = 10000;
const REQUEST_TIMEOUT_MS = 8000;
const FAST_REQUEST_TIMEOUT_MS = 4000;
const POLL_INTERVAL_MS = 600;
const STATS_DEBOUNCE_MS = 200;
const CLEANUP_TIMEOUT_MS = 1500;
const DISCONNECT_GRACE_MS = 1500;
const ERROR_THROTTLE_MS = 5000;
const CDP_REFRESH_INTERVAL_MS = 5000;
const EMPTY_CONFIG: EngineFilterConfig = { enabled: false, cosmetic: [], networkPatterns: [], layout: [] };
const INJECTED_MESSAGE_TYPES = new Set<string>([
  'ready',
  'pick',
  'picker-state',
  'hidden',
  'layout',
  'layout-editor',
  'error',
]);

export interface InspectorEngineOptions extends EngineOptions {
  /** Node inspector port of the app main process (launched with --inspect=<port>). */
  inspectorPort: number;
}

export interface InspectorBindingReport {
  windowId: number;
  payload: string;
  at?: number;
}

export interface InspectorBlockedLogEntry {
  windowId: number;
  url: string;
  at: number;
  pageUrl?: string;
}

export interface InspectorApplySummary {
  hidden: number;
  perWindow: Map<number, number>;
}

/** True for helper windows that must not be shown as the app page. */
export function isInternalInspectorUrl(url: string): boolean {
  const lower = url.trim().toLowerCase();
  if (!lower) return true;
  if (lower === 'about:blank') return true;
  return (
    lower.startsWith('owepm://') ||
    lower.startsWith('devtools://') ||
    lower.startsWith('chrome://') ||
    lower.startsWith('chrome-extension://')
  );
}

/** Counts the windows the inspector actually drives; skipped foreign windows are excluded. */
export function countAttachedInspectorWindows(
  windows: readonly InspectorWindowSnapshot[],
): number {
  let count = 0;
  for (const window of windows) {
    if (window.attached) count += 1;
  }
  return count;
}

/** First non-internal window URL; keeps the previous URL when only helper windows report one. */
export function selectInspectorPageUrl(
  windows: readonly InspectorWindowSnapshot[],
  previous?: string,
): string | undefined {
  for (const window of windows) {
    if (!window.url) continue;
    if (isInternalInspectorUrl(window.url)) continue;
    return window.url;
  }
  return previous;
}

/** Finds the Node inspector websocket URL in a /json/list payload. */
export function findInspectorSocket(list: unknown): string | undefined {
  if (!Array.isArray(list)) return undefined;
  for (const entry of list) {
    const record = asRecord(entry);
    if (!record) continue;
    if (asString(record.type) !== 'node') continue;
    const url = asString(record.webSocketDebuggerUrl);
    if (url) return url;
  }
  return undefined;
}

/** Validates the bootstrap window snapshots. */
export function parseInspectorWindows(value: unknown): InspectorWindowSnapshot[] {
  if (!Array.isArray(value)) return [];
  const output: InspectorWindowSnapshot[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const id = asNumber(record.id);
    if (id === undefined) continue;
    const window: InspectorWindowSnapshot = {
      id: Math.round(id),
      url: asString(record.url) ?? '',
      title: asString(record.title) ?? '',
      attached: record.attached === true,
    };
    const error = asString(record.error);
    if (error) window.error = error;
    output.push(window);
  }
  return output;
}

/** Validates the queued binding reports drained from the bootstrap. */
export function parseInspectorReports(value: unknown): InspectorBindingReport[] {
  if (!Array.isArray(value)) return [];
  const output: InspectorBindingReport[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const windowId = asNumber(record.windowId);
    const payload = asString(record.payload);
    if (windowId === undefined || !payload) continue;
    const report: InspectorBindingReport = { windowId: Math.round(windowId), payload };
    const at = asNumber(record.at);
    if (at !== undefined) report.at = at;
    output.push(report);
  }
  return output;
}

/** Parses one JSON report emitted by the injected page script. */
export function parseInjectedPayload(payload: string): InjectedMessage | null {
  if (typeof payload !== 'string' || payload.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const type = asString(record.type);
  if (!type || !INJECTED_MESSAGE_TYPES.has(type)) return null;
  return value as InjectedMessage;
}

/** Validates the blocked request log drained from the bootstrap. */
export function parseInspectorBlockedLogs(value: unknown): InspectorBlockedLogEntry[] {
  if (!Array.isArray(value)) return [];
  const output: InspectorBlockedLogEntry[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const url = asString(record.url);
    if (!url) continue;
    const windowId = asNumber(record.windowId) ?? 0;
    const at = asNumber(record.at) ?? Date.now();
    const item: InspectorBlockedLogEntry = {
      windowId: Math.round(windowId),
      url,
      at: Math.max(0, Math.round(at)),
    };
    const pageUrl = asString(record.pageUrl);
    if (pageUrl) item.pageUrl = pageUrl;
    output.push(item);
  }
  return output;
}

/** Sums the per-window hidden counts returned by the bootstrap apply() call. */
export function sumInspectorApplyResults(value: unknown): InspectorApplySummary {
  const perWindow = new Map<number, number>();
  let hidden = 0;
  if (!Array.isArray(value)) return { hidden, perWindow };
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const windowId = asNumber(record.windowId);
    if (windowId === undefined) continue;
    const count = Math.max(0, Math.round(asNumber(record.hidden) ?? 0));
    perWindow.set(Math.round(windowId), count);
    hidden += count;
  }
  return { hidden, perWindow };
}

/** Validates and de-duplicates scan candidates merged from every window. */
export function mergeInspectorCandidates(value: unknown): AdCandidate[] {
  const output: AdCandidate[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(value)) return output;
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const selectorValue = asString(record.selector);
    const selector = selectorValue ? selectorValue.trim() : '';
    if (!selector || seen.has(selector)) continue;
    seen.add(selector);
    output.push({
      selector,
      tag: asString(record.tag) ?? '',
      reason: asString(record.reason) ?? 'suspected ad element',
      matchCount: Math.max(1, Math.round(asNumber(record.matchCount) ?? 1)),
      width: Math.max(0, Math.round(asNumber(record.width) ?? 0)),
      height: Math.max(0, Math.round(asNumber(record.height) ?? 0)),
    });
    if (output.length >= 200) break;
  }
  return output;
}

/** Builds the cosmetic/layout payload evaluated inside every window. */
export function buildInspectorFilterPayload(config: EngineFilterConfig): {
  cosmetic: Array<{ selector: string; urlPattern?: string }>;
  layout: Array<{ selector: string; declarations: Record<string, string> }>;
} {
  const cosmetic: Array<{ selector: string; urlPattern?: string }> = [];
  const layout: Array<{ selector: string; declarations: Record<string, string> }> = [];
  if (!config.enabled) return { cosmetic, layout };
  for (const rule of config.cosmetic) {
    if (rule.enabled === false) continue;
    const selector = String(rule.selector ?? '').trim();
    if (!selector) continue;
    if (rule.urlPattern) cosmetic.push({ selector, urlPattern: rule.urlPattern });
    else cosmetic.push({ selector });
  }
  for (const rule of config.layout) {
    if (rule.enabled === false) continue;
    const selector = String(rule.selector ?? '').trim();
    if (!selector) continue;
    const declarations: Record<string, string> = {};
    for (const [property, value] of Object.entries(rule.declarations ?? {})) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (!property || !text) continue;
      declarations[property] = text;
    }
    if (Object.keys(declarations).length === 0) continue;
    layout.push({ selector, declarations });
  }
  return { cosmetic, layout };
}

function sanitizeInspectorConfig(raw: EngineFilterConfig | null | undefined): EngineFilterConfig {
  const record = asRecord(raw);
  if (!record) return EMPTY_CONFIG;
  const cosmetic: CosmeticRule[] = [];
  if (Array.isArray(record.cosmetic)) {
    for (const entry of record.cosmetic) {
      const rule = asRecord(entry);
      if (!rule) continue;
      const selector = asString(rule.selector);
      if (!selector || !selector.trim()) continue;
      if (rule.enabled === false) continue;
      cosmetic.push(entry as CosmeticRule);
    }
  }
  const networkPatterns: string[] = [];
  if (Array.isArray(record.networkPatterns)) {
    for (const entry of record.networkPatterns) {
      const pattern = asString(entry);
      if (pattern && pattern.trim()) networkPatterns.push(pattern.trim());
    }
  }
  const layout: LayoutRule[] = [];
  if (Array.isArray(record.layout)) {
    for (const entry of record.layout) {
      const rule = asRecord(entry);
      if (!rule) continue;
      const selector = asString(rule.selector);
      if (!selector || !selector.trim()) continue;
      if (rule.enabled === false) continue;
      const declarationsRaw = asRecord(rule.declarations);
      if (!declarationsRaw) continue;
      const declarations: Record<string, string> = {};
      for (const [property, value] of Object.entries(declarationsRaw)) {
        const text = asString(value);
        if (!property || !text) continue;
        declarations[property] = text;
      }
      if (Object.keys(declarations).length === 0) continue;
      layout.push({
        id: asString(rule.id) ?? '',
        selector: selector.trim(),
        declarations,
        enabled: true,
        source: 'layout',
        createdAt: 0,
      });
    }
  }
  return { enabled: record.enabled === true, cosmetic, networkPatterns, layout };
}

/**
 * Engine implementation for apps whose visible windows are absent from the Chromium CDP target
 * list. It drives the Electron main process through the Node inspector, attaches each window's
 * own webContents debugger and evaluates the same injected cosmetic script there.
 */
class InspectorEngineController implements Engine {
  private readonly options: InspectorEngineOptions;
  private client: CdpClient | null = null;
  private port: number | null = null;
  private connectedFlag = false;
  private config: EngineFilterConfig = EMPTY_CONFIG;
  private electronVersion: string | undefined;
  private windows: InspectorWindowSnapshot[] = [];
  private windowHidden = new Map<number, number>();
  private blockedRequests = 0;
  private lastBlockedAt: number | undefined;
  private lastPageUrl: string | undefined;
  private pickerActive = false;
  private pickerPicked = 0;
  private layoutEditorActive = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<EngineConnectResult> | null = null;
  private disconnectPromise: Promise<void> | null = null;
  private disconnectedEmitted = false;
  private lastErrorEmitAt = 0;
  private pollFailures = 0;
  private lastEmittedPages = -1;
  private lastEmittedPageUrl: string | undefined;
  private lastCdpRefreshAt = 0;
  private applyChain: Promise<void> = Promise.resolve();

  constructor(options: InspectorEngineOptions) {
    this.options = options;
  }

  get connected(): boolean {
    return this.connectedFlag;
  }

  async connect(port: number): Promise<EngineConnectResult> {
    const target = this.resolvePort(port);
    if (this.connectedFlag) {
      if (this.port === target) return this.connectResult();
      await this.disconnect();
    }
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect(target);
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  disconnect(): Promise<void> {
    if (this.disconnectPromise) return this.disconnectPromise;
    const run = this.doDisconnect();
    this.disconnectPromise = run;
    return run.then(
      () => {
        if (this.disconnectPromise === run) this.disconnectPromise = null;
      },
      () => {
        if (this.disconnectPromise === run) this.disconnectPromise = null;
      },
    );
  }

  async updateFilters(): Promise<void> {
    this.refreshConfig();
    if (!this.client || !this.connectedFlag) return;
    try {
      await this.applyPatterns();
    } catch (error) {
      this.emitThrottledError('Could not update network filters: ' + errorText(error));
    }
    await this.applyCurrentPayload();
    this.scheduleStats();
  }

  async startPicker(): Promise<void> {
    this.requireConnected();
    if (this.pickerActive) return;
    this.pickerActive = true;
    this.pickerPicked = 0;
    this.emitPicker();
    await this.runWindowCommand('startPicker');
  }

  async stopPicker(): Promise<void> {
    const wasActive = this.pickerActive;
    this.pickerActive = false;
    if (wasActive) this.emitPicker();
    if (this.client && this.connectedFlag) await this.runWindowCommand('stopPicker');
  }

  async startLayoutEditor(): Promise<void> {
    this.requireConnected();
    if (this.layoutEditorActive) return;
    this.layoutEditorActive = true;
    this.emit({ type: 'layout-editor', active: true });
    await this.runWindowCommand('startLayoutEditor');
  }

  async stopLayoutEditor(): Promise<void> {
    const wasActive = this.layoutEditorActive;
    this.layoutEditorActive = false;
    if (wasActive) this.emit({ type: 'layout-editor', active: false });
    if (this.client && this.connectedFlag) await this.runWindowCommand('stopLayoutEditor');
  }

  async scanForAds(): Promise<AdCandidate[]> {
    this.requireConnected();
    let value: unknown;
    try {
      value = await this.callApi('scan', [], REQUEST_TIMEOUT_MS);
    } catch (error) {
      throw new Error('Could not scan the attached app: ' + errorText(error));
    }
    return mergeInspectorCandidates(value);
  }

  stats(): AppStats {
    let hidden = 0;
    for (const count of this.windowHidden.values()) hidden += count;
    const result: AppStats = {
      blockedRequests: this.blockedRequests,
      hiddenElements: hidden,
      pages: countAttachedInspectorWindows(this.windows),
    };
    if (this.lastBlockedAt !== undefined) result.lastBlockedAt = this.lastBlockedAt;
    if (this.lastPageUrl) result.lastPageUrl = this.lastPageUrl;
    return result;
  }

  private resolvePort(port: number): number {
    const candidate =
      Number.isInteger(port) && port > 0 && port <= 65535 ? port : this.options.inspectorPort;
    if (!Number.isInteger(candidate) || candidate <= 0 || candidate > 65535) {
      throw new Error('Invalid inspector port: ' + String(port));
    }
    return candidate;
  }

  private async doConnect(inspectorPort: number): Promise<EngineConnectResult> {
    this.resetState();
    this.refreshConfig();
    const base = 'http://127.0.0.1:' + String(inspectorPort);
    const list = await fetchJson(base + '/json/list', CONNECT_TIMEOUT_MS);
    const webSocketDebuggerUrl = findInspectorSocket(list);
    if (!webSocketDebuggerUrl) {
      throw new Error(
        'No Node inspector target found at ' + base + '/json/list. Launch the app with --inspect=<port>.',
      );
    }
    const client = await CdpClient.connect(webSocketDebuggerUrl, CONNECT_TIMEOUT_MS);
    this.client = client;
    this.port = inspectorPort;
    this.disconnectedEmitted = false;
    client.onClose((reason) => this.handleSocketClosed(client, reason));
    try {
      await client.send('Runtime.enable', {}, undefined, REQUEST_TIMEOUT_MS);
      await this.installBootstrap();
      // Learn which windows the Chromium CDP engine already owns before attaching anything.
      try {
        await this.callApi('refreshCdpTargets', [], FAST_REQUEST_TIMEOUT_MS);
      } catch {
        // The bootstrap retries; attach decisions stay conservative in the meantime.
      }
      this.lastCdpRefreshAt = Date.now();
      const configured = await this.callApi<InspectorSyncPayload>('configureSource', [
        this.options.injectedScript,
      ]);
      const configuredRecord = asRecord(configured);
      if (!configuredRecord || configuredRecord.electron !== true) {
        const reason = configuredRecord ? asString(configuredRecord.electronError) : undefined;
        throw new Error(
          'The inspector is reachable but Electron is unavailable in that main process' +
            (reason ? ': ' + reason : '.'),
        );
      }
      const electronVersion = asString(configuredRecord.electronVersion);
      if (electronVersion) this.electronVersion = electronVersion;
      this.windows = parseInspectorWindows(configuredRecord.windows);
      await this.applyPatterns();
      await this.applyCurrentPayload();
      this.connectedFlag = true;
      this.startPolling();
      const pages = countAttachedInspectorWindows(this.windows);
      const connectedEvent: EngineEvent = { type: 'connected', port: inspectorPort, pages };
      if (this.electronVersion) connectedEvent.electronVersion = this.electronVersion;
      this.emit(connectedEvent);
      this.syncPageState();
      this.scheduleStats();
      return this.connectResult();
    } catch (error) {
      await this.cleanupFailedConnect();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private async cleanupFailedConnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.connectedFlag = false;
    this.stopPolling();
    this.stopStatsTimer();
    if (client) {
      try {
        client.close('engine connect failed');
        await Promise.race([client.whenClosed(), delay(500)]);
      } catch {
        // Best effort.
      }
    }
    this.windows = [];
    this.windowHidden.clear();
    this.port = null;
  }

  private async doDisconnect(): Promise<void> {
    const client = this.client;
    const wasConnected = this.connectedFlag;
    this.connectedFlag = false;
    this.stopPolling();
    this.stopStatsTimer();
    if (client) {
      try {
        await withTimeout(this.callApi('shutdown', [], CLEANUP_TIMEOUT_MS), CLEANUP_TIMEOUT_MS + 300);
      } catch {
        // Shutdown is best effort; the socket close below still tears the session down.
      }
      client.close('engine disconnected');
      await Promise.race([client.whenClosed(), delay(DISCONNECT_GRACE_MS)]);
    }
    if (this.client !== null && this.client !== client) return;
    if (this.client === client) this.client = null;
    this.windows = [];
    this.windowHidden.clear();
    this.pickerActive = false;
    this.pickerPicked = 0;
    this.layoutEditorActive = false;
    this.port = null;
    this.lastEmittedPages = -1;
    this.lastEmittedPageUrl = undefined;
    if (wasConnected) this.emitDisconnected('engine disconnected');
  }

  private handleSocketClosed(client: CdpClient, reason: string): void {
    if (this.client !== client) return;
    const wasConnected = this.connectedFlag;
    this.connectedFlag = false;
    this.stopPolling();
    this.stopStatsTimer();
    this.client = null;
    this.windows = [];
    this.windowHidden.clear();
    this.pickerActive = false;
    this.layoutEditorActive = false;
    this.port = null;
    if (wasConnected) this.emitDisconnected(reason);
  }

  private resetState(): void {
    this.stopPolling();
    this.stopStatsTimer();
    this.client = null;
    this.port = null;
    this.connectedFlag = false;
    this.blockedRequests = 0;
    this.lastBlockedAt = undefined;
    this.lastPageUrl = undefined;
    this.electronVersion = undefined;
    this.windows = [];
    this.windowHidden.clear();
    this.pickerActive = false;
    this.pickerPicked = 0;
    this.layoutEditorActive = false;
    this.disconnectedEmitted = false;
    this.lastErrorEmitAt = 0;
    this.pollFailures = 0;
    this.lastEmittedPages = -1;
    this.lastEmittedPageUrl = undefined;
    this.lastCdpRefreshAt = 0;
  }

  private async installBootstrap(): Promise<void> {
    const marker = asRecord(await this.evaluate(createInspectorBootstrapScript()));
    if (
      !marker ||
      marker.installed !== true ||
      asNumber(marker.version) !== INSPECTOR_BOOTSTRAP_VERSION
    ) {
      throw new Error('Could not install the inspector bootstrap in the app main process.');
    }
  }

  private async evaluate(expression: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const client = this.client;
    if (!client) throw new Error('Inspector engine is not connected');
    const response = await client.send<Record<string, unknown>>(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        silent: true,
      },
      undefined,
      timeoutMs,
    );
    const exception = asRecord(response.exceptionDetails);
    if (exception) {
      const thrown = asRecord(exception.exception);
      const description =
        asString(thrown?.description) ?? asString(exception.text) ?? 'Inspector evaluation failed';
      throw new Error(description);
    }
    const remote = asRecord(response.result);
    return remote ? remote.value : undefined;
  }

  private async callApi<T = unknown>(
    method: string,
    args: unknown[] = [],
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const argumentList = args.map((argument) => JSON.stringify(argument) ?? 'null').join(', ');
    const target = 'globalThis.' + INSPECTOR_API_GLOBAL;
    const expression = target + ' && ' + target + '.' + method + '(' + argumentList + ')';
    const value = await this.evaluate(expression, timeoutMs);
    return value as T;
  }

  private refreshConfig(): void {
    try {
      this.config = sanitizeInspectorConfig(this.options.getConfig());
    } catch (error) {
      this.config = EMPTY_CONFIG;
      this.emitError('Could not read the filter configuration: ' + errorText(error));
    }
  }

  private async applyPatterns(): Promise<void> {
    const patterns = this.config.enabled ? normalizeNetworkPatterns(this.config.networkPatterns) : [];
    const result = await this.callApi<InspectorSyncPayload>('setPatterns', [
      patterns,
      this.config.enabled,
    ]);
    const record = asRecord(result);
    if (!record) return;
    this.windows = parseInspectorWindows(record.windows);
    const electronVersion = asString(record.electronVersion);
    if (electronVersion) this.electronVersion = electronVersion;
  }

  private applyCurrentPayload(): Promise<void> {
    const payload = buildInspectorFilterPayload(this.config);
    const run = async (): Promise<void> => {
      const client = this.client;
      if (!client || !client.connected) return;
      try {
        const value = await this.callApi('apply', [payload]);
        const summary = sumInspectorApplyResults(value);
        this.windowHidden = summary.perWindow;
        if (this.connectedFlag) this.scheduleStats();
      } catch (error) {
        this.emitThrottledError('Could not apply filters: ' + errorText(error));
      }
    };
    const next = this.applyChain.then(run, run);
    this.applyChain = next;
    return next;
  }

  private async runWindowCommand(method: string): Promise<void> {
    try {
      await this.callApi(method, []);
    } catch (error) {
      this.emitThrottledError(method + ' failed: ' + errorText(error));
    }
  }

  private startPolling(): void {
    this.stopPolling();
    this.scheduleNextPoll();
  }

  private scheduleNextPoll(): void {
    if (this.pollTimer || !this.connectedFlag) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.pollOnce()
        .catch(() => {
          // Unexpected poll failures must not surface as unhandled rejections.
        })
        .finally(() => this.scheduleNextPoll());
    }, POLL_INTERVAL_MS);
    unrefTimer(this.pollTimer);
  }

  private stopPolling(): void {
    if (!this.pollTimer) return;
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private async pollOnce(): Promise<void> {
    const client = this.client;
    if (!client || !this.connectedFlag) return;
    if (Date.now() - this.lastCdpRefreshAt >= CDP_REFRESH_INTERVAL_MS) {
      this.lastCdpRefreshAt = Date.now();
      try {
        await this.callApi('refreshCdpTargets', [], FAST_REQUEST_TIMEOUT_MS);
      } catch {
        // Retried on the next poll; stale visibility data only delays recovery.
      }
      if (!this.connectedFlag || this.client !== client) return;
    }
    let raw: unknown;
    try {
      raw = await this.callApi('drainReports', [], FAST_REQUEST_TIMEOUT_MS);
    } catch (error) {
      this.notePollFailure(error);
      return;
    }
    if (!this.connectedFlag || this.client !== client) return;
    this.pollFailures = 0;
    const drain = asRecord(raw);
    if (!drain) return;
    const windows = parseInspectorWindows(drain.windows);
    this.windows = windows;
    const reports = parseInspectorReports(drain.reports);
    let needsApply = false;
    for (const report of reports) {
      const message = parseInjectedPayload(report.payload);
      if (!message) continue;
      if (this.handleInspectorMessage(message, report, windows)) needsApply = true;
    }
    const blockedLogs = parseInspectorBlockedLogs(drain.blockedLogs);
    for (const entry of blockedLogs) {
      const blocked: BlockedEvent = { appId: this.options.appId, url: entry.url, at: entry.at };
      if (entry.pageUrl) blocked.pageUrl = entry.pageUrl;
      this.emit({ type: 'blocked', entry: blocked });
      if (entry.pageUrl) this.lastPageUrl = entry.pageUrl;
    }
    const blockedCount = asNumber(drain.blockedCount);
    if (blockedCount !== undefined) this.blockedRequests = Math.max(0, Math.round(blockedCount));
    const lastBlockedAt = asNumber(drain.lastBlockedAt);
    if (lastBlockedAt !== undefined && lastBlockedAt > 0) this.lastBlockedAt = lastBlockedAt;
    const electronVersion = asString(drain.electronVersion);
    if (electronVersion) this.electronVersion = electronVersion;
    if (needsApply) await this.applyCurrentPayload();
    this.syncPageState();
    this.scheduleStats();
  }

  private handleInspectorMessage(
    message: InjectedMessage,
    report: InspectorBindingReport,
    windows: readonly InspectorWindowSnapshot[],
  ): boolean {
    const fallbackUrl = windows.find((window) => window.id === report.windowId)?.url ?? '';
    switch (message.type) {
      case 'ready':
        return true;
      case 'hidden': {
        const count = asNumber(message.count);
        if (count !== undefined) {
          this.windowHidden.set(report.windowId, Math.max(0, Math.round(count)));
          this.scheduleStats();
        }
        return false;
      }
      case 'pick':
        this.handlePicked(message.payload, fallbackUrl);
        return false;
      case 'picker-state': {
        const picked = asNumber(message.picked);
        if (picked !== undefined) {
          this.pickerPicked = Math.max(this.pickerPicked, Math.max(0, Math.round(picked)));
        }
        if (message.active === false && this.pickerActive) {
          this.pickerActive = false;
          void this.runWindowCommand('stopPicker');
        }
        this.emitPicker();
        return false;
      }
      case 'layout':
        this.handleLayoutReport(message.payload, fallbackUrl);
        return false;
      case 'layout-editor':
        this.layoutEditorActive = message.active === true;
        this.emit({ type: 'layout-editor', active: this.layoutEditorActive });
        return false;
      case 'error':
        this.emitError(message.message);
        return false;
      default:
        return false;
    }
  }

  private handlePicked(report: PickReport | undefined, fallbackUrl: string): void {
    const raw = asRecord(report);
    if (!raw) return;
    const selector = asString(raw.selector);
    if (!selector || !selector.trim()) return;
    const pick: PickReport = {
      selector: selector.trim(),
      label: asString(raw.label) ?? '',
      matchCount: Math.max(1, Math.round(asNumber(raw.matchCount) ?? 1)),
      frameUrl: asString(raw.frameUrl) || fallbackUrl,
      tag: asString(raw.tag) ?? '',
      width: Math.max(0, Math.round(asNumber(raw.width) ?? 0)),
      height: Math.max(0, Math.round(asNumber(raw.height) ?? 0)),
    };
    this.pickerPicked += 1;
    this.emit({ type: 'picked', report: pick });
    this.emitPicker();
  }

  private handleLayoutReport(report: LayoutReport | undefined, fallbackUrl: string): void {
    const raw = asRecord(report);
    if (!raw) return;
    const selector = asString(raw.selector);
    if (!selector || !selector.trim()) return;
    const declarationsRaw = asRecord(raw.declarations);
    const declarations: Record<string, string> = {};
    if (declarationsRaw) {
      for (const [property, value] of Object.entries(declarationsRaw)) {
        const text = asString(value);
        if (!property || !text) continue;
        declarations[property] = text;
      }
    }
    if (Object.keys(declarations).length === 0) return;
    this.emit({
      type: 'layout',
      report: {
        selector: selector.trim(),
        declarations,
        label: asString(raw.label) ?? '',
        frameUrl: asString(raw.frameUrl) || fallbackUrl,
        matches: Math.max(1, Math.round(asNumber(raw.matches) ?? 1)),
      },
    });
  }

  private syncPageState(): void {
    if (!this.connectedFlag) return;
    const pages = countAttachedInspectorWindows(this.windows);
    const url = selectInspectorPageUrl(this.windows, this.lastPageUrl) ?? '';
    if (url) this.lastPageUrl = url;
    if (pages === this.lastEmittedPages && url === (this.lastEmittedPageUrl ?? '')) return;
    this.lastEmittedPages = pages;
    this.lastEmittedPageUrl = url;
    this.emit({ type: 'page', url, pages });
    this.scheduleStats();
  }

  private notePollFailure(error: unknown): void {
    this.pollFailures += 1;
    const now = Date.now();
    if (this.pollFailures === 1 || now - this.lastErrorEmitAt > ERROR_THROTTLE_MS) {
      this.lastErrorEmitAt = now;
      this.emitError('Inspector poll failed: ' + errorText(error));
    }
  }

  private scheduleStats(): void {
    if (this.statsTimer || !this.connectedFlag) return;
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null;
      if (this.connectedFlag) this.emit({ type: 'stats', stats: this.stats() });
    }, STATS_DEBOUNCE_MS);
    unrefTimer(this.statsTimer);
  }

  private stopStatsTimer(): void {
    if (!this.statsTimer) return;
    clearTimeout(this.statsTimer);
    this.statsTimer = null;
  }

  private connectResult(): EngineConnectResult {
    const result: EngineConnectResult = { pages: countAttachedInspectorWindows(this.windows) };
    if (this.electronVersion) result.electronVersion = this.electronVersion;
    return result;
  }

  private requireConnected(): void {
    if (!this.connectedFlag || !this.client) throw new Error('Engine is not connected');
  }

  private emitPicker(): void {
    this.emit({ type: 'picker', active: this.pickerActive, picked: this.pickerPicked });
  }

  private emitDisconnected(reason: string | undefined): void {
    if (this.disconnectedEmitted) return;
    this.disconnectedEmitted = true;
    if (reason) this.emit({ type: 'disconnected', reason });
    else this.emit({ type: 'disconnected' });
  }

  private emit(event: EngineEvent): void {
    try {
      this.options.onEvent(event);
    } catch {
      // A consumer throwing must never break the engine.
    }
  }

  private emitError(message: string): void {
    this.emit({ type: 'error', message });
  }

  private emitThrottledError(message: string): void {
    const now = Date.now();
    if (now - this.lastErrorEmitAt < ERROR_THROTTLE_MS) return;
    this.lastErrorEmitAt = now;
    this.emitError(message);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T | undefined>([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
        if (timer) unrefTimer(timer);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    unrefTimer(timer);
  });
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Creates an engine that drives hidden Electron windows through the main-process inspector. */
export function createInspectorEngine(options: InspectorEngineOptions): Engine {
  return new InspectorEngineController(options);
}
