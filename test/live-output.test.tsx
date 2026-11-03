import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { describe, expect, it } from 'vitest';
import type { Agent, AgentEvent } from '../src/agent/agent.js';
import type { Message } from '../src/llm/types.js';
import { fitTail } from '../src/tui/markdown.js';
import { replayInto, settledLength, UiStore, type Item, type UiSnapshot } from '../src/tui/store.js';
import { LiveArea, todoRows } from '../src/tui/views.js';
import { Emitter } from '../src/util/emitter.js';

const plain = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A store wired to a stand-in agent whose events the test sends by hand. */
function wired(opts: { printAsStreamed?: boolean } = {}) {
  const store = new UiStore(opts);
  const events = new Emitter<{ event: AgentEvent }>();
  store.attachAgent({ events } as unknown as Agent);
  const send = (e: AgentEvent) => events.emit('event', e);
  const items = () => store.getSnapshot().items;
  const replies = () =>
    items().filter((i): i is Extract<Item, { kind: 'assistant' }> => i.kind === 'assistant');
  const stream = (text: string) => {
    for (const ch of text.match(/[\s\S]{1,7}/g) ?? []) send({ type: 'text', delta: ch });
  };
  const finish = (text: string, thinking?: string) =>
    send({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          ...(thinking ? [{ type: 'thinking' as const, text: thinking }] : []),
          { type: 'text', text },
        ],
      },
    });
  return { store, send, items, replies, stream, finish };
}

describe('replies printed as they stream', () => {
  it('finds the part of a reply that is final', () => {
    expect(settledLength('one\ntwo\nthr')).toBe(8);
    expect(settledLength('no newline yet')).toBe(0);
    // An open code block holds everything from its fence on, until it closes.
    expect(settledLength('intro\n```ts\nconst a = 1;\n')).toBe(6);
    expect(settledLength('intro\n```ts\nconst a = 1;\n```\nafter')).toBe(29);
    // So does a table, until a line that is not part of it.
    expect(settledLength('| a | b |\n|---|---|\n| 1 | 2 |\n')).toBe(0);
    expect(settledLength('| a | b |\n|---|---|\n| 1 | 2 |\n\nnext\n')).toBe(36);
  });

  it('prints finished lines straight away and keeps only the unfinished part live', () => {
    const ui = wired({ printAsStreamed: true });
    ui.send({ type: 'turn_start' });
    ui.send({ type: 'thinking', delta: 'Let me plan. ' });
    ui.stream('First paragraph.\n\nSecond line\n');
    // The reasoning goes first, then the reply's lines, before the reply is complete.
    expect(ui.items().map((i) => i.kind)).toEqual(['thinking', 'assistant', 'assistant']);
    expect(ui.replies().map((r) => [r.text, !!r.cont, !!r.gap])).toEqual([
      ['First paragraph.', false, false],
      ['Second line', true, true], // the blank line between them is kept
    ]);
    ui.stream('```ts\nconst a = 1;\n');
    expect(ui.replies()).toHaveLength(2); // the code block waits until it is closed
    expect(ui.store.getSnapshot().live[0]!.text).toBe('```ts\nconst a = 1;\n');
    ui.stream('```\nlast words');
    ui.finish('First paragraph.\n\nSecond line\n```ts\nconst a = 1;\n```\nlast words', 'Let me plan. ');
    expect(ui.replies().map((r) => r.text)).toEqual([
      'First paragraph.',
      'Second line',
      '```ts\nconst a = 1;\n```',
      'last words',
    ]);
    // The reasoning is printed once, and nothing is left live.
    expect(ui.items().filter((i) => i.kind === 'thinking')).toHaveLength(1);
    expect(ui.store.getSnapshot().live[0]!.text).toBe('');
  });

  it('prints a reply whole when nothing is printed early (the dashboard, and short replies)', () => {
    const ui = wired();
    ui.send({ type: 'turn_start' });
    ui.stream('one\ntwo\n');
    expect(ui.replies()).toHaveLength(0);
    ui.finish('one\ntwo');
    expect(ui.replies().map((r) => [r.text, !!r.cont])).toEqual([['one\ntwo', false]]);

    const short = wired({ printAsStreamed: true });
    short.send({ type: 'turn_start' });
    short.stream('Just one line');
    short.finish('Just one line');
    expect(short.replies().map((r) => [r.text, !!r.cont])).toEqual([['Just one line', false]]);
  });
});

