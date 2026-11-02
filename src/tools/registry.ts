import { z } from 'zod';
import type { ToolSpec } from '../llm/types.js';
import type { AnyTool, Tool, ToolContext, ToolResult } from './types.js';
import { globMatch } from '../util/glob.js';

export class ToolRegistry {
  private tools = new Map<string, AnyTool>();

  register<S extends z.ZodType>(tool: Tool<S> | AnyTool): this {
    this.tools.set(tool.name, tool as AnyTool);
    return this;
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name);
  }

  all(): AnyTool[] {
    return [...this.tools.values()];
  }

  /** A view of the registry limited to tools matching any of the given globs. */
  subset(globs: string[] | undefined): ToolRegistry {
    if (!globs) return this;
    const out = new ToolRegistry();
    for (const t of this.tools.values()) if (globs.some((g) => globMatch(g, t.name))) out.register(t);
    return out;
  }

  specs(): ToolSpec[] {
    return this.all().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.jsonSchema ?? toJsonSchema(t.schema),
    }));
  }

  /** Validate raw model input. Returns parsed input or an error string suitable for the model. */
  parse(name: string, raw: unknown): { ok: true; input: unknown } | { ok: false; error: string } {
    const tool = this.tools.get(name);
    if (!tool)
      return { ok: false, error: `Unknown tool "${name}". Available: ${[...this.tools.keys()].join(', ')}` };
    const r = tool.schema.safeParse(raw);
    if (r.success) return { ok: true, input: r.data };
    const issues = r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
    return { ok: false, error: `Invalid input for ${name}: ${issues}` };
  }

  async run(name: string, input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { content: `Unknown tool "${name}"`, isError: true };
    try {
      return await tool.execute(input as never, ctx);
    } catch (e) {
      if (ctx.signal.aborted) return { content: 'Interrupted by user.', isError: true };
      return { content: `${name} failed: ${(e as Error).message}`, isError: true };
    }
  }
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}
