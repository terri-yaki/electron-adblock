// Injected entry point. The host injects this IIFE at document_start into every frame's
// main world, then talks to it through window.__electronAdblock and __electronAdblockReport.
import { INJECTED_BINDING, INJECTED_GLOBAL } from '../shared/types';
import type { AdCandidate, LayoutReport } from '../shared/types';
import { CosmeticController } from './cosmetic';
import { LayoutEditor } from './layout-editor';
import { LayoutStyles } from './layout';
import type { InjectedMessage, ReportFn } from './messages';
import { ElementPicker } from './picker';
import type { PickerOptions } from './picker';
import { scanAdCandidates } from './suggest';

interface InjectedApi {
  apply: (payload: unknown) => number;
  startPicker: (options?: PickerOptions) => void;
  stopPicker: () => void;
  scan: () => AdCandidate[];
  startLayoutEditor: () => void;
  stopLayoutEditor: () => void;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'injected: unknown error';
}

const report: ReportFn = (message: InjectedMessage): void => {
  try {
    const host = window as unknown as Record<string, unknown>;
    const binding = host[INJECTED_BINDING];
    if (typeof binding !== 'function') return;
    (binding as (payload: string) => void)(JSON.stringify(message));
  } catch {
    // Reporting is best effort; the binding may not exist yet.
  }
};

function install(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const host = window as unknown as Record<string, unknown>;
  // Double injection must be a no-op.
  if (host[INJECTED_GLOBAL] !== undefined) return;

  try {
    const cosmetic = new CosmeticController({ doc: document, report });
    const layoutStyles = new LayoutStyles(document);
    const picker = new ElementPicker(
      {
        report,
        onPick: (selector: string) => {
          cosmetic.addSelector(selector);
        },
      },
      document,
    );
    const layoutEditor = new LayoutEditor(
      {
        report,
        onSave: (saved: LayoutReport) => {
          // Optimistic: keep the panel adjusted until the engine re-sends the saved rule.
          layoutStyles.upsert(saved.selector, saved.declarations);
          report({ type: 'layout', payload: saved });
        },
      },
      document,
    );

    const api: InjectedApi = {
      apply: (payload: unknown): number => {
        let hidden = 0;
        try {
          hidden = cosmetic.apply(payload);
        } catch (error) {
          report({ type: 'error', message: messageOf(error) });
        }
        try {
          layoutStyles.applyLayout(payload);
        } catch (error) {
          report({ type: 'error', message: messageOf(error) });
        }
        return hidden;
      },
      startPicker: (options?: PickerOptions): void => {
        try {
          if (layoutEditor.isActive) layoutEditor.stop();
          picker.start(options);
        } catch (error) {
          report({ type: 'error', message: messageOf(error) });
        }
      },
      stopPicker: (): void => {
        try {
          picker.stop();
        } catch (error) {
          report({ type: 'error', message: messageOf(error) });
        }
      },
      scan: (): AdCandidate[] => {
        try {
          return scanAdCandidates(document);
        } catch (error) {
          report({ type: 'error', message: messageOf(error) });
          return [];
        }
      },
      startLayoutEditor: (): void => {
        try {
          if (picker.isActive) picker.stop();
          layoutEditor.start();
        } catch (error) {
          report({ type: 'error', message: messageOf(error) });
        }
      },
      stopLayoutEditor: (): void => {
        try {
          layoutEditor.stop();
        } catch (error) {
          report({ type: 'error', message: messageOf(error) });
        }
      },
    };

    try {
      Object.defineProperty(host, INJECTED_GLOBAL, {
        value: api,
        configurable: true,
        enumerable: false,
        writable: false,
      });
    } catch {
      host[INJECTED_GLOBAL] = api;
    }

    cosmetic.start();
    report({ type: 'ready' });
  } catch (error) {
    report({ type: 'error', message: messageOf(error) });
  }
}

install();

export {};