describe('live area height', () => {
  it('keeps the end of a long block within the rows it is given', () => {
    const code = ['```py', ...Array.from({ length: 60 }, (_, i) => `x${i} = ${i}`), ''].join('\n');
    const fit = fitTail(code, 80, 10);
    expect(fit.hidden).toBeGreaterThan(0);
    const lines = fit.text.split('\n');
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines[0]).toBe('```py'); // still renders as code
    expect(fit.text).toContain('x59 = 59');
    expect(fitTail('short', 80, 10)).toEqual({ text: 'short', hidden: 0 });
    // One enormous line: its end is shown.
    expect(fitTail('a'.repeat(5000) + 'END', 50, 6).text.endsWith('END')).toBe(true);
  });

  it('shortens a long task list to what fits', () => {
    const todos = Array.from({ length: 14 }, (_, i) => ({
      content: `step ${i}`,
      status: (i < 6 ? 'completed' : i === 6 ? 'in_progress' : 'pending') as
        'completed' | 'in_progress' | 'pending',
    }));
    const r = todoRows(todos, 6);
    expect(r.doneHidden).toBe(6);
    expect(r.items[0]!.content).toBe('step 6'); // starts at the one in progress
    expect(1 + r.items.length + 1).toBeLessThanOrEqual(6);
    expect(r.moreHidden).toBe(8 - r.items.length);
  });

  it('never draws a live frame as tall as the window, however long the reply', async () => {
    class Tty extends PassThrough {
      isTTY = true;
      columns = 80;
      rows = 24;
    }
    const stdout = new Tty();
    let out = '';
    stdout.on('data', (d: Buffer) => (out += d.toString()));
    const text = [
      'Here is the file:',
      '```ts',
      ...Array.from({ length: 120 }, (_, i) => `const v${i} = ${i};`),
    ].join('\n');
    const snap: UiSnapshot = {
      items: [],
      live: [
        { name: 'main', text, thinking: 0, thought: '', tools: [], running: true, startedAt: Date.now() },
      ],
      swarmActive: false,
      browser: { open: false, holder: 'agent' },
      contextTokens: 0,
      tokens: { input: 0, output: 0 },
      queued: 0,
      showThinking: false,
    };
    const todos = Array.from({ length: 12 }, (_, i) => ({
      content: `step ${i}`,
      status: 'pending' as const,
    }));
    const app = render(<LiveArea snap={snap} todos={todos} showPanes={false} />, {
      stdout: stdout as never,
      patchConsole: false,
      interactive: true,
    });
    await sleep(100);
    app.unmount();
    const frame = plain(out).trimEnd().split('\n');
    // The live area shares the window with the input box and footer, so it must leave room for them too.
    expect(frame.length).toBeLessThan(24 - 5);
    expect(plain(out)).toContain('const v119 = 119;'); // the newest line is what shows
    expect(plain(out)).toContain('lines above');
  });
});

describe('replaying a session', () => {
  it('does not show the task list reminder as something the user typed', () => {
    const store = new UiStore();
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'build it' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'built' }] },
      {
        role: 'user',
        content: [{ type: 'text', text: '[Task list check] Your task list still shows 1 item' }],
      },
    ];
    replayInto(store, msgs);
    const users = store.getSnapshot().items.filter((i) => i.kind === 'user');
    expect(users.map((u) => (u.kind === 'user' ? u.text : ''))).toEqual(['build it']);
  });
});

describe('tokens per second', () => {
  it('times a reply from its first token to its last, live and at the end', async () => {
    const { SpeedMeter } = await import('../src/agent/agent.js');
    let now = 1000;
    const live: number[] = [];
    const m = new SpeedMeter(
      (tps) => live.push(tps),
      () => now,
    );
    // 350 characters (≈ 100 tokens) every 250 ms → about 400 tokens a second.
    for (let i = 0; i < 8; i++) {
      m.add(350);
      now += 250;
    }
    expect(live.length).toBeGreaterThan(0);
    expect(live.at(-1)).toBeGreaterThan(350);
    // The provider's count wins at the end: 600 tokens over the 1.75 s between first and last token.
    expect(m.final(600)).toBe(343);
    expect(new SpeedMeter(() => {}).final(500)).toBeUndefined(); // nothing streamed: nothing to time
  });

  it('shows the speed in the footer, and drops the least useful parts when the window is narrow', async () => {
    const { Footer, fitFooter } = await import('../src/tui/views.js');
    const parts = (ws: [number, number][]) => ws.map(([width, drop]) => ({ width, drop }));
    const [l, r] = fitFooter(
      parts([
        [8, 0],
        [9, 9],
        [13, 5],
      ]),
      parts([
        [10, 6],
        [11, 0],
        [12, 7],
      ]),
      54,
    );
    expect(l.map((p) => p.drop)).toEqual([0, 5]); // "shift+tab" (9) went first
    expect(r.map((p) => p.drop)).toEqual([6, 0]); // then the token totals (7)

    for (const columns of [120, 60]) {
      class Tty extends PassThrough {
        isTTY = true;
        columns = columns;
        rows = 24;
      }
      const stdout = new Tty();
      let out = '';
      stdout.on('data', (d: Buffer) => (out += d.toString()));
      const snap: UiSnapshot = {
        items: [],
        live: [],
        swarmActive: false,
        browser: { open: false, holder: 'agent' },
        contextTokens: 77_000,
        tokens: { input: 145_000, output: 27_000 },
        queued: 0,
        showThinking: true,
        speed: { tokensPerSecond: 42, live: true },
      };
      const app = render(
        <Footer mode="auto" sandbox="guard" snap={snap} contextWindow={100_000} swarmCount={0} queued={0} />,
        { stdout: stdout as never, patchConsole: false, interactive: true },
      );
      await sleep(50);
      app.unmount();
      const lines = plain(out)
        .trimEnd()
        .split('\n')
        .filter((l) => l.trim());
      expect(lines).toHaveLength(1); // one line, nothing run together
      expect(lines[0]).toContain('context 77%');
      if (columns === 120) expect(lines[0]).toContain('42 tok/s');
    }
  });
});
