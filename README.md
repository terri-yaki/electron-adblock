# Electron Adblock

A desktop ad blocker for Electron applications. It relaunches any Electron app with a local DevTools port, attaches over the Chrome DevTools Protocol, blocks ad and tracker requests, and hides ad elements you pick with your mouse. Built around OP.GG-style desktop advertisements, it works with any Electron app that accepts a remote debugging port, including Overwolf-runtime apps such as TFTAcademy whose windows are hidden from the normal target list. Live-verified against OP.GG and TFTAcademy.

## Features

- Network blocking: known ad and tracker hosts are rejected inside the app before the request leaves the machine. A curated list is built in, and per-app domains or glob patterns can be added.
- Hidden-window support: some Electron apps (for example the Overwolf-based TFTAcademy) keep their main windows out of the normal Chromium debugging target list. Electron Adblock also starts apps with a local Node inspector port and drives those windows directly, so hiding, the visual picker and layout changes work there too.
- Cosmetic hiding: a CSP-safe constructed stylesheet is injected into every frame. Hidden elements stay hidden across navigation and app restarts.
- Visual element picker: hover anything in the target app, click to hide it. Alt+click hides the parent container. Keep picking until Esc.
- Page scan: detects likely ad slots automatically (ad-like ids, classes, attributes, ad iframes) and hides them with one click.
- Layout adjustment: hiding an ad often leaves an empty panel behind. Click **Adjust layout**, select the leftover panel, drag its resize handles or use Fill width / Fill height / Auto, then Save. Layer order is adjustable too: use Front / Forward / Backward / Back to bring a panel above or below other layers (the editor writes `position` and `z-index` overrides). Layout rules persist with the app and are applied with !important on top of the page CSS.
- Reset appearance: one button in the app toolbar menu, Layout tab or Hidden elements clears every hide rule and layout/layer adjustment for that app and puts the page back the way it was. Network blocking is kept.
- Per-app rules: cosmetic rules, network rules and layout rules are stored per application, with a per-app pause switch and a global master switch.
- Live activity: blocked requests stream into the Activity panel with page context.
- Resident tray app, global picker hotkey (default Ctrl+Shift+E), start with Windows, portable exe build.

## How it works

1. Electron Adblock discovers Electron applications from several sources: Start Menu shortcuts, installed-program registry entries, common install folders, and currently running Electron process trees. Each source is merged and deduplicated by executable path, and apps you add manually are also supported.
2. It starts the chosen app with `--remote-debugging-port=<free local port>` and connects to the browser-level CDP endpoint over a WebSocket.
3. For every page and webview target it injects a content script, enables CDP Fetch interception for the configured ad patterns, and applies the cosmetic stylesheet. Matching requests fail locally instead of loading. If an app hides its windows from the target list, a second engine connects to the app main process through a local Node inspector port and applies the same script/rules/picker to those windows.
4. The picker and page scanner run inside the target page in an injected overlay. Picked selectors are saved by the host and pushed back to every frame.
5. Rules live in a local JSON file. No external service is involved.

## Requirements

- Windows 10 or 11 (discovery, launching and process control are Windows-specific).
- Node.js 20 or newer for development. The packaged portable exe needs no runtime.
- Applications must be launched through Electron Adblock (or expose a debugging port themselves). Normal running instances cannot be attached without that port.

## Quick start

```
cd D:\workspace\electron-adblock
npm install
npm start
```

Visual mock mode without touching real apps:

```
npm run build
node scripts/screenshot.mjs --mock --out _shots/ui.png
```

Portable Windows build:

```
npm run package
```

The exe is written to `release/Electron-Adblock-portable.exe`.

## Using it

1. Click **Add application** and choose an Electron app from the detected list, or browse for its `.exe`.
2. Click **Relaunch under ad blocking** (or **Launch** when it is not running). The app restarts with a local debugging port and becomes attached.
3. Click **Pick element**. Electron Adblock minimizes itself; switch to the target app, hover an ad, and click it. Press Esc when finished.
4. Or click **Scan page** and hide the suggested ad containers with one click.
5. Click **Adjust layout** to fix the space an ad left behind. In the target app, click the panel (container, sidebar, main content), drag a handle to resize it, press Fill width / Fill height / Auto, or use Front / Forward / Backward / Back to change the layer order, then Save. Escape cancels. Manual layout overrides (including `z-index` and `position`) can also be added under the Layout tab.
6. Add custom network domains under Network rules if an ad host is missing.
7. To undo everything for one app, use **Reset appearance**. Toggle blocking globally with the master switch in Settings or from the tray menu.

The global hotkey targets the most recently attached app. Closing the window keeps Electron Adblock in the tray.

## Notes and limitations

- The debugging ports are bound to localhost and only exist while the target app runs: one Chromium DevTools port for normal windows and one Node inspector port for hidden-window support. Both give local processes control over the app while they are open, so treat them with the same care as DevTools. If Electron Adblock is closed, target apps keep the ports until they exit. Use the tray Quit command or close the apps if you care about that.
- Already-running apps only attach if they already expose a debugging endpoint. Otherwise use Relaunch; Electron Adblock closes the app gracefully (window close, then force after a timeout).
- Cross-origin ad iframes are normally stopped by network blocking. Cosmetic hiding works in the frames you can interact with.
- Apps with anti-cheat, integrity checks, or hardened Electron fuses may refuse the debugging/inspect flags; those apps cannot be attached. Blocking ads may violate an application Terms of Service; use this on apps you are allowed to modify on your own machine.
- The first launch of an app through the tool may restart it. Unsaved in-app state can be lost if the app does not handle a normal window close.

## Data

Rules and settings (including layout adjustments) are stored in `adblock-data.json` in the Electron user data folder, usually `%APPDATA%\Electron Adblock\`. Delete that file while the app is closed to reset everything. Icons, rule lists and logs stay local; there is no telemetry.

## Development

```
npm run build        # esbuild bundles main, preload, injected script, renderer
npm run typecheck    # tsc --noEmit
npm test             # build + node:test unit and integration suites
npm run shot -- --mock --out _shots/ui.png   # visual snapshot with mock data
```

Layout:

- `src/main/main.ts` - Electron lifecycle, window, tray, hotkey, IPC wiring.
- `src/main/app-service.ts` - orchestration: discovery, launch, attach, rules, stats, events.
- `src/main/engine/` - CDP client, target sessions, network interception, filter application.
- `src/main/apps/` - Windows discovery, launcher, process and port helpers.
- `src/injected/` - cosmetic stylesheet engine, element picker overlay, layout editor (panel selection, resize handles, presets), selector builder, page scanner.
- `src/renderer/` - dashboard UI.
- `fixture/` and `tests/` - a real Electron test app, a local ad server, and CDP integration tests.

Mock mode (`EAB_MOCK=1`) serves canned apps and events so the UI can be developed without launching other applications.

## Privacy

Electron Adblock never sends data anywhere. It only talks to localhost debugging ports of the apps you attach. All blocklists and rules are local.
