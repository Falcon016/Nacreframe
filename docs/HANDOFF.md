# Handoff notes

Where the project stands, what has and has not been verified, and what to do next. Written for whoever (a person or
another assistant) continues this work, including publishing it to GitHub.

## What this is

A from-scratch rebuild of the old "turtlebot" harness as **Nacreframe** (CLI: `nacre`, MIT, Node ≥ 22.18, TypeScript,
Ink TUI, plain-JS dashboard). The old project is not being kept; this folder is intended to _replace_ the contents of
that repository.

## Publishing it (not done yet — nothing here has been committed or pushed)

1. In a clean clone of the target repository, remove the old files (keep the `.git` directory), then copy this
   folder's contents in. Do not copy `node_modules/` or `dist/`.
2. `npm ci && npm run check && npm run build` must pass before the first commit.
3. Review `git status` for anything unexpected, then commit on a branch (a suggested name is
   `feat/nacreframe-rebuild`) and open a pull request, rather than force-pushing over `main`.
4. Decide whether to rename the repository (the README currently says `<this-repository-url>` on purpose).
5. CI is in `.github/workflows/ci.yml` (Linux, macOS, Windows × Node 22/24, plus a history secret scan). Watch the first
   run: only Windows has been exercised so far.
6. **No secrets are in the tree** (`npm run scan-secrets` checks, and CI re-checks history). Keep it that way: API keys
   come from the environment or `nacre auth set`; the dashboard token is generated at runtime.

## Verified

- 90+ automated tests (`npm test`), typecheck, lint, formatting — all green on Windows 11 / Node 24.
- The Ink UI rendered into a fake terminal; the dashboard driven in a real Chrome (sign-in, session creation, streaming
  Markdown, XSS safety, approvals via keyboard, swarm roster, mobile layout, zero CSP errors).
- Live browser control against real Chrome; container sandbox against real Docker; MCP against a real stdio server.
- A real llama.cpp router server: model listing, **context-window detection from `--ctx-size`**, a real completion, and
  tool use. `npm run live-check -- <provider>/<model>` repeats this for any model, including a forced-compaction test.
- Compaction guarantees (see [compaction.md](compaction.md)) are covered by `test/compaction.test.ts`.

## Not verified

- The Anthropic and OpenAI adapters have only run against mocked streams (no API keys were used). Try them first.
- Linux and macOS (CI will tell), Podman, the Docker image in `deploy/`, systemd unit.
- The dashboard behind a real TLS reverse proxy.
- `install.sh` and `nacre setup`: exercised on Linux only (dash and bash `--posix`, a real pseudo-terminal, shellcheck
  clean). macOS (zsh/Homebrew), fish, and the wizard's arrow-key menus in Windows Terminal / PowerShell are untested.
  There is no PowerShell installer yet, so native Windows installs by hand (see [install.md](install.md)).
- Quality of summaries differs per model; `live-check` reports whether a model kept an early fact through compaction.

## Design decisions worth knowing

- **No default model.** The user wants to test models before choosing a favourite. `model` is optional everywhere; the
  TUI opens a picker, scripted modes list what is available and exit.
- **Compaction is non-negotiable:** always on, ≤ 80% trigger, chat held, transactional, pauses rather than overflows.
- **Swarm members are normal sessions** (persisted, compacted, resumable), not in-memory sidecars.
- **Dashboard default port 7437**, loopback, token auth. It was picked to avoid 3000/5173/8000/8080/8888/11434 etc.
- Built-in provider `llamacpp` defaults to llama-server's `:8080`; the author's server is on `:11434` (the same port as
  Ollama's default), configured via `providers.llamacpp.baseUrl`.

## Ideas, in rough priority order

1. Run the CI matrix; fix whatever Linux/macOS turns up.
2. Anthropic/OpenAI live checks with real keys (extend `live-check`).
3. Dashboard: interactive remote view of the agent's browser (today: refreshed screenshot + pause), per-user accounts,
   file browser / diff review pane.
4. `nacre serve` Docker image published to a registry; Chromium variant.
5. Extension reload without restart; richer swarm topologies (beyond lead and teammates).
6. Podman and native OS sandboxes (bubblewrap / Seatbelt) behind the existing `Sandbox` interface.

## Conventions

LF line endings (`.gitattributes`), Prettier + ESLint, `.js` import extensions, file tools always go through
`ctx.sandbox.checkPath`, anything from the web/browser/MCP goes through `wrapUntrusted`, tests that need Chrome or
Docker skip themselves when unavailable. See [AGENTS.md](../AGENTS.md) and [architecture.md](architecture.md).
