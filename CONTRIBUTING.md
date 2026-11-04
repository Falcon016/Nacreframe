# Contributing

```bash
npm ci
npm run check      # typecheck, lint, tests, secret scan — must pass
npm run dev        # run from source
npm run mock       # offline OpenAI-compatible model for trying the UI (second terminal: NEXUS_MODEL=mock/m)
```

Requires Node ≥ 22.18. Windows, macOS and Linux are all first-class: avoid POSIX-only assumptions (use `node:path`,
no hard-coded `/tmp`, no shell-specific syntax in tests), and remember CI runs all three.

## Guidelines

- **Safety first.** File tools must go through `ctx.sandbox.checkPath`. New tools declare an honest `risk`. Anything
  that returns content from outside the project (web, browser, MCP) must wrap it with `wrapUntrusted`.
- **Tests with the change.** Prefer driving the real thing (scripted provider, fake TTY, real stdio MCP server) over
  mocks of our own code. Tests needing Chrome or Docker must `skipIf` when absent.
- **No secrets, ever** — not even "temporary" ones, and not in tests, fixtures or screenshots.
  Use obviously fake placeholders (`sk-ant-AAAAAAAA…`). `npm run scan-secrets` runs in CI.
- **Keep the core small.** If a feature can be an extension, skill or prompt template, it probably should be.
- Code style is enforced by Prettier and ESLint (`npm run format`, `npm run lint`).

## Pull requests

Describe the behaviour change and how you verified it. Mention platform-specific behaviour you could only test on
one OS. Update docs when you change flags, config or security-relevant behaviour.
