import type {
  AdCandidate,
  AppStats,
  BlockedEvent,
  CosmeticRule,
  DebugEndpointInfo,
  Engine,
  EngineConnectResult,
  EngineEvent,
  EngineFilterConfig,
  EngineOptions,
  LayoutReport,
  LayoutRule,
  PickReport,
} from '../../shared/types';
import { INJECTED_BINDING, INJECTED_GLOBAL } from '../../shared/types';
import {
  CdpClient,
  asNumber,
  asRecord,
  asString,
  fetchJson,
  parseElectronVersion,
  unrefTimer,
  type CdpEvent,
} from './cdp';
import {
  createUrlMatcher,
  matchesUrlFilter,
  normalizeNetworkPatterns,
  type UrlMatcher,
} from './patterns';

const CONNECT_TIMEOUT_MS = 10000;
const REQUEST_TIMEOUT_MS = 8000;
const FAST_REQUEST_TIMEOUT_MS = 4000;
const CLEANUP_TIMEOUT_MS = 600;
const STATS_DEBOUNCE_MS = 200;
const DISCONNECT_GRACE_MS = 1200;
const ATTACH_RETRY_DELAY_MS = 5000;
const TARGET_TYPES = new Set(['page', 'webview']);
const EMPTY_CONFIG: EngineFilterConfig = { enabled: false, cosmetic: [], networkPatterns: [], layout: [] };

interface VersionProbe {
  webSocketDebuggerUrl?: string;
  electronVersion?: string;
  targetCount: number;
}

interface TargetState {
  targetId: string;
  type: string;
  url: string;
  title: string;
  sessionId?: string;
  attaching: boolean;
  attachFailures: number;
  lastAttachAt: number;
}

interface ContextState {
  contextId: number;
  frameId?: string;
  url: string;
  hidden: number;
  ready: boolean;
  applied: boolean;
  pickerStarted: boolean;
  destroyed: boolean;
  applyChain: Promise<void>;
}

interface SessionState {
  sessionId: string;
  targetId: string;
  targetType: string;
  contexts: Map<number, ContextState>;
  frameUrls: Map<string, string>;
  mainFrameId?: string;
  networkPatterns: string[];
  urlMatcher: UrlMatcher;
  fetchEnabled: boolean;
  scriptIdentifier?: string;
  disposed: boolean;
}

interface InjectedOutcome {
  ok: boolean;
  value: unknown;
}

/**
 * Browser-level CDP engine: discovers page/webview targets, injects the cosmetic script,
 * blocks matching requests through Fetch and relays picker/report messages as EngineEvents.
 * Every protocol interaction is defensive; target crashes and malformed events never throw.
 */
class EngineController implements Engine {
  private readonly options: EngineOptions;
  private readonly sessions = new Map<string, SessionState>();
  private readonly targets = new Map<string, TargetState>();
  private client: CdpClient | null = null;
  private port: number | null = null;
  private connectedFlag = false;
  private config: EngineFilterConfig = EMPTY_CONFIG;
  private electronVersion: string | undefined;
  private blockedRequests = 0;
  private lastBlockedAt: number | undefined;
  private lastPageUrl: string | undefined;
  private pickerActive = false;
  private pickerPicked = 0;
  private layoutEditorActive = false;
  private statsTimer: ReturnType<typeof setTimeout> | null = null;
  private connectPromise: Promise<EngineConnectResult> | null = null;
  private disconnectPromise: Promise<void> | null = null;
  private disconnectedEmitted = false;
  private bindingWarningEmitted = false;
  private lastEmittedPages = 0;
  private lastEmittedPageUrl: string | undefined;

  constructor(options: EngineOptions) {
    this.options = options;
  }

  get connected(): boolean {
    return this.connectedFlag;
  }

