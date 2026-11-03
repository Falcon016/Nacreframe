# Configuration

You rarely need to edit these files by hand: `nacre setup` asks a few questions and writes the user config (and stores
your API key separately). See [install.md](install.md#the-setup-wizard). This page is the reference.

## Where config lives

| Layer   | Path                                                                                                                                                 |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| User    | Linux `~/.config/nacreframe/config.json` · macOS `~/Library/Application Support/nacreframe/config.json` · Windows `%APPDATA%\nacreframe\config.json` |
| Project | `.nacreframe/config.json` in the project (or any parent directory)                                                                                   |
| Env     | `NACRE_MODEL`, `NACRE_APPROVAL`, `NACRE_SANDBOX`                                                                                                     |
| Flags   | `--model`, `--approval`, `--sandbox`, `--no-browser`                                                                                                 |

Later layers win. List settings (`rules`, `denyPaths`, `allowPaths`, `allowedHosts`, `blockedHosts`, `agents`) are
concatenated; objects are merged. Set `NACRE_HOME` to relocate everything (config/data/state) — handy for tests and
containers. `nacre doctor` prints what it found.

**Project config is untrusted by default.** Until you run `nacre trust` in the project, only these are applied:
`model`, `theme`, `deny`/`ask` approval rules, extra `sandbox.denyPaths`, `browser.blockedHosts`. Everything else
(including `approval.mode`, allow rules, `sandbox.mode`, `mcpServers`, `providers`) is ignored with a warning, and the
project's skills, extensions, prompt templates and `SYSTEM.md` are not loaded.

## Reference

| Key                                              | Default                                                  | Notes                                                                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`                                          | _(none)_                                                 | `<provider>/<model>`. Deliberately no default: pick with `--model`, `NACRE_MODEL` or `/model`                                                             |
| `smallModel`                                     | = `model`                                                | Used for compaction summaries (same model by default: no model swap on a single-GPU server)                                                               |
| `contextWindows`                                 | `{}`                                                     | `{ "<provider>/<model>": tokens }` overrides what the server reports                                                                                      |
| `maxTokens`                                      | `0`                                                      | Output tokens per model call. `0` = all the room left in the context window after the prompt; hosted APIs that cap lower are learned on the first refusal |
| `thinkingBudget`                                 | `0`                                                      | Extended-thinking tokens (Anthropic); `0` disables                                                                                                        |
| `providers.<id>`                                 | anthropic, openai, ollama, lmstudio                      | `{ type: "anthropic" \| "openai", baseUrl?, apiKeyEnv?, headers?, contextWindow? }`                                                                       |
| `approval.mode`                                  | `ask`                                                    | `ask` \| `edits` \| `auto` \| `plan`                                                                                                                      |
| `approval.rules[]`                               | `[]`                                                     | `{ tool, match?, action: "allow"\|"ask"\|"deny" }`; `tool` is a glob, `match` globs the command/path/URL                                                  |
| `sandbox.mode`                                   | `guard`                                                  | `off` \| `guard` \| `container`                                                                                                                           |
| `sandbox.allowPaths[]`                           | `[]`                                                     | Extra directories file tools may use                                                                                                                      |
| `sandbox.denyPaths[]`                            | `.env`, `.env.*`, `**/.ssh/**`, `**/*.pem`, `**/id_rsa*` | Never readable/writable                                                                                                                                   |
| `sandbox.container`                              | docker, `node:22-bookworm-slim`, no network, 2g, 2 cpus  | `{ runtime, image, network, memory, cpus }`                                                                                                               |
| `browser.enabled`                                | `true`                                                   |                                                                                                                                                           |
| `browser.channel`                                | `chrome`                                                 | `chrome` \| `msedge` \| `chromium` (the last needs `npx playwright-core install chromium`)                                                                |
| `browser.headless`                               | `false`                                                  | Headed by default so you can watch                                                                                                                        |
| `browser.allowedHosts[]` / `blockedHosts[]`      | `[]`                                                     | Host globs; if `allowedHosts` is non-empty everything else is blocked                                                                                     |
| `swarm.agents[]`                                 | `[]`                                                     | `{ name, role, model?, tools?, color? }`                                                                                                                  |
| `swarm.maxAgents` / `maxMessages` / `allowSpawn` | `6` / `60` / `false`                                     | `maxMessages`: agent-to-agent messages between yours, 0 = no limit (`/swarm limit` sets it)                                                               |
| `compaction`                                     | `{ threshold: 0.8, keepRecent: 6 }`                      | Always on. `threshold` 0.3–0.8 (cannot exceed 80%); `keepRecent` newest messages kept verbatim. See [compaction.md](compaction.md)                        |
| `telegram`                                       | `{ allowedUsers: [] }`                                   | Who may use `nacre telegram` (user ids) and `cwd`, the folder it works in. User config only. See [telegram.md](telegram.md)                               |
| `mcpServers.<name>`                              | `{}`                                                     | `{ command, args?, env?, cwd? }` (stdio) or `{ url, headers? }` (HTTP)                                                                                    |
| `maxToolIterations`                              | `60`                                                     | Tool calls an agent may make in one turn before it stops and waits for you; 0 = no limit                                                                  |
| `theme`                                          | `nacre`                                                  | `nacre` \| `mono` (`NO_COLOR` also forces mono)                                                                                                           |
| `showThinking`                                   | `false`                                                  | Show agents' reasoning in full in the terminal UI. Toggle any time with ctrl+t or `/thinking`                                                             |

## Providers

```json
{
  "providers": {
    "unsloth": { "type": "openai", "baseUrl": "http://127.0.0.1:8888/v1" },
    "openrouter": {
      "type": "openai",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    }
  }
}
```

Anything that speaks OpenAI's `/chat/completions` streaming protocol works (Ollama, LM Studio, vLLM, llama.cpp server,
Unsloth Studio...). Local `localhost` endpoints need no key. The context window is read from the server (llama.cpp `--ctx-size` via the
router's `/v1/models`, or `/props`; LM Studio; Ollama `/api/ps`). If it is not reported, 32,768 tokens is assumed and
you get a warning: set `contextWindows` (or the provider's `contextWindow`) so compaction triggers at the right size.
Built-in providers: `anthropic`, `openai`, `ollama` (:11434), `lmstudio` (:1234), `llamacpp` (:8080). Ollama's default
port is also 11434, so if you run llama.cpp there, override `providers.llamacpp.baseUrl` and use the `llamacpp/` prefix. Tool calling must be supported by the model/server you pick.

## Instructions, skills, templates

- `AGENTS.md` / `NACREFRAME.md`: read from the config dir and every directory from `/` down to the working directory.
- `SYSTEM.md` in the config dir (or a trusted project's `.nacreframe/`) replaces the built-in system prompt.
- `skills/<name>/SKILL.md` with `name` and `description` front-matter: listed to the model, loaded on demand.
  Three ship built in: `python-env` (find and repair a Python environment), `security-review` (secrets, injection,
  auth and dependency checks with severities) and `pre-commit-review` (run the project's checks, read the diff, write
  the commit message). A user or project skill with the same name replaces a built-in one. `/skills` lists them.
- `prompts/<name>.md` → `/name`; `$ARGUMENTS` and `$1`…`$9` are substituted.
- `extensions/*.{ts,js}`: see the README and [examples/extensions](../examples/extensions).
