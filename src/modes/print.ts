import type { AgentEvent } from '../agent/agent.js';
import type { Runtime } from '../runtime.js';

export interface PrintOptions {
  prompt: string;
  json: boolean;
}

/**
 * Non-interactive mode: run one prompt and exit. Assistant text goes to stdout (or JSON events,
 * one per line); progress goes to stderr. There is no approval UI, so anything that would need
 * approval is refused unless the mode is `auto` or an allow rule matches.
 */
export async function runPrint(runtime: Runtime, opts: PrintOptions): Promise<number> {
  let failed = false;
  let wroteText = false;
  runtime.agent.events.on('event', (e: AgentEvent) => {
    if (opts.json) {
      process.stdout.write(JSON.stringify(e) + '\n');
    } else if (e.type === 'text') {
      wroteText = true;
      process.stdout.write(e.delta);
    } else if (e.type === 'tool_start') {
      process.stderr.write(`▸ ${e.name} ${e.description}\n`);
    } else if (e.type === 'tool_denied') {
      process.stderr.write(`⊘ denied: ${e.reason}\n`);
    } else if (e.type === 'error') {
      process.stderr.write(`error: ${e.message}\n`);
    }
    if (e.type === 'error') failed = true;
  });
  process.once('SIGINT', () => runtime.agent.abort());
  await runtime.agent.run(opts.prompt);
  if (!opts.json && wroteText) process.stdout.write('\n');
  return failed ? 1 : 0;
}