  async connect(port: number): Promise<EngineConnectResult> {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error('Invalid debugging port: ' + String(port));
    }
    if (this.connectedFlag) {
      if (this.port === port) return this.connectResult();
      await this.disconnect();
    }
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.doConnect(port);
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
    const sessions = [...this.sessions.values()];
    if (this.client && this.client.connected) {
      await Promise.allSettled(sessions.map((session) => this.applyNetworkFilters(session)));
      for (const session of sessions) {
        if (session.disposed) continue;
        for (const context of session.contexts.values()) this.queueCosmetics(session, context);
      }
      const pending: Promise<void>[] = [];
      for (const session of sessions) {
        for (const context of session.contexts.values()) pending.push(context.applyChain);
      }
      await Promise.allSettled(pending);
    }
    this.scheduleStats();
  }

  async startPicker(): Promise<void> {
    this.requireConnected();
    if (this.pickerActive) return;
    this.pickerActive = true;
    this.pickerPicked = 0;
    this.emitPicker();
    await this.broadcastPicker('startPicker');
  }

  async stopPicker(): Promise<void> {
    const wasActive = this.pickerActive;
    this.pickerActive = false;
    if (wasActive) this.emitPicker();
    if (this.client && this.client.connected) await this.broadcastPicker('stopPicker');
  }

  async startLayoutEditor(): Promise<void> {
    this.requireConnected();
    if (this.layoutEditorActive) return;
    this.layoutEditorActive = true;
    this.emit({ type: 'layout-editor', active: true });
    await this.broadcastLayoutEditor('startLayoutEditor');
  }

  async stopLayoutEditor(): Promise<void> {
    const wasActive = this.layoutEditorActive;
    this.layoutEditorActive = false;
    if (wasActive) this.emit({ type: 'layout-editor', active: false });
    if (this.client && this.client.connected) await this.broadcastLayoutEditor('stopLayoutEditor');
  }

  async scanForAds(): Promise<AdCandidate[]> {
    this.requireConnected();
    const tasks: Promise<AdCandidate[]>[] = [];
    for (const session of this.sessions.values()) {
      if (session.disposed) continue;
      for (const context of session.contexts.values()) {
        if (!context.destroyed) tasks.push(this.scanContext(session, context));
      }
    }
    const lists = await Promise.all(tasks);
    const output: AdCandidate[] = [];
    const seen = new Set<string>();
    for (const list of lists) {
      for (const candidate of list) {
        if (seen.has(candidate.selector)) continue;
        seen.add(candidate.selector);
        output.push(candidate);
      }
    }
    return output;
  }

  stats(): AppStats {
    const result: AppStats = {
      blockedRequests: this.blockedRequests,
      hiddenElements: this.hiddenElements(),
      pages: this.pageCount(),
    };
    if (this.lastBlockedAt !== undefined) result.lastBlockedAt = this.lastBlockedAt;
    if (this.lastPageUrl) result.lastPageUrl = this.lastPageUrl;
    return result;
  }

  private async doConnect(port: number): Promise<EngineConnectResult> {
    this.resetState();
    this.refreshConfig();
    const probe = await probeVersionInfo(port, CONNECT_TIMEOUT_MS);
    if (!probe || !probe.webSocketDebuggerUrl) {
      throw new Error('No CDP endpoint found at http://127.0.0.1:' + String(port) + '/json/version');
    }
    const client = await CdpClient.connect(probe.webSocketDebuggerUrl, CONNECT_TIMEOUT_MS);
    this.client = client;
    this.port = port;
    this.disconnectedEmitted = false;
    client.onEvent((event) => this.handleEvent(event));
    client.onClose((reason) => this.handleSocketClosed(client, reason));
    try {
      let electronVersion = probe.electronVersion;
      try {
        const version = await client.send<Record<string, unknown>>(
          'Browser.getVersion',
          {},
          undefined,
          REQUEST_TIMEOUT_MS,
        );
        electronVersion =
          parseElectronVersion(version.userAgent) ?? parseElectronVersion(version.product) ?? electronVersion;
      } catch {
        // Browser.getVersion is optional; /json/version already carries the user agent.
      }
      this.electronVersion = electronVersion;
      await client.send('Target.setDiscoverTargets', { discover: true }, undefined, REQUEST_TIMEOUT_MS);
      let targetInfos: unknown[] = [];
      try {
        const result = await client.send<Record<string, unknown>>(
          'Target.getTargets',
          {},
          undefined,
          REQUEST_TIMEOUT_MS,
        );
        if (Array.isArray(result.targetInfos)) targetInfos = result.targetInfos;
      } catch {
        // Discovery events still deliver targets when getTargets is unavailable.
      }
      const attachTasks: Promise<void>[] = [];
      for (const info of targetInfos) {
        const target = this.upsertTarget(info);
        if (!target) continue;
        this.noteTargetUrl(target);
        attachTasks.push(this.attachTarget(target));
      }
      await Promise.allSettled(attachTasks);
      this.connectedFlag = true;
      const pages = this.pageCount();
      const connectedEvent: EngineEvent = { type: 'connected', port, pages };
      if (electronVersion) connectedEvent.electronVersion = electronVersion;
      this.emit(connectedEvent);
      this.syncPages();
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
    this.stopStatsTimer();
    if (client) {
      try {
        client.close('engine connect failed');
        await Promise.race([client.whenClosed(), delay(500)]);
      } catch {
        // Best effort.
      }
    }
    this.sessions.clear();
    this.targets.clear();
    this.port = null;
    this.lastEmittedPages = 0;
    this.lastEmittedPageUrl = undefined;
  }

  private resetState(): void {
    this.stopStatsTimer();
    this.sessions.clear();
    this.targets.clear();
    this.client = null;
    this.port = null;
    this.connectedFlag = false;
    this.blockedRequests = 0;
    this.lastBlockedAt = undefined;
    this.lastPageUrl = undefined;
    this.electronVersion = undefined;
    this.pickerActive = false;
    this.pickerPicked = 0;
    this.bindingWarningEmitted = false;
    this.lastEmittedPages = 0;
    this.lastEmittedPageUrl = undefined;
  }

  private async doDisconnect(): Promise<void> {
    const client = this.client;
    const wasConnected = this.connectedFlag;
    this.connectedFlag = false;
    this.stopStatsTimer();
    if (client) {
      try {
        await this.releasePageState(client);
      } catch {
        // Best effort cleanup before detaching.
      }
      client.close('engine disconnected');
      await Promise.race([client.whenClosed(), delay(DISCONNECT_GRACE_MS)]);
    }
    // A concurrent connect may have replaced the client while the old socket closed.
    if (this.client !== null && this.client !== client) return;
    if (this.client === client) this.client = null;
    this.sessions.clear();
    this.targets.clear();
    this.pickerActive = false;
    this.pickerPicked = 0;
    this.port = null;
    this.lastEmittedPages = 0;
    this.lastEmittedPageUrl = undefined;
    if (wasConnected) this.emitDisconnected('engine disconnected');
  }

  private async releasePageState(client: CdpClient): Promise<void> {
    if (!client.connected) return;
    const tasks: Promise<unknown>[] = [];
    for (const session of this.sessions.values()) {
      if (session.disposed) continue;
      for (const context of session.contexts.values()) {
        if (context.destroyed) continue;
        tasks.push(this.callInjected(session, context, 'stopPicker', [], CLEANUP_TIMEOUT_MS));
        tasks.push(this.callInjected(session, context, 'apply', [{ cosmetic: [] }], CLEANUP_TIMEOUT_MS));
      }
      tasks.push(client.send('Fetch.disable', {}, session.sessionId, CLEANUP_TIMEOUT_MS).catch(() => undefined));
    }
    if (tasks.length === 0) return;
    await Promise.race([Promise.allSettled(tasks), delay(DISCONNECT_GRACE_MS)]);
  }

  private connectResult(): EngineConnectResult {
    const result: EngineConnectResult = { pages: this.pageCount() };
    if (this.electronVersion) result.electronVersion = this.electronVersion;
    return result;
  }

  private handleSocketClosed(client: CdpClient, reason: string): void {
    if (this.client !== client) return;
    const wasConnected = this.connectedFlag;
    this.connectedFlag = false;
    this.stopStatsTimer();
    this.sessions.clear();
    this.targets.clear();
    this.pickerActive = false;
    this.port = null;
    this.client = null;
    if (wasConnected) this.emitDisconnected(reason);
  }

  private emitDisconnected(reason: string | undefined): void {
    if (this.disconnectedEmitted) return;
    this.disconnectedEmitted = true;
    if (reason) this.emit({ type: 'disconnected', reason });
    else this.emit({ type: 'disconnected' });
  }

  private handleEvent(event: CdpEvent): void {
    try {
      switch (event.method) {
        case 'Target.targetCreated':
          this.onTargetCreated(event.params);
          break;
        case 'Target.targetInfoChanged':
          this.onTargetInfoChanged(event.params);
          break;
        case 'Target.targetDestroyed':
          this.onTargetDestroyed(event.params);
          break;
        case 'Target.attachedToTarget':
          this.onAttachedToTarget(event);
          break;
        case 'Target.detachedFromTarget':
          this.onDetachedFromTarget(event.params);
          break;
        case 'Target.targetCrashed':
          this.onTargetCrashed(event.params);
          break;
        case 'Runtime.executionContextCreated':
          this.onContextCreated(event);
          break;
        case 'Runtime.executionContextDestroyed':
          this.onContextDestroyed(event);
          break;
        case 'Runtime.executionContextsCleared':
          this.onContextsCleared(event);
          break;
        case 'Runtime.bindingCalled':
          this.onBindingCalled(event);
          break;
        case 'Page.frameNavigated':
          this.onFrameNavigated(event);
          break;
        case 'Fetch.requestPaused':
          this.onRequestPaused(event);
          break;
        default:
          break;
      }
    } catch (error) {
      // Payloads come from the attached app; malformed data must not take the engine down.
      this.emitError('Failed to process ' + event.method + ': ' + errorText(error));
    }
  }

  private onTargetCreated(params: Record<string, unknown>): void {
    const target = this.upsertTarget(params.targetInfo);
    if (!target) return;
    this.noteTargetUrl(target);
    void this.attachTarget(target);
    this.syncPages();
  }

  private onTargetInfoChanged(params: Record<string, unknown>): void {
    const updated = this.upsertTarget(params.targetInfo);
    if (!updated) return;
    this.noteTargetUrl(updated);
    if (!updated.sessionId && !updated.attaching && this.client && this.client.connected) {
      const due = Date.now() - updated.lastAttachAt > ATTACH_RETRY_DELAY_MS;
      if (updated.attachFailures < 2 && due) void this.attachTarget(updated);
    }
    this.syncPages();
  }

  private onTargetDestroyed(params: Record<string, unknown>): void {
    const targetId = asString(params.targetId);
    if (!targetId) return;
    const target = this.targets.get(targetId);
    if (!target) return;
    this.targets.delete(targetId);
    if (target.sessionId) this.dropSession(target.sessionId);
    this.syncPages();
  }

  private onAttachedToTarget(event: CdpEvent): void {
    const sessionId = asString(event.params.sessionId);
    if (!sessionId || this.sessions.has(sessionId)) return;
    const target = this.upsertTarget(event.params.targetInfo);
    if (!target) return;
    if (!target.sessionId) target.sessionId = sessionId;
    const session = this.createSession(sessionId, target);
    void this.setupSession(session);
  }

  private onDetachedFromTarget(params: Record<string, unknown>): void {
    const sessionId = asString(params.sessionId);
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    this.dropSession(sessionId);
    const targetId = asString(params.targetId) ?? session?.targetId;
    if (targetId) {
      const target = this.targets.get(targetId);
      if (target) {
        target.sessionId = undefined;
        target.attaching = false;
      }
    }
    this.syncPages();
  }

  private onTargetCrashed(params: Record<string, unknown>): void {
    const targetId = asString(params.targetId) ?? 'unknown';
    const status = asString(params.status) ?? 'crashed';
    const errorCode = asNumber(params.errorCode);
    const suffix = errorCode === undefined ? '' : ', code ' + String(errorCode);
    this.emitError('Page target ' + targetId + ' crashed (' + status + suffix + ')');
    const target = this.targets.get(targetId);
    if (target && target.sessionId) this.dropSession(target.sessionId);
  }

  private upsertTarget(info: unknown): TargetState | null {
    const record = asRecord(info);
    if (!record) return null;
    const targetId = asString(record.targetId);
    const type = asString(record.type) ?? '';
    if (!targetId || !TARGET_TYPES.has(type)) return null;
    const url = asString(record.url) ?? '';
    const title = asString(record.title) ?? '';
    let target = this.targets.get(targetId);
    if (!target) {
      target = {
        targetId,
        type,
        url,
        title,
        attaching: false,
        attachFailures: 0,
        lastAttachAt: 0,
      };
      this.targets.set(targetId, target);
      return target;
    }
    target.type = type;
    target.title = title;
    if (url) target.url = url;
    return target;
  }

  private noteTargetUrl(target: TargetState): void {
    if (target.type !== 'page') return;
    if (!target.url || target.url === 'about:blank') return;
    this.lastPageUrl = target.url;
  }

  private async attachTarget(target: TargetState): Promise<void> {
    const client = this.client;
    if (!client || !client.connected || target.sessionId || target.attaching) return;
    target.attaching = true;
    target.lastAttachAt = Date.now();
    try {
      const result = await client.send<Record<string, unknown>>(
        'Target.attachToTarget',
        { targetId: target.targetId, flatten: true },
        undefined,
        REQUEST_TIMEOUT_MS,
      );
      const sessionId = asString(result.sessionId);
      if (!sessionId) throw new Error('attachToTarget returned no session id');
      target.sessionId = sessionId;
      if (!this.sessions.has(sessionId)) {
        const session = this.createSession(sessionId, target);
        await this.setupSession(session);
      }
    } catch (error) {
      target.attachFailures += 1;
      if (this.client) this.emitError('Could not attach to ' + target.type + ' target: ' + errorText(error));
    } finally {
      target.attaching = false;
    }
  }

  private createSession(sessionId: string, target: TargetState): SessionState {
    const session: SessionState = {
      sessionId,
      targetId: target.targetId,
      targetType: target.type,
      contexts: new Map<number, ContextState>(),
      frameUrls: new Map<string, string>(),
      networkPatterns: [],
      urlMatcher: createUrlMatcher([]),
      fetchEnabled: false,
      disposed: false,
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  private async setupSession(session: SessionState): Promise<void> {
    const client = this.client;
    if (!client || session.disposed) return;
    this.refreshConfig();
    // Intercept network requests before enabling the rest so early page loads are covered.
    await this.applyNetworkFilters(session);
    if (session.disposed) return;
    await this.trySend(session, 'Page.enable');
    await this.trySend(session, 'Runtime.enable');
    await this.addReportBinding(session);
    await this.addInjectionScript(session);
    for (const context of [...session.contexts.values()]) this.queueCosmetics(session, context);
    if (this.pickerActive) {
      for (const context of [...session.contexts.values()]) void this.startPickerInContext(session, context);
    }
  }

  private async trySend(
    session: SessionState,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<void> {
    const client = this.client;
    if (!client || session.disposed) return;
    try {
      await client.send(method, params, session.sessionId, REQUEST_TIMEOUT_MS);
    } catch (error) {
      if (!session.disposed) this.emitError(method + ' failed: ' + errorText(error));
    }
  }

  private async addReportBinding(session: SessionState): Promise<void> {
    const client = this.client;
    if (!client || session.disposed) return;
    try {
      await client.send(
        'Runtime.addBinding',
        { name: INJECTED_BINDING },
        session.sessionId,
        REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      if (!session.disposed && !this.bindingWarningEmitted) {
        this.bindingWarningEmitted = true;
        this.emitError('Could not install the page report binding: ' + errorText(error));
      }
    }
  }

  private async addInjectionScript(session: SessionState): Promise<void> {
    const client = this.client;
    const source = this.options.injectedScript;
    if (!client || session.disposed || typeof source !== 'string' || source.length === 0) return;
    try {
      const result = await client.send<Record<string, unknown>>(
        'Page.addScriptToEvaluateOnNewDocument',
        { source, runImmediately: true },
        session.sessionId,
        REQUEST_TIMEOUT_MS,
      );
      session.scriptIdentifier = asString(result.identifier);
    } catch {
      // Older protocol builds may reject runImmediately; retry with the classic form.
      try {
        const result = await client.send<Record<string, unknown>>(
          'Page.addScriptToEvaluateOnNewDocument',
          { source },
          session.sessionId,
          REQUEST_TIMEOUT_MS,
        );
        session.scriptIdentifier = asString(result.identifier);
      } catch (retryError) {
        if (!session.disposed) this.emitError('Could not inject the page script: ' + errorText(retryError));
      }
    }
  }

  private async applyNetworkFilters(session: SessionState): Promise<void> {
    const client = this.client;
    if (!client || session.disposed) return;
    const patterns = this.config.enabled ? normalizeNetworkPatterns(this.config.networkPatterns) : [];
    session.networkPatterns = patterns;
    session.urlMatcher = createUrlMatcher(patterns);
    if (patterns.length === 0) {
      if (session.fetchEnabled) {
        try {
          await client.send('Fetch.disable', {}, session.sessionId, REQUEST_TIMEOUT_MS);
        } catch {
          // Ignore disable failures.
        }
        session.fetchEnabled = false;
      }
      return;
    }
    const requestPatterns = patterns.map((urlPattern) => ({ urlPattern, requestStage: 'Request' }));
    try {
      await client.send('Fetch.enable', { patterns: requestPatterns }, session.sessionId, REQUEST_TIMEOUT_MS);
      session.fetchEnabled = true;
    } catch (error) {
      session.fetchEnabled = false;
      if (!session.disposed) this.emitError('Could not enable network interception: ' + errorText(error));
    }
  }

  private onRequestPaused(event: CdpEvent): void {
    const sessionId = event.sessionId;
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) return;
    const requestId = asString(event.params.requestId);
    if (!requestId) return;
    const request = asRecord(event.params.request);
    const url = asString(request?.url) ?? '';
    const frameId = asString(event.params.frameId);
    if (!this.config.enabled || session.networkPatterns.length === 0 || !session.urlMatcher(url)) {
      this.resumeRequest(session, requestId, 'continue');
      return;
    }
    this.resumeRequest(session, requestId, 'fail', url, frameId);
  }

  private resumeRequest(
    session: SessionState,
    requestId: string,
    action: 'continue' | 'fail',
    url?: string,
    frameId?: string,
  ): void {
    const client = this.client;
    if (!client || session.disposed) return;
    const sessionId = session.sessionId;
    if (action === 'continue') {
      client.send('Fetch.continueRequest', { requestId }, sessionId, FAST_REQUEST_TIMEOUT_MS).catch(() => {});
      return;
    }
    client
      .send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId, FAST_REQUEST_TIMEOUT_MS)
      .then(
        () => {
          this.recordBlock(session, url ?? '', frameId);
        },
        () => {
          // The request may have been resolved elsewhere; release it instead of hanging the page.
          client.send('Fetch.continueRequest', { requestId }, sessionId, FAST_REQUEST_TIMEOUT_MS).catch(() => {});
        },
      )
      .catch(() => {});
  }

  private recordBlock(session: SessionState, url: string, frameId: string | undefined): void {
    if (!url) return;
    const at = Date.now();
    this.blockedRequests += 1;
    this.lastBlockedAt = at;
    const pageUrl = this.pageUrlFor(session, frameId);
    if (pageUrl) {
      this.lastPageUrl = pageUrl;
      this.syncPages();
    }
    const entry: BlockedEvent = { appId: this.options.appId, url, at };
    if (pageUrl) entry.pageUrl = pageUrl;
    this.emit({ type: 'blocked', entry });
    this.scheduleStats();
  }

  private pageUrlFor(session: SessionState, frameId: string | undefined): string | undefined {
    if (frameId) {
      const byFrame = session.frameUrls.get(frameId);
      if (byFrame) return byFrame;
      for (const context of session.contexts.values()) {
        if (context.frameId === frameId && context.url) return context.url;
      }
    }
    const target = this.targets.get(session.targetId);
    if (target && target.url) return target.url;
    return this.lastPageUrl;
  }

  private onContextCreated(event: CdpEvent): void {
    const sessionId = event.sessionId;
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) return;
    const contextInfo = asRecord(event.params.context);
    if (!contextInfo) return;
    const contextId = asNumber(contextInfo.id);
    if (contextId === undefined) return;
    const auxData = asRecord(contextInfo.auxData);
    if (auxData && auxData.isDefault === false) return;
    const frameId = asString(auxData?.frameId);
    const origin = asString(contextInfo.origin);
    const target = this.targets.get(session.targetId);
    let url = frameId ? session.frameUrls.get(frameId) : undefined;
    if (!url && origin && origin !== '://') url = origin;
    if (!url && target) url = target.url;
    const context: ContextState = {
      contextId,
      frameId,
      url: url ?? '',
      hidden: 0,
      ready: false,
      applied: false,
      pickerStarted: false,
      destroyed: false,
      applyChain: Promise.resolve(),
    };
    session.contexts.set(contextId, context);
    this.queueCosmetics(session, context);
  }

  private onContextDestroyed(event: CdpEvent): void {
    const contextId = asNumber(event.params.executionContextId);
    if (contextId === undefined) return;
    const session = event.sessionId ? this.sessions.get(event.sessionId) : undefined;
    if (!session) return;
    const context = session.contexts.get(contextId);
    if (!context) return;
    context.destroyed = true;
    session.contexts.delete(contextId);
    this.scheduleStats();
  }

  private onContextsCleared(event: CdpEvent): void {
    const session = event.sessionId ? this.sessions.get(event.sessionId) : undefined;
    if (!session) return;
    for (const context of session.contexts.values()) context.destroyed = true;
    session.contexts.clear();
    this.scheduleStats();
  }

  private onBindingCalled(event: CdpEvent): void {
    const name = asString(event.params.name);
    if (name !== INJECTED_BINDING) return;
    const payloadText = asString(event.params.payload);
    if (!payloadText) return;
    const session = event.sessionId ? this.sessions.get(event.sessionId) : undefined;
    const contextId = asNumber(event.params.executionContextId);
    const context = session && contextId !== undefined ? session.contexts.get(contextId) : undefined;
    let message: unknown;
    try {
      message = JSON.parse(payloadText);
    } catch {
      return;
    }
    const record = asRecord(message);
    if (!record) return;
    const type = asString(record.type);
    if (!type) return;
    if (type === 'ready') {
      if (session && context) {
        context.ready = true;
        this.onContextReady(session, context);
      }
      return;
    }
    if (type === 'hidden') {
      const count = this.readHiddenCount(record);
      if (count !== undefined && context) this.setContextHidden(context, count);
      return;
    }
    if (type === 'pick') {
      this.handlePick(record, session, context);
      return;
    }
    if (type === 'picker-state') {
      this.handlePickerState(record);
      return;
    }
    if (type === 'layout') {
      this.handleLayout(record, session, context);
      return;
    }
    if (type === 'layout-editor') {
      const active = typeof record.active === 'boolean' ? record.active : true;
      this.layoutEditorActive = active;
      this.emit({ type: 'layout-editor', active });
      return;
    }
    if (type === 'error') {
      this.emitError(asString(record.message) ?? 'The injected script reported an error');
    }
  }

  private readHiddenCount(record: Record<string, unknown>): number | undefined {
    const direct = asNumber(record.count);
    if (direct !== undefined) return Math.max(0, Math.round(direct));
    const nested = asNumber(record.hidden);
    return nested === undefined ? undefined : Math.max(0, Math.round(nested));
  }

  private handlePick(
    record: Record<string, unknown>,
    session: SessionState | undefined,
    context: ContextState | undefined,
  ): void {
    const raw = asRecord(record.payload) ?? asRecord(record.report) ?? record;
    const selector = asString(raw.selector);
    if (!selector || !selector.trim()) return;
    const target = session ? this.targets.get(session.targetId) : undefined;
    const report: PickReport = {
      selector: selector.trim(),
      label: asString(raw.label) ?? '',
      matchCount: Math.max(1, Math.round(asNumber(raw.matchCount) ?? 1)),
      frameUrl: asString(raw.frameUrl) ?? context?.url ?? target?.url ?? '',
      tag: asString(raw.tag) ?? '',
      width: Math.max(0, Math.round(asNumber(raw.width) ?? 0)),
      height: Math.max(0, Math.round(asNumber(raw.height) ?? 0)),
    };
    this.pickerPicked += 1;
    this.emit({ type: 'picked', report });
    this.emitPicker();
  }

  private handleLayout(
    record: Record<string, unknown>,
    session: SessionState | undefined,
    context: ContextState | undefined,
  ): void {
    const raw = asRecord(record.payload) ?? asRecord(record.report) ?? record;
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
    const target = session ? this.targets.get(session.targetId) : undefined;
    const report: LayoutReport = {
      selector: selector.trim(),
      declarations,
      label: asString(raw.label) ?? '',
      frameUrl: asString(raw.frameUrl) ?? context?.url ?? target?.url ?? '',
      matches: Math.max(1, Math.round(asNumber(raw.matches) ?? asNumber(raw.matchCount) ?? 1)),
    };
    this.emit({ type: 'layout', report });
  }

  private handlePickerState(record: Record<string, unknown>): void {
    const active = typeof record.active === 'boolean' ? record.active : undefined;
    const picked = asNumber(record.picked);
    if (picked !== undefined) this.pickerPicked = Math.max(this.pickerPicked, Math.max(0, Math.round(picked)));
    if (active === false && this.pickerActive) {
      this.pickerActive = false;
      void this.broadcastPicker('stopPicker');
    }
    this.emitPicker();
  }

  private onContextReady(session: SessionState, context: ContextState): void {
    this.queueCosmetics(session, context);
    if (this.pickerActive) void this.startPickerInContext(session, context);
    if (this.layoutEditorActive) void this.startLayoutEditorInContext(session, context);
  }

  private queueCosmetics(session: SessionState, context: ContextState): void {
    context.applyChain = context.applyChain
      .then(() => this.applyCosmeticsToContext(session, context))
      .catch(() => {});
  }

  private async applyCosmeticsToContext(session: SessionState, context: ContextState): Promise<void> {
    const client = this.client;
    if (!client || session.disposed || context.destroyed) return;
    if (!context.url && context.frameId) {
      const frameUrl = session.frameUrls.get(context.frameId);
      if (frameUrl) context.url = frameUrl;
    }
    const rules = this.config.cosmetic.filter(
      (rule) => !rule.urlPattern || matchesUrlFilter(context.url, rule.urlPattern),
    );
    const layoutRules = this.config.layout;
    if (rules.length === 0 && layoutRules.length === 0) {
      if (context.applied) {
        await this.callInjected(session, context, 'apply', [{ cosmetic: [], layout: [] }]);
        context.applied = false;
      }
      this.setContextHidden(context, 0);
      return;
    }
    const payload = {
      cosmetic: rules.map((rule) =>
        rule.urlPattern ? { selector: rule.selector, urlPattern: rule.urlPattern } : { selector: rule.selector },
      ),
      layout: layoutRules.map((rule) => ({ selector: rule.selector, declarations: rule.declarations })),
    };
    const outcome = await this.callInjected(session, context, 'apply', [payload]);
    if (!outcome.ok) return;
    context.applied = true;
    this.setContextHidden(context, this.interpretCount(outcome.value) ?? 0);
  }

  private interpretCount(value: unknown): number | undefined {
    const direct = asNumber(value);
    if (direct !== undefined) return Math.max(0, Math.round(direct));
    const record = asRecord(value);
    if (!record) return undefined;
    return this.readHiddenCount(record);
  }

  private async callInjected(
    session: SessionState,
    context: ContextState,
    method: string,
    args: unknown[],
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<InjectedOutcome> {
    const client = this.client;
    if (!client || session.disposed || context.destroyed) return { ok: false, value: undefined };
    const argumentList = args.map((argument) => JSON.stringify(argument) ?? 'null').join(', ');
    const expression = [
      '(async () => {',
      '  try {',
      '    const api = window.' + INJECTED_GLOBAL + ';',
      "    if (!api || typeof api." + method + " !== 'function') return { ok: false };",
      '    return { ok: true, value: await api.' + method + '(' + argumentList + ') };',
      '  } catch (error) {',
      '    return { ok: false };',
      '  }',
      '})()',
    ].join('\n');
    try {
      const result = await client.send<Record<string, unknown>>(
        'Runtime.evaluate',
        {
          expression,
          contextId: context.contextId,
          returnByValue: true,
          awaitPromise: true,
          silent: true,
        },
        session.sessionId,
        timeoutMs,
      );
      const remote = asRecord(result.result);
      const value = remote ? asRecord(remote.value) : undefined;
      if (value && value.ok === true) return { ok: true, value: value.value };
      return { ok: false, value: undefined };
    } catch {
      return { ok: false, value: undefined };
    }
  }

  private setContextHidden(context: ContextState, value: number): void {
    const next = Math.max(0, Math.round(value));
    if (context.hidden === next) return;
    context.hidden = next;
    this.scheduleStats();
  }

  private async startPickerInContext(session: SessionState, context: ContextState): Promise<void> {
    const outcome = await this.callInjected(session, context, 'startPicker', []);
    if (outcome.ok) context.pickerStarted = true;
  }

  private async stopPickerInContext(session: SessionState, context: ContextState): Promise<void> {
    const outcome = await this.callInjected(session, context, 'stopPicker', []);
    if (outcome.ok) context.pickerStarted = false;
  }

  private async startLayoutEditorInContext(session: SessionState, context: ContextState): Promise<void> {
    await this.callInjected(session, context, 'startLayoutEditor', []);
  }

  private async stopLayoutEditorInContext(session: SessionState, context: ContextState): Promise<void> {
    await this.callInjected(session, context, 'stopLayoutEditor', []);
  }

  private async broadcastLayoutEditor(method: 'startLayoutEditor' | 'stopLayoutEditor'): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      if (session.disposed) continue;
      for (const context of session.contexts.values()) {
        if (context.destroyed) continue;
        tasks.push(
          method === 'startLayoutEditor'
            ? this.startLayoutEditorInContext(session, context)
            : this.stopLayoutEditorInContext(session, context),
        );
      }
    }
    await Promise.allSettled(tasks);
  }

  private async broadcastPicker(method: 'startPicker' | 'stopPicker'): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      if (session.disposed) continue;
      for (const context of session.contexts.values()) {
        if (context.destroyed) continue;
        tasks.push(
          method === 'startPicker'
            ? this.startPickerInContext(session, context)
            : this.stopPickerInContext(session, context),
        );
      }
    }
    await Promise.allSettled(tasks);
  }

  private async scanContext(session: SessionState, context: ContextState): Promise<AdCandidate[]> {
    const outcome = await this.callInjected(session, context, 'scan', []);
    if (!outcome.ok || !Array.isArray(outcome.value)) return [];
    const output: AdCandidate[] = [];
    for (const raw of outcome.value) {
      const candidate = toAdCandidate(raw);
      if (candidate) output.push(candidate);
    }
    return output;
  }

  private onFrameNavigated(event: CdpEvent): void {
    const sessionId = event.sessionId;
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (!session || session.disposed) return;
    const frame = asRecord(event.params.frame);
    if (!frame) return;
    const frameId = asString(frame.id);
    if (!frameId) return;
    const url = asString(frame.url) ?? '';
    const parentId = asString(frame.parentId);
    if (url) session.frameUrls.set(frameId, url);
    if (parentId) return;
    session.mainFrameId = frameId;
    const target = this.targets.get(session.targetId);
    if (target && target.type === 'page' && url && url !== 'about:blank') {
      target.url = url;
      this.lastPageUrl = url;
    }
    this.syncPages();
  }

  private dropSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.disposed = true;
    this.sessions.delete(sessionId);
    this.scheduleStats();
  }

  private hiddenElements(): number {
    let total = 0;
    for (const session of this.sessions.values()) {
      for (const context of session.contexts.values()) total += context.hidden;
    }
    return total;
  }

  private pageCount(): number {
    let count = 0;
    for (const target of this.targets.values()) {
      if (target.type === 'page') count += 1;
    }
    return count;
  }

  private syncPages(): void {
    if (!this.connectedFlag) return;
    const pages = this.pageCount();
    const url = this.lastPageUrl ?? '';
    if (pages === this.lastEmittedPages && url === this.lastEmittedPageUrl) return;
    this.lastEmittedPages = pages;
    this.lastEmittedPageUrl = url;
    this.emit({ type: 'page', url, pages });
    this.scheduleStats();
  }

  private refreshConfig(): void {
    try {
      this.config = sanitizeConfig(this.options.getConfig());
    } catch (error) {
      this.config = EMPTY_CONFIG;
      this.emitError('Could not read the filter configuration: ' + errorText(error));
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

  private emitPicker(): void {
    this.emit({ type: 'picker', active: this.pickerActive, picked: this.pickerPicked });
  }

  private requireConnected(): void {
    if (!this.connectedFlag || !this.client) throw new Error('Engine is not connected');
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
}

function sanitizeConfig(raw: EngineFilterConfig | null | undefined): EngineFilterConfig {
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
        label: asString(rule.label),
        enabled: true,
        source: 'layout',
        createdAt: 0,
      });
    }
  }
  return { enabled: record.enabled === true, cosmetic, networkPatterns, layout };
}

