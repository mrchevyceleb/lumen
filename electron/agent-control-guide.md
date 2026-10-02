# Run visible coding tasks in Lumen

Lumen must be running. Settings → Agent control contains the connection path and a copyable helper command. Local control is on by default. It binds only to 127.0.0.1, requires a random bearer token, and rejects browser origins. Turning it off disconnects clients without stopping chats. Turning it back on or restarting rotates the token and port. Read the connection file for each invocation; never hard-code or share its token.

Installed Windows profiles use `%APPDATA%\Lumen\agent-control.json`. Portable/custom profiles can use a different path: copy it from Settings, pass `--connection FILE`, or set `LUMEN_CONTROL_FILE`. Lumen's child agents inherit that environment variable. The dependency-free helper and this guide are copied into the same directory; Node.js runs the helper.

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
# Busy messages queue by default; send returns messageId.
node $lumen steer TASK_ID MESSAGE_ID
node $lumen remove TASK_ID MESSAGE_ID
node $lumen stop TASK_ID
node $lumen resume TASK_ID
node $lumen focus TASK_ID
node $lumen models TASK_ID
node $lumen configure TASK_ID --model MODEL_ID --effort LEVEL
node $lumen rename TASK_ID --name 'Login repair'
```

Choose `pi`, `codex`, `claude`, `grok`, or `shell`. Omit `--root` for no workspace. `--cwd` must be inside the selected workspace. `--account-id` selects a saved account; omitting it uses the app's default. Empty strings select CLI defaults for model/effort/account. Configure uses the same supported-model validation as the UI. Claude/Grok support `--work-mode plan` or `default`; other agents retain their own planning workflows.

Task IDs are stable across normal app restarts. List includes all open chats, including ones created by a human. Native chats can be inspected or focused, but must return to readable view in the app before sending prompts or changing controls. Shell commands retain their PowerShell process and must finish before another is sent. Closing requires an idle readable chat with an empty queue. Closing removes that tab just as closing it in the UI does; saved files and native CLI history remain.

Create and send accept `--id UUID` for retry safety. Save your chosen UUID before sending a request. Retrying a create with the same open task ID returns that task and does not resend an initial prompt already in its transcript or queue. If initial submission fails before acceptance, create returns the opened task with `deliveryError`; retry with the same ID and text to submit the missing prompt. Retrying a send with a retained transcript/queue message ID returns the previous message. A timeout is an uncertain result: read/list before retrying. IDs of closed tasks or messages outside the saved transcript are not retained forever.

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

Every request requires `Authorization: Bearer TOKEN`. POST requests require JSON objects with `Content-Type: application/json`. Successful responses are JSON. Errors return `{ "error": "..." }` with a non-2xx HTTP status. Lumen returns 503 while restoring chats, 409 for a busy/incompatible task, 404 for closed/missing tasks, 504 for an uncertain operation timeout. Model/provider errors stay visible in the transcript. Queue and steer use native adapters for each CLI, including their normal failure/paused-queue behavior.

| Method / route | Body / result |
| --- | --- |
| GET /v1 | Protocol version, capabilities, ready |
| GET /v1/tasks | `{ tasks: [...] }` with metadata, queues, context usage, pending questions |
| POST /v1/tasks | `id?`, `agent?`, `root?`, `cwd?`, `name?`, `owner?`, `accountId?`, `model?`, `effort?`, `workMode?`, `text?`; returns visible task |
| GET /v1/tasks/ID | Metadata plus the last 200 visible messages (up to 80,000 characters each); `transcriptLimited` reports truncation |
| POST /v1/tasks/ID/messages | `{ id?: UUID, text: string }`; returns `messageId`, queue and current task |
| POST /v1/tasks/ID/queue | `{ messageId: UUID, action: "steer" or "remove" }` |
| POST /v1/tasks/ID/resume | `{}`; resumes a paused queue |
| POST /v1/tasks/ID/stop | `{}`; stops the turn and pauses its queue |
| POST /v1/tasks/ID/focus | `{}`; selects the task in the app |
| POST /v1/tasks/ID/rename | `{ name: string }` |
| GET /v1/tasks/ID/models | Installed CLI's model catalog and effort options |
| POST /v1/tasks/ID/configure | `model?`, `effort?`, `workMode?`; requires idle readable view |
| POST /v1/tasks/ID/answer | `{ requestId: string, response: object }` |
| POST /v1/tasks/ID/close | `{}`; requires idle readable view and empty queue |

All prompts, streamed responses, and tool activity use the regular chat UI. Agent-created tabs show an Agent control badge; management actions leave visible notices. Creating a task leaves your current selected chat alone. Focus explicitly to select it. No CLI login tokens are exposed by this interface; it uses the app's existing accounts and permissions. The local connection token grants access to coding tasks on this computer, so give it only to agents you intend to use.
