import type {
  AdCandidate,
  AppStats,
  Engine,
  EngineConnectResult,
  EngineEvent,
  EngineFilterConfig,
  EngineOptions,
} from '../../shared/types';
import { createEngine } from './engine';
import { createInspectorEngine } from './inspector-engine';

export interface CombinedEngineOptions extends EngineOptions {
  inspectorPort?: number;
}

function isInternalInspectorUrl(url: string | undefined): boolean {
  if (!url) return true;
  const lower = url.toLowerCase();
  if (lower === 'about:blank') return true;
  return (
    lower.includes('overwolf.com/monsdk') ||
    lower.includes('/adview') ||
    lower.includes('ow-cmp') ||
    lower.includes('offline.html') ||
    lower.includes('offline_overlay') ||
    lower.startsWith('owepm://')
  );
}

function mergeCandidates(primary: AdCandidate[], secondary: AdCandidate[]): AdCandidate[] {
  const output: AdCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of [...primary, ...secondary]) {
    if (!candidate || !candidate.selector) continue;
    if (seen.has(candidate.selector)) continue;
    seen.add(candidate.selector);
    output.push(candidate);
  }
  return output;
}

/**
 * Runs the standard CDP engine for regular targets and an optional main-process inspector engine
 * for Electron windows that are hidden from the CDP target list (custom-scheme/Overwolf windows).
 */
export function createCombinedEngine(options: CombinedEngineOptions): Engine {
  const forward = (event: EngineEvent) => {
    try {
      options.onEvent(event);
    } catch {
      // A consumer throwing must never break the engines.
    }
  };
  const cdp = createEngine({
    appId: options.appId,
    injectedScript: options.injectedScript,
    getConfig: options.getConfig,
    onEvent: forward,
  });
  const inspector =
    options.inspectorPort !== undefined
      ? createInspectorEngine({
          ...options,
          inspectorPort: options.inspectorPort,
          onEvent: forward,
        })
      : null;
  let inspectorActive = false;
  let inspectorPort = options.inspectorPort;

  const startInspector = async (): Promise<boolean> => {
    if (!inspector) return false;
    try {
      await inspector.connect(inspectorPort as number);
      inspectorActive = inspector.connected;
      return inspectorActive;
    } catch {
      inspectorActive = false;
      return false;
    }
  };

  const engine: Engine = {
    get connected(): boolean {
      return cdp.connected || (inspectorActive && inspector?.connected === true);
    },

    async connect(port: number): Promise<EngineConnectResult> {
      const result = await cdp.connect(port);
      inspectorPort = inspectorPort ?? options.inspectorPort;
      await startInspector();
      const extraPages = inspectorActive && inspector ? inspector.stats().pages : 0;
      return { electronVersion: result.electronVersion, pages: result.pages + extraPages };
    },

    async disconnect(): Promise<void> {
      inspectorActive = false;
      await Promise.allSettled([
        cdp.disconnect(),
        inspector ? inspector.disconnect() : Promise.resolve(),
      ]);
    },

    async updateFilters(): Promise<void> {
      const tasks: Promise<void>[] = [cdp.updateFilters()];
      if (inspectorActive && inspector?.connected) tasks.push(inspector.updateFilters());
      await Promise.allSettled(tasks);
    },

    async startPicker(): Promise<void> {
      const tasks: Promise<void>[] = [cdp.startPicker()];
      if (inspectorActive && inspector?.connected) tasks.push(inspector.startPicker().catch(() => undefined));
      await Promise.allSettled(tasks);
    },

    async stopPicker(): Promise<void> {
      const tasks: Promise<void>[] = [cdp.stopPicker()];
      if (inspectorActive && inspector?.connected) tasks.push(inspector.stopPicker().catch(() => undefined));
      await Promise.allSettled(tasks);
    },

    async startLayoutEditor(): Promise<void> {
      const tasks: Promise<void>[] = [cdp.startLayoutEditor()];
      if (inspectorActive && inspector?.connected) tasks.push(inspector.startLayoutEditor().catch(() => undefined));
      await Promise.allSettled(tasks);
    },

    async stopLayoutEditor(): Promise<void> {
      const tasks: Promise<void>[] = [cdp.stopLayoutEditor()];
      if (inspectorActive && inspector?.connected) tasks.push(inspector.stopLayoutEditor().catch(() => undefined));
      await Promise.allSettled(tasks);
    },

    async scanForAds(): Promise<AdCandidate[]> {
      const lists = await Promise.allSettled([
        cdp.scanForAds(),
        inspectorActive && inspector?.connected ? inspector.scanForAds() : Promise.resolve([]),
      ]);
      const collected: AdCandidate[][] = lists.map((entry) =>
        entry.status === 'fulfilled' ? entry.value : [],
      );
      return mergeCandidates(collected[0] ?? [], collected[1] ?? []);
    },

    stats(): AppStats {
      const base = cdp.stats();
      if (!inspectorActive || !inspector?.connected) return base;
      const extra = inspector.stats();
      const result: AppStats = {
        blockedRequests: base.blockedRequests + extra.blockedRequests,
        hiddenElements: base.hiddenElements + extra.hiddenElements,
        pages: base.pages + extra.pages,
      };
      const lastBlockedAt = Math.max(base.lastBlockedAt ?? 0, extra.lastBlockedAt ?? 0);
      if (lastBlockedAt > 0) result.lastBlockedAt = lastBlockedAt;
      if (!isInternalInspectorUrl(base.lastPageUrl) && base.lastPageUrl) {
        result.lastPageUrl = base.lastPageUrl;
      } else if (extra.lastPageUrl && !isInternalInspectorUrl(extra.lastPageUrl)) {
        result.lastPageUrl = extra.lastPageUrl;
      } else {
        const fallback = base.lastPageUrl ?? extra.lastPageUrl;
        if (fallback) result.lastPageUrl = fallback;
      }
      return result;
    },
  };

  return engine;
}