function toAdCandidate(value: unknown): AdCandidate | null {
  const record = asRecord(value);
  if (!record) return null;
  const selector = asString(record.selector);
  if (!selector || !selector.trim()) return null;
  return {
    selector: selector.trim(),
    tag: asString(record.tag) ?? '',
    reason: asString(record.reason) ?? 'suspected ad element',
    matchCount: Math.max(1, Math.round(asNumber(record.matchCount) ?? 1)),
    width: Math.max(0, Math.round(asNumber(record.width) ?? 0)),
    height: Math.max(0, Math.round(asNumber(record.height) ?? 0)),
  };
}

async function probeVersionInfo(port: number, timeoutMs: number): Promise<VersionProbe | null> {
  const base = 'http://127.0.0.1:' + String(port);
  const [version, list] = await Promise.all([
    fetchJson(base + '/json/version', timeoutMs),
    fetchJson(base + '/json/list', timeoutMs),
  ]);
  const record = asRecord(version);
  if (!record) return null;
  const webSocketDebuggerUrl =
    asString(record.webSocketDebuggerUrl) ?? asString(record.webSocketUrl) ?? undefined;
  const probe: VersionProbe = {
    targetCount: Array.isArray(list) ? list.length : 0,
  };
  if (webSocketDebuggerUrl) probe.webSocketDebuggerUrl = webSocketDebuggerUrl;
  const electronVersion = parseElectronVersion(record);
  if (electronVersion) probe.electronVersion = electronVersion;
  return probe;
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

/**
 * GETs http://127.0.0.1:PORT/json/version and reports whether a debuggable Electron app
 * is listening, its Electron version and its target count. Resolves null when unreachable.
 */
export async function probeDebugEndpoint(
  port: number,
  timeoutMs = 1500,
): Promise<DebugEndpointInfo | null> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const probe = await probeVersionInfo(port, Math.max(50, timeoutMs));
  if (!probe) return null;
  const info: DebugEndpointInfo = { port, targetCount: probe.targetCount };
  if (probe.electronVersion) info.electronVersion = probe.electronVersion;
  return info;
}

/** Creates an engine bound to one attached application. */
export function createEngine(options: EngineOptions): Engine {
  return new EngineController(options);
}
