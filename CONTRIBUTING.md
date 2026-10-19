# Contributing to Lumen

Thanks for helping. Bug reports, ideas, and pull requests are all welcome. By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## Prerequisites

- Windows 10 or 11, x64. Lumen is a Windows app; the terminal runtime (`node-pty`) and packaging target Windows.
- Node.js 22.12+ or 24+ (CI uses Node 24).
- Git.
- Any agent CLIs you want to test with (Pi, Codex, Claude Code, Grok, Google Antigravity). A plain terminal tab works without any of them.

## Set up and run

```powershell
git clone https://github.com/mrchevyceleb/lumen.git
cd lumen
npm install
npm run build
npm start
```

`npm start` runs Electron against the production build in `dist/`.

### Hot reload

Run the Vite dev server in one terminal:

```powershell
npm run dev
```

Then start Electron pointed at it in another:

```powershell
$env:LUMEN_DEV='1'; npm start
```

Renderer changes in `src/` reload live. Changes to `electron/` need an app restart.

### Useful environment variables

| Variable | Purpose |
| --- | --- |
| `LUMEN_DEV=1` | Load the UI from the Vite dev server at `http://127.0.0.1:5173`. |
| `LUMEN_TEST_DATA=<folder>` | Use a separate user-data folder, so you can test without touching your real settings and chats. |
| `LUMEN_PROMPTS_DIR=<folder>` | Folder of shared slash-command prompts (defaults to `%APPDATA%\Lumen\prompts`). |
| `LUMEN_CONTROL_FILE=<file>` | Connection file the `lumen-agent` helper uses to reach the local agent-control API. |

## Checks

Before opening a pull request, run:

```powershell
npm run lint    # TypeScript type check
npm run build   # type check + production Vite build
```

The same two checks run automatically on every pull request (the **PR build check** workflow on `windows-latest`).

Please keep pull requests focused, and describe what changed and how you tried it in the app. The project does not keep a unit-test suite, so manual verification in a running build matters. For UI changes, a screenshot or short clip helps a lot.

## Packaging

```powershell
npm run package          # builds dist/ and the NSIS installer into release/
npm run verify:release   # checks update metadata, checksum, and the packaged terminal runtime
npm run package:portable # optional portable .exe (does not auto-update)
```

Packaging needs Windows. Builds are unsigned.

## Code layout

| Path | What lives there |
| --- | --- |
| `electron/main.cjs` | Main-process entry: window, IPC handlers, startup and shutdown. |
| `electron/services.cjs` | `WorkspaceService` (files, Git, worktrees) and `Sessions` (terminal and agent processes, protocols, queues). |
| `electron/session-controls.cjs` | Per-agent launch options, runtimes, MCP access, and auto-compaction. |
| `electron/accounts.cjs`, `profile-launcher.cjs` | Saved CLI accounts and PowerShell profile launching. |
| `electron/commands.cjs`, `models.cjs`, `default-models.cjs`, `shared-prompts.cjs` | Slash-command, model, and effort discovery. |
| `electron/google.cjs` | Google Antigravity (`agy`) turns, models, and install. |
| `electron/pi-controls.mjs` | Pi extension bundled with Lumen for readable-view controls. |
| `electron/browser.cjs` | Embedded Chromium browser. |
| `electron/agent-control.cjs`, `lumen-agent.cjs`, `agent-control-guide.md` | Local agent-control API, its CLI helper, and its guide. |
| `electron/recovery.cjs`, `session-history.cjs`, `attachments.cjs` | Session restore, transcript history, and attachments. |
| `electron/updates.cjs`, `administrator.cjs` | Auto-update and restart-as-administrator. |
| `electron/preload.cjs` | The bridge that exposes main-process APIs to the renderer. |
| `src/App.tsx` | The renderer: layout, chats, panels, and most UI state. |
| `src/*.tsx`, `src/*.css` | UI components (conversation, terminal, editor, settings, sidebar) and styles. |
| `src/settings.ts`, `src/types.ts` | Settings defaults, themes, and shared types. |
| `scripts/` | Release version selection, release and install verification, Explorer context-menu install. |
| `.github/workflows/` | PR build check and the Windows release workflow. |

The main process is plain CommonJS (`.cjs`). The renderer is React 19 + TypeScript, bundled by Vite.

## How releases work

**Every push to `main` ships a public release.** The `Windows release` workflow picks the next version (above every existing release, using `package.json` as a minimum), runs `npm ci`, `npm run package`, and `npm run verify:release`, test-installs on a clean runner, uploads to a draft release, and then publishes it. Installed copies download it automatically.

That means:

- Only merge pull requests that are ready for users.
- You do not need to bump the version; CI does it on the runner without committing.
- Changes to `.github/workflows/release.yml`, `scripts/release-version.cjs`, `scripts/verify-release.cjs`, or the `build` section of `package.json` affect every user's updates. Call them out clearly in your pull request.
- Pull requests and other branches only run the PR build check. They never publish.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
