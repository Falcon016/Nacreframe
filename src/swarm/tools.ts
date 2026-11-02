import { z } from 'zod';
import { defineTool, type AnyTool, type ToolContext } from '../tools/types.js';
import type { SwarmMember } from './types.js';

function member(ctx: ToolContext): SwarmMember {
  if (!ctx.swarm) throw new Error('Not running inside a swarm.');
  return ctx.swarm;
}

export const swarmTools: AnyTool[] = [
  defineTool({
    name: 'swarm_say',
    description:
      'Post a message to the shared team channel (visible live to the user). Set `to` to address one teammate and wake them; omit it to speak to everyone. Be brief and concrete; do not send acknowledgements.',
    risk: 'agent',
    schema: z.object({
      text: z.string().min(1).max(4000),
      to: z.string().optional().describe('Teammate name, "you" for the user, or omit for everyone'),
    }),
    describe: (i) => `say${i.to ? ` → ${i.to}` : ''}: ${i.text.slice(0, 60)}`,
    async execute(i, ctx) {
      const r = member(ctx).say(i.text, i.to);
      return r.ok ? { content: 'Sent.' } : { content: r.error, isError: true };
    },
  }),
  defineTool({
    name: 'swarm_roster',
    description: 'List teammates, their roles and whether they are currently working.',
    risk: 'agent',
    schema: z.object({}),
    describe: () => 'roster',
    async execute(_i, ctx) {
      const r = member(ctx).roster();
      return { content: r.map((t) => `${t.name} — ${t.role}${t.running ? ' (working)' : ''}`).join('\n') };
    },
  }),
  defineTool({
    name: 'swarm_note',
    description:
      'Write a shared note (plans, interfaces, findings) that every teammate can read with swarm_notes.',
    risk: 'agent',
    schema: z.object({ key: z.string().min(1).max(64), value: z.string().max(8000) }),
    describe: (i) => `note ${i.key}`,
    async execute(i, ctx) {
      member(ctx).note(i.key, i.value);
      return { content: `Saved note "${i.key}".` };
    },
  }),
  defineTool({
    name: 'swarm_notes',
    description: 'Read all shared notes.',
    risk: 'agent',
    schema: z.object({}),
    describe: () => 'read notes',
    async execute(_i, ctx) {
      const n = member(ctx).notes();
      const keys = Object.keys(n);
      return { content: keys.length ? keys.map((k) => `## ${k}\n${n[k]}`).join('\n\n') : '(no notes yet)' };
    },
  }),
  defineTool({
    name: 'swarm_spawn',
    description: 'Add a new teammate with a role and (optionally) hand them a first task. Use sparingly.',
    risk: 'agent',
    schema: z.object({
      name: z.string().regex(/^[a-z][a-z0-9_-]{0,23}$/),
      role: z.string().min(3).max(300),
      task: z.string().max(4000).optional(),
    }),
    describe: (i) => `spawn ${i.name} (${i.role.slice(0, 40)})`,
    async execute(i, ctx) {
      const m = member(ctx);
      if (!m.spawn) return { content: 'Spawning is disabled (swarm.allowSpawn = false).', isError: true };
      try {
        await m.spawn({ name: i.name, role: i.role }, i.task);
        return { content: `${i.name} joined the team.` };
      } catch (e) {
        return { content: (e as Error).message, isError: true };
      }
    },
  }),
];
