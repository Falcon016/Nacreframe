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

function build(
  providers: Record<string, ScriptedProvider>,
  opts: { maxMessages?: number; maxToolIterations?: number } = {},
) {
  const config = testConfig(opts.maxToolIterations ? { maxToolIterations: opts.maxToolIterations } : {});
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

  // ---- reporting lines (small models drift out of role, so the harness enforces them) ----------

  const settle = async (swarm: Swarm) => {
    for (let i = 0; i < 20; i++) {
      await swarm.idle();
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('sends a teammate message meant for the user to the lead instead', async () => {
    const lead = new ScriptedProvider([
      callTool('a', 'swarm_say', { to: 'worker', text: 'build it' }),
      say('delegated'),
      say('worker asked a question; answering the user myself'),
    ]);
    const worker = new ScriptedProvider([
      callTool('b', 'swarm_say', { to: 'you', text: 'should I also do the bug pass?' }),
      say('waiting'),
    ]);
    const swarm = build({ lead, worker });
    await swarm.addAgent({ name: 'lead', role: 'lead' });
    await swarm.addAgent({ name: 'worker', role: 'worker' });
    swarm.say('go');
    await settle(swarm);
    const chat = swarm.log.filter((m) => m.kind === 'chat').map((m) => `${m.from}->${m.to ?? 'all'}`);
    expect(chat).toContain('worker->lead');
    expect(chat).not.toContain('worker->you');
    const result = worker.requests[1]!.messages.at(-1)!.content[0]!;
    expect(result.type === 'tool_result' && JSON.stringify(result)).toContain(
      'only the lead talks to the user',
    );
    expect(JSON.stringify(lead.requests[2]!.messages)).toContain('should I also do the bug pass?');
  });

  it("delivers a teammate's final text to whoever woke it when it ends its turn without reporting", async () => {
    const lead = new ScriptedProvider([
      callTool('a', 'swarm_say', { to: 'worker', text: 'write the parser' }),
      say('delegated'),
      say('parser is in; done'),
    ]);
    // A small model that just answers in plain text and stops, never calling swarm_say.
    const worker = new ScriptedProvider([say('Parser written in src/parse.ts; 4 tests pass.')]);
    const swarm = build({ lead, worker });
    await swarm.addAgent({ name: 'lead', role: 'lead' });
    await swarm.addAgent({ name: 'worker', role: 'worker' });
    swarm.say('ship it');
    await settle(swarm);
    const report = swarm.log.find((m) => m.from === 'worker');
    expect(report).toMatchObject({
      to: 'lead',
      auto: true,
      text: 'Parser written in src/parse.ts; 4 tests pass.',
    });
    expect(lead.requests).toHaveLength(3); // the report woke the lead, so the work carried on
    expect(JSON.stringify(lead.requests[2]!.messages)).toContain('4 tests pass');
  });

  it('routes "@teammate do X" written as plain text by the lead', async () => {
    const lead = new ScriptedProvider([say('@worker please add a README'), say('thanks')]);
    const worker = new ScriptedProvider([say('README added.')]);
    const swarm = build({ lead, worker });
    await swarm.addAgent({ name: 'lead', role: 'lead' });
    await swarm.addAgent({ name: 'worker', role: 'worker' });
    swarm.say('docs please');
    await settle(swarm);
    expect(worker.requests).toHaveLength(1);
    expect(JSON.stringify(worker.requests[0]!.messages)).toContain('please add a README');
    expect(lead.requests).toHaveLength(2); // and the worker's report came back
  });

  it("does not treat a passing @mention in the lead's answer as a hand-off", async () => {
    const lead = new ScriptedProvider([say('All done, thanks to @worker for the parser.')]);
    const worker = new ScriptedProvider([]);
    const swarm = build({ lead, worker });
    await swarm.addAgent({ name: 'lead', role: 'lead' });
    await swarm.addAgent({ name: 'worker', role: 'worker' });
    swarm.say('status?');
    await settle(swarm);
    expect(worker.requests).toHaveLength(0);
  });

  it('reminds each agent of its role and who it answers to on every wake-up', async () => {
    const lead = new ScriptedProvider([
      callTool('a', 'swarm_say', { to: 'worker', text: 'do it' }),
      say('ok'),
      say('done'),
    ]);
    const worker = new ScriptedProvider([say('did it')]);
    const swarm = build({ lead, worker });
    await swarm.addAgent({ name: 'lead', role: 'lead' });
    await swarm.addAgent({ name: 'worker', role: 'worker' });
    swarm.say('go');
    await settle(swarm);
    expect(JSON.stringify(lead.requests[0]!.messages)).toContain('You are lead, the lead');
    const w = JSON.stringify(worker.requests[0]!.messages);
    expect(w).toContain('You report to lead, never to the user');
    expect(w).toContain('delivered to lead automatically');
  });

  it('does not wake the lead when the user asked a teammate directly, but keeps it informed', async () => {
    const lead = new ScriptedProvider([say('later')]);
    const worker = new ScriptedProvider([say('the tests use vitest')]);
    const swarm = build({ lead, worker });
    await swarm.addAgent({ name: 'lead', role: 'lead' });
    await swarm.addAgent({ name: 'worker', role: 'worker' });
    swarm.say('@worker which test runner?');
    await settle(swarm);
    expect(lead.requests).toHaveLength(0);
    swarm.say('carry on');
    await settle(swarm);
    expect(JSON.stringify(lead.requests[0]!.messages)).toContain('the tests use vitest');
  });

  // ---- the message budget -------------------------------------------------------------------

  const pingpong = (self: string, other: string, n = 40) =>
    new ScriptedProvider(
      Array.from({ length: n }, (_, i) =>
        i % 2 === 0 ? callTool(`${self}${i}`, 'swarm_say', { to: other, text: `ping ${i}` }) : say('waiting'),
      ),
    );

  it('reports how much of the budget is used, and resets it when the user speaks', async () => {
    const a = pingpong('a', 'b', 8);
    const b = pingpong('b', 'a', 8);
    const swarm = build({ a, b }, { maxMessages: 4 });
    await swarm.addAgent({ name: 'a', role: 'x' });
    await swarm.addAgent({ name: 'b', role: 'y' });
    const seen: string[] = [];
    swarm.events.on('budget', (x) => seen.push(`${x.used}/${x.limit}`));
    swarm.say('begin');
    await settle(swarm);
    expect(seen.slice(0, 5)).toEqual(['0/4', '1/4', '2/4', '3/4', '4/4']);
    expect(swarm.budget()).toEqual({ used: 4, limit: 4 });
    swarm.say('keep going');
    expect(swarm.budget().used).toBe(0);
  });

  it('runs without a budget when the limit is 0, and a raised limit takes effect at once', async () => {
    const a = pingpong('a', 'b', 20);
    const b = pingpong('b', 'a', 20);
    const swarm = build({ a, b }, { maxMessages: 0 });
    await swarm.addAgent({ name: 'a', role: 'x' });
    await swarm.addAgent({ name: 'b', role: 'y' });
    let exhausted = false;
    swarm.events.on('budget_exhausted', () => (exhausted = true));
    swarm.say('begin');
    await settle(swarm);
    expect(exhausted).toBe(false);
    expect(swarm.log.filter((m) => m.kind === 'chat' && m.from !== 'you').length).toBeGreaterThan(10);
    swarm.setLimit(3);
    expect(swarm.budget().limit).toBe(3);
  });

  // ---- failures ------------------------------------------------------------------------------

  it("reports a teammate's failed turn to the lead, and pauses the team after three in a row", async () => {
    // A stubborn lead that keeps handing the work out again, as a small model might.
    const lead = new ScriptedProvider([
      ...Array.from({ length: 12 }, (_, i) =>
        callTool(`l${i}`, 'swarm_say', { to: 'worker', text: 'try again' }),
      ),
      say('giving up'),
    ]);
    const broken = () => {
      throw new Error('model server unreachable');
    };
    const worker = new ScriptedProvider(Array.from({ length: 10 }, () => broken));
    const swarm = build({ lead, worker }, { maxMessages: 0 }); // no message limit: only the breaker stops it
    await swarm.addAgent({ name: 'lead', role: 'lead' });
    await swarm.addAgent({ name: 'worker', role: 'worker' });
    swarm.say('build it');
    await settle(swarm);
    const reports = swarm.log.filter((m) => m.from === 'worker' && m.auto);
    expect(reports[0]!.text).toContain("worker's turn failed: ");
    expect(swarm.log.some((m) => m.kind === 'system' && /worker failed 3 times in a row/.test(m.text))).toBe(
      true,
    );
    expect(worker.requests.length).toBe(3); // three failed turns, then the team is held
    const before = worker.requests.length;
    await settle(swarm);
    expect(worker.requests.length).toBe(before);
  });

  it('says when a teammate stopped at the tool-call limit', async () => {
    const lead = new ScriptedProvider([
      callTool('a', 'swarm_say', { to: 'worker', text: 'go' }),
      say('ok'),
      say('noted'),
    ]);
    const loops = Array.from({ length: 5 }, (_, i) => callTool(`w${i}`, 'swarm_roster', {}));
    const worker = new ScriptedProvider([...loops, say('unreachable')]);
    const swarm = build({ lead, worker }, { maxToolIterations: 2 });
    await swarm.addAgent({ name: 'lead', role: 'lead' });
    await swarm.addAgent({ name: 'worker', role: 'worker' });
    swarm.say('start');
    await settle(swarm);
    const report = swarm.log.find((m) => m.from === 'worker' && m.auto);
    expect(report?.text).toContain('stopped at the tool-call limit');
  });
});
