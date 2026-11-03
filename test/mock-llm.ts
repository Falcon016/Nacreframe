import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A tiny OpenAI-compatible server for end-to-end tests and demos (`npm run mock`).
 * Behaviour is keyed off the latest user message so it needs no configuration:
 *   "read <file>"  → calls the read tool, then summarises
 *   "write <file>" → calls the write tool (exercises approvals), then confirms
 *   "run <cmd>"    → calls bash
 *   "think ..."    → streams reasoning (reasoning_content) before the reply
 *   "ponder ..."   → the same, written inline as <think>...</think> like some local models do
 *   anything else  → plain text reply
 * Each tool result is answered with a short wrap-up so the loop terminates.
 */
export function startMockLlm(port = 0): Promise<{ server: Server; url: string; requests: unknown[] }> {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.setHeader('content-type', 'application/json');
      return void res.end(JSON.stringify({ data: [{ id: 'mock-1' }, { id: 'mock-2' }] }));
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.statusCode = 404;
      return void res.end('{"error":{"message":"not found"}}');
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body || '{}') as {
        messages: { role: string; content: unknown }[];
        tools?: unknown[];
      };
      requests.push(j);
      const last = j.messages.at(-1)!;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const reason = (t: string) => {
        for (const w of t.match(/\S+\s*/g) ?? []) send({ choices: [{ delta: { reasoning_content: w } }] });
      };
      const text = (t: string) => {
        for (const w of t.match(/\S+\s*/g) ?? []) send({ choices: [{ delta: { content: w } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      };
      const call = (name: string, args: object) => {
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_' + Math.random().toString(36).slice(2, 8),
                    function: { name, arguments: JSON.stringify(args) },
                  },
                ],
              },
            },
          ],
        });
        send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      };
      if (last.role === 'tool')
        text(`All done. Tool said: ${String(last.content).split('\n')[0]!.slice(0, 80)}`);
      else {
        const u = String(typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
        // Only offer tool calls when the request carries tools (summary requests do not).
        const m = j.tools?.length ? /\b(read|write|run)\s+(\S+)/i.exec(u) : null;
        if (m?.[1]!.toLowerCase() === 'read') call('read', { path: m[2] });
        else if (m?.[1]!.toLowerCase() === 'write')
          call('write', { path: m[2], content: 'hello from the mock\n' });
        else if (m?.[1]!.toLowerCase() === 'run') call('bash', { command: u.replace(/^.*\brun\s+/i, '') });
        else if (/\bthink\b/i.test(u)) {
          reason('The user wants me to think first.\nStep one: read the request.\nStep two: answer briefly.');
          text('Thought it through: the answer is 42.');
        } else if (/\bponder\b/i.test(u))
          text(
            '<think>Pondering inline, the way small local models do.</think>\n\nPondered: the answer is 42.',
          );
        else
          text(
            `Hello! This is the **mock** model. You said: ${u.slice(0, 60)}\n\n- It streams tokens\n- It supports \`inline code\`\n\n\`\`\`ts\nconst x = 1;\n\`\`\``,
          );
      }
      send({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 24 } });
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests }),
    ),
  );
}

// `npx tsx test/mock-llm.ts` starts it on a fixed port for manual TUI testing.
if (process.argv[1]?.replaceAll('\\', '/').endsWith('test/mock-llm.ts')) {
  startMockLlm(11499).then(({ url }) => console.log(`mock LLM listening at ${url}`));
}
