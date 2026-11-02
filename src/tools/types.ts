import type { z } from 'zod';
import type { BrowserService } from '../browser/service.js';
import type { Config } from '../config/schema.js';
import type { ImageData } from '../llm/types.js';
import type { Sandbox } from '../sandbox/types.js';
import type { SwarmMember } from '../swarm/types.js';

/** What a tool can do to the world. Drives approval policy. */
export type ToolRisk = 'read' | 'edit' | 'exec' | 'network' | 'browser' | 'agent';

export interface ToolResult {
  /** Text returned to the model. */
  content: string;
  isError?: boolean;
  images?: ImageData[];
  /** Optional richer text for the UI only (e.g. a diff). */
  display?: string;
}

export interface Question {
  question: string;
  options?: string[];
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  sandbox: Sandbox;
  config: Config;
  /** Id of the agent running this tool ("main" outside swarms). */
  agentId: string;
  /** path -> mtimeMs recorded when this agent last read/wrote it; used to refuse blind or stale edits. */
  readState: Map<string, number>;
  /** Stream partial output to the UI while a tool runs. */
  progress(text: string): void;
  ask?: (q: Question) => Promise<string>;
  setTodos?: (todos: TodoItem[]) => void;
  browser?: BrowserService;
  swarm?: SwarmMember;
  skills?: { get(name: string): string | undefined; names(): string[] };
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  risk: ToolRisk;
  schema: S;
  /** Safe to run concurrently with other read-only tools. */
  parallel?: boolean;
  /** The argument policy rules match against (command, path, URL...). */
  primaryArg?(input: z.infer<S>): string | undefined;
  /** One-line summary for the transcript and approval prompt. */
  describe(input: z.infer<S>): string;
  /** Optional extra detail for the approval prompt (e.g. a diff). */
  preview?(input: z.infer<S>, ctx: ToolContext): Promise<string | undefined>;
  execute(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}

/** Type-erased tool as stored in the registry. */
export interface AnyTool {
  name: string;
  description: string;
  risk: ToolRisk;
  parallel?: boolean;
  schema: z.ZodType;
  /** JSON Schema override (used by MCP tools which bring their own schema). */
  jsonSchema?: Record<string, unknown>;
  primaryArg?(input: never): string | undefined;
  describe(input: never): string;
  preview?(input: never, ctx: ToolContext): Promise<string | undefined>;
  execute(input: never, ctx: ToolContext): Promise<ToolResult>;
}
