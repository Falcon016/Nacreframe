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
- **`nacre doctor --fix`** repairs broken or invalid settings, a missing API key, key-file permissions, missing folders, a
  missing or off-`PATH` launcher, a too-old Node.js and (after asking) a missing browser; plain `nacre doctor` offers it.
  The Node.js check now compares the minor version (22.18), not just the major.
- **`nacre setup`**: guided wizard (arrow-key menus; provider, API key checked before saving, local-server detection,
  model, approval mode, sandbox, browser) that saves nothing until confirmed and keeps unrelated settings. `--yes`
  mode with flags for scripts and CI. `nacre doctor` and `setup` share their system checks.
