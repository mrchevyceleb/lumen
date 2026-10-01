# Lumen

A local Windows terminal workspace with readable agent conversations, real terminal tabs, an offline code editor, Git controls, and worktrees.

## Start

Download **Lumen-Setup-<version>.exe** from the [latest GitHub release](https://github.com/mrchevyceleb/lumen/releases/latest) and run it on each Windows computer. It installs for your Windows account, adds Start menu and desktop shortcuts, and registers **Open with Lumen**. Choose **Open a workspace** and select your repository, or **Start without a workspace**. Existing Lumen settings and saved chats are retained.

## Automatic updates

Installed Lumen checks GitHub after launch and every six hours, downloads newer stable releases in the background, and installs them when you close the app. **Settings → Updates** shows your version, download status, and **Check for updates**. **Update ready** in the bottom bar or **Restart and update** lets you install sooner. Restarting uses the same unsaved-file and running-session checks as closing normally and saves your chats before exiting. No GitHub login is required. Updates do not sync projects, files, or credentials between computers.

Older portable/manual copies need the Setup installer once to enable updates. Close them before installing. The optional portable build remains available for development, but does not update itself.

Open a new session with the **+** beside the tabs. Choose Terminal, Pi, Codex, Claude Code, or Grok. Each tab has its own process and working folder. Double-click a tab to rename it or pick its color.

The project list in the left sidebar has no fixed project limit. Add repositories with its **+**, click a project to return to its chats, and use its options to pin, rename, reorder, or **Remove project**. Removal hides the project from the sidebar across restarts. Files and chats stay available, and running sessions continue. Reopen the folder with **+** or **Ctrl O** to bring back its chats and saved name/pin. You can also drag the grips to reorder projects. Search appears when the list grows. Each project shows its own chat tabs; switching keeps other projects' processes, conversations, and unsaved editors open. Projects and their organization restore on restart.

On Windows, run `scripts/install-context-menu.ps1` after packaging to install a stable copy under `%LOCALAPPDATA%\Programs\Lumen` and add **Open with Lumen** for files, folders, folder backgrounds, and drives. It uses only your user registry and requires no administrator permissions. Windows 11 may show it under **Show more options**. Folders open a native terminal at that exact location, including subfolders within repositories. Files open a terminal in their parent folder and also open supported text in the editor. A running Lumen receives new tabs without interrupting existing work. Run `scripts/remove-context-menu.ps1` to remove just those entries. You can also launch `Lumen.exe --open "C:\path\to\folder-or-file"`.

You can also choose **Start without a workspace** on the welcome screen or **+ → New chat without workspace** from an existing repository. These chats run in their own persistent scratch folder under Lumen's local user-data directory. Terminal commands and all four agents work there without selecting a repository. Files and Git become available when you open a workspace. Scratch chats, their transcripts, and their agent resume references restore on restart.

## Two ways to work

- **Readable view** renders agent event streams as spacious Markdown, message bubbles, and expandable tool activity. Shell commands appear as separate command/output blocks. The shell retains variables and directory changes between commands.
- **Native CLI** opens a complete terminal with ANSI colors, keyboard input, interactive prompts, and full-screen programs. It supports the normal CLI experience, including login, slash commands, and permissions. Changing views transfers the tab's process ownership. When opened from an existing rich agent conversation, it resumes that CLI session, and switching back retains the reference. Start a conversation in readable view when you want this continuity; a session first started in native view has no structured resume reference.

Switching agents creates an independent session in the same repository. Their conversations and permissions remain specific to each CLI. Lumen uses the CLI's configured account and model; it doesn't require a separate AI subscription or API key. Configure executable paths, models, extra arguments, and agent colors in **Settings → Agents**. New configuration applies to new tabs.

Pi uses RPC mode; Codex uses JSON events; Claude Code and Grok use streaming message events. Pi extension questions are displayed in the app. If another CLI needs an interactive approval or a TUI-only feature, use its Native CLI tab. Codex rich mode starts with workspace-write sandboxing and noninteractive approval behavior; it does not enable the CLI's bypass flag. Claude and Grok retain their configured permission behavior.

Grok may run stop hooks after its reply appears. When its text stream pauses, Lumen shows **Waiting for Grok to finish…**; after an explicit end-of-turn signal, it shows **Finishing Grok CLI…**. The next message becomes available when that process closes, preserving CLI history and preventing overlapping operations. Active tool calls continue to show working status.

## Discover commands

Type **/** at the start of an agent message, or click the **/** button in the composer. Lumen asks your installed CLI for the commands loaded in that working folder, including personal, project, extension, and plugin resources. Filter by command name or description, use **↑ / ↓** to navigate, and **Tab / Enter** to insert. Add arguments, then send. **Escape** dismisses the menu. The refresh button scans again after you add a command or skill. Discovery sends no model prompt and works in scratch chats too.

Pi returns extensions, prompt templates, and skills through `get_commands`; an existing Pi conversation is queried directly. Claude returns its supported commands through its initialization protocol. Grok returns its commands through ACP. Codex returns its enabled skills through `skills/list`; selecting one inserts its native **$skill-name** syntax, and typing **$** also opens the menu. The menu displays descriptions, argument hints, and available source/scope metadata. Project resources follow the CLI's existing folder-trust settings; if the CLI requires trust first, grant it in native view and refresh the menu.

Grok shell commands with terminal-only output are marked **Native view**. Sending one opens the terminal in the same tab and displays a copyable command draft; paste it when the CLI is ready. Skills and workflows remain in readable view. Use **Native commands** in the menu for additional interactive commands, including Pi's TUI settings and Codex's built-in terminal menus. Those interfaces do not expose their built-in TUI inventory through the discovery APIs. Custom agent flags apply to discovery as well; if they aren't compatible with that CLI's discovery mode, the menu shows the error and lets you refresh or use native view.

## Models, effort, and planning

Use the model, effort, and mode pickers below the composer. Models come from your installed CLI: Pi's authenticated model registry, Codex's paginated model catalog, Claude's initialization metadata, and Grok's ACP session configuration. Effort choices follow the selected model's native capabilities. Changes apply to the current chat without sending a message or losing its history or draft, and restore with that tab on restart.

Pi changes its running RPC session directly. **Ctrl L** opens models, **Ctrl P** cycles forward, and **Shift Tab** cycles thinking. Lumen reads your Pi keybinding overrides; on this machine **Ctrl Alt P** cycles backward. Scoped models from Pi's settings or `--models` appear as favorites and retain their order and per-model thinking levels. When no scope is configured, Pi cycles its full available catalog. The bundled Lumen extension supplies scope metadata and backward cycling; it does not write Pi's global settings. Manage the scope using Pi's native `/models` UI or Lumen's advanced `--models` arguments.

Claude's **Alt P** opens models, **Alt T** opens effort, and **Shift Tab** opens planning controls in readable view. **Ctrl Alt M** and **Ctrl Alt R** open the model and effort pickers for any agent. Bare `/model`, `/thinking`, and `/effort` open those controls. **Ctrl Shift P** opens planning controls, unless your Pi binding assigns it to another model action.

Claude and Grok use their native plan permission mode; select Default to return to normal permission prompts. Pi's planning action inserts your installed `/plan` command into the draft for you to send. Codex's planning action opens native view with a copyable `/plan` draft, because this release's `codex exec` transport does not expose native plan mode. Native view keeps the CLI's keyboard shortcuts. Lumen reserves its UI zoom shortcuts and **Ctrl Shift F** for wrapper scrollback search.

The bottom bar always identifies the active folder or linked worktree and its Git branch, including detached HEAD. It follows the active tab and shell directory changes in readable view or native PowerShell. Projectless chats show **No workspace** until a shell navigates to another folder.

## Files and Git

Click files in the explorer to view or edit them beside the conversation. Save with **Ctrl S**. The editor checks for changes on disk before saving and asks you to reload rather than overwriting a newer version. Closing unsaved files or the app prompts before discarding edits. Text files up to 2 MB are supported; dependency/build folders are excluded from the explorer.

The Git panel supports individual/all staging and unstaging, readable diffs, commits, fetch, pull, push, and recent history. Pull uses fast-forward only. A first push sets the branch's upstream. The GitHub view lists PRs when the GitHub CLI is installed and signed in, and opens them in your browser. Git remote authentication uses your existing Git configuration.

Open **Worktrees** to create a branch and checkout, or switch to an existing checkout. New worktrees are created beside the repository under `<repository>.worktrees/`. Existing sessions remain in their original checkout. Worktree removal and destructive Git resets are left to the terminal.

## Personalize

Choose Graphite, Midnight, Evergreen, Ember, Lilac, or Paper. Adjust canvas, panels, text, borders, code blocks, user bubbles, and accent colors individually. Set per-agent colors or individual tab colors. Change conversation fonts, type size, line spacing, and native terminal text size.

Press **Ctrl +** (or **Ctrl =**) to enlarge the whole UI, **Ctrl -** to shrink it, and **Ctrl 0** to reset. Numpad plus, minus, and zero also work. Zoom changes in 10% steps between 50% and 200%, works in the terminal, editor, and dialogs, and stays saved when you reopen Lumen.

Aurora, Orbital, Rain, **Star field**, and **Nebula** have visible motion and live animated previews in Settings → Backgrounds. Star field slowly drifts through layered stars at different depths. Nebula blends moving violet, rose, and blue gas clouds with distant stars. Cards label these as **Animated**; grid, contours, grain, solid colors, and custom images are **Static**. Backgrounds show behind readable chats and native terminals. You can use your own PNG/JPEG/WebP image up to 5 MB. Adjust background intensity or turn animation off. **Background blur** runs from **0–100**: zero keeps the design sharp; 100 gives maximum softness. It updates the background and previews live, saves across restarts, and keeps text and controls sharp. The app respects the system's reduced-motion preference, which also disables previews. Optional playful details add click sparks and a moving status strip.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl K / Ctrl P | Find files and commands (Ctrl P belongs to Pi in its composer) |
| Ctrl O | Open a workspace |
| Ctrl S | Save the active file |
| Ctrl Shift T | New readable terminal |
| Ctrl Shift N | Worktrees |
| Ctrl , | Settings |
| Ctrl + / Ctrl - / Ctrl 0 | Enlarge / shrink / reset the whole UI |
| Enter / Shift Enter | Send / new line (customizable) |
| / at start of an agent message | Discover CLI commands |
| ↑ / ↓, Tab / Enter, Escape in command menu | Navigate, insert, dismiss |
| Ctrl Alt M / Ctrl Alt R | Model / effort picker |
| Ctrl Shift P in an agent composer | Planning picker |
| Ctrl Shift F in a native terminal | Search terminal scrollback |

Your theme, recent workspaces, readable tabs, transcripts, and CLI resume references are stored locally in Lumen's user-data directory and flushed when the window closes. A known agent conversation returns in readable view on restart even if you closed it in native view. Standalone native terminal tabs are not restored. Native processes and shell variables live for the lifetime of their shell; stopping a readable command or changing views starts a fresh shell. Unsaved editor changes are not persisted. Readable transcripts stay local, while agent prompts are sent by the chosen CLI to its configured provider, as usual.

## Develop

Requires Node.js 22.12+ or 24+, Git, and whichever agent CLIs you want to use.

```powershell
npm install
npm run build
npm start
```

For hot reload, run `npm run dev` in one terminal, then `$env:LUMEN_DEV='1'; npm start` in another. Build the Windows installer with `npm run package`, then run `npm run verify:release` to check its update metadata, checksum, and packaged terminal runtime. `npm run package:portable` produces an optional portable executable. The file editor and its workers are bundled locally; no CDN is needed.

Every push to `main` runs the Windows release workflow. It chooses a version above existing stable release numbers (using the source version as a minimum), builds and verifies the installer, then uploads all assets to a draft before publishing. No personal access token is needed for CI. Build version changes stay on the runner, so releases do not create extra source commits. Failed builds remain unpublished. The repository and releases are public; source is licensed under MIT.

The Windows release is unsigned. SmartScreen may require **More info → Run anyway** on a downloaded copy. Linux/macOS packaging is not included in this release.

Reference protocols: [Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md), [Claude commands](https://code.claude.com/docs/en/agent-sdk/slash-commands), [Grok ACP](https://docs.x.ai/build/cli/headless-scripting). Codex discovery was checked against its locally generated app-server schema and installed CLI.
