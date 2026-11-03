# Changelog

## 0.1.0 — unreleased

First release of the ground-up rewrite (replaces the earlier turtlebot harness).

- Agent loop with streaming, parallel read-only tools, steering, abort, session trees.
- **Compaction that cannot corrupt a conversation**: always on, at most 80% of the real context window, the chat is
  held while it runs, transactional and chunked, falls back to shorter tails, pauses instead of overflowing; dangling
  tool calls are repaired; tool results are capped.
- Providers: Anthropic and any OpenAI-compatible endpoint (llama.cpp, Ollama, LM Studio, Unsloth Studio, vLLM...).
  Context windows are detected from the server. No default model.
- Approval modes `ask` / `edits` / `auto` / `plan` with rules; sandbox levels `off` / `guard` / `container`.
- Live browser control via Playwright with host policy and user take-over.
- Collaborative swarms in a shared channel with split-pane view; persistent, compacted, resumable like any session.
- Ink TUI with the Nacre theme; print / JSON / RPC modes.
- Self-hosted web dashboard (`nacre serve`): token auth, strict CSP, SSE streaming, approvals, context meter, swarm,
  live browser view; Docker and systemd deployment files.
- Extensions, skills, prompt templates, MCP client, `AGENTS.md`.
- `nacre models`, `nacre doctor`, `npm run live-check`.
- **One-command install** for Linux, macOS and WSL: `curl -fsSL .../install.sh | sh` checks Node/git/npm, builds into
  `~/.nacreframe`, links `nacre`, asks before touching your shell profile, updates by re-running, and `--uninstall`.
  It installs what is missing: a private, checksum-verified Node.js when none is usable, and git through your package
  manager if you agree. `nacre` is a launcher that picks that Node.js and repairs a damaged install on its own;
  `install.sh --repair` does the same by hand.
- **`/update`** and `nacre update [--check]`: check the installed branch for a newer version, show what changed, ask,
  update through the installer, and offer to restart straight into it, continuing the conversation. `--version` now
  reads `package.json`, so it always shows the installed version.
- **Thinking**: each agent's reasoning is kept. Hidden, it is one quiet line ("✻ planner thought for 8s"); ctrl+t or
  `/thinking` shows it in full, set off by a rule in the agent's colour, both in the transcript and live in the swarm
  panes. The dashboard shows it as a line that opens. Reasoning that local models write inline as `<think>...</think>`
  is separated from the answer. `showThinking: true` shows it by default.
- **Teams**: `/swarm quad` (architect, builder, reviewer, security advisor) joins `duo` and `trio`; `/swarm custom`
  builds a team of any size from a list of roles or roles you write, and can save it as `/swarm config`. Agents no
  longer add teammates unless `swarm.allowSpawn` is on, so `trio` stays three. Reviewers and the security advisor
  cannot edit files.
- **`/flush`** deletes old saved conversations and swarms: older than N days or everything, for this folder or every
  folder. It shows what it would delete and asks first; the current conversation and running swarm are always kept.
- **Swarm reporting lines**: only the lead talks to you; teammates report to the lead. Teammates lose `ask_user`,
  their messages to you are rerouted to the lead, a turn that ends without a message is delivered as a report (so
  small models no longer stall the team), plain-text `@mentions` from the lead are delivered, and every wake-up
  restates the agent's role.
- **Terminal UI**: a framed welcome panel with the mascot (a pearl in its shell) at launch; the screen is cleared and
  reprinted after a resize, which fixes ghost copies of the swarm panes when going fullscreen; swarm panes stay short
  enough to fit the window and give way to a one-line roster in small windows or while a dialog is open.
- **New look**: a black and deep-purple palette shared by the dashboard, terminal UI, installer, setup wizard and the
  bundled terminal schemes; a new logo (a pearl between two brackets, `[●]` in the terminal) replaces the diamond.
  The dashboard drops glows, gradient washes and floating cards for hairlines and surface steps, groups mode, sandbox
  and model into one control, shows keycaps on approvals, and opens on a list of your allowed folders. Newsreader is
  no longer bundled.
- **`nacre doctor --fix`** repairs broken or invalid settings, a missing API key, key-file permissions, missing folders, a
  missing or off-`PATH` launcher, a too-old Node.js and (after asking) a missing browser; plain `nacre doctor` offers it.
  The Node.js check now compares the minor version (22.18), not just the major.
- **`nacre setup`**: guided wizard (arrow-key menus; provider, API key checked before saving, local-server detection,
  model, approval mode, sandbox, browser) that saves nothing until confirmed and keeps unrelated settings. `--yes`
  mode with flags for scripts and CI. `nacre doctor` and `setup` share their system checks.
