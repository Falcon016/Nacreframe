# Security model

Nacreframe lets a language model read files, run commands and drive a browser on your machine. This page states
what it defends against, how, and — just as important — what it does **not** defend against.

## Threats

| Threat                                                                    | Mitigation                                                                                                                                                                              |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The model makes a mistake (deletes files, force-pushes)                   | Approval modes; hard blocklist; escalations always ask; read-before-edit; diffs shown before writes                                                                                     |
| **Prompt injection** from web pages, fetched URLs, MCP output, repo files | Untrusted-content envelope + system prompt rule; browser/fetch/MCP results are always wrapped; risky tools still need approval                                                          |
| A cloned repo ships config that auto-approves or runs code                | Project config is _restricted_ until `nacre trust`: only deny/ask rules, extra deny-paths, host blocks are honoured; project skills, extensions, prompts and `SYSTEM.md` are not loaded |
| Secrets leak to the model provider or the session log                     | Output redaction (token shapes + secret-named env values); child processes get a scrubbed environment; `.env`, `*.pem`, SSH keys are deny-listed by default                             |
| Agent reads/writes outside the project                                    | `guard`: realpath-resolved path confinement (symlinks/junctions can't escape), Windows device/ADS paths rejected                                                                        |
| SSRF via `web_fetch` (cloud metadata, localhost services)                 | Private, loopback, link-local and metadata addresses are refused, re-checked on every redirect                                                                                          |
| Browser navigates somewhere it shouldn't                                  | Scheme allow-list (http/https), metadata addresses blocked, `allowedHosts`/`blockedHosts` enforced at the network layer on every document request                                       |
| Two agents corrupt each other's edits                                     | Per-file async locks, atomic writes, mtime checks that refuse stale edits                                                                                                               |
| Runaway agent loops / chatter                                             | Iteration cap per turn; swarm message budget that only a human message resets                                                                                                           |

## What `guard` is — and isn't

`guard` confines the agent's **file tools** and removes secrets from the **environment** of shell commands. It does
not sandbox the shell: a `bash` command can `curl` your data somewhere or read `~/.ssh` if you approve it. In `ask`
and `edits` modes you see every such command first; in `auto` mode you do not. If you want auto-approval for
untrusted work, use `--sandbox container`.

## Conversation integrity

Compaction is always on, keeps the context at or below 80% of the window, and holds the chat until a transactional summary is
committed; a failure pauses the chat instead of sending an oversized request (see [compaction.md](compaction.md)).
Tool results are capped to a slice of the window, tool calls left dangling by a crash are closed before the next request,
and session files are append-only, so no operation can silently truncate or corrupt a conversation.

## Web dashboard

`nacre serve` adds an HTTP surface. It listens on loopback by default, refuses a network address without a login token,
compares tokens in constant time, rate-limits failed logins, uses `HttpOnly` + `SameSite=Strict` cookies, requires an
`X-Nacre` header and a matching `Origin` on every state-changing call (CSRF), checks the `Host` header (DNS rebinding),
sends a strict CSP, only opens folders inside configured `--root`s, validates every id from the client so no file path
reaches the file system, and renders model output with DOM text nodes only. Details and deployment advice (TLS reverse
proxy or VPN) are in [web.md](web.md). A signed-in user can make the agent run commands as the server's user: treat the
token like an SSH key.

## Container sandbox

Each command runs `docker|podman run --rm` with: no host environment variables, `--cap-drop ALL`,
`no-new-privileges`, PID/memory/CPU limits, `--network none` unless enabled, only the project directory bind-mounted at
`/workspace`, and the invoking user's uid/gid on POSIX. A timeout or Ctrl-C also `kill`s the named container. Note that
the project directory is writable by the container — that is what makes edits visible to you.

## Browser profile

Browser control uses a persistent profile under the app data directory so logins survive. Anything you sign into in
that window is available to the agent while it has control. Use `/browser takeover` before entering credentials, or run
with `browser.headless = true` and a clean profile for unattended work. The agent is instructed never to type secrets
it was not explicitly given, but that is a model behaviour, not a technical barrier.

## Extensions and MCP servers

Extensions are arbitrary code with your privileges. MCP servers are separate processes (stdio) or remote services; their
tools are treated as `exec`-risk (approval required) unless they declare `readOnlyHint`, and stdio servers receive only a
minimal environment plus the variables you list. Neither is loaded from an untrusted project directory.

## Credentials

Keys come from environment variables or `nacre auth set` (stored in `auth.json`, mode `0600` on POSIX; on Windows it
inherits the permissions of your profile directory). Nothing in this repository holds credentials; `npm run scan-secrets`
and CI scan the tree and git history for credential shapes.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
