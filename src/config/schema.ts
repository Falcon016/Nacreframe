import { z } from 'zod';

export const approvalModeSchema = z.enum(['ask', 'edits', 'auto', 'plan']);
export type ApprovalMode = z.infer<typeof approvalModeSchema>;

export const sandboxModeSchema = z.enum(['off', 'guard', 'container']);
export type SandboxMode = z.infer<typeof sandboxModeSchema>;

export const providerSchema = z.object({
  type: z.enum(['anthropic', 'openai']),
  baseUrl: z.string().url().optional(),
  /** Name of the environment variable holding the key. The key itself never lives in config. */
  apiKeyEnv: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** Optional context window hint for models served by this provider. */
  contextWindow: z.number().int().positive().optional(),
});
export type ProviderConfig = z.infer<typeof providerSchema>;

export const ruleSchema = z.object({
  /** Tool name glob, e.g. `bash`, `browser_*`, `mcp__github__*`. */
  tool: z.string(),
  /** Optional glob against the tool's primary argument (command, path or URL). */
  match: z.string().optional(),
  action: z.enum(['allow', 'ask', 'deny']),
});
export type Rule = z.infer<typeof ruleSchema>;

export const mcpServerSchema = z.union([
  z.object({
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  }),
  z.object({ url: z.string().url(), headers: z.record(z.string(), z.string()).optional() }),
]);
export type McpServerConfig = z.infer<typeof mcpServerSchema>;

export const swarmAgentSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,23}$/),
  role: z.string(),
  model: z.string().optional(),
  /** Restrict this agent to a subset of tool names/globs. */
  tools: z.array(z.string()).optional(),
  color: z.string().optional(),
});
export type SwarmAgentConfig = z.infer<typeof swarmAgentSchema>;

export const configSchema = z.object({
  /** `<provider>/<model>`. Deliberately has no default: you pick one with `--model` or `/model`. */
  model: z.string().optional(),
  /** Model used for compaction summaries. Defaults to `model` (avoids swapping models on single-GPU servers). */
  smallModel: z.string().optional(),
  /** Override the detected context window (tokens) per `<provider>/<model>`. */
  contextWindows: z.record(z.string(), z.number().int().min(1024)).default({}),
  maxTokens: z.number().int().positive().default(8192),
  thinkingBudget: z.number().int().min(0).default(0),
  providers: z.record(z.string(), providerSchema).default({}),

  approval: z
    .object({
      mode: approvalModeSchema.default('ask'),
      rules: z.array(ruleSchema).default([]),
    })
    .default({ mode: 'ask', rules: [] }),

  sandbox: z
    .object({
      mode: sandboxModeSchema.default('guard'),
      /** Extra directories the agent may read/write besides the workspace. */
      allowPaths: z.array(z.string()).default([]),
      /** Paths never readable or writable, even inside the workspace. */
      denyPaths: z.array(z.string()).default(['.env', '.env.*', '**/.ssh/**', '**/*.pem', '**/id_rsa*']),
      container: z
        .object({
          runtime: z.enum(['docker', 'podman']).default('docker'),
          image: z.string().default('node:22-bookworm-slim'),
          network: z.boolean().default(false),
          memory: z.string().default('2g'),
          cpus: z.string().default('2'),
        })
        .default({
          runtime: 'docker',
          image: 'node:22-bookworm-slim',
          network: false,
          memory: '2g',
          cpus: '2',
        }),
    })
    .default({
      mode: 'guard',
      allowPaths: [],
      denyPaths: ['.env', '.env.*', '**/.ssh/**', '**/*.pem', '**/id_rsa*'],
      container: {
        runtime: 'docker',
        image: 'node:22-bookworm-slim',
        network: false,
        memory: '2g',
        cpus: '2',
      },
    }),

  browser: z
    .object({
      enabled: z.boolean().default(true),
      /** `chrome`, `msedge` or `chromium`. Chrome/Edge use the browser already installed on the machine. */
      channel: z.enum(['chrome', 'msedge', 'chromium']).default('chrome'),
      headless: z.boolean().default(false),
      /** Navigation allow-list (host globs). Empty means any host, subject to approval rules. */
      allowedHosts: z.array(z.string()).default([]),
      blockedHosts: z.array(z.string()).default([]),
    })
    .default({ enabled: true, channel: 'chrome', headless: false, allowedHosts: [], blockedHosts: [] }),

  swarm: z
    .object({
      agents: z.array(swarmAgentSchema).default([]),
      maxAgents: z.number().int().min(1).max(12).default(6),
      /**
       * Messages agents may send each other between two of yours, a backstop against runaway chatter.
       * Anything you type resets it. 0 means no limit.
       */
      maxMessages: z.number().int().min(0).default(60),
      /** Let agents add teammates mid-run. Off by default: the team you start is the team you get. */
      allowSpawn: z.boolean().default(false),
    })
    .default({ agents: [], maxAgents: 6, maxMessages: 60, allowSpawn: false }),

  /**
   * Compaction is always on and cannot be disabled. The trigger can be lowered but never raised above
   * 80% of the context window, and the chat is held (nothing is sent) until compaction completes.
   */
  compaction: z
    .object({
      threshold: z.number().min(0.3).max(0.8).default(0.8),
      /** Newest messages kept verbatim; shrinks automatically when the context is still too large. */
      keepRecent: z.number().int().min(1).default(6),
    })
    .default({ threshold: 0.8, keepRecent: 6 }),

  mcpServers: z.record(z.string(), mcpServerSchema).default({}),
  /** Tool calls an agent may make in one turn before it stops and waits for you. 0 means no limit. */
  maxToolIterations: z.number().int().min(0).default(60),
  theme: z.enum(['nacre', 'mono']).default('nacre'),
  /** Show agents' reasoning in full in the terminal UI (toggle with ctrl+t or /thinking). */
  showThinking: z.boolean().default(false),
});

export type Config = z.infer<typeof configSchema>;
export type PartialConfig = Record<string, unknown>;
