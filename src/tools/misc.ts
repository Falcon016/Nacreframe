import { z } from 'zod';
import { defineTool } from './types.js';

export const todoTool = defineTool({
  name: 'todo_write',
  description:
    'Maintain a visible task list for multi-step work. Send the complete list each time. Keep at most one item in_progress.',
  risk: 'agent',
  schema: z.object({
    todos: z.array(
      z.object({
        content: z.string().min(1),
        status: z.enum(['pending', 'in_progress', 'completed']),
      }),
    ),
  }),
  describe: (i) => `update task list (${i.todos.length})`,
  async execute(input, ctx) {
    ctx.setTodos?.(input.todos);
    const done = input.todos.filter((t) => t.status === 'completed').length;
    return { content: `Task list updated (${done}/${input.todos.length} done).` };
  },
});

export const askUserTool = defineTool({
  name: 'ask_user',
  description:
    'Ask the human a clarifying question and wait for the answer. Use sparingly, only when you cannot proceed sensibly otherwise. Optionally offer a few choices.',
  risk: 'agent',
  schema: z.object({
    question: z.string().min(1),
    options: z.array(z.string()).max(6).optional(),
  }),
  describe: (i) => i.question,
  async execute(input, ctx) {
    if (!ctx.ask)
      return {
        content: 'No interactive user is available. Make a reasonable assumption and continue.',
        isError: true,
      };
    const answer = await ctx.ask({
      question: input.question,
      ...(input.options ? { options: input.options } : {}),
    });
    return { content: `User answered: ${answer}` };
  },
});

export const skillTool = defineTool({
  name: 'skill',
  description: 'Load the full instructions of a named skill listed in the system prompt.',
  risk: 'read',
  schema: z.object({ name: z.string() }),
  describe: (i) => i.name,
  async execute(input, ctx) {
    const body = ctx.skills?.get(input.name);
    if (!body)
      return {
        content: `No skill named "${input.name}". Available: ${ctx.skills?.names().join(', ') || 'none'}`,
        isError: true,
      };
    return { content: body };
  },
});
