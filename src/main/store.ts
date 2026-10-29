import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createDefaultState, DEFAULT_SETTINGS } from '../shared/defaults';
import type {
  AppSource,
  CosmeticRule,
  CosmeticRuleSource,
  LayoutRule,
  LayoutRuleSource,
  NetworkRule,
  NetworkRuleSource,
  PersistedApp,
  PersistedState,
  Settings,
} from '../shared/types';

const DATA_FILE_NAME = 'adblock-data.json';
const SCHEMA_VERSION = 1;
const RENAME_ATTEMPTS = 4;

const APP_SOURCES: readonly AppSource[] = ['start-menu', 'running', 'manual', 'preset'];
const COSMETIC_RULE_SOURCES: readonly CosmeticRuleSource[] = ['picker', 'manual', 'suggestion', 'preset'];
const NETWORK_RULE_SOURCES: readonly NetworkRuleSource[] = ['manual', 'preset', 'default'];
const LAYOUT_RULE_SOURCES: readonly LayoutRuleSource[] = ['layout', 'manual', 'preset'];

export class AppStore {
  data: PersistedState;

  private saveQueue: Promise<void> = Promise.resolve();
  private writeCounter = 0;

  constructor(readonly dir: string) {
    this.data = createDefaultState();
  }

  async load(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    let raw: string;
    try {
      raw = await fs.readFile(this.dataPath, 'utf8');
    } catch (error) {
      this.data = createDefaultState();
      if (!isNotFoundError(error)) return;
      return;
    }
    const parsed = parsePersistedState(raw);
    if (parsed) {
      this.data = parsed;
      return;
    }
    this.data = createDefaultState();
    await this.backupCorruptFile();
    try {
      await this.enqueueWrite(serializeState(this.data));
    } catch {
      // Defaults stay in memory even when the rewrite fails.
    }
  }

  save(): Promise<void> {
    return this.enqueueWrite(serializeState(this.data));
  }

  private get dataPath(): string {
    return path.join(this.dir, DATA_FILE_NAME);
  }

