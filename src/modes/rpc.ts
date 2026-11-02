import { createInterface } from 'node:readline';
import type { ApprovalResponse } from '../agent/agent.js';
import { approvalModeSchema } from '../config/schema.js';
import type { Runtime } from '../runtime.js';
import { VERSION } from '../version.js';

/**
 * JSON-lines protocol over stdin/stdout for embedding Nacreframe in other programs.
 *
 *   in : {"type":"prompt","text":"..."}  {"type":"steer","text":"..."}  {"type":"abort"}
 *        {"type":"approve","id":N,"allow":true,"always":false,"feedback":"..."}
 *        {"type":"set_mode","mode":"ask|edits|auto|plan"}  {"type":"answer","id":N,"text":"..."}
 *   out: {"type":"ready","version":"..."}  {"type":"event","event":{...}}
 *        {"type":"approval_request","id":N,...}  {"type":"question","id":N,...}  {"type":"error","message":"..."}
 */
export async function runRpc(runtime: Runtime): Promise<void> {
  const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');
  let nextId = 1;
  const approvals = new Map<number, (r: ApprovalResponse) => void>();
  const questions = new Map<number, (a: string) => void>();

  runtime.agent.events.on('event', (event) => out({ type: 'event', agent: 'main', event }));
  runtime.broker.approvalHandler = (req, signal) =>
    new Promise((resolve) => {
      const id = nextId++;
      approvals.set(id, resolve);
      signal.addEventListener('abort', () => (approvals.delete(id), resolve({ allow: false })), {
        once: true,
      });
      out({ type: 'approval_request', id, ...req });
    });
  runtime.broker.questionHandler = (agent, q) =>
    new Promise((resolve) => {
      const id = nextId++;
      questions.set(id, resolve);
      out({ type: 'question', id, agent, ...q });
    });

  out({ type: 'ready', version: VERSION, model: runtime.config.model, mode: runtime.policy.mode });

  const rl = createInterface({ input: process.stdin });
  const pending: Promise<void>[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: { type: string; [k: string]: unknown };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      out({ type: 'error', message: 'invalid JSON' });
      continue;
    }
    switch (msg.type) {
      case 'prompt':
        pending.push(runtime.agent.run(String(msg.text ?? '')));
        break;
      case 'steer':
        runtime.agent.steer(String(msg.text ?? ''));
        break;
      case 'abort':
        runtime.agent.abort();
        break;
      case 'approve': {
        const r = approvals.get(Number(msg.id));
        approvals.delete(Number(msg.id));
        r?.({
          allow: !!msg.allow,
          always: !!msg.always,
          ...(msg.feedback ? { feedback: String(msg.feedback) } : {}),
        });
        break;
      }
      case 'answer': {
        const r = questions.get(Number(msg.id));
        questions.delete(Number(msg.id));
        r?.(String(msg.text ?? ''));
        break;
      }
      case 'set_mode': {
        const m = approvalModeSchema.safeParse(msg.mode);
        if (m.success) runtime.setApprovalMode(m.data);
        else out({ type: 'error', message: 'invalid mode' });
        break;
      }
      default:
        out({ type: 'error', message: `unknown message type "${msg.type}"` });
    }
  }
  await Promise.allSettled(pending);
}
