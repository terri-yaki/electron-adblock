import WebSocket from 'ws';

// Small raw CDP client. It is independent of the engine under test: assertions use
// the browser endpoint (/json/version) and attach to page targets with flattened sessions.
export interface TargetInfo {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface JsonVersion {
  Browser?: string;
  'Protocol-Version'?: string;
  webSocketDebuggerUrl: string;
}

export interface BrowserEndpoint {
  browserWebSocketUrl: string;
  version: JsonVersion;
  targets: TargetInfo[];
}

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PendingCall {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

const JSON_TIMEOUT_MS = 2000;

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isPageTarget(target: TargetInfo): boolean {
  return target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string';
}

async function fetchJson<T>(url: string, timeoutMs = JSON_TIMEOUT_MS): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error('GET ' + url + ' failed with HTTP ' + response.status);
  return (await response.json()) as T;
}

export async function fetchJsonVersion(port: number): Promise<JsonVersion> {
  return fetchJson<JsonVersion>('http://127.0.0.1:' + port + '/json/version');
}

export async function fetchTargets(port: number): Promise<TargetInfo[]> {
  return fetchJson<TargetInfo[]>('http://127.0.0.1:' + port + '/json/list');
}

export interface WaitEndpointOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  requirePage?: boolean;
}

export async function waitForEndpoint(port: number, options: WaitEndpointOptions = {}): Promise<BrowserEndpoint> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | null = null;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) {
      throw new Error('aborted while waiting for the CDP endpoint on port ' + port);
    }
    try {
      const version = await fetchJsonVersion(port);
      const targets = await fetchTargets(port);
      const pages = targets.filter(isPageTarget);
      if (!options.requirePage || pages.length > 0) {
        if (typeof version.webSocketDebuggerUrl !== 'string') {
          throw new Error('/json/version did not expose a browser websocket URL');
        }
        return { browserWebSocketUrl: version.webSocketDebuggerUrl, version, targets };
      }
      lastError = new Error('the devtools endpoint is up but no page target is available yet');
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await delay(100);
  }

  const suffix = lastError ? ': ' + lastError.message : '';
  throw new Error('timed out after ' + timeoutMs + 'ms waiting for the CDP endpoint on 127.0.0.1:' + port + suffix);
}

export interface EvaluateOptions {
  awaitPromise?: boolean;
  userGesture?: boolean;
  timeoutMs?: number;
}

export class CdpPage {
  readonly target: TargetInfo;
  private readonly connection: CdpConnection;
  private readonly sessionId: string;

  constructor(connection: CdpConnection, target: TargetInfo, sessionId: string) {
    this.connection = connection;
    this.target = target;
    this.sessionId = sessionId;
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<Record<string, unknown>> {
    return this.connection.send(method, params, this.sessionId, timeoutMs);
  }

  async evaluate<T>(expression: string, options: EvaluateOptions = {}): Promise<T> {
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: options.awaitPromise ?? true,
        userGesture: options.userGesture ?? false,
      },
      options.timeoutMs ?? 15000,
    );
    const exception = result.exceptionDetails as
      | { text?: string; exception?: { description?: string } }
      | undefined;
    if (exception) {
      const description = exception.exception?.description ?? exception.text ?? 'unknown error';
      throw new Error('evaluate failed: ' + description + ' | expression: ' + expression);
    }
    const remote = result.result as { value?: T } | undefined;
    return remote?.value as T;
  }

  async waitFor<T>(
    expression: string,
    options: { timeoutMs?: number; pollMs?: number; description?: string } = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 5000;
    const pollMs = options.pollMs ?? 50;
    const deadline = Date.now() + timeoutMs;
    let lastError: Error | null = null;

    while (Date.now() < deadline) {
      try {
        const value = await this.evaluate<T>(expression, { awaitPromise: false, timeoutMs: 5000 });
        if (value) return value;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
      await delay(pollMs);
    }

    const description = options.description ? ' waiting for ' + options.description : '';
    const suffix = lastError ? '; last error: ' + lastError.message : '';
    throw new Error('timed out after ' + timeoutMs + 'ms' + description + ' (' + expression + ')' + suffix);
  }

  async navigate(url: string, options: { timeoutMs?: number } = {}): Promise<void> {
    const result = await this.send('Page.navigate', { url });
    const errorText = result.errorText;
    if (typeof errorText === 'string' && errorText.length > 0) {
      throw new Error('navigation to ' + url + ' failed: ' + errorText);
    }
    await this.waitFor(
      'location.href === ' + JSON.stringify(url) + ' && document.readyState === "complete"',
      { timeoutMs: options.timeoutMs ?? 15000, description: 'navigation to ' + url },
    );
  }

  async reload(options: { ignoreCache?: boolean; timeoutMs?: number } = {}): Promise<void> {
    const previousTimeOrigin = await this.evaluate<number>('performance.timeOrigin');
    await this.send('Page.reload', { ignoreCache: options.ignoreCache ?? true });
    await this.waitFor(
      'performance.timeOrigin !== ' + String(previousTimeOrigin) + ' && document.readyState === "complete"',
      { timeoutMs: options.timeoutMs ?? 15000, description: 'page reload' },
    );
  }

  async dispatchMouseEvent(
    type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
    x: number,
    y: number,
    options: { button?: 'none' | 'left'; buttons?: number; clickCount?: number } = {},
  ): Promise<Record<string, unknown>> {
    return this.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: options.button ?? 'none',
      buttons: options.buttons ?? 0,
      clickCount: options.clickCount ?? 0,
    });
  }

  async click(x: number, y: number): Promise<void> {
    await this.dispatchMouseEvent('mouseMoved', x, y);
    await delay(40);
    await this.dispatchMouseEvent('mousePressed', x, y, { button: 'left', buttons: 1, clickCount: 1 });
    await this.dispatchMouseEvent('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount: 1 });
  }

  async boundingRect(selector: string): Promise<Rectangle | null> {
    const rect = await this.evaluate<Rectangle | null>(
      '(() => { const element = document.querySelector(' +
        JSON.stringify(selector) +
        '); if (!element) return null; const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; })()',
      { awaitPromise: false },
    );
    return rect ?? null;
  }

  async computedDisplay(selector: string): Promise<string | null> {
    const display = await this.evaluate<string | null>(
      '(() => { const element = document.querySelector(' +
        JSON.stringify(selector) +
        '); return element ? getComputedStyle(element).display : null; })()',
      { awaitPromise: false },
    );
    return display ?? null;
  }

  async close(): Promise<void> {
    try {
      await this.connection.send('Target.detachFromTarget', { sessionId: this.sessionId }, undefined, 2000);
    } catch {
      // The target may already be gone; detaching is best effort.
    }
  }
}

