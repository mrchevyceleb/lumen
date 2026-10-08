# Lumen

A local Windows terminal workspace with readable agent conversations, real terminal tabs, an offline code editor, Git controls, and worktrees.

## Start

Download **Lumen-Setup-<version>.exe** from the [latest GitHub release](https://github.com/mrchevyceleb/lumen/releases/latest) and run it on each Windows computer. It installs for your Windows account, adds Start menu and desktop shortcuts, and registers **Open with Lumen**. Choose **Open a workspace** and select your repository, or **Start without a workspace**. Existing Lumen settings and saved chats are retained.

## Automatic updates

Installed Lumen checks GitHub after launch and every six hours, downloads newer stable releases in the background, and installs them when you close the app. **Settings → Updates** shows your version, download status, and **Check for updates**. **Update ready** in the bottom bar or **Restart and update** lets you install sooner. Restarting uses the same unsaved-file and running-session checks as closing normally and saves your chats before exiting. No GitHub login is required. Updates do not sync projects, files, or credentials between computers.

Older portable/manual copies need the Setup installer once to enable updates. Close them before installing. The optional portable build remains available for development, but does not update itself.

Open a new session with **+** in the chat header or beside a project. Choose Terminal, Pi, Codex, Claude Code, or Grok. Each chat has its own process and working folder. Double-click a chat name to rename it or pick its color.

Chats appear vertically beneath their projects by default, with workspace-free chats grouped under **No workspace**. Collapse a project's chats using its chevron. Choose **Settings → Workspace → Chat layout → Horizontal tabs** for the tab row, or use the layout button beside **Projects** or **+** in the chat header to switch instantly. Your choice and project collapse state are saved. Switching layouts preserves running sessions, history, queues, and drafts. Hiding the sidebar temporarily shows horizontal tabs so chats remain accessible. Slimmer headers and a wider conversation column leave more room for your work; the separate compact-message setting is still available.

The project list in the left sidebar has no fixed project limit. Add repositories with its **+**, click a project to return to its chats, and use its options to pin, rename, reorder, or **Remove project**. Removal hides the project from the sidebar across restarts. Files and chats stay available, and running sessions continue. Reopen the folder with **+** or **Ctrl O** to bring back its chats and saved name/pin. You can also drag the grips to reorder projects. Search appears when the list grows. Each project shows its own chat tabs; switching keeps other projects' processes, conversations, and unsaved editors open. Projects and their organization restore on restart.

On Windows, run `scripts/install-context-menu.ps1` after packaging to install a stable copy under `%LOCALAPPDATA%\Programs\Lumen` and add **Open with Lumen** for files, folders, folder backgrounds, and drives. It uses only your user registry and requires no administrator permissions. Windows 11 may show it under **Show more options**. Folders open a native terminal at that exact location, including subfolders within repositories. Files open a terminal in their parent folder and also open supported text in the editor. A running Lumen receives new tabs without interrupting existing work. Run `scripts/remove-context-menu.ps1` to remove just those entries. You can also launch `Lumen.exe --open "C:\path\to\folder-or-file"`.

You can also choose **Start without a workspace** on the welcome screen or **+ → New chat without workspace** from an existing repository. These chats run in their own persistent scratch folder under Lumen's local user-data directory. Terminal commands and all four agents work there without selecting a repository. Files and Git become available when you open a workspace. Scratch chats, their transcripts, and their agent resume references restore on restart.

## Two ways to work

- **Readable view** renders agent event streams as spacious Markdown, message bubbles, and expandable tool activity. Shell commands appear as separate command/output blocks. The shell retains variables and directory changes between commands.
- **Native CLI** opens a complete terminal with ANSI colors, keyboard input, interactive prompts, and full-screen programs. Shells use the same persistent PTY in both views. Codex uses one authenticated loopback app-server and thread; Pi keeps its native CLI and a local extension bridge. Claude and Grok wait for active work before handing off the saved conversation. When returning from their native CLI, its terminal stays accessible until you exit it; Readable then reconnects to that same conversation.

The readable composer starts with one line and grows for multiline or wrapped prompts, then scrolls once it reaches its height limit. Model, effort, planning, slash-command, attachment, MCP, and auto-compact controls share one compact toolbar. The cable icon opens **MCPs & context**. Agent and account remain visible in the chat header. **Enter** sends and **Shift Enter** adds a line; change this in Settings to send with **Ctrl Enter**. Send and Stop stay beside the text box while an agent works, and follow-up messages still queue by default.

Switching agents creates an independent session in the same repository. Their conversations and permissions remain specific to each CLI. Lumen uses the CLI's configured account and model; it doesn't require a separate AI subscription or API key. Configure executable paths, models, extra arguments, and agent colors in **Settings → Agents**. New configuration applies to new tabs.

**Settings → Accounts** saves multiple Claude Code and OpenAI/Codex logins on this computer. Name an account and choose **Add & sign in** to complete the CLI's normal browser login, or **Save current CLI login** to keep your current file-based login as a named account. Set a default for new chats or choose **Start chat** on any saved account. The account picker appears beside Native CLI/Readable view; choosing another account opens a fresh chat in the same workspace. Existing chats retain their account after restart, including when you change the default. **CLI default** continues to use your normal terminal login.

Named logins use separate native configuration folders and do not replace your normal CLI login. Codex uses file-based credentials in each account's `CODEX_HOME`; Claude uses an account-specific configuration source and private per-chat MCP preferences, with refreshed credentials synchronized among that account's chats. Named accounts use direct Claude/OpenAI authentication rather than inherited API-key, proxy, or federation environment overrides. Both readable and native views, model/command discovery, and browser login use the selected account. Installed skills/plugins remain available. Close an account's chats before signing in again or removing its login; removing the login retains local chat files. OS-keyring-only credentials must be signed in again rather than imported. Logins are local and must be added separately on another computer.

Claude and Grok **CLI default** chats synchronize their saved login with your normal terminal configuration. A fresh sign-in replaces stale chat credentials, and a refresh from the same login is shared with other default chats. Per-chat MCP choices remain separate. New terminal logins and logouts take precedence over old chat credentials. Codex uses the selected account's native credential store directly; Pi uses its normal shared provider credentials.

Authentication errors in **Claude, Codex, Grok, and Pi** offer **Sign in** inside Lumen. You can also choose **Sign in to this account…** in any agent chat's account picker, or use **Settings → Accounts**. Claude, Codex, and Grok run their native browser sign-in in an embedded terminal; paste any requested code there. Pi opens its native terminal: click **Choose provider** to open `/login`, then choose the provider for your model and complete OAuth or save its API key. **Done** appears after the native login succeeds; a cancelled or failed login never reports success. Default sign-in updates your normal terminal login, too. Finish that account's running turns and switch its native terminals to readable view before signing in. Idle chats keep their transcript, draft, and resume reference, and reconnect on their next turn. Retry your message yourself; Lumen does not automatically replay it or resume a paused queue.

Pi uses a native CLI extension bridge, Codex uses its shared app-server, Claude Code uses stream JSON, and Grok uses ACP. Agents run locally with your Windows account’s access. Readable supports common questions, Codex/Claude/Grok planning, MCP elicitation forms, and ACP tool terminals. Pi custom widgets and unfamiliar requests expose actionable native controls. Windows administrator access remains an explicit restart option below.

Claude launches with `--dangerously-skip-permissions` and its shell sandbox disabled. Codex uses `danger-full-access` with no approval prompts; Grok uses permission bypass and `--sandbox off`. Outside plan mode, Lumen approves native tool callbacks automatically. These agents can access files, shell commands, processes, and the network with your Windows account's permissions. Agent questions and plan approvals remain interactive.

Grok may run stop hooks after its reply appears. When its text stream pauses, Lumen shows **Waiting for Grok to finish…**. The next message becomes available when its native prompt completes, preserving CLI history and preventing overlapping operations. Active tool calls continue to show working status.

## Administrator mode

Choose **Run as administrator** in the bottom bar, or **Settings → Workspace → Restart as administrator**. Accept the Windows UAC prompt to restart Lumen with administrator access for all agents and terminals. Save edited files first; Lumen asks before stopping active agents or native terminals. Your chats, settings, queues, and CLI session references restore, and you continue agents by sending your next message. Cancelling the UAC prompt keeps the current window and sessions running. The bottom bar shows **Administrator** when elevation is active. Close Lumen and launch it normally to return to standard access. Administrator mode is optional and does not run any commands automatically.

## Session MCPs and auto-compaction

Open **MCPs & context** below the composer, or send **/mcp**, to see the current chat's MCP servers, connection status, source, and tool counts. Switch access off or on for that chat. These choices persist with the tab. Other Lumen chats and your CLI settings keep their own choices. **Use CLI MCP defaults** or **/mcp reset** clears the chat's overrides, including when a saved server is unavailable. Finish a running turn before changing access. Existing tool results and recorded tool definitions remain in conversation history until compaction.

The panel refreshes while servers are connecting and when you return from authorization. In Claude chats, use a server's **Reconnect** button or **Reconnect unavailable** to retry failed connections without turning on disabled MCPs or changing the conversation. Connection errors stay visible. **Authorize** opens Claude's connector settings for cloud connectors, or the same chat's native MCP controls for local OAuth. Reconnect afterward. If Claude's session token was rejected, sign in to Claude again using the offered account sign-in action. You can also open native MCP controls from the panel for other CLI-specific recovery. These actions report the CLI's actual result; reconnecting cannot authorize an account on your behalf.

Claude and Grok keep MCP preferences in private per-chat configuration folders; account credentials and installed plugins remain available. Pi’s MCP manager uses its native widgets: open **/mcp** in its terminal. Codex reconnects the same thread to apply MCP or compaction changes; finish background terminals and exit its native TUI first. Unsupported controls show their actual limitations.

**/autocompact 160000** (or **/autocompact 160k**) sets that chat's token threshold across all four agents. Bare **/autocompact** opens the controls. **/autocompact auto**, **default**, or **off** removes Lumen's override and restores the CLI's normal automatic compaction; it does not disable its context-limit protection. These Lumen commands run locally in readable view and never become model prompts.

Claude uses its native `--autocompact` window (100k–1M tokens). Codex uses its native total-context token limit. Pi and Grok compact at safe completed-run boundaries and continue the same conversation; their native safeguards still protect long running turns. Pi may defer a compaction if its history is too small to summarize. Small thresholds cannot shrink a fixed system prompt or retained history below the chosen count; Lumen prevents repeated compaction loops without fresh context growth. Use current versions of the CLIs for these controls.

## Discover commands

Type **/** at the start of an agent message, or click the **/** button in the composer. Lumen asks your installed CLI for the commands loaded in that working folder, including personal, project, extension, and plugin resources. Filter by command name or description, use **↑ / ↓** to navigate, and **Tab / Enter** to insert. Add arguments, then send. **Escape** dismisses the menu. The refresh button scans again after you add a command or skill. Discovery sends no model prompt and works in scratch chats too.

Pi returns extensions, prompt templates, and skills through `get_commands`; an existing Pi conversation is queried directly. Claude returns its supported commands through its initialization protocol. Grok returns its commands through ACP. Codex returns its enabled skills through `skills/list`; selecting one inserts its native **$skill-name** syntax, and typing **$** also opens the menu. The menu displays descriptions, argument hints, and available source/scope metadata. Project resources follow the CLI's existing folder-trust settings; if the CLI requires trust first, grant it in native view and refresh the menu.

Grok shell commands with terminal-only output are marked **Native view**. Sending one opens the terminal in the same tab and displays a copyable command draft; paste it when the CLI is ready. Skills and workflows remain in readable view. Use **Native commands** in the menu for additional interactive commands, including Pi's TUI settings and Codex's built-in terminal menus. Those interfaces do not expose their built-in TUI inventory through the discovery APIs. Custom agent flags apply to discovery as well; if they aren't compatible with that CLI's discovery mode, the menu shows the error and lets you refresh or use native view.

## Models, effort, and planning

While an agent is working, write another message and press **Enter** or **Queue**. It waits above the composer and sends as a separate turn when the current turn finishes. Click **Steer** on a queued message to send it into the active run at the CLI's next supported boundary. You can edit or remove messages before they send. Stopping a run, a failed steering request, or restoring saved messages pauses the queue; choose **Resume queue** to continue. Messages remain with their own chat when you switch projects or tabs. Run slash commands after the current turn finishes.

Steering uses native Pi RPC `steer`, Codex app-server `turn/steer` with its current turn ID, Grok ACP interjections, and Claude Code's persistent streaming user input. It leaves running tools alive. A CLI may finish before it accepts a correction; failed requests keep the message queued and pause automatic delivery so you can decide what to do next.

Every agent chat shows **Context** beside its account/view controls: the latest CLI-reported token count, context capacity, and percentage when available. It updates at the CLI's message and turn boundaries and follows each chat independently. Unknown usage or capacity stays unknown; Lumen does not substitute cumulative session totals or invent limits. In native view, after native activity, or after restoring a saved chat, an existing count is labeled **Last context** until a fresh CLI report arrives. Grok's native context report may itself be an estimate.

Use the model, effort, and mode pickers in the composer toolbar. Models come from your installed CLI: Pi's authenticated model registry, Codex's paginated model catalog, Claude's initialization metadata, and Grok's ACP session configuration. Effort choices follow the selected model's native capabilities. Changes apply to the current chat without sending a message or losing its history or draft, and restore with that tab on restart.

Pi changes its running RPC session directly. **Ctrl L** opens models, **Ctrl P** cycles forward, and **Shift Tab** cycles thinking. Lumen reads your Pi keybinding overrides; on this machine **Ctrl Alt P** cycles backward. Scoped models from Pi's settings or `--models` appear as favorites and retain their order and per-model thinking levels. When no scope is configured, Pi cycles its full available catalog. The bundled Lumen extension supplies scope metadata and backward cycling; it does not write Pi's global settings. Manage the scope using Pi's native `/models` UI or Lumen's advanced `--models` arguments.

Claude's **Alt P** opens models, **Alt T** opens effort, and **Shift Tab** opens planning controls in readable view. **Ctrl Alt M** and **Ctrl Alt R** open the model and effort pickers for any agent. Bare `/model`, `/thinking`, and `/effort` open those controls. **Ctrl Shift P** opens planning controls, unless your Pi binding assigns it to another model action.

Claude, Grok, and Codex planning are available directly in Readable. Choose **Full access** to return to execution. Pi’s installed **/plan** command and other custom interfaces open its existing terminal. Native views keep the CLI’s keyboard shortcuts; Lumen reserves its zoom shortcuts and **Ctrl Shift F** for scrollback search.

The bottom bar always identifies the active folder or linked worktree and its Git branch, including detached HEAD. It follows the active tab and shell directory changes in readable view or native PowerShell. Projectless chats show **No workspace** until a shell navigates to another folder.

## Cancellation, images, and recovery

**Stop** requests provider cancellation or shell Ctrl+C and pauses the queue. If cancellation has not completed after ten seconds, **Force stop** becomes available separately. Closing a chat or confirming an application restart also ends its processes.

PowerShell profiles load by default, including aliases, wrapper functions, and environment settings. Profile output stays separate from agent protocol output, and selected-account credential filtering runs afterward. Disable **Load PowerShell profiles** in Workspace settings while troubleshooting startup.

Paste a clipboard image, choose PNG/JPEG/WebP files with the attachment button, or drop them onto the composer. Preview and remove attachments before sending. Images travel with drafts, queued messages, and steering; Lumen sends real image content and checks model support before submission. Images are stored in Lumen’s local app data, with a 20 MB total limit per message.

**Restore sessions on launch** is enabled by default. The main process journals transcripts and input state and writes atomic snapshots with a backup. After an abrupt exit, update, or administrator restart, Lumen restores tabs, the selected view, conversation IDs, account binding, cwd, settings, drafts, images, and queues. Agents reconnect and wait for your next action; interrupted turns offer **Continue**. Queues stay paused. Uncertain delivery is checked against available provider history and is never automatically resent.

Missing accounts, folders, or provider session files leave a retained chat with a recovery error and retry action. Lumen never replaces a failed resume with a fresh conversation. Reboots restore agent history, not destroyed shell processes or shell variables. Recovery starts when Lumen opens; Windows startup registration is separate.

## Files and Git

The left sidebar contains projects and their chats. Collapse it with the arrow in its Projects heading or the projects icon on the left rail; that icon also brings it back. Chats fall back to horizontal tabs while the sidebar is hidden. The file explorer lives in an independent right panel, hidden by default. Use the panel icon in the top-right title bar to show or hide it, or close it from its heading. Source control opens in the same right panel. Both panels remember their visibility and width across restarts and can be resized by dragging their inside edge or using the focused separator's arrow keys.

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

Your theme, recent workspaces, tabs, selected views, transcripts, drafts, attachments, and CLI resume references are stored locally in Lumen's user-data directory. With **Restore sessions on launch** enabled, saved tabs return in their selected view, agent conversations reconnect, and interrupted work waits for your next action. Shell tabs reopen with their saved working directory; previous shell processes and in-memory variables cannot survive an application restart or reboot. Changing views preserves the live shell, and stopping a shell command sends Ctrl+C without replacing its PTY. Unsaved editor changes are not persisted. Readable transcripts stay local, while agent prompts are sent by the chosen CLI to its configured provider, as usual.

## Embedded Chromium browser

Click the **globe** in the left rail or title bar, or press **Ctrl Shift B**, to open a resizable browser beside your chat and editor. Enter `localhost:3000`, `localhost:5173`, or any HTTP/HTTPS website. Use tabs, Back/Forward, Reload, **Ctrl L** for the address, and **F12** or **DevTools** to inspect the page. Navigation stays inside Chromium, so live websites can load even when they disallow iframe embedding. Start your project's dev server in a Lumen terminal before opening its localhost address.

Browser tabs and the selected tab are saved separately for each working folder, including worktrees. Hiding the browser preserves its pages; closing a tab releases its renderer. Website cookies and logins use a persistent Lumen browser profile shared by these tabs, separate from your system browser and coding-agent accounts. Login popups open in Chromium windows. Websites run in a sandbox with no Node.js or Lumen API access; normal HTTPS certificate checks apply. Camera, microphone, location, and notification permissions are currently disabled.

Web and server links in chat, code blocks, and terminal output open in Lumen's browser by default. **Ctrl-click** (or Command-click on macOS) opens your main browser. Right-click a link to choose **Open in main browser**, **Open in Lumen browser**, or **Copy link address**. Local file links still open in the editor.

**Attach to chat** adds a screenshot, URL, and page text to your current readable agent chat's draft. Review or edit it, then send it normally. Local agents can also navigate, inspect, interact with, and screenshot browser tabs through the authenticated browser API described in the [agent guide](electron/agent-control-guide.md).

## Local agent control

Use **Settings → Agent control → Copy instructions for an agent** to let another AI start and manage visible coding tasks in Lumen. A dependency-free `lumen-agent.cjs` helper supports create, list, get/watch, continue, queue/steer, stop/resume, model configuration, rename, focus, answer, and close. Any installed provider or a shell can be selected, with a workspace or without one. Existing chats are available too. Agent-created chats have a badge, and management actions leave visible notices.

The API is on by default, stays on loopback, requires a private per-launch token, and rejects browser origins. Turn it off in Settings to disconnect clients while chats keep running. The helper discovers `%APPDATA%\Lumen\agent-control.json`, or a copied connection path/`LUMEN_CONTROL_FILE` for portable profiles. Lumen agents inherit the connection path. Task IDs persist with saved chats; messages queue by default. See the [full CLI and HTTP guide](electron/agent-control-guide.md) for retry-safe IDs, output monitoring, and PowerShell examples that don't require Node.js.

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
