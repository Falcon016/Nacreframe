# NexusHarness: notes for coding agents

TypeScript (ESM, strict), Node ≥ 22.18, Ink 8 + React 19 for the TUI, zod 4 for schemas, vitest for tests.

- Verify with `npm run check` (typecheck + eslint + vitest + secret scan). Format with `npm run format`.
- Source layout and design rationale: `docs/architecture.md`. Security model: `docs/security.md`.
- Imports use the `.js` extension (NodeNext), even for `.ts`/`.tsx` sources.
- File tools must call `ctx.sandbox.checkPath()`. Content from the web, browser or MCP must go through `wrapUntrusted()`.
- Never add secrets to the repo, tests or fixtures. Use obvious placeholders.
- Tests that need Chrome or Docker must skip themselves when unavailable.
- Write files with LF endings (`.gitattributes` enforces this).
