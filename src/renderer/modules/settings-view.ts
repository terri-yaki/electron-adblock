import type { Settings } from '../../shared/types';
import type { Controller } from './context';
import { h } from './dom';
import { icon, type IconName } from './icons';
import { hotkeyLabel, normalizeHotkey } from './format';
import { button, iconButton, kbd, syncToggle, tag, toggle } from './primitives';

type BooleanSettingKey =
  | 'enabled'
  | 'hideKnownAdDomains'
  | 'blockAnalytics'
  | 'minimizeToTray'
  | 'launchAtLogin'
  | 'closeManagedAppsOnQuit';

export interface SettingsViewComponent {
  el: HTMLElement;
  update(): void;
}

export function createSettingsView(ctx: Controller): SettingsViewComponent {
  const settings = (): Settings | null => ctx.state.settings;
  const toggleRefs = new Map<BooleanSettingKey, HTMLButtonElement>();
  const version = ctx.state.version;

  function booleanRow(key: BooleanSettingKey, title: string, description: string, extra?: HTMLElement): HTMLElement {
    const control = toggle({
      checked: Boolean(settings()?.[key]),
      label: title,
      onChange: (next) => {
        void ctx.updateSetting(key, next);
      },
    });
    toggleRefs.set(key, control);
    return h(
      'div',
      { class: 'setting-row' },
      h(
        'div',
        { class: 'setting-copy' },
        h('div', { class: 'setting-title-line' }, h('span', { class: 'setting-title', text: title }), extra ?? null),
        h('p', { class: 'setting-desc', text: description }),
      ),
      h('div', { class: 'setting-control' }, control),
    );
  }

  function card(iconName: IconName, title: string, description: string, rows: HTMLElement[]): HTMLElement {
    return h(
      'section',
      { class: 'card settings-card' },
      h(
        'header',
        { class: 'settings-card-head' },
        h('span', { class: 'settings-card-icon' }, icon(iconName, 16)),
        h(
          'div',
          { class: 'settings-card-headings' },
          h('h2', { class: 'settings-card-title', text: title }),
          h('p', { class: 'settings-card-desc', text: description }),
        ),
      ),
      h('div', { class: 'settings-rows' }, ...rows),
    );
  }

  // Picker hotkey
  const hotkeyInput = h('input', {
    class: 'text-input hotkey-input',
    type: 'text',
    value: settings()?.pickerHotkey ?? '',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Picker shortcut',
    'aria-describedby': 'hotkey-hint',
  });
  const hotkeyHint = h('p', { class: 'form-hint form-hint-inline', id: 'hotkey-hint' });
  const saveHotkeyBtn = button({ label: 'Save', variant: 'secondary', size: 'sm' });
  const hotkeyRow = h(
    'div',
    { class: 'setting-row setting-row-stack' },
    h(
      'div',
      { class: 'setting-copy' },
      h('div', { class: 'setting-title-line' }, h('span', { class: 'setting-title', text: 'Picker shortcut' })),
      h('p', { class: 'setting-desc', text: 'Global shortcut that starts the picker on the last attached app.' }),
    ),
    h('div', { class: 'hotkey-control' }, hotkeyInput, saveHotkeyBtn),
    hotkeyHint,
  );

  function updateHotkeyHint(): void {
    const current = settings()?.pickerHotkey ?? '';
    hotkeyHint.replaceChildren(
      h('span', { text: 'Current: ' }),
      kbd(hotkeyLabel(current)),
      h('span', { text: ' - use at least one modifier and a key, for example Ctrl+Shift+E.' }),
    );
  }

  function updateSaveState(): void {
    const current = settings()?.pickerHotkey ?? '';
    const normalized = normalizeHotkey(hotkeyInput.value);
    saveHotkeyBtn.disabled = normalized === null || normalized === current;
  }

  async function saveHotkey(): Promise<void> {
    if (saveHotkeyBtn.disabled) return;
    saveHotkeyBtn.disabled = true;
    const ok = await ctx.savePickerHotkey(hotkeyInput.value);
    await Promise.resolve();
    if (ok) hotkeyInput.value = settings()?.pickerHotkey ?? hotkeyInput.value;
    updateSaveState();
  }

  saveHotkeyBtn.addEventListener('click', () => {
    void saveHotkey();
  });
  hotkeyInput.addEventListener('input', updateSaveState);
  hotkeyInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void saveHotkey();
  });

  // Data directory
  const dataDirEl = h('code', { class: 'data-path mono', title: ctx.state.dataDir, text: ctx.state.dataDir });
  const copyDataDirBtn = iconButton({
    iconName: 'copy',
    label: 'Copy data directory',
    title: 'Copy path',
    onClick: () => {
      void ctx.copyText(ctx.state.dataDir);
    },
  });

  const dataCard = card(
    'folder',
    'Storage and versions',
    'Local state, configuration path and build information.',
    [
      h(
        'div',
        { class: 'setting-row' },
        h(
          'div',
          { class: 'setting-copy' },
          h('div', { class: 'setting-title-line' }, h('span', { class: 'setting-title', text: 'Data directory' })),
          h('p', { class: 'setting-desc', text: 'Rules and settings are stored here.' }),
          dataDirEl,
        ),
        h('div', { class: 'setting-control' }, copyDataDirBtn),
      ),
      h(
        'div',
        { class: 'setting-row setting-row-stack' },
        h(
          'div',
          { class: 'setting-copy' },
          h('div', { class: 'setting-title-line' }, h('span', { class: 'setting-title', text: 'Versions' })),
          h('p', { class: 'setting-desc', text: 'Runtime bundled with this build.' }),
        ),
        h(
          'div',
          { class: 'version-grid' },
          versionItem('Application', version?.app),
          versionItem('Electron', version?.electron),
          versionItem('Chromium', version?.chrome),
          versionItem('Node', version?.node),
        ),
      ),
    ],
  );

  function versionItem(label: string, value: string | undefined): HTMLElement {
    return h(
      'div',
      { class: 'version-item' },
      h('span', { class: 'version-label', text: label }),
      h('span', { class: 'version-value mono', text: value && value.length > 0 ? value : 'Unknown' }),
    );
  }

  const protectionCard = card('shield', 'Protection', 'Applied to every attached application.', [
    booleanRow('enabled', 'Blocking enabled', 'Master switch for network and cosmetic filtering.', tag('Master', 'accent')),
    booleanRow('hideKnownAdDomains', 'Built-in ad domains', 'Block a bundled list of well-known advertising hosts.'),
    booleanRow(
      'blockAnalytics',
      'Analytics and trackers',
      'Also block analytics requests that are not strictly ads.',
      tag('Category', 'blue'),
    ),
  ]);

  const applicationCard = card('monitor', 'Application behavior', 'How the desktop window and apps behave.', [
    booleanRow('minimizeToTray', 'Keep running in the tray', 'Closing the window hides it instead of quitting.'),
    booleanRow('launchAtLogin', 'Start with Windows', 'Launch Electron Adblock when you sign in.'),
    booleanRow(
      'closeManagedAppsOnQuit',
      'Close managed apps on quit',
      'Quit apps launched through Electron Adblock when the dashboard exits.',
    ),
  ]);

  const pickerCard = card('picker', 'Element picker', 'Visual rule creation for attached apps.', [hotkeyRow]);

  const buildTag = tag(ctx.state.packaged ? 'Packaged build' : 'Development build', ctx.state.packaged ? 'green' : 'amber');
  const el = h(
    'div',
    { class: 'page settings-page' },
    h(
      'header',
      { class: 'page-head' },
      h(
        'div',
        { class: 'page-heading' },
        h('p', { class: 'eyebrow', text: 'Preferences' }),
        h('h1', { class: 'page-title', text: 'Settings' }),
        h('p', { class: 'page-sub', text: 'Global protection, desktop behavior and diagnostics.' }),
      ),
      h('div', { class: 'page-head-side' }, buildTag),
    ),
    h(
      'div',
      { class: 'settings-columns' },
      h('div', { class: 'settings-column' }, protectionCard, pickerCard),
      h('div', { class: 'settings-column' }, applicationCard, dataCard),
    ),
  );

  function update(): void {
    const current = settings();
    if (!current) return;
    for (const [key, control] of toggleRefs) syncToggle(control, Boolean(current[key]));
    if (document.activeElement !== hotkeyInput) hotkeyInput.value = current.pickerHotkey;
    updateHotkeyHint();
    updateSaveState();
    if (dataDirEl.textContent !== ctx.state.dataDir) {
      dataDirEl.textContent = ctx.state.dataDir;
      dataDirEl.title = ctx.state.dataDir;
    }
  }

  update();
  return { el, update };
}