  // Serializes writes so concurrent save calls cannot interleave.
  private enqueueWrite(content: string): Promise<void> {
    const operation = this.saveQueue.then(() => this.writeAtomic(content));
    this.saveQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async writeAtomic(content: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    this.writeCounter += 1;
    const tempPath = path.join(this.dir, '.' + DATA_FILE_NAME + '.' + process.pid + '.' + this.writeCounter + '.tmp');
    try {
      const handle = await fs.open(tempPath, 'w');
      try {
        await handle.writeFile(content, 'utf8');
        try {
          await handle.sync();
        } catch {
          // Durability is best effort; rename still makes the swap atomic.
        }
      } finally {
        await handle.close();
      }
      await this.renameWithRetry(tempPath, this.dataPath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private async renameWithRetry(from: string, to: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
      try {
        await fs.rename(from, to);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < RENAME_ATTEMPTS - 1) await delay(20 * (attempt + 1));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async backupCorruptFile(): Promise<void> {
    const backupPath = path.join(this.dir, DATA_FILE_NAME + '.corrupt-' + Date.now());
    try {
      await fs.rename(this.dataPath, backupPath);
      return;
    } catch {
      // Fall through to a copy when the rename is blocked.
    }
    try {
      await fs.copyFile(this.dataPath, backupPath);
    } catch {
      // Nothing else to recover; defaults remain in memory.
    }
  }
}

// Validates persisted JSON; returns null when the file must be treated as corrupt.
export function sanitizePersistedState(value: unknown): PersistedState | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== SCHEMA_VERSION) return null;
  if (!Array.isArray(value.apps)) return null;
  const apps: PersistedApp[] = [];
  const seenIds = new Set<string>();
  for (const rawApp of value.apps) {
    const app = sanitizeApp(rawApp);
    if (!app) continue;
    const key = app.id.toLowerCase();
    if (seenIds.has(key)) continue;
    seenIds.add(key);
    apps.push(app);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: sanitizeSettings(value.settings),
    apps,
  };
}

function parsePersistedState(raw: string): PersistedState | null {
  let value: unknown;
  try {
    value = JSON.parse(stripBom(raw));
  } catch {
    return null;
  }
  return sanitizePersistedState(value);
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function serializeState(state: PersistedState): string {
  return JSON.stringify(state, null, 2) + '\n';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function pickOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function pickTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  return Date.now();
}

function pickPort(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536) return value;
  return undefined;
}

function pickAppSource(value: unknown): AppSource {
  if (typeof value === 'string' && (APP_SOURCES as readonly string[]).includes(value)) return value as AppSource;
  return 'manual';
}

function pickCosmeticSource(value: unknown): CosmeticRuleSource {
  if (typeof value === 'string' && (COSMETIC_RULE_SOURCES as readonly string[]).includes(value)) {
    return value as CosmeticRuleSource;
  }
  return 'manual';
}

function pickNetworkSource(value: unknown): NetworkRuleSource {
  if (typeof value === 'string' && (NETWORK_RULE_SOURCES as readonly string[]).includes(value)) {
    return value as NetworkRuleSource;
  }
  return 'manual';
}

function sanitizeSettings(value: unknown): Settings {
  const source = isRecord(value) ? value : {};
  return {
    enabled: pickBoolean(source.enabled, DEFAULT_SETTINGS.enabled),
    hideKnownAdDomains: pickBoolean(source.hideKnownAdDomains, DEFAULT_SETTINGS.hideKnownAdDomains),
    blockAnalytics: pickBoolean(source.blockAnalytics, DEFAULT_SETTINGS.blockAnalytics),
    minimizeToTray: pickBoolean(source.minimizeToTray, DEFAULT_SETTINGS.minimizeToTray),
    launchAtLogin: pickBoolean(source.launchAtLogin, DEFAULT_SETTINGS.launchAtLogin),
    closeManagedAppsOnQuit: pickBoolean(source.closeManagedAppsOnQuit, DEFAULT_SETTINGS.closeManagedAppsOnQuit),
    pickerHotkey: pickString(source.pickerHotkey, DEFAULT_SETTINGS.pickerHotkey),
  };
}

function sanitizeApp(value: unknown): PersistedApp | null {
  if (!isRecord(value)) return null;
  const id = pickString(value.id, '');
  const exePath = pickString(value.exePath, '');
  if (!id || !exePath) return null;
  const app: PersistedApp = {
    id,
    name: pickString(value.name, path.win32.basename(exePath)),
    exePath,
    shortcutArgs: Array.isArray(value.shortcutArgs)
      ? value.shortcutArgs.filter((item): item is string => typeof item === 'string')
      : [],
    source: pickAppSource(value.source),
    enabled: pickBoolean(value.enabled, true),
    addedAt: pickTimestamp(value.addedAt),
    cosmeticRules: sanitizeCosmeticRules(value.cosmeticRules),
    networkRules: sanitizeNetworkRules(value.networkRules),
    layoutRules: sanitizeLayoutRules(value.layoutRules),
  };
  const debugPort = pickPort(value.debugPort);
  if (debugPort !== undefined) app.debugPort = debugPort;
  if (typeof value.lastOpenedAt === 'number' && Number.isFinite(value.lastOpenedAt) && value.lastOpenedAt > 0) {
    app.lastOpenedAt = value.lastOpenedAt;
  }
  return app;
}

function sanitizeCosmeticRules(value: unknown): CosmeticRule[] {
  if (!Array.isArray(value)) return [];
  const rules: CosmeticRule[] = [];
  const seen = new Set<string>();
  for (const rawRule of value) {
    if (!isRecord(rawRule)) continue;
    const id = pickString(rawRule.id, '');
    const selector = pickString(rawRule.selector, '');
    if (!id || !selector) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const rule: CosmeticRule = {
      id,
      selector,
      enabled: pickBoolean(rawRule.enabled, true),
      source: pickCosmeticSource(rawRule.source),
      createdAt: pickTimestamp(rawRule.createdAt),
    };
    const urlPattern = pickOptionalString(rawRule.urlPattern);
    if (urlPattern) rule.urlPattern = urlPattern;
    const label = pickOptionalString(rawRule.label);
    if (label) rule.label = label;
    rules.push(rule);
  }
  return rules;
}

function pickLayoutSource(value: unknown): LayoutRuleSource {
  if (typeof value === 'string' && (LAYOUT_RULE_SOURCES as readonly string[]).includes(value)) {
    return value as LayoutRuleSource;
  }
  return 'manual';
}

function sanitizeLayoutDeclarations(value: unknown): Record<string, string> {
  const output: Record<string, string> = {};
  if (!isRecord(value)) return output;
  for (const [key, raw] of Object.entries(value)) {
    const property = key.trim().toLowerCase();
    if (!/^[a-z-]{2,32}$/.test(property)) continue;
    if (typeof raw !== 'string') continue;
    const text = raw.trim();
    if (!text || text.length > 120) continue;
    if (/[;{}<>\\]/.test(text)) continue;
    if (/url\s*\(|expression\s*\(|@import/i.test(text)) continue;
    output[property] = text;
    if (Object.keys(output).length >= 20) break;
  }
  return output;
}

function sanitizeLayoutRules(value: unknown): LayoutRule[] {
  if (!Array.isArray(value)) return [];
  const rules: LayoutRule[] = [];
  const seen = new Set<string>();
  for (const rawRule of value) {
    if (!isRecord(rawRule)) continue;
    const id = pickString(rawRule.id, '');
    const selector = pickString(rawRule.selector, '');
    const declarations = sanitizeLayoutDeclarations(rawRule.declarations);
    if (!id || !selector || Object.keys(declarations).length === 0) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const rule: LayoutRule = {
      id,
      selector,
      declarations,
      enabled: pickBoolean(rawRule.enabled, true),
      source: pickLayoutSource(rawRule.source),
      createdAt: pickTimestamp(rawRule.createdAt),
    };
    const label = pickOptionalString(rawRule.label);
    if (label) rule.label = label;
    rules.push(rule);
  }
  return rules;
}

function sanitizeNetworkRules(value: unknown): NetworkRule[] {
  if (!Array.isArray(value)) return [];
  const rules: NetworkRule[] = [];
  const seen = new Set<string>();
  for (const rawRule of value) {
    if (!isRecord(rawRule)) continue;
    const id = pickString(rawRule.id, '');
    const pattern = pickString(rawRule.pattern, '');
    if (!id || !pattern) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({
      id,
      pattern,
      enabled: pickBoolean(rawRule.enabled, true),
      source: pickNetworkSource(rawRule.source),
      createdAt: pickTimestamp(rawRule.createdAt),
    });
  }
  return rules;
}
