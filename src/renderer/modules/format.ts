const numberFormat = new Intl.NumberFormat('en-US');

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return numberFormat.format(Math.max(0, Math.round(value)));
}

export function plural(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? singular + 's');
}

export function relativeTime(at: number | undefined, now = Date.now()): string {
  if (!at || !Number.isFinite(at)) return 'never';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return seconds + 's ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.round(hours / 24);
  if (days < 7) return days + 'd ago';
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function clockTime(at: number): string {
  const date = new Date(at);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return hours + ':' + minutes;
}

export function clockSeconds(at: number): string {
  const date = new Date(at);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return hours + ':' + minutes + ':' + seconds;
}

export function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    const withoutScheme = url.replace(/^[a-z]+:\/\//i, '');
    return withoutScheme.split('/')[0] || url;
  }
}

export function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return (parsed.pathname + parsed.search) || '/';
  } catch {
    return '';
  }
}

export function pageLabel(url: string | undefined): string {
  if (!url) return 'No page loaded';
  const host = hostOf(url);
  const path = pathOf(url);
  return path && path !== '/' ? host + path : host;
}

export function fileName(exePath: string): string {
  const parts = exePath.split(/[\\/]/);
  return parts[parts.length - 1] || exePath;
}

export function fileDir(exePath: string): string {
  const index = Math.max(exePath.lastIndexOf('\\'), exePath.lastIndexOf('/'));
  return index > 0 ? exePath.slice(0, index) : '';
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Something went wrong.';
}

function isMacLike(): boolean {
  return /Mac/i.test(navigator.userAgent);
}

const MODIFIER_LABELS: Record<string, string> = {
  commandorcontrol: isMacLike() ? 'Cmd' : 'Ctrl',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  meta: isMacLike() ? 'Cmd' : 'Win',
  super: isMacLike() ? 'Cmd' : 'Win',
  cmd: 'Cmd',
  command: isMacLike() ? 'Cmd' : 'Win',
};

export function hotkeyLabel(accelerator: string): string {
  if (!accelerator) return 'None';
  return accelerator
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => MODIFIER_LABELS[part.toLowerCase()] ?? (part.length === 1 ? part.toUpperCase() : part))
    .join(' + ');
}

/** Validates an Electron accelerator; returns a normalized value or null. */
export function normalizeHotkey(value: string): string | null {
  const parts = value
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const key = parts[parts.length - 1];
  if (!key || key.length > 16 || /\s/.test(key)) return null;
  const modifiers = parts.slice(0, -1);
  const normalized: string[] = [];
  for (const modifier of modifiers) {
    const lower = modifier.toLowerCase();
    let canonical: string;
    switch (lower) {
      case 'commandorcontrol':
        canonical = 'CommandOrControl';
        break;
      case 'control':
      case 'ctrl':
        canonical = 'Control';
        break;
      case 'alt':
        canonical = 'Alt';
        break;
      case 'shift':
        canonical = 'Shift';
        break;
      case 'meta':
      case 'super':
      case 'cmd':
      case 'command':
        canonical = 'Super';
        break;
      default:
        return null;
    }
    if (!normalized.includes(canonical)) normalized.push(canonical);
  }
  if (normalized.length === 0) return null;
  const normalizedKey = key.length === 1 ? key.toUpperCase() : key;
  return normalized.concat(normalizedKey).join('+');
}

export function truncateMiddle(value: string, max: number): string {
  if (value.length <= max) return value;
  const keep = Math.max(4, Math.floor((max - 1) / 2));
  return value.slice(0, keep) + '...' + value.slice(value.length - keep);
}
