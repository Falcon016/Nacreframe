<p align="center">
  <img src="assets/banner.svg" alt="Nacreframe" width="720">
</p>

<p align="center">
  A terminal-native AI agent harness with layered sandboxing, approval modes, live browser control,
  agent swarms that talk to each other, and a self-hosted web dashboard.
</p>

<p align="center">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-b4a7e8">
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522.18-e6c384">
  <img alt="Platforms" src="https://img.shields.io/badge/Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-e3b7c4">
</p>

---

Nacreframe is a coding-agent harness in the spirit of [pi](https://pi.dev) (small core, extensible, session trees,
steering) with the day-to-day features of Claude Code (approvals, plan mode, diffs, MCP, skills, sub-agents). It runs
against Anthropic, OpenAI-compatible endpoints, and local models (llama.cpp, Ollama, LM Studio, Unsloth Studio, vLLM...).
It has **no default model**: you pick one, and the harness reads that model's real context window from the server.

## Highlights

- **Compaction that cannot corrupt a conversation.** Always on, triggers at 80% of the _real_ context window, and
  holds the chat (nothing is sent to the model) until the summary is done. It is transactional: the session is only
  touched if a valid summary was produced, the full history stays in the append-only session file, and if compaction
  fails or cannot free enough room the chat pauses with everything intact rather than sending an oversized request.
  Messages you type meanwhile are queued, not lost. [Details](docs/compaction.md).
- **Web dashboard you can self-host.** `nacre serve` gives you the whole harness in a browser: sessions, streaming
  chat, approvals, a context meter with the compaction line, swarm roster, live browser view. Token login, loopback by
  default, strict CSP, no external requests. [Details](docs/web.md).
- **Four approval modes.** `ask`, `edits`, `auto`, `plan` — switch live with <kbd>Shift</kbd>+<kbd>Tab</kbd>. Per-tool
  allow/ask/deny rules on top. A hard blocklist (`rm -rf /`, fork bombs, disk formatting) applies in every mode, and
  escalations (`sudo`, `git push`, `curl | sh`, `npm publish`...) always require a human, even in `auto`.
- **Layered sandbox.** `off`, `guard` (file tools confined to the workspace, symlink-safe, deny-globs for `.env` / keys,
  secrets scrubbed from the environment of every command) and `container` (every command runs in a throw-away Docker
  container: no host env, no network by default, capabilities dropped, resource-limited).
- **Live browser control.** The agent drives a real Chrome/Edge window through Playwright. You watch every step and can
  take over with `/browser takeover`. Pages are read as accessibility snapshots with element refs; everything from the
  page is wrapped as untrusted data; host allow/block lists are enforced on _every_ navigation, including link clicks.
- **Collaborative swarms that behave like normal sessions.** `/swarm trio` starts several agents in one shared channel.
  They message each other, hand off work and share notes; you watch live and can interject (`@builder use the new API`).
  Each member has its own persistent conversation with the same compaction and resume as the main agent, and a whole
  swarm resumes with `/swarm resume`. [Details](docs/swarm.md).
- **Session trees.** Sessions are append-only JSONL trees. `/tree` rewinds to any earlier message and branches without
  losing the original.
- **Extensible.** TypeScript extensions (tools, slash commands, before/after-tool hooks), skills (`SKILL.md`), prompt
  templates, an MCP client, `AGENTS.md` project instructions.
- **Scriptable.** `nacre -p "..."` for pipelines, `--mode json` for event streams, `--mode rpc` for embedding.
- **Safe by default.** Secrets are redacted from tool output before the model or the session log sees them; project
  config from a cloned repo can only _tighten_ policy until you run `nacre trust`.

## Install

On Linux, macOS or WSL, one command installs Nacreframe and walks you through setup:

```bash
curl -fsSL https://raw.githubusercontent.com/Falcon016/Nacreframe/main/install.sh | sh
```

It sets up what Nacreframe needs: if Node.js 22.18+ is missing it downloads a private, checksum-verified copy (no
`sudo`), and if git is missing it offers to install it with your package manager. Everything lives under
`~/.nacreframe`, `nacre` goes into `~/.local/bin`, and it asks before it edits your shell profile. Run it again to
update; add `-s -- --uninstall` after `sh` to remove it. Options, troubleshooting and a Windows recipe:
[docs/install.md](docs/install.md).

