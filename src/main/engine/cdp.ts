import http from 'node:http';
import WebSocket, { type RawData } from 'ws';

/** Event pushed by the browser over the CDP socket. */
export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** Transport or protocol level failure for a single CDP request. */
export class CdpRequestError extends Error {
  readonly code?: number;
  readonly data?: string;

  constructor(message: string, code?: number, data?: string) {
    super(message);
    this.name = 'CdpRequestError';
    this.code = code;
    this.data = data;
  }
}

type EventListener = (event: CdpEvent) => void;
type CloseListener = (reason: string) => void;

interface PendingCall {
  method: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const SOCKET_CLOSE_GRACE_MS = 750;
const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;
const ELECTRON_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const ELECTRON_TOKEN_PATTERN = /Electron\/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i;

export function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const candidate = timer as unknown as { unref?: () => void };
  if (typeof candidate.unref === 'function') candidate.unref();
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function rawDataToString(data: RawData): string {
  const candidate: unknown = data;
  if (typeof candidate === 'string') return candidate;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

/**
 * Minimal JSON-RPC client for the Chrome DevTools Protocol over a websocket.
 * Supports request/response correlation, flat session scoping (sessionId), push events,
 * per-request timeouts and close handling that rejects every pending call.
 */
export class CdpClient {
  private readonly socket: WebSocket;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<number, PendingCall>();
  private readonly eventListeners = new Set<EventListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;
  private nextId = 1;
  private open = true;
  private closeReason = 'socket closed';
  private lastSocketError: string | undefined;

  private constructor(socket: WebSocket, requestTimeoutMs: number) {
    this.socket = socket;
    this.requestTimeoutMs = requestTimeoutMs;
    this.closedPromise = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    socket.on('message', (data: RawData) => {
      this.onMessage(data);
    });
    socket.on('close', (code: number, reason: Buffer) => {
      const suffix = reason && reason.length > 0 ? ': ' + reason.toString('utf8') : '';
      this.finalize('socket closed (' + code + ')' + suffix);
    });
    socket.on('error', (error: Error) => {
      this.lastSocketError = error.message;
    });
  }

  /** Opens a websocket to a CDP endpoint and resolves once the handshake completed. */
  static connect(url: string, timeoutMs = 10000): Promise<CdpClient> {
    return new Promise<CdpClient>((resolve, reject) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url, {
          perMessageDeflate: false,
          handshakeTimeout: Math.max(500, timeoutMs),
        });
      } catch (error) {
        reject(new CdpRequestError('Could not create CDP websocket: ' + errorText(error)));
        return;
      }
      const client = new CdpClient(socket, DEFAULT_REQUEST_TIMEOUT_MS);
      let settled = false;
      const finish = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeListener('open', onOpen);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
        action();
      };
      const onOpen = (): void => finish(() => resolve(client));
      const onError = (error: Error): void =>
        finish(() => reject(new CdpRequestError('CDP websocket failed: ' + error.message)));
      const onClose = (): void =>
        finish(() => reject(new CdpRequestError('CDP endpoint closed before the websocket handshake')));
      const timer = setTimeout(() => {
        finish(() => {
          client.close('handshake timeout');
          reject(new CdpRequestError('Timed out connecting to CDP endpoint ' + url));
        });
      }, Math.max(250, timeoutMs));
      unrefTimer(timer);
      socket.once('open', onOpen);
      socket.once('error', onError);
      socket.once('close', onClose);
    });
  }

  get connected(): boolean {
    return this.open;
  }

  /** Sends one CDP command and resolves with its result object. */
  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<T> {
    if (!this.open) {
      return Promise.reject(new CdpRequestError('CDP connection is closed; cannot send ' + method));
    }
    const id = this.nextId;
    this.nextId += 1;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    const waitMs = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : this.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new CdpRequestError('CDP request timed out: ' + method));
      }, waitMs);
      unrefTimer(timer);
      this.pending.set(id, {
        method,
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      });
      try {
        this.socket.send(JSON.stringify(message), (error?: Error) => {
          if (!error) return;
          const call = this.pending.get(id);
          if (!call) return;
          this.pending.delete(id);
          clearTimeout(call.timer);
          call.reject(new CdpRequestError('Failed to send ' + method + ': ' + error.message));
        });
      } catch (error) {
        const call = this.pending.get(id);
        if (!call) return;
        this.pending.delete(id);
        clearTimeout(call.timer);
        reject(new CdpRequestError('Failed to send ' + method + ': ' + errorText(error)));
      }
    });
  }

  /** Subscribes to protocol events; returns an unsubscribe function. */
  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /** Subscribes to socket closure; returns an unsubscribe function. */
  onClose(listener: CloseListener): () => void {
    if (!this.open) {
      listener(this.closeReason);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  /** Closes the socket. Pending calls reject through the normal close path. */
  close(reason = 'client closed'): void {
    if (!this.open) return;
    this.closeReason = reason;
    try {
      this.socket.close();
    } catch {
      try {
        this.socket.terminate();
      } catch {
        // Ignore teardown failures.
      }
      this.finalize(reason);
      return;
    }
    const fallback = setTimeout(() => {
      try {
        this.socket.terminate();
      } catch {
        // Ignore teardown failures.
      }
      this.finalize(this.closeReason);
    }, SOCKET_CLOSE_GRACE_MS);
    unrefTimer(fallback);
  }

  /** Resolves when the socket finished closing (immediately when already closed). */
  whenClosed(): Promise<void> {
    return this.closedPromise;
  }

  private finalize(reason: string): void {
    if (!this.open) return;
    this.open = false;
    const suffix = this.lastSocketError ? ' - ' + this.lastSocketError : '';
    this.closeReason = reason + suffix;
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(
        new CdpRequestError('CDP connection closed before ' + call.method + ' completed: ' + this.closeReason),
      );
    }
    this.pending.clear();
    for (const listener of [...this.closeListeners]) {
      try {
        listener(this.closeReason);
      } catch {
        // A close listener must never prevent the remaining listeners from running.
      }
    }
    this.closeListeners.clear();
    this.eventListeners.clear();
    this.resolveClosed();
  }

  private onMessage(data: RawData): void {
    let text: string;
    try {
      text = rawDataToString(data);
    } catch {
      return;
    }
    if (!text) return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const record = asRecord(message);
    if (!record) return;
    const id = asNumber(record.id);
    if (id !== undefined) {
      this.handleResponse(id, record);
      return;
    }
    const method = asString(record.method);
    if (!method) return;
    const event: CdpEvent = {
      method,
      params: asRecord(record.params) ?? {},
    };
    const sessionId = asString(record.sessionId);
    if (sessionId) event.sessionId = sessionId;
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event);
      } catch {
        // Event listener failures must never break the transport.
      }
    }
  }

  private handleResponse(id: number, record: Record<string, unknown>): void {
    const call = this.pending.get(id);
    if (!call) return;
    this.pending.delete(id);
    clearTimeout(call.timer);
    const error = asRecord(record.error);
    if (error) {
      call.reject(
        new CdpRequestError(
          asString(error.message) ?? 'CDP request failed',
          asNumber(error.code),
          asString(error.data),
        ),
      );
      return;
    }
    call.resolve(asRecord(record.result) ?? {});
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Parses the Electron version out of /json/version or Browser.getVersion data. */
export function parseElectronVersion(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (ELECTRON_VERSION_PATTERN.test(trimmed)) return trimmed;
    const token = ELECTRON_TOKEN_PATTERN.exec(trimmed);
    return token ? token[1] : undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ['electron', 'Electron', 'electronVersion', 'ElectronVersion']) {
    const candidate = asString(record[key]);
    if (candidate && ELECTRON_VERSION_PATTERN.test(candidate.trim())) return candidate.trim();
  }
  for (const key of ['User-Agent', 'userAgent', 'Browser', 'browser', 'product', 'Product']) {
    const candidate = asString(record[key]);
    if (!candidate) continue;
    const token = ELECTRON_TOKEN_PATTERN.exec(candidate);
    if (token) return token[1];
  }
  return undefined;
}

/** GETs a JSON document from a local http endpoint; resolves null on any failure. */
export function fetchJson(url: string, timeoutMs = 1500): Promise<unknown> {
  return new Promise<unknown>((resolve) => {
    let settled = false;
    let request: http.ClientRequest | undefined;
    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timeout = Math.max(50, timeoutMs);
    try {
      request = http.get(url, { timeout, headers: { accept: 'application/json' } }, (response) => {
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          response.resume();
          finish(null);
          return;
        }
        let body = '';
        let bytes = 0;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_HTTP_BODY_BYTES) {
            request?.destroy();
            finish(null);
            return;
          }
          body += chunk;
        });
        response.on('end', () => {
          try {
            finish(JSON.parse(body));
          } catch {
            finish(null);
          }
        });
        response.on('error', () => finish(null));
      });
    } catch {
      finish(null);
      return;
    }
    request.on('timeout', () => {
      request?.destroy();
      finish(null);
    });
    request.on('error', () => finish(null));
  });
}
