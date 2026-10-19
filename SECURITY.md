# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub's [private vulnerability reporting](https://github.com/mrchevyceleb/lumen/security/advisories/new) (the **Security** tab, then **Report a vulnerability**). Do not open a public issue or pull request for a vulnerability.

Include what you found, the Lumen version (Settings → Updates), steps to reproduce, and the impact you expect. You will get a reply as soon as the report has been read, and fixes ship through the normal release channel, so every installed copy picks them up automatically.

## Supported versions

Only the [latest release](https://github.com/mrchevyceleb/lumen/releases/latest) is supported. Installed copies update themselves, so please confirm the problem on the latest version before reporting.

## How Lumen's trust model works

Lumen is a local desktop app. It runs coding agents as your Windows user and gives them the same access you have. Keep these points in mind when using it and when judging whether something is a vulnerability.

### Agents run with permission prompts bypassed

Lumen launches agent CLIs in their most permissive modes so they can work without stopping for approval:

- Claude Code and Google Antigravity run with `--dangerously-skip-permissions` (Claude's shell sandbox is also disabled).
- Codex runs with `danger-full-access` and no approval prompts.
- Grok runs with permission bypass and `--sandbox off`.
- Outside plan mode, Lumen approves native tool callbacks automatically.

Agents can read and change files, run any command, start processes, and use the network with your account's permissions. Only open workspaces and run prompts you trust. Treat untrusted repositories, prompt files, MCP servers, and web content as a prompt-injection risk. This behavior is by design; reports that only restate it are not vulnerabilities, but ways for untrusted input to escalate beyond it are.

**Run as administrator** restarts Lumen elevated, which gives every agent and terminal administrator access. It is never enabled automatically.

### The local agent-control API

Lumen starts a local HTTP API so other agents and scripts can create and manage chats and browser tabs. It is on by default and can be turned off in **Settings → Agent control**.

- It listens only on `127.0.0.1` on a random port and rejects browser origins.
- Every launch generates a new random bearer token.
- The URL and token are written to `%APPDATA%\Lumen\agent-control.json` (or the file named by `LUMEN_CONTROL_FILE` for portable or custom profiles).

**That file is sensitive.** Anyone or anything that can read it while Lumen is running can drive your agents, and through them run commands as you. Do not share it, paste it into chats or issues, commit it, or sync it to other machines. Agents that Lumen launches inherit the connection path on purpose so they can use the API. Turn the API off if you do not need it.

### Other local data

Lumen stores settings, transcripts, drafts, attachments, saved account logins (separate Claude and Codex configuration folders), and its embedded browser profile in `%APPDATA%\Lumen`. Treat that folder as private. Agent prompts are sent by each CLI to its own provider, exactly as when you use that CLI directly.

### Embedded browser

Websites in the built-in browser run sandboxed with no Node.js or Lumen API access, normal HTTPS certificate checks, and camera, microphone, location, and notification permissions disabled. Local agents can control browser tabs only through the authenticated agent-control API.

### Unsigned builds

Release installers are not code-signed. Download them only from this repository's [GitHub releases](https://github.com/mrchevyceleb/lumen/releases). Updates are fetched from the same releases.
