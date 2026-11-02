import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compact } from '../src/agent/compaction.js';
import { sanitizeMessages } from '../src/agent/context.js';
import { Session } from '../src/agent/session.js';
import type { Message } from '../src/llm/types.js';
import { applyEdit } from '../src/tools/fs-tools.js';
import { unifiedDiff } from '../src/util/diff.js';
import { globMatch } from '../src/util/glob.js';
import { say, ScriptedProvider, tmpWorkspace } from './helpers.js';

let ws: ReturnType<typeof tmpWorkspace>;
beforeEach(() => (ws = tmpWorkspace()));
afterEach(() => ws.cleanup());

const user = (t: string): Message => ({ role: 'user', content: [{ type: 'text', text: t }] });
const asst = (t: string): Message => ({ role: 'assistant', content: [{ type: 'text', text: t }] });

describe('session tree', () => {
  it('persists, reloads and branches without losing the original path', () => {
    const dir = join(ws.dir, 's');
    const s = Session.create(ws.dir, dir);
    s.append(user('one'));
    const a1 = s.append(asst('first answer'));
    s.append(user('two'));
    s.append(asst('second'));

    s.branchTo(a1);
    s.append(user('two-alt'));
    expect(s.messages().map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'one',
      'first answer',
      'two-alt',
    ]);

    const reloaded = Session.load(join(dir, `${s.id}.jsonl`));
    expect(reloaded.messages().map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'one',
      'first answer',
      'two-alt',
    ]);
    expect(reloaded.childrenOf(a1).length).toBe(2); // both branches still exist
    expect(Session.list(dir)).toHaveLength(1);
  });

  it('compacts old history into a summary and keeps the recent tail intact', async () => {
    const s = Session.create(ws.dir);
    for (let i = 0; i < 6; i++) {
      s.append(user(`question ${i}`));
      s.append(asst(`answer ${i}`));
    }
    const provider = new ScriptedProvider([
      say('SUMMARY: the user asked six questions and received six answers.'),
    ]);
    const res = await compact({ session: s, provider, model: 'm', window: 100_000, keepRecent: 4 });
    expect(res?.summary).toContain('SUMMARY');
    const msgs = s.messages();
    expect((msgs[0]!.content[0] as { text: string }).text).toContain('SUMMARY');
    expect(msgs.length).toBeLessThan(13);
    expect(msgs.at(-1)).toEqual(asst('answer 5'));
    // never starts the kept tail mid tool-exchange: first kept message is a user text message
    expect(msgs[1]!.role).toBe('user');
  });

  it('compacts inside a long tool loop without splitting tool_use / tool_result pairs', async () => {
    const s = Session.create(ws.dir);
    s.append(user('start'));
    for (let i = 0; i < 5; i++) {
      s.append({
        role: 'assistant',
        content: [{ type: 'tool_use', id: `t${i}`, name: 'read', input: { path: 'f'.repeat(40) } }],
      });
      s.append({
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: `t${i}`, content: 'x'.repeat(400) }],
      });
    }
    s.append(asst('done'));
    const res = await compact({
      session: s,
      provider: new ScriptedProvider([say('Summary: five files were read and nothing else happened yet.')]),
      model: 'm',
      window: 100_000,
      keepRecent: 3,
    });
    expect(res).toBeDefined();
    const view = s.messages();
    // every tool_use is answered immediately, and no tool_result is orphaned
    expect(sanitizeMessages(view)).toEqual(view);
    expect(view.length).toBeLessThan(s.messageEntries().length);
  });

  it('never summarises text it already summarised, and folds the old summary into the new one', async () => {
    const s = Session.create(ws.dir);
    for (let i = 0; i < 8; i++) {
      s.append(user(`question number ${i} with some padding text to give it weight`));
      s.append(asst(`answer number ${i} with some padding text to give it weight`));
    }
    const first = new ScriptedProvider([
      say('FIRST-SUMMARY covering the opening questions of the conversation.'),
    ]);
    await compact({ session: s, provider: first, model: 'm', window: 100_000, keepRecent: 6 });
    for (let i = 8; i < 14; i++) {
      s.append(user(`question number ${i} with some padding text to give it weight`));
      s.append(asst(`answer number ${i} with some padding text to give it weight`));
    }
    const second = new ScriptedProvider([say('SECOND-SUMMARY that now also covers the later questions.')]);
    await compact({ session: s, provider: second, model: 'm', window: 100_000, keepRecent: 6 });
    expect(JSON.stringify(second.requests[0]!.messages)).toContain('FIRST-SUMMARY'); // earlier summary is merged in
    expect((s.messages()[0]!.content[0] as { text: string }).text).toContain('SECOND-SUMMARY');
    expect(JSON.stringify(s.messages())).not.toContain('FIRST-SUMMARY');
  });
});

describe('edit helpers', () => {
  it('requires a unique match unless replace_all', () => {
    expect(applyEdit('a b a', 'b', 'c', false)).toBe('a c a');
    expect(() => applyEdit('a b a', 'a', 'z', false)).toThrow(/more than once/);
    expect(applyEdit('a b a', 'a', 'z', true)).toBe('z b z');
    expect(() => applyEdit('abc', 'x', 'y', false)).toThrow(/not found/);
  });

  it('produces a readable unified diff', () => {
    const d = unifiedDiff('a\nb\nc\nd\ne\n', 'a\nb\nC\nd\ne\n', 1);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.text).toContain('-c');
    expect(d.text).toContain('+C');
  });

  it('matches globs', () => {
    expect(globMatch('src/**/*.ts', 'src/a/b/c.ts')).toBe(true);
    expect(globMatch('src/**/*.ts', 'src/c.ts')).toBe(true);
    expect(globMatch('*.{ts,tsx}', 'a.tsx')).toBe(true);
    expect(globMatch('*.ts', 'a/b.ts')).toBe(false);
    expect(globMatch('.env.*', '.env.local')).toBe(true);
  });
});
