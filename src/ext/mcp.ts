import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import type { McpServerConfig } from '../config/schema.js';
import { wrapUntrusted } from '../util/untrusted.js';
import { redact } from '../util/redact.js';
import { truncateMiddle } from '../util/text.js';
import { VERSION } from '../version.js';
import type { AnyTool, ToolResult } from '../tools/types.js';

export interface McpConnection {
  name: string;
  client: Client;
  tools: AnyTool[];
  close(): Promise<void>;
}

const CONNECT_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>(
    (_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms)),
  );
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

const safeName = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

/** Connect to one MCP server and expose its tools as `mcp__<server>__<tool>`. */
export async function connectMcp(name: string, cfg: McpServerConfig): Promise<McpConnection> {
  const client = new Client({ name: 'nexusharness', version: VERSION });
  const transport =
    'command' in cfg
      ? new StdioClientTransport({
          command: cfg.command,
          args: cfg.args,
          // Only a safe subset of the host environment (no API keys) plus what the config lists explicitly.
          env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
          ...(cfg.cwd ? { cwd: cfg.cwd } : {}),
          stderr: 'ignore',
        })
      : new StreamableHTTPClientTransport(
          new URL(cfg.url),
          cfg.headers ? { requestInit: { headers: cfg.headers } } : {},
        );

  await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `MCP server "${name}"`);
  const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `MCP server "${name}" tools/list`);

  const tools: AnyTool[] = listed.tools.map((t): AnyTool => {
    const toolName = `mcp__${safeName(name)}__${safeName(t.name)}`;
    const readOnly = t.annotations?.readOnlyHint === true;
    return {
      name: toolName,
      description: `[MCP ${name}] ${t.description ?? t.name}`,
      // Unknown third-party code: treated as `exec` unless the server declares it read-only.
      risk: readOnly ? 'read' : 'exec',
      schema: z.record(z.string(), z.unknown()),
      jsonSchema: t.inputSchema as Record<string, unknown>,
      primaryArg: () => undefined,
      describe: (input: never) => `${t.name} ${truncateMiddle(JSON.stringify(input), 80)}`,
      async execute(input, ctx): Promise<ToolResult> {
        const res = await client.callTool(
          { name: t.name, arguments: input as Record<string, unknown> },
          undefined,
          { signal: ctx.signal },
        );
        const parts = Array.isArray(res.content)
          ? (res.content as { type: string; text?: string; data?: string; mimeType?: string }[])
          : [];
        const text = parts
          .filter((p) => p.type === 'text')
          .map((p) => p.text ?? '')
          .join('\n');
        const images = parts
          .filter((p) => p.type === 'image' && p.data)
          .map((p) => ({ mediaType: p.mimeType ?? 'image/png', data: p.data! }));
        return {
          content: wrapUntrusted(
            `mcp:${name}/${t.name}`,
            truncateMiddle(redact(text) || '(no text output)', 40_000),
          ),
          ...(res.isError ? { isError: true } : {}),
          ...(images.length ? { images } : {}),
        };
      },
    };
  });

  return { name, client, tools, close: () => client.close() };
}

export async function connectAll(
  servers: Record<string, McpServerConfig>,
): Promise<{ connections: McpConnection[]; warnings: string[] }> {
  const connections: McpConnection[] = [];
  const warnings: string[] = [];
  await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      try {
        connections.push(await connectMcp(name, cfg));
      } catch (e) {
        warnings.push(`MCP server "${name}" failed: ${(e as Error).message}`);
      }
    }),
  );
  return { connections, warnings };
}