export class CdpConnection {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, PendingCall>();
  private readonly eventListeners = new Set<(event: CdpEvent) => void>();
  private nextId = 0;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', this.handleMessage);
    socket.on('close', () => this.rejectAll(new Error('CDP connection closed')));
    socket.on('error', (error: Error) => this.rejectAll(new Error('CDP socket error: ' + error.message)));
  }

  static async connect(webSocketUrl: string, timeoutMs = 5000): Promise<CdpConnection> {
    const socket = new WebSocket(webSocketUrl, { perMessageDeflate: false, handshakeTimeout: timeoutMs });
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        socket.off('error', onError);
        resolve();
      };
      const onError = (error: Error): void => {
        socket.off('open', onOpen);
        reject(new Error('CDP websocket connection failed: ' + error.message));
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
    });
    return new CdpConnection(socket);
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 15000,
  ): Promise<Record<string, unknown>> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP ' + method + ' failed: connection is not open'));
    }
    const id = (this.nextId += 1);
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP ' + method + ' timed out after ' + timeoutMs + 'ms'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const payload: Record<string, unknown> = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.socket.send(JSON.stringify(payload), (error?: Error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new Error('CDP send failed: ' + error.message));
        }
      });
    });
  }

  onEvent(listener: (event: CdpEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async attachToPage(target: TargetInfo): Promise<CdpPage> {
    const result = await this.send('Target.attachToTarget', { targetId: target.id, flatten: true });
    const sessionId = result.sessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('Target.attachToTarget returned no session id for target ' + target.id);
    }
    return new CdpPage(this, target, sessionId);
  }

  async close(): Promise<void> {
    for (const call of this.pending.values()) call.reject(new Error('CDP connection closed'));
    this.pending.clear();
    this.eventListeners.clear();
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      this.socket.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.close();
    });
  }

  private rejectAll(error: Error): void {
    for (const call of this.pending.values()) call.reject(error);
    this.pending.clear();
  }

  private readonly handleMessage = (data: WebSocket.RawData): void => {
    let message: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: { message?: string };
      sessionId?: string;
    };
    try {
      message = JSON.parse(String(data)) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      if (message.error) call.reject(new Error('CDP request failed: ' + (message.error.message ?? 'unknown error')));
      else call.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === 'string') {
      const event: CdpEvent = {
        method: message.method,
        params: message.params ?? {},
        sessionId: message.sessionId,
      };
      for (const listener of this.eventListeners) listener(event);
    }
  };
}

export interface ConnectedFixturePage {
  connection: CdpConnection;
  page: CdpPage;
  endpoint: BrowserEndpoint;
}

export async function connectToPage(
  port: number,
  options: { timeoutMs?: number } = {},
): Promise<ConnectedFixturePage> {
  const endpoint = await waitForEndpoint(port, {
    timeoutMs: options.timeoutMs ?? 15000,
    requirePage: true,
  });
  const target = endpoint.targets.find(isPageTarget);
  if (!target) throw new Error('no page target available on 127.0.0.1:' + port);
  const connection = await CdpConnection.connect(endpoint.browserWebSocketUrl);
  try {
    const page = await connection.attachToPage(target);
    return { connection, page, endpoint };
  } catch (error) {
    await connection.close();
    throw error;
  }
}
