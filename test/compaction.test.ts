import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/agent/agent.js';
import { estimateMessages, sanitizeMessages } from '../src/agent/context.js';
import { Session } from '../src/agent/session.js';
import { configSchema } from '../src/config/schema.js';
import { ProviderError, type Message, type StreamRequest } from '../src/llm/types.js';
import { readTool } from '../src/tools/fs-tools.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { AutoProvider, callTool, makeAgent, say, tmpWorkspace } from './helpers.js';

let ws: ReturnType<typeof tmpWorkspace>;
beforeEach(() => (ws = tmpWorkspace()));
afterEach(() => ws.cleanup());

const WINDOW = 4000; // target (80%) = 3200 tokens, hard limit = 3744
const SUMMARY = say(
  'Summary: the user and the assistant discussed many numbered topics; no work is pending right now.',
);

const isSummary = AutoProvider.isSummary;
const mainCalls = (p: AutoProvider) => p.calls;
const text = (m: Message) => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
const user = (t: string): Message => ({ role: 'user', content: [{ type: 'text', text: t }] });
const asst = (t: string): Message => ({ role: 'assistant', content: [{ type: 'text', text: t }] });

/** Minimal tool set so the fixed prompt overhead is small relative to the tiny test windows. */
const readOnly = () => new ToolRegistry().register(readTool);

function fill(session: Session, pairs: number, chars = 1200) {
  for (let i = 0; i < pairs; i++) {
    session.append(user(`question ${i}: ${'q'.repeat(chars)}`));
    session.append(asst(`answer ${i}: ${'a'.repeat(chars)}`));
  }
}

const used = (r: StreamRequest) => estimateMessages(r.messages);

describe('automatic compaction at 80% of the context window', () => {
  it('compacts before the request that would cross the threshold, then sends a smaller one', async () => {
    const session = Session.create(ws.dir);
    fill(session, 6); // ≈ 4200 estimated tokens: over the 3200 trigger
    const p = new AutoProvider([say('ok')]);
    const { agent, events } = makeAgent(ws.dir, p, { window: WINDOW, session, tools: readOnly() });
    await agent.run('continue please');

    expect(isSummary(p.requests[0]!)).toBe(true); // the summariser ran first…
    const real = mainCalls(p);
    expect(real).toHaveLength(1); // …and only then the real request
    expect(text(real[0]!.messages[0]!)).toContain('[Summary of the earlier conversation]');
    expect(used(real[0]!)).toBeLessThan(0.8 * WINDOW);

    const kinds = events.map((e) => (e.type === 'compaction' ? `compaction:${e.phase}` : e.type));
    expect(kinds.indexOf('compaction:start')).toBeGreaterThan(-1);
    expect(kinds.indexOf('compaction:end')).toBeGreaterThan(kinds.indexOf('compaction:start'));
    expect(kinds.indexOf('compaction:end')).toBeLessThan(kinds.indexOf('usage')); // before the model call
  });

  it('does nothing below the threshold', async () => {
    const session = Session.create(ws.dir);
    fill(session, 1, 200);
    const p = new AutoProvider([say('ok')]);
    const { agent } = makeAgent(ws.dir, p, { window: WINDOW, session, tools: readOnly() });
    await agent.run('hi');
    expect(p.requests).toHaveLength(1);
    expect(session.path().some((e) => e.type === 'compaction')).toBe(false);
  });

  it('uses the provider-reported size, not just the estimate', async () => {
    const session = Session.create(ws.dir);
    fill(session, 3, 300); // small by estimate
    writeFileSync(join(ws.dir, 'f.txt'), 'hello');
    const p = new AutoProvider([
      [
        ...callTool('t1', 'read', { path: 'f.txt' }).filter((e) => e.type !== 'done'),
        { type: 'usage', usage: { inputTokens: 3300, outputTokens: 40 } }, // server says: 83% full
        { type: 'done', stopReason: 'tool_use' },
      ],
      say('done'),
    ]);
    const { agent } = makeAgent(ws.dir, p, { window: WINDOW, session, tools: readOnly() });
    await agent.run('read it');
    // call order: model → (tool) → summariser → model
    expect(p.requests.map((r) => (isSummary(r) ? 'summary' : 'model'))).toEqual([
      'model',
      'summary',
      'model',
    ]);
  });

  it('can never be configured above 80% or switched off', () => {
    expect(configSchema.safeParse({ compaction: { threshold: 0.9 } }).success).toBe(false);
    expect(configSchema.parse({}).compaction).toEqual({ threshold: 0.8, keepRecent: 6 });
    expect('enabled' in configSchema.parse({ compaction: { enabled: false } }).compaction).toBe(false);
  });

  it('honours a lower configured threshold', async () => {
    const { agent } = makeAgent(ws.dir, new AutoProvider([]), {
      window: 10_000,
      tools: readOnly(),
      config: { compaction: { threshold: 0.5 }, maxTokens: 1000 },
    });
    expect(agent.limits().target).toBe(5000);
  });
});

