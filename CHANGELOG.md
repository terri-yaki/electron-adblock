# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-30

### Added

- CDP-based network ad blocking, cosmetic hiding and visual element picker for Electron apps on Windows.
- Page scanner for likely ad containers.
- Layout adjustment with resize handles, presets and saved layout rules.
- Layer reordering (Front / Forward / Backward / Back, z-index and position overrides).
- Reset appearance per app (hide + layout/layer rules) while keeping network blocking.
- Hidden-window support through a local main-process inspector engine (verified with TFTAcademy / Overwolf runtime).
- Per-app cosmetic, network and layout rules, live blocked-request activity, tray mode, global picker hotkey and start with Windows.
- App discovery from Start Menu, registry, common install folders and running process trees.
- Portable Windows build via electron-builder.

### Security

- All debugging ports bind to localhost only.
- No telemetry, analytics or remote configuration.