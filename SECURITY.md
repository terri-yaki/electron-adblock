# Security Policy

## Supported versions

The latest release is supported with security fixes. Older builds may be asked to upgrade.

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub private [Security Advisories](https://github.com/terri-yaki/electron-adblock/security/advisories/new) form for this repository. Include:

- affected version and Windows version,
- a description of the issue and impact,
- steps to reproduce,
- any suggested fix if you have one.

You can expect an acknowledgement within a few days. Please give maintainers a reasonable window to fix the issue before public disclosure.

## Security model

Electron Adblock is a local tool. It does not run a remote service, collect telemetry or fetch ad lists from the internet.

To do its job it launches target applications with local debugging ports:

- a Chromium DevTools port (`--remote-debugging-port`) used for normal windows,
- optionally a Node inspector port (`--inspect`) used for applications that hide their windows from the DevTools target list.

Both ports bind to loopback and exist only while the target app is running. Any local process that can reach those ports can control the target app, so treat them like an open DevTools window. Quit Electron Adblock (or the target app) to close them.

Rules and settings are stored locally in `%APPDATA%\Electron Adblock\adblock-data.json`.