<details>
<summary>Install by hand (any OS, including native Windows)</summary>

```bash
git clone https://github.com/Falcon016/Nacreframe.git nacreframe
cd nacreframe
npm ci
npm run build
npm link          # puts `nacre` on your PATH
nacre setup       # guided setup
```

</details>

## Set up

```bash
nacre setup       # provider, API key, model and safety, in about a minute
nacre doctor      # checks your environment any time
nacre doctor --fix  # ...and repairs what it can: settings, keys, permissions, PATH, the install itself
```

The wizard uses arrow-key menus, checks your API key with the provider before saving it, finds local model servers
(Ollama, LM Studio, llama.cpp) that are already running, and writes nothing until you confirm. For scripts and CI:
`nacre setup --yes --provider anthropic --key-stdin --model <model>` ([all options](docs/install.md#the-setup-wizard)).

## First run

```bash
cd your-project
nacre                                       # no -m: the UI opens a model picker if you skipped it in setup
nacre models                                # what your providers offer right now, with context windows
nacre -m llamacpp/<model>                   # a local llama.cpp server (see below for non-default ports)
nacre auth set anthropic && nacre -m anthropic/<model>
```

Inside the UI: type a request, <kbd>Enter</kbd> to send, `\`+<kbd>Enter</kbd> or <kbd>Ctrl</kbd>+<kbd>J</kbd> for a
newline, <kbd>Esc</kbd> to interrupt, `/` for commands. Typing while the agent works _steers_ it mid-run.

### Local servers

Built-in provider names: `anthropic`, `openai`, `ollama` (`:11434`), `lmstudio` (`:1234`), `llamacpp` (`:8080`).
Point one somewhere else in your config, e.g. a llama.cpp server on port 11434:

```json
{ "providers": { "llamacpp": { "baseUrl": "http://127.0.0.1:11434/v1" } } }
```

Context windows are detected from the server (llama.cpp router/`/props`, LM Studio, Ollama `/api/ps`). If a server does
not report one, 32,768 tokens is assumed and you are told; set `"contextWindows": { "<provider>/<model>": 100000 }`.

| Command                                       | What it does                                               |
| --------------------------------------------- | ---------------------------------------------------------- |
| `/model [provider/model]`                     | Pick a model (lists what your providers offer)             |
| `/mode [ask\|edits\|auto\|plan]`              | Approval mode                                              |
| `/sandbox [off\|guard\|container]`            | Sandbox level                                              |
| `/swarm duo\|trio\|quad\|custom`              | Start a team (2, 3 or 4 agents, or one you put together)   |
| `/swarm config\|resume\|stop\|panes`          | Your saved team; resume or stop a team; toggle split panes |
| `/browser [status\|takeover\|release\|close]` | Live browser control                                       |
| `/tree` · `/resume` · `/clear`                | Branch from an earlier message · resume · start fresh      |
| `/flush [all\|<days>] [everywhere]`           | Delete old saved conversations and swarms (asks first)     |
| `/compact [focus]`                            | Summarise older context now (it also happens by itself)    |
| `/skills` · `/tools` · `/mcp`                 | Inspect what is loaded                                     |
| `/export [file]`                              | Save the conversation as Markdown                          |
| `/trust`                                      | Trust this project's `.nacreframe` config                  |

### Web dashboard

```bash
nacre serve                                  # http://127.0.0.1:7437 — prints a sign-in link with your token
nacre serve --host 0.0.0.0 --allow-host nacre.lan --root ~/projects   # on a homelab, behind TLS
```

Docker and systemd files for homelab use are in [deploy/](deploy/). See [docs/web.md](docs/web.md).

### Try a model before choosing it

```bash
npm run live-check -- llamacpp/<model> 8192     # replies? uses tools? survives forced compaction and still remembers?
```

## Approval modes

| Mode    | Reads | File edits | Commands / network / browser actions | Notes                                       |
| ------- | :---: | :--------: | :----------------------------------: | ------------------------------------------- |
| `ask`   |   ✓   |    asks    |                 asks                 | Read-only shell commands (`git status`) run |
| `edits` |   ✓   |     ✓      |                 asks                 |                                             |
| `auto`  |   ✓   |     ✓      |                  ✓                   | Blocklist + escalations still apply         |
| `plan`  |   ✓   |  refused   |               refused                | The agent can only investigate and plan     |

Rules refine any mode (`deny` beats `ask` beats `allow`):

```json
{
  "approval": {
    "rules": [
      { "tool": "bash", "match": "npm test*", "action": "allow" },
      { "tool": "write", "match": "**/*.lock", "action": "deny" }
    ]
  }
}
```

Choosing **"Yes, and don't ask again"** in a prompt grants that action for the session only.

## Sandbox levels

| Level       | File tools                                  | `bash`                                                | Use it when                      |
| ----------- | ------------------------------------------- | ----------------------------------------------------- | -------------------------------- |
| `off`       | unrestricted                                | host shell, full environment                          | you fully trust the task         |
| `guard`     | confined to the workspace, deny-globs apply | host shell, secrets scrubbed from env                 | everyday use (default)           |
| `container` | confined to the workspace                   | Docker: no host env, no network, caps dropped, limits | untrusted repos, unattended runs |

> **`guard` is policy, not a security boundary for shell commands.** A command the agent runs can still reach
> anything _you_ can. Use `container` when that matters. See [docs/security.md](docs/security.md).

## Swarms

```text
> /swarm trio
 ● Swarm "trio" is up: architect, builder, reviewer.
> add rate limiting to the API and cover it with tests

architect → builder   Add a token bucket in src/limiter.ts; keep it dependency-free.
builder   → architect Done, 6 tests passing. @reviewer please check edge cases around clock skew.
reviewer  → builder   Two issues: refill uses Date.now() (not monotonic) and there's no test for burst=0.
```

Unaddressed messages go to the lead (first agent); `@name` addresses anyone. Agents share one workspace, with per-file
locks and read-before-edit checks so two agents cannot silently overwrite each other. Define your own teams under
`swarm.agents` (see [examples/config.json](examples/config.json)).

## Configuration

Layered: built-in defaults → user config → project `.nacreframe/config.json` → environment → flags. Paths follow each
OS's conventions (`nacre doctor` prints them). Annotated example: [examples/config.json](examples/config.json).
Reference: [docs/configuration.md](docs/configuration.md).

API keys come from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ...) or `nacre auth set`. They are never
read from project config and never written to the repository.

## Extending

```ts
// ~/.config/nacreframe/extensions/protect-lockfiles.ts   (Node ≥ 22.18 runs TypeScript directly)
import type { ExtensionApi } from 'nacreframe/extensions';

export default function (api: ExtensionApi) {
  api.onBeforeTool(async ({ name, input }) => {
    if (name === 'write' && String(input.path).endsWith('package-lock.json'))
      return { block: 'Managed by npm.' };
  });
}
```

Skills live in `<config>/skills/<name>/SKILL.md`; prompt templates in `<config>/prompts/*.md` become slash commands; MCP
servers go under `mcpServers`. Examples are in [examples/](examples/). Extensions run with your full privileges — only
install code you trust.

## Terminal theme

The terminal UI and the dashboard share one palette: black, deep purple, pearl-white text, and a few status colours
(amber for "asks first", teal for edits, pink for auto, violet for plan). Purple marks what you can act on, what is
selected, and what is running; nothing glows. The logo is a pearl held between two brackets, `[●]` in the terminal.
The terminal's own background is left alone; matching black-and-purple schemes for Windows Terminal, Ghostty and
Alacritty are in [assets/terminal-themes](assets/terminal-themes). The dashboard bundles IBM Plex Sans and JetBrains
Mono (both SIL OFL). `NO_COLOR=1` switches the terminal UI to monochrome.

## Development

```bash
npm run dev          # run the terminal UI from source
npm run check        # typecheck + lint + tests + secret scan
npm run mock         # fake OpenAI-compatible model on :11499 for trying the UI offline
npm run live-check   # exercise a real model (see above)
```

Architecture notes: [docs/architecture.md](docs/architecture.md). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).
Security policy: [SECURITY.md](SECURITY.md). Project state and next steps: [docs/HANDOFF.md](docs/HANDOFF.md).

## License

[MIT](LICENSE)
