import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../src/agent/agent.js';
import { Session } from '../src/agent/session.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { GuardSandbox } from '../src/sandbox/guard.js';
import { Swarm } from '../src/swarm/swarm.js';
import { swarmTools } from '../src/swarm/tools.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { callTool, resolved, say, ScriptedProvider, testConfig, tmpWorkspace } from './helpers.js';

let ws: ReturnType<typeof tmpWorkspace>;
beforeEach(() => (ws = tmpWorkspace()));
afterEach(() => ws.cleanup());

function build(providers: Record<string, ScriptedProvider>, opts: { maxMessages?: number } = {}) {
  const config = testConfig();
  const policy = new PolicyEngine({ mode: 'auto', rules: [] });
  const swarm = new Swarm({
    maxAgents: 4,
    maxMessages: opts.maxMessages ?? 20,
    allowSpawn: true,
    createAgent: (cfg, member) => {
      const tools = new ToolRegistry();
      for (const t of swarmTools) tools.register(t);
      return new Agent({
        id: cfg.name,
        cwd: ws.dir,
        config,
        model: resolved(providers[cfg.name]!),
        tools,
        policy,
        sandbox: new GuardSandbox({ cwd: ws.dir }),
        session: Session.create(ws.dir),
        approver: async () => ({ allow: true }),
        system: () => `you are ${cfg.name}`,
        services: { swarm: member },
      });
    },
  });
  return swarm;
}

describe('swarm', () => {
  it('routes an unaddressed user message to the lead only', async () => {
    const lead = new ScriptedProvider([say('on it')]);
    const worker = new ScriptedProvider([]);
    const swarm = build({ lead, worker });
    await swarm.addAgent({ name: 'lead', role: 'lead' });
    await swarm.addAgent({ name: 'worker', role: 'worker' });
    swarm.say('please build the thing');
    await swarm.idle();
    expect(lead.requests).toHaveLength(1);
    expect(worker.requests).toHaveLength(0);
  });

  it('lets agents talk to each other live and wakes the addressee', async () => {
    const lead = new ScriptedProvider([
      callTool('a', 'swarm_say', { to: 'worker', text: 'write the parser' }),
      say('delegated'),
      say('thanks, all done'),
    ]);
    const worker = new ScriptedProvider([
      callTool('b', 'swarm_say', { to: 'lead', text: 'parser done' }),
      say('reported'),
    ]);
    const swarm = build({ lead, worker });
    await swarm.addAgent({ name: 'lead', role: 'lead' });
    await swarm.addAgent({ name: 'worker', role: 'worker' });
    const seen: string[] = [];
    swarm.events.on(
      'message',
      (m) => m.kind === 'chat' && seen.push(`${m.from}->${m.to ?? 'all'}: ${m.text}`),
    );

    swarm.say('ship it');
    // wait until the whole conversation settles
    for (let i = 0; i < 20; i++) {
      await swarm.idle();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(seen).toEqual([
      'you->all: ship it',
      'lead->worker: write the parser',
      'worker->lead: parser done',
    ]);
    expect(JSON.stringify(worker.requests[0]!.messages)).toContain('write the parser');
    expect(JSON.stringify(lead.requests[2]!.messages)).toContain('parser done');
  });

  it('delivers @mentions and gives sleeping agents the channel context on wake', async () => {
    const lead = new ScriptedProvider([
      callTool('a', 'swarm_say', { text: 'FYI the schema changed' }),
      say('ok'),
    ]);
    const worker = new ScriptedProvider([say('noted')]);
    const swarm = build({ lead, worker });
    await swarm.addAgent({ name: 'lead', role: 'lead' });
    await swarm.addAgent({ name: 'worker', role: 'worker' });
    swarm.say('start');
    await swarm.idle();
    expect(worker.requests).toHaveLength(0); // broadcast did not wake the worker
    swarm.say('@worker what changed?');
    await swarm.idle();
    const prompt = JSON.stringify(worker.requests[0]!.messages);
    expect(prompt).toContain('FYI the schema changed');
    expect(prompt).toContain('what changed?');
  });

  it('stops runaway agent chatter at the message budget until the user speaks', async () => {
    const pingpong = (self: string, other: string) =>
      new ScriptedProvider(
        Array.from({ length: 40 }, (_, i) =>
          i % 2 === 0
            ? callTool(`${self}${i}`, 'swarm_say', { to: other, text: `ping ${i}` })
            : say('waiting'),
        ),
      );
    const a = pingpong('a', 'b');
    const b = pingpong('b', 'a');
    const swarm = build({ a, b }, { maxMessages: 4 });
    await swarm.addAgent({ name: 'a', role: 'x' });
    await swarm.addAgent({ name: 'b', role: 'y' });
    let exhausted = false;
    swarm.events.on('budget_exhausted', () => (exhausted = true));
    swarm.say('begin');
    for (let i = 0; i < 30; i++) {
      await swarm.idle();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(exhausted).toBe(true);
    expect(swarm.log.filter((m) => m.kind === 'chat' && m.from !== 'you').length).toBeLessThanOrEqual(4);
  });

  it('rejects messages to unknown teammates and enforces the agent cap', async () => {
    const a = new ScriptedProvider([callTool('x', 'swarm_say', { to: 'ghost', text: 'hello?' }), say('ok')]);
    const swarm = build({ a });
    await swarm.addAgent({ name: 'a', role: 'x' });
    swarm.say('go');
    await swarm.idle();
    const result = a.requests[1]!.messages.at(-1)!.content[0]!;
    expect(result.type === 'tool_result' && result.isError).toBe(true);
    await expect(swarm.addAgent({ name: 'a', role: 'dup' })).rejects.toThrow(/already exists/);
  });
});
