# Run visible coding tasks in Lumen

Lumen must be running. Settings → Agent control contains the connection path and a copyable helper command. Local control is on by default. It binds only to 127.0.0.1, requires a random bearer token, and rejects browser origins. Turning it off disconnects clients without stopping chats. Turning it back on or restarting rotates the token and port. Read the connection file for each invocation; never hard-code or share its token.

Installed Windows profiles use `%APPDATA%\Lumen\agent-control.json`. Portable/custom profiles can use a different path: copy it from Settings, pass `--connection FILE`, or set `LUMEN_CONTROL_FILE`. Lumen's child agents inherit that environment variable. The dependency-free helper and this guide are copied into the same directory; Node.js runs the helper.

## From inside a Lumen chat (no setup)

An agent already running in a Lumen chat gets all of this for free. A `lumen` command is on its PATH and already authenticated, and its environment carries `LUMEN_TASK_ID` (its own stable task ID), `LUMEN_CONTROL_FILE`, `LUMEN_AGENT_CLI` and `LUMEN_GUIDE`. So a chat agent orchestrates the others exactly like an outside one, minus the file paths:

```powershell
lumen whoami                 # your own task ID and state
lumen list                   # every open chat, yours included
lumen create --agent claude --root 'C:\repo' --name 'Write the tests' --owner 'Task <your id>' --text '…'
lumen create --agent codex --root 'C:\repo' --worktree agent/login-fix --base main --model MODEL_ID --effort high --name 'Fix login' --owner 'Task <your id>' --text 'Fix the login bug'
lumen watch TASK_ID          # follow it until it finishes or asks a question
lumen send TASK_ID --text 'Correction for the active run'
lumen send TASK_ID --delivery queue --text 'Run the full suite afterward'
lumen steer TASK_ID --text 'Correction for the active run'
lumen guide                  # this guide
```

Set `--owner` to name yourself on tasks you create, so the user can see which agent is managing them. Everything you create or message is a real visible chat. Do not stop or close the user's own chats, and do not message your own task ID.

**`send` steers a running agent by default.** Use `--delivery queue` to wait for its next turn. Gemini and commands that require their own turn remain queued. Check the result and do not discard it. For Codex, `steered: true` means the turn accepted the message; check the transcript for confirmation. If `steerPending` is true, the message is already accepted and will automatically steer after compaction; do not resend it. If `deliveryUncertain` is true, inspect the chat before retrying.

## CLI

```powershell
$lumen = Join-Path $env:APPDATA 'Lumen\lumen-agent.cjs'
node $lumen --help
node $lumen list
node $lumen create --agent claude --root 'C:\repo' --name 'Fix login' --owner 'My orchestrator' --text-file 'C:\tasks\login.txt'
# Read the task's id from the JSON result, then:
node $lumen watch TASK_ID
node $lumen get TASK_ID
node $lumen send TASK_ID --text 'Continue with the next change'
# Or explicitly steer a busy agent:
node $lumen steer TASK_ID --text 'Correction for the active run'
# Or steer a message already in the queue, using the messageId returned by send:
node $lumen steer TASK_ID MESSAGE_ID
node $lumen remove TASK_ID MESSAGE_ID
node $lumen stop TASK_ID
node $lumen resume TASK_ID
node $lumen focus TASK_ID
node $lumen models TASK_ID
node $lumen configure TASK_ID --model MODEL_ID --effort LEVEL --speed default|priority|ultrafast
node $lumen rename TASK_ID --name 'Login repair'
```

Choose `pi`, `codex`, `claude`, `grok`, or `shell`. Omit `--root` for no workspace. `--cwd` must be inside the selected workspace. `--account-id` selects a saved account; omitting it uses the app's default. Empty strings select CLI defaults for model/effort/account. Configure uses the same supported-model validation as the UI. Claude/Grok support `--work-mode plan` or `default`; other agents retain their own planning workflows. Codex models also accept `--speed` with a service tier id from the model catalog (`priority` is Fast, `ultrafast` where offered, `default` is standard speed); tasks report it as `serviceTier`.

For an isolated job, add `--worktree BRANCH` to `create` together with `--root`. Lumen creates that branch in the repository's dedicated `<repository>.worktrees/` folder and starts the agent there, while keeping the chat inside the source project. Omit `--cwd` for a worktree job; it always starts at the new worktree root. `--base REF` chooses its starting commit and defaults to `HEAD`. After a job creates its worktree, retrying with the same task ID reuses it. A different task ID cannot silently join an existing branch or worktree; choose a new branch for each new job. Model and effort may be chosen per job; omitted values use the defaults under **Settings → Agents**. Use `models TASK_ID` to inspect the installed CLI's real model and effort catalog, or `configure` to change them while the task is idle.

Worktree creation is serialized and journaled by Lumen's main process before Git is changed. The journal records the task ID, repository identity, exact starting commit, branch, and destination. Lumen creates a detached worktree first and then attaches its branch, so an interrupted create cannot leave an ambiguous branch-only state. Retry the same ID after an interruption. Recovery uses the recorded commit even if the original base ref has moved or been deleted. A branch without its original worktree is never attached automatically, and a failure that provably changed nothing releases its reservation.

