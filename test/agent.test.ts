import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Approver } from '../src/agent/agent.js';
import { callTool, makeAgent, say, ScriptedProvider, tmpWorkspace } from './helpers.js';

let ws: ReturnType<typeof tmpWorkspace>;
beforeEach(() => (ws = tmpWorkspace()));
afterEach(() => ws.cleanup());

describe('agent loop', () => {
  it('runs a tool call and feeds the result back to the model', async () => {
    writeFileSync(join(ws.dir, 'a.txt'), 'hello\nworld\n');
    const p = new ScriptedProvider([callTool('t1', 'read', { path: 'a.txt' }), say('It says hello.')]);
    const { agent, events } = makeAgent(ws.dir, p);
    await agent.run('what is in a.txt?');

    expect(events.map((e) => e.type)).toContain('tool_end');
    const second = p.requests[1]!;
    const last = second.messages.at(-1)!;
    expect(last.role).toBe('user');
    const block = last.content[0]!;
    expect(block.type).toBe('tool_result');
    expect(block.type === 'tool_result' && block.content).toContain('hello');
    expect(events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'end_turn' });
  });

  it('edits a file only after it has been read, and rejects stale edits', async () => {
    const f = join(ws.dir, 'b.txt');
    writeFileSync(f, 'one\ntwo\n');
    const blind = new ScriptedProvider([
      callTool('t1', 'edit', { path: 'b.txt', old_string: 'one', new_string: '1' }),
      say('done'),
    ]);
    const a1 = makeAgent(ws.dir, blind);
    await a1.agent.run('edit');
    const res = blind.requests[1]!.messages.at(-1)!.content[0]!;
    expect(res.type === 'tool_result' && res.isError).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('one\ntwo\n');

    const ok = new ScriptedProvider([
      callTool('t1', 'read', { path: 'b.txt' }),
      callTool('t2', 'edit', { path: 'b.txt', old_string: 'one', new_string: '1' }),
      say('done'),
    ]);
    const a2 = makeAgent(ws.dir, ok);
    await a2.agent.run('edit');
    expect(readFileSync(f, 'utf8')).toBe('1\ntwo\n');
  });

  it('refuses an edit when another writer changed the file after the read', async () => {
    const f = join(ws.dir, 'c.txt');
    writeFileSync(f, 'x\n');
    const p = new ScriptedProvider([
      callTool('t1', 'read', { path: 'c.txt' }),
      () => {
        writeFileSync(f, 'changed by someone else\n');
        const future = new Date(Date.now() + 5000);
        // ensure mtime moves even on coarse filesystems
        import('node:fs').then((fs) => fs.utimesSync(f, future, future));
        return callTool('t2', 'edit', { path: 'c.txt', old_string: 'x', new_string: 'y' });
      },
      say('ok'),
    ]);
    const { agent } = makeAgent(ws.dir, p);
    await agent.run('go');
    await new Promise((r) => setTimeout(r, 50));
    expect(readFileSync(f, 'utf8')).toBe('changed by someone else\n');
  });

  it('asks for approval in ask mode and honours a denial with feedback', async () => {
    const asked: string[] = [];
    const approver: Approver = async (req) => {
      asked.push(req.toolName);
      return { allow: false, feedback: 'not now' };
    };
    const p = new ScriptedProvider([callTool('t1', 'write', { path: 'n.txt', content: 'x' }), say('ok')]);
    const { agent, events } = makeAgent(ws.dir, p, { mode: 'ask', approver });
    await agent.run('write it');
    expect(asked).toEqual(['write']);
    expect(events.some((e) => e.type === 'tool_denied')).toBe(true);
    const r = p.requests[1]!.messages.at(-1)!.content[0]!;
    expect(r.type === 'tool_result' && r.content).toContain('not now');
    expect(() => readFileSync(join(ws.dir, 'n.txt'))).toThrow();
  });

  it('plan mode denies edits without asking', async () => {
    let asked = false;
    const approver: Approver = async () => ((asked = true), { allow: true });
    const p = new ScriptedProvider([callTool('t1', 'write', { path: 'n.txt', content: 'x' }), say('ok')]);
    const { agent } = makeAgent(ws.dir, p, { mode: 'plan', approver });
    await agent.run('write it');
    expect(asked).toBe(false);
    expect(() => readFileSync(join(ws.dir, 'n.txt'))).toThrow();
  });

  it('always answers every tool_use, even for unknown tools and invalid input', async () => {
    const p = new ScriptedProvider([
      [
        ...callTool('t1', 'nope', {}).filter((e) => e.type !== 'done'),
        ...callTool('t2', 'read', { wrong: 1 }),
      ],
      say('recovered'),
    ]);
    const { agent } = makeAgent(ws.dir, p);
    await agent.run('go');
    const results = p.requests[1]!.messages.at(-1)!.content;
    expect(results).toHaveLength(2);
    expect(results.every((b) => b.type === 'tool_result' && b.isError)).toBe(true);
  });

  it('keeps the transcript valid when aborted mid-run', async () => {
    const p = new ScriptedProvider([
      callTool('t1', 'bash', { command: 'node -e "setTimeout(()=>{},30000)"' }),
      say('never'),
    ]);
    const { agent, events } = makeAgent(ws.dir, p);
    const run = agent.run('sleep');
    await new Promise((r) => setTimeout(r, 600));
    agent.abort();
    await run;
    expect(events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'aborted' });
    const msgs = agent.session.messages();
    const last = msgs.at(-1)!;
    expect(last.content[0]!.type).toBe('tool_result');
  });

  it('delivers steering messages before the next model call', async () => {
    writeFileSync(join(ws.dir, 'a.txt'), 'x');
    const p = new ScriptedProvider([callTool('t1', 'read', { path: 'a.txt' }), say('adjusted')]);
    const { agent } = makeAgent(ws.dir, p);
    const run = agent.run('start');
    agent.steer('actually, be brief');
    await run;
    const flat = JSON.stringify(p.requests[1]!.messages);
    expect(flat).toContain('actually, be brief');
  });

  it('redacts secrets in tool output before they reach the model', async () => {
    writeFileSync(join(ws.dir, 'note.txt'), 'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 end');
    const p = new ScriptedProvider([callTool('t1', 'read', { path: 'note.txt' }), say('ok')]);
    const { agent } = makeAgent(ws.dir, p);
    await agent.run('read');
    expect(JSON.stringify(p.requests[1]!.messages)).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });
});
