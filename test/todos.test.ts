import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StreamRequest } from '../src/llm/types.js';
import { todoTool } from '../src/tools/misc.js';
import { AutoProvider, callTool, makeAgent, say, standardTools, tmpWorkspace } from './helpers.js';

let ws: ReturnType<typeof tmpWorkspace>;
beforeEach(() => (ws = tmpWorkspace()));
afterEach(() => ws.cleanup());

const tools = () => standardTools().register(todoTool);
const plan = (...statuses: ('pending' | 'in_progress' | 'completed')[]) => ({
  todos: statuses.map((status, i) => ({ content: `step ${i + 1}`, status })),
});
const lastUserText = (r: StreamRequest) => {
  const m = r.messages.at(-1)!;
  return m.role === 'user' ? m.content.map((b) => (b.type === 'text' ? b.text : '')).join('') : '';
};

describe('keeping the task list current', () => {
  it('reminds the model once when it finishes work with items still open, then lets it end', async () => {
    const p = new AutoProvider([
      callTool('t1', 'todo_write', plan('in_progress', 'pending')),
      callTool('l1', 'ls', { path: '.' }),
      say('Built both steps.'),
      // After the reminder: the list is brought up to date, with a short line.
      callTool('t2', 'todo_write', plan('completed', 'completed')),
      say('List updated.'),
    ]);
    const { agent, events } = makeAgent(ws.dir, p, { tools: tools() });
    await agent.run('build two things');
    const calls = p.calls;
    expect(calls).toHaveLength(5);
    const reminder = lastUserText(calls[3]!);
    expect(reminder).toContain('[Task list check]');
    expect(reminder).toContain('[~] step 1');
    expect(reminder).toContain('[ ] step 2');
    expect(events.some((e) => e.type === 'turn_end' && e.stopReason === 'end_turn')).toBe(true);
  });

  it('does not remind twice, even if the list is still open', async () => {
    const p = new AutoProvider([
      callTool('t1', 'todo_write', plan('in_progress')),
      callTool('l1', 'ls', { path: '.' }),
      say('Done.'),
      say('Step 1 was not finished.'),
    ]);
    const { agent } = makeAgent(ws.dir, p, { tools: tools() });
    await agent.run('go');
    expect(p.calls).toHaveLength(4);
  });

  it('does not remind when the list is finished, or when the turn did no work', async () => {
    const done = new AutoProvider([
      callTool('t1', 'todo_write', plan('completed')),
      callTool('l1', 'ls', { path: '.' }),
      say('Done.'),
    ]);
    await makeAgent(ws.dir, done, { tools: tools() }).agent.run('go');
    expect(done.calls).toHaveLength(3);

    // An open list from earlier, then a question that needs no tools: no reminder.
    const chat = new AutoProvider([
      callTool('t1', 'todo_write', plan('pending')),
      say('Planned.'),
      say('Four.'),
    ]);
    const { agent } = makeAgent(ws.dir, chat, { tools: tools() });
    await agent.run('plan it');
    await agent.run('what is 2 + 2?');
    expect(chat.calls).toHaveLength(3);
  });

  it('tells the model what is next when it updates the list', async () => {
    const r = await todoTool.execute(plan('completed', 'in_progress', 'pending'), {} as never);
    expect(r.content).toContain('1/3 done');
    expect(r.content).toContain('Next: step 2');
  });
});