Task IDs are stable across normal app restarts. List includes all open chats, including ones created by a human. Native chats can be inspected or focused, but must return to readable view in the app before sending prompts or changing controls. Shell commands retain their PowerShell process and must finish before another is sent. Closing requires an idle readable chat with an empty queue. Closing removes that tab just as closing it in the UI does; saved files and native CLI history remain.

Create, send, and direct steer (`steer --text`) accept `--id UUID` for retry safety. Save your chosen UUID before sending a request. Retrying a create with the same open task ID returns that task and does not resend an initial prompt already in its transcript or queue. If initial submission fails before acceptance, create returns the opened task with `deliveryError`; retry with the same ID and text to submit the missing prompt. Retrying a send or direct steer with a retained transcript/queue message ID returns the previous message without duplicating it; a still-queued direct steer retries steering. A timeout is an uncertain result: read/list before retrying. IDs of closed tasks or messages outside the saved transcript are not retained forever.

Watch prints JSON snapshots only when the transcript or status changes. It exits at idle, a paused queue, failure, or an input request; default timeout is 600 seconds. A watch timeout leaves the task running. Inspect `status`, `exitCode`, `pendingRequests`, and `queuePaused` to choose the next action. Agent questions and plan approval are also visible in Lumen. To answer through the API, provide the same native response shape that the dialog sends (`value`, `confirmed`, `answers` with optional `answerLists`/`notes`, or `cancelled: true` as appropriate):

```powershell
node $lumen answer TASK_ID REQUEST_ID --response '{"confirmed":true}'
```

For `questions`, answer every question using its exact ID from `pendingRequests`; empty/missing/unknown answers are rejected. Optional `answerLists` supports multi-select questions and allows only one answer for a single-select question. Custom written answers are allowed, just as in the app. Use `{ "cancelled": true }` to decline rather than sending incomplete answers.

## HTTP API (PowerShell requires no Node.js)

```powershell
$connection = Get-Content (Join-Path $env:APPDATA 'Lumen\agent-control.json') -Raw | ConvertFrom-Json
$headers = @{ Authorization = 'Bearer ' + $connection.token }
Invoke-RestMethod ($connection.url + '/v1/tasks') -Headers $headers
$body = @{ id = [guid]::NewGuid().ToString(); agent = 'codex'; name = 'Fix login'; root = 'C:\repo'; text = 'Find and fix the login bug' } | ConvertTo-Json
$task = Invoke-RestMethod ($connection.url + '/v1/tasks') -Method Post -Headers $headers -ContentType 'application/json' -Body $body
Invoke-RestMethod ($connection.url + '/v1/tasks/' + $task.id) -Headers $headers
```

Every request requires `Authorization: Bearer TOKEN`. POST requests require JSON objects with `Content-Type: application/json`. Successful responses are JSON. Errors return `{ "error": "..." }` with a non-2xx HTTP status. Lumen returns 503 while restoring chats, 409 for a busy/incompatible task, 404 for closed/missing tasks, 504 for an uncertain operation timeout. Model/provider errors stay visible in the transcript. Queue and steer use native adapters for each CLI. Accepted steering returns `steered: true` and leaves the queue immediately; a native turn-boundary rejection returns `steered: false` with a reason and keeps the message queued for automatic next-turn delivery. Only an uncertain transport failure pauses the queue for inspection. Gemini supports queued follow-ups but not live steering: a busy-task `steer` request is rejected without changing its queue or delivery state. Once idle, `steer` sends the selected queued message next.

| Method / route | Body / result |
| --- | --- |
| GET /v1 | Protocol version, capabilities, ready |
| GET /v1/tasks | `{ tasks: [...] }` with metadata, queues, context usage, pending questions |
| POST /v1/tasks | `id?`, `agent?`, `root?`, `cwd?`, `worktree?`, `base?`, `name?`, `owner?`, `accountId?`, `model?`, `effort?`, `workMode?`, `serviceTier?`, `text?`; returns visible task |
| GET /v1/tasks/ID | Metadata plus the last 200 visible messages (up to 80,000 characters each); `transcriptLimited` reports truncation |
| POST /v1/tasks/ID/messages | `{ id?: UUID, text: string, senderId?: UUID, delivery?: "queue" or "steer" }`; returns `messageId`, queue and current task. The CLI automatically supplies its originating chat as `senderId`; callers using HTTP can supply it too. Omit `delivery` to steer a running supported agent; use `delivery: "queue"` to wait for the next turn, or `delivery: "steer"` to explicitly request steering. |
| POST /v1/tasks/ID/queue | `{ messageId: UUID, action: "steer" or "remove" }` |
| POST /v1/tasks/ID/resume | `{}`; resumes a paused queue |
| POST /v1/tasks/ID/stop | `{}`; stops the turn and pauses its queue |
| POST /v1/tasks/ID/focus | `{}`; selects the task in the app |
| POST /v1/tasks/ID/rename | `{ name: string }` |
| GET /v1/tasks/ID/models | Installed CLI's model catalog and effort options |
| POST /v1/tasks/ID/configure | `model?`, `effort?`, `workMode?`, `serviceTier?`; requires idle readable view |
| POST /v1/tasks/ID/answer | `{ requestId: string, response: object }` |
| POST /v1/tasks/ID/close | `{}`; requires idle readable view and empty queue |

