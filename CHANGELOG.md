# Changelog

## 0.1.0 — unreleased

First release of the ground-up rewrite (replaces the earlier turtlebot harness).

- **Renamed to NexusHarness** (it was Nacreframe), with the `nexus` command; `nacre` still works. Settings, API keys
  and sessions move to the new folders on first start; `NACRE_*` environment variables, `.nacreframe/` project
  folders and `NACREFRAME.md` are still read; the installer moves `~/.nacreframe` to `~/.nexusharness`, and an install
  updated with `/update` gets the `nexus` command added beside `nacre`. New black-and-blue look from the new logo
  across the terminal UI, dashboard, installer, setup wizard and terminal schemes; `◉` is the mark in text, and the
  welcome panel's mascot is Nex, a small agent robot.

- Agent loop with streaming, parallel read-only tools, steering, abort, session trees.
- **Compaction that cannot corrupt a conversation**: always on, at most 80% of the real context window, the chat is
  held while it runs, transactional and chunked, falls back to shorter tails, pauses instead of overflowing; dangling
  tool calls are repaired; tool results are capped.
- Providers: Anthropic and any OpenAI-compatible endpoint (llama.cpp, Ollama, LM Studio, Unsloth Studio, vLLM...).
  Context windows are detected from the server. No default model.
- **Telegram bot**: `nexus telegram` relays your messages to an agent and its replies, progress, approvals (buttons)
  and questions back. Only allowed users in private chats; the token lives in auth.json. `nexus setup` connects a
  bot, checks the token and finds your account by asking you to message it.
- **Built-in skills**: `python-env`, `security-review` and `pre-commit-review` ship with the harness (user and
  project skills of the same name replace them); `/skills` lists what is installed. The swarm's reviewer and
  security advisor are pointed at theirs.
- **`/context`**: shows the context window, where it came from, how much is used and where compaction starts.
  `/context 128k` sets it for the model in use and saves it (it then wins over what the server reports, which is
  still asked at every start); `/context auto` goes back to the server's figure. Also in the Telegram bot.
- **Tokens per second** in the terminal footer and the dashboard: live while a reply streams, then the reply's
  measured speed. The footer now fits narrow windows by dropping its least useful parts instead of running together.
- **No repeated text in the terminal**: a reply taller than the window used to leave copies of itself in the
  scrollback on every redraw. Each finished line of a reply is now printed as it arrives, and the live area (the
  unfinished part, the task list, running tools) always fits in the window.
- **Compaction no longer restarts finished work**: the summary is marked as background rather than a new request,
  separates what is done from what remains, is written knowing what happened after the part it compresses, and
  carries the current task list.
- **Task lists stay current**: the agent is reminded once if it finishes working while its list still shows open
  items, and the list survives compaction.
- **Replies can use the whole context**: by default each model call may write as much as fits in the context window
  after the prompt (`maxTokens: 0`), instead of a fixed 8192 tokens; long answers and long reasoning no longer get
  cut off early. Hosted APIs that cap output lower say so when they refuse, and the agent takes their figure and
  retries. Set `maxTokens` to a number to cap it.
- Approval modes `ask` / `edits` / `auto` / `plan` with rules; sandbox levels `off` / `guard` / `container`.
- Live browser control via Playwright with host policy and user take-over.
- Collaborative swarms in a shared channel with split-pane view; persistent, compacted, resumable like any session.
- Ink TUI with the Nexus theme; print / JSON / RPC modes.
- Self-hosted web dashboard (`nexus serve`): token auth, strict CSP, SSE streaming, approvals, context meter, swarm,
  live browser view; Docker and systemd deployment files.
- Extensions, skills, prompt templates, MCP client, `AGENTS.md`.
- `nexus models`, `nexus doctor`, `npm run live-check`.
- **One-command install** for Linux, macOS and WSL: `curl -fsSL .../install.sh | sh` checks Node/git/npm, builds into
  `~/.nexusharness`, links `nexus`, asks before touching your shell profile, updates by re-running, and `--uninstall`.
  It installs what is missing: a private, checksum-verified Node.js when none is usable, and git through your package
  manager if you agree. `nexus` is a launcher that picks that Node.js and repairs a damaged install on its own;
  `install.sh --repair` does the same by hand.
- **Fixes from a bug pass**: live reasoning is word-wrapped and grows line by line instead of sliding sideways in a
  single cut-off line (it looked like it was buffering); the dashboard streams it too, and the server sends only
  its tail. A teammate whose turns keep failing (model server down) pauses the team after three failures in a row
  instead of being re-woken forever when there is no message limit; failed turns and turns stopped at the
  tool-call limit are reported to the lead as such. Custom agents cannot be named `you`, `system` or `all`.
- **Swarm limits**: `/swarm custom` asks how many messages the agents may send each other before checking in with
  you, and how many tool calls one agent may make per turn, and saves both to your config (0 / "No limit" allowed).
  `/swarm limit [n|off]` changes them any time, also for a running team. The footer shows `messages 12/60` beside
  the context meter, amber near the limit and red when the team is waiting; the dashboard shows the same.
- **`/update`** and `nexus update [--check]`: check the installed branch for a newer version, show what changed, ask,
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
- **`nexus doctor --fix`** repairs broken or invalid settings, a missing API key, key-file permissions, missing folders, a
  missing or off-`PATH` launcher, a too-old Node.js and (after asking) a missing browser; plain `nexus doctor` offers it.
  The Node.js check now compares the minor version (22.18), not just the major.
- **`nexus setup`**: guided wizard (arrow-key menus; provider, API key checked before saving, local-server detection,
  model, approval mode, sandbox, browser) that saves nothing until confirmed and keeps unrelated settings. `--yes`
  mode with flags for scripts and CI. `nexus doctor` and `setup` share their system checks.
