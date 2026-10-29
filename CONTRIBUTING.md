# Contributing to Electron Adblock

Thanks for helping out. This project is a Windows Electron app written in TypeScript with a vanilla renderer.

## Before you start

- Search existing issues first.
- For larger changes, open an issue to discuss the approach before writing a lot of code.
- Security issues go through [SECURITY.md](SECURITY.md), not public issues.

## Development setup

Requirements: Windows 10/11, Node.js 20+ and npm.

```bash
git clone https://github.com/terri-yaki/electron-adblock.git
cd electron-adblock
npm install
npm start
```

Useful commands:

```bash
npm run build        # bundle everything with esbuild
npm run typecheck    # tsc --noEmit
npm run test:unit    # unit tests only, no GUI
npm test             # build + unit + Electron fixture integration tests
npm run package      # portable Windows build
```

Integration tests launch a real Electron fixture app and a local fake ad server. Run them on a desktop session, not from a bare CI container.

## Code style

- TypeScript strict mode; keep comments short and useful.
- No frameworks in the renderer; plain TypeScript and CSS.
- No emojis in code, comments or UI strings.
- Prefer small, focused modules and keep the IPC contract in `src/shared/types.ts` in sync when adding features.
- Do not add telemetry, remote logging or network calls that are not localhost debugging.

## Pull requests

1. Fork the repository and create a topic branch.
2. Add or update tests when behaviour changes.
3. Run `npm run typecheck` and `npm test` (or at least `npm run test:unit`) and make sure they pass.
4. Describe the change, how you tested it, and any screenshots for UI work.
5. Keep pull requests focused; split unrelated refactors.

## Reporting bugs

Include the Windows version, target app name and version, what you expected, what happened, and whether the target app was launched through Electron Adblock. Attach relevant Activity panel excerpts if possible. Never attach private data or tokens.