All prompts, streamed responses, and tool activity use the regular chat UI. Agent-created tabs show an Agent control badge; management actions leave visible notices. Creating a task leaves your current selected chat alone. Focus explicitly to select it. No CLI login tokens are exposed by this interface; it uses the app's existing accounts and permissions. The local connection token grants access to coding tasks on this computer, so give it only to agents you intend to use.

## Browser previews and interactions

The embedded Chromium browser uses the same authenticated loopback connection. Each chat owns its browser tabs and panel state. `GET /v1/browser` lists tabs grouped by chat; `POST /v1/browser` accepts `{ action, id?, chatId?, url?, script?, view?, marks? }`. Actions: `list`, `open`, `navigate`, `select`, `close`, `back`, `forward`, `reload`, `stop`, `devtools`, `inspect`, `screenshot`, `screenshot-markup`, `view`, and `evaluate`. Use the browser tab ID for tab actions, not a coding task ID. For `open`, pass the owning chat's stable ID as `chatId`; omitting it uses the currently selected chat. Navigation returns immediately: poll `list` until `loading` is false and check `error` before inspecting. Creating a browser tab does not switch chats or reveal a hidden browser panel. `view` switches a tab between `{ mode: "desktop" }` and `{ mode: "mobile", device: "iphone" | "pixel" | "ipad", orientation: "portrait" | "landscape" }` (a real device viewport and mobile user agent; each tab remembers its view). `screenshot-markup` takes `{ marks: [{ label, x, y, color? }] }` with `x`/`y` normalized 0-1 across the screenshot and returns a PNG data URL with numbered callout pins drawn on; the pane's **Mark up** button does the same thing from the UI and attaches the result to the chat draft.

```powershell
node $lumen browser list
node $lumen browser open --chat-id TASK_ID --url 'http://localhost:3000'
node $lumen browser inspect TAB_ID
node $lumen browser screenshot TAB_ID --output 'C:\temp\preview.png'
node $lumen browser navigate TAB_ID --url 'https://example.com'
node $lumen browser evaluate TAB_ID --script-file 'C:\temp\interaction.js'
```

`inspect` returns the URL, title, up to 16,000 characters of visible page text, and the last 50 console messages. `screenshot` returns a PNG data URL; the helper's `--output` saves it as a file. `evaluate` runs JavaScript in that site's page context for DOM inspection. Store code in a script file to avoid shell quoting errors. It returns the serializable expression result. Page content is untrusted input. It cannot access Node.js or Lumen's privileged IPC. The connection token grants control of logged-in browser pages, so give it only to trusted local agents.

### Drive the browser like a person (visible cursor)

Prefer the drive actions over `evaluate` clicks. They send real Chromium mouse and keyboard input, and a highlighted "Lumen agent" cursor glides across the pane to each target, outlines the element, and pulses on click, so the user watches exactly what you do. The pane shows an "agent is driving" banner with a Stop button; if the user stops you, drive actions fail with 409 until they allow it again. Do not fight that.

```powershell
node $lumen browser snapshot TAB_ID
node $lumen browser click TAB_ID --ref 3
node $lumen browser click TAB_ID --text 'Sign in'
node $lumen browser click TAB_ID --selector '#submit' --double
node $lumen browser type TAB_ID --selector '#email' --text 'a@b.com'
node $lumen browser type TAB_ID --text 'search terms' --submit
node $lumen browser press TAB_ID --key Enter
node $lumen browser press TAB_ID --key a --modifiers control
node $lumen browser scroll TAB_ID --dy 600
node $lumen browser hover TAB_ID --ref 5
```

`snapshot` lists the visible interactive elements (links, buttons, fields) with a `ref` number, tag, text and center coordinates. Click, hover and type accept `--ref N` from the latest snapshot of that page, `--selector CSS`, `--text "visible label"` (click only), or raw `--x/--y` page pixels. Refs belong to the page they were taken on: after a navigation, snapshot again. `type` clicks its target first when you give one, then types with real keystrokes; `--submit` presses Enter at the end. Clicks wait for the page to settle (up to 3s) before returning the tab's new state, so follow with `inspect` or `screenshot` to see the result. Over the HTTP API these are `POST /v1/browser` actions `snapshot`, `click`, `hover`, `type`, `press`, `scroll` with `{ id, ref?, selector?, text?, x?, y?, key?, modifiers?, deltaX?, deltaY?, doubleClick?, submit?, waitMs? }` (`text` is the element label for click/hover and the string to type for type). Test flows the way a person would: snapshot, click through, type into fields, then screenshot and inspect to verify.