describe('the chat is paused while compacting', () => {
  it('holds all model calls and queues what the user types, then delivers it in order', async () => {
    const session = Session.create(ws.dir);
    fill(session, 6);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = new AutoProvider([say('answered both')], async () => (await gate, SUMMARY));
    const { agent } = makeAgent(ws.dir, p, { window: WINDOW, session, tools: readOnly() });

    const run = agent.run('first message');
    for (let i = 0; i < 200 && !agent.isCompacting; i++) await new Promise((r) => setTimeout(r, 5));
    expect(agent.isCompacting).toBe(true);

    agent.steer('typed during compaction');
    expect(agent.queued).toBe(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(mainCalls(p)).toHaveLength(0); // nothing reached the model while paused
    expect(p.requests).toHaveLength(1); // only the summariser is running

    release();
    await run;
    const real = mainCalls(p);
    expect(real).toHaveLength(1);
    const texts = real[0]!.messages.map(text);
    expect(texts.findIndex((t) => t.includes('first message'))).toBeLessThan(
      texts.findIndex((t) => t.includes('typed during compaction')),
    );
    expect(agent.queued).toBe(0);
  });

  it('pauses the turn — without losing or corrupting anything — when compaction keeps failing', async () => {
    const session = Session.create(ws.dir);
    fill(session, 6);
    const before = JSON.stringify(session.messages());
    const boom = () => {
      throw new ProviderError('model server is down', 503);
    };
    const p = new AutoProvider([], boom);
    const { agent, events } = makeAgent(ws.dir, p, { window: WINDOW, session, tools: readOnly() });
    await agent.run('please continue');

    const types = events.map((e) => e.type);
    expect(types).toContain('paused');
    expect(events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'paused' });
    expect(mainCalls(p)).toHaveLength(0); // no oversized request was ever sent
    expect(session.path().some((e) => e.type === 'compaction')).toBe(false); // session untouched by the failure
    expect(JSON.stringify(session.messages())).toBe(
      JSON.stringify([...JSON.parse(before), user('please continue')]),
    ); // old history intact + the user's message kept

    // The server comes back: the next message compacts and goes through, with nothing lost.
    p.summary = SUMMARY;
    p.main.push(say('back to normal'));
    await agent.run('are you there?');
    expect(events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'end_turn' });
    const flat = JSON.stringify(mainCalls(p).at(-1)!.messages);
    expect(flat).toContain('are you there?');
  });

  it('leaves the session unchanged if the user aborts during compaction', async () => {
    const session = Session.create(ws.dir);
    fill(session, 6);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = new AutoProvider([], async () => (await gate, SUMMARY));
    const { agent, events } = makeAgent(ws.dir, p, { window: WINDOW, session, tools: readOnly() });
    const run = agent.run('go');
    for (let i = 0; i < 200 && !agent.isCompacting; i++) await new Promise((r) => setTimeout(r, 5));
    agent.abort();
    release();
    await run;
    expect(events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'aborted' });
    expect(session.path().some((e) => e.type === 'compaction')).toBe(false);
    expect(mainCalls(p)).toHaveLength(0);
  });
});

