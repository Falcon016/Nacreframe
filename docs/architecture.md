# Architecture

```
src/
  cli.ts             entry: flags, auth/doctor/trust subcommands, picks a mode
  runtime.ts         wires config → providers → tools → policy → sandbox → agent (+ swarm); shared by every mode
  agent/
    agent.ts         the loop: stream → tool calls → approvals → results → repeat; steering, abort, compaction
    session.ts       append-only JSONL tree (branching)
    compaction.ts    transactional chunked summarisation at a safe cut; context.ts: sizing, sanitising, limits
    broker.ts        serialises approval/question prompts from many agents into one UI
    prompt.ts        system prompt (+ AGENTS.md, skills, swarm role)
  llm/               provider-neutral types, Anthropic + OpenAI-compatible streaming adapters, retry, registry
  tools/             read, write, edit, glob, grep, ls, bash, web_fetch, todo, ask_user, skill
  policy/engine.ts   approval decisions (modes + rules + blocklist + grants)
  sandbox/           guard (path confinement), container (docker/podman), shell detection
  browser/           Playwright service (policy, control hand-off) + the browser_* tools
  swarm/             message bus, wake rules, budget guard, persistence (store.ts), swarm_* tools
  server/            `nacre serve`: HTTP + SSE API, auth, session manager (web/ holds the dashboard)
  ext/               extensions, skills, prompt templates, MCP client
  config/            zod schema, layered loading, trust model, auth store
  tui/               Ink UI: store (events → state), views, input, dialogs, slash commands, theme
  modes/             print/json and rpc
web/                 the dashboard: plain HTML/CSS/JS, bundled fonts, no build step
```

## Design decisions

**One loop, many surfaces.** `Runtime` owns everything; the TUI, `-p` mode and RPC mode are thin adapters over the same
`Agent` event stream. Nothing in `agent/`, `tools/`, `policy/` or `swarm/` imports the UI.

**Provider-neutral messages.** Conversations are stored as `{role, content[]}` blocks (text, thinking, tool_use,
tool_result, image). Each provider adapter converts at the edge. OpenAI-compatible servers that omit tool-call ids, or
report `stop` while calling tools, are normalised.

**Every `tool_use` gets a `tool_result`.** Aborts, denials, unknown tools, malformed JSON and hook blocks all still
produce a result, so the transcript is always valid for the next request.

**Policy is separate from tools.** Tools declare a _risk_ (`read`, `edit`, `exec`, `network`, `browser`, `agent`) and a
`primaryArg`; `PolicyEngine` decides. Order: hard blocklist → deny rules → plan-mode read-only → ask rules →
escalations → allow rules → session grants → read-only shell commands → mode default.

**UI state lives outside React.** `UiStore` folds agent events into snapshots published at ≤30 fps, consumed via
`useSyncExternalStore`. Finished items go into Ink's `<Static>` so they stay in your terminal scrollback.

**Swarm = N agents + a bus.** Each swarm member is an ordinary `Agent` with its own session. `Swarm.route` records the
message, wakes the addressee (or the lead for unaddressed user messages), and queues everything else as context for the
next wake-up. A running agent is _steered_ instead of restarted.

## Adding a tool

```ts
export const myTool = defineTool({
  name: 'my_tool',
  description: 'What the model should know',
  risk: 'read', // drives approval policy
  schema: z.object({ path: z.string() }),
  primaryArg: (i) => i.path, // what allow/deny rules match
  describe: (i) => i.path, // one-line label in the UI
  async execute(input, ctx) {
    // ctx: cwd, sandbox, signal, readState, progress, ask, browser, swarm...
    const path = ctx.sandbox.checkPath(input.path, 'read');
    return { content: '...' };
  },
});
```

Register it in `runtime.ts` (or ship it as an extension). File tools must always go through `ctx.sandbox.checkPath`.

## Testing

`vitest` suites cover provider streaming, the agent loop with a scripted model, policy, sandbox, config trust, sessions
and compaction, swarm routing, extensions/MCP (against a real stdio server), the Ink UI (rendered into a fake TTY), the
live browser (real Chrome/Edge, skipped where absent) and the container sandbox (real Docker, skipped without the
image). `test/mock-llm.ts` is an OpenAI-compatible server used both by tests and `npm run mock`.