describe('no data loss and no corrupt conversations', () => {
  it('keeps every original message on disk and resumes identically', async () => {
    const dir = join(ws.dir, 'sessions');
    const session = Session.create(ws.dir, dir);
    fill(session, 6);
    const originals = session.messageEntries().map((e) => JSON.stringify(e.message));
    const p = new AutoProvider([say('ok')]);
    const { agent } = makeAgent(ws.dir, p, { window: WINDOW, session, tools: readOnly() });
    await agent.run('continue');

    const file = join(dir, `${session.id}.jsonl`);
    const onDisk = readFileSync(file, 'utf8');
    for (const m of originals) expect(onDisk).toContain(m); // nothing was deleted or rewritten
    expect(onDisk.split('\n').filter((l) => l.includes('"type":"compaction"'))).toHaveLength(1);

    const reloaded = Session.load(file);
    expect(JSON.stringify(reloaded.messages())).toBe(JSON.stringify(session.messages()));
  });

  it('can compact in the middle of a long tool loop and keeps tool_use/tool_result pairs together', async () => {
    const session = Session.create(ws.dir);
    session.append(user('analyse the files'));
    for (let i = 0; i < 6; i++) {
      session.append({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `t${i}`, name: 'read', input: { path: `file${i}.txt` } }],
      });
      session.append({
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: `t${i}`, content: 'r'.repeat(1500) }],
      });
    }
    const p = new AutoProvider([say('finished')]);
    const { agent } = makeAgent(ws.dir, p, { window: WINDOW, session, tools: readOnly() });
    await agent.run('and then?');
    const sent = mainCalls(p)[0]!.messages;
    expect(sanitizeMessages(sent)).toEqual(sent); // already valid: no orphans, no missing results
    expect(used(mainCalls(p)[0]!)).toBeLessThan(0.8 * WINDOW);
  });

  it('repairs a tool call left unanswered by a crash before sending anything', async () => {
    const session = Session.create(ws.dir);
    session.append(user('do the thing'));
    session.append({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'lost', name: 'read', input: { path: 'x' } }],
    });
    // (process died here: no tool_result was ever written)
    const p = new AutoProvider([say('recovered')]);
    const { agent } = makeAgent(ws.dir, p, { session, tools: readOnly() });
    await agent.run('hello again');
    const sent = p.requests[0]!.messages;
    expect(sent[2]!.content[0]).toMatchObject({ type: 'tool_result', toolUseId: 'lost', isError: true });
    expect(session.messages().some((m) => JSON.stringify(m).includes('Interrupted before'))).toBe(true);
  });

  it('sanitises orphaned and missing tool results in any message list', () => {
    const broken: Message[] = [
      user('a'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'read', input: {} }] },
      user('no result for x, and a stray one:'),
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'ghost', content: 'orphan' }] },
    ];
    const fixed = sanitizeMessages(broken);
    expect(JSON.stringify(fixed)).not.toContain('orphan');
    expect(fixed[2]!.content[0]).toMatchObject({ type: 'tool_result', toolUseId: 'x', isError: true });
    expect(sanitizeMessages(fixed)).toEqual(fixed); // idempotent
  });

  it('truncates a huge tool result so one command cannot blow the window', async () => {
    writeFileSync(join(ws.dir, 'big.txt'), 'line of text\n'.repeat(20_000));
    const p = new AutoProvider([callTool('t1', 'read', { path: 'big.txt' }), say('seen')]);
    const { agent } = makeAgent(ws.dir, p, { window: WINDOW, tools: readOnly() });
    await agent.run('read big.txt');
    const result = p.requests[1]!.messages.at(-1)!.content[0]!;
    expect(result.type === 'tool_result' && result.content.length).toBeLessThan(3500);
    expect(result.type === 'tool_result' && result.content).toContain('truncated');
  });
});

describe('hard limits', () => {
  it('refuses to send a request that cannot be made to fit, and pauses instead', async () => {
    const session = Session.create(ws.dir);
    fill(session, 2, 300);
    const p = new AutoProvider([]);
    const { agent, events } = makeAgent(ws.dir, p, { window: 3000, session, tools: readOnly() });
    await agent.run('x'.repeat(30_000)); // one message larger than the whole window
    expect(events.some((e) => e.type === 'paused')).toBe(true);
    expect(mainCalls(p)).toHaveLength(0);
    for (const r of p.requests) expect(used(r)).toBeLessThan(3000); // not even the summariser got an oversized prompt
  });

  it('learns the real window from a provider overflow error, compacts harder and retries', async () => {
    const session = Session.create(ws.dir);
    fill(session, 5, 600);
    const p = new AutoProvider([
      () => {
        throw new ProviderError(
          'request (9000 tokens) exceeds the available context size (4096 tokens)',
          400,
        );
      },
      say('worked after all'),
    ]);
    // We *believe* the window is 200k, so nothing triggers; the server knows better.
    const { agent, events } = makeAgent(ws.dir, p, { window: 200_000, session, tools: readOnly() });
    await agent.run('go');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(agent.model.contextWindow).toBeLessThan(200_000);
    expect(mainCalls(p).at(-1)!.messages.map(text).join()).toContain('Summary');
  });

  it('keeps the reply budget inside the window', async () => {
    const p = new AutoProvider([say('ok')]);
    const { agent } = makeAgent(ws.dir, p, {
      window: WINDOW,
      tools: readOnly(),
      config: { maxTokens: 8192 },
    });
    await agent.run('hi');
    expect(p.requests[0]!.maxTokens).toBeLessThan(WINDOW);
  });
});

describe('events', () => {
  it('reports compaction progress and the queue size to UIs', async () => {
    const session = Session.create(ws.dir);
    fill(session, 6);
    const p = new AutoProvider([say('ok')]);
    const { agent, events } = makeAgent(ws.dir, p, { window: WINDOW, session, tools: readOnly() });
    agent.steer('queued');
    await agent.run('go');
    type Compaction = Extract<AgentEvent, { type: 'compaction' }>;
    const start = events.find((e) => e.type === 'compaction' && e.phase === 'start') as
      Extract<Compaction, { phase: 'start' }> | undefined;
    const end = events.find((e) => e.type === 'compaction' && e.phase === 'end') as
      Extract<Compaction, { phase: 'end' }> | undefined;
    expect(start?.pct).toBeGreaterThanOrEqual(80);
    expect(end?.ok).toBe(true);
    expect(end?.afterPct).toBeLessThan(80);
    expect(events.filter((e) => e.type === 'queued').length).toBeGreaterThan(0);
  });
});
