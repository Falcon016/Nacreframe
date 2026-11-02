import { assemble } from '../llm/assemble.js';
import type { Message, Provider } from '../llm/types.js';
import { truncateMiddle } from '../util/text.js';
import { estimateMessages } from './context.js';
import { isToolResultOnly, type Session } from './session.js';

export { estimateMessages } from './context.js';

const CHARS_PER_TOKEN = 3.5;

export interface CompactionPlan {
  /** Index (into the session's message entries) of the first message that stays verbatim. */
  cutIndex: number;
  firstKeptId: string;
  /** Exactly what the model currently sees before the cut (earlier summary included). */
  toSummarise: Message[];
  keptCount: number;
  /** Session leaf when the plan was made; the commit is refused if it moved. */
  leaf: string | null;
}

/**
 * Choose where to cut. Any message except a tool_result-only user message is a safe boundary, because a
 * tool_use and its tool_result then always stay on the same side. (An assistant message starts a fresh
 * exchange; a user text message starts a fresh turn.) That makes it possible to compact even in the
 * middle of a long tool loop, which a "plain user message only" rule could not.
 */
export function planCompaction(session: Session, keepRecent: number): CompactionPlan | undefined {
  const entries = session.messageEntries();
  const n = entries.length;
  if (n < 2) return undefined;

  // Never cut inside the part an earlier compaction already summarised: that would summarise nothing new.
  const path = session.path();
  const lastComp = [...path].reverse().find((e) => e.type === 'compaction');
  const prevKept =
    lastComp && lastComp.type === 'compaction' ? entries.findIndex((e) => e.id === lastComp.firstKeptId) : -1;

  const start = Math.min(n - Math.max(1, keepRecent), n - 1);
  let cut = -1;
  for (let i = start; i > prevKept && i > 0; i--) {
    if (!isToolResultOnly(entries[i]!.message.content)) {
      cut = i;
      break;
    }
  }
  if (cut <= 0) return undefined;

  const visible = session.messages();
  const keptCount = n - cut;
  const toSummarise = visible.slice(0, Math.max(0, visible.length - keptCount));
  if (!toSummarise.length) return undefined;
  return { cutIndex: cut, firstKeptId: entries[cut]!.id, toSummarise, keptCount, leaf: session.leaf };
}

function pieces(messages: Message[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'text') out.push(`${m.role.toUpperCase()}: ${b.text}`);
      else if (b.type === 'tool_use')
        out.push(`TOOL CALL ${b.name}: ${truncateMiddle(JSON.stringify(b.input), 600)}`);
      else if (b.type === 'tool_result') {
        out.push(`TOOL RESULT${b.isError ? ' (error)' : ''}: ${truncateMiddle(b.content, 800)}`);
      }
    }
  }
  return out;
}

const SUMMARY_SYSTEM =
  'You compress coding-agent conversations. Write a dense, factual summary another agent can continue from. ' +
  "Include: the user's goals and constraints, decisions made, files created or changed (with paths), commands run and their outcomes, " +
  'errors still unresolved, and the exact next steps. Do not invent details. Use short bullet points.';

export interface SummariseOptions {
  provider: Provider;
  model: string;
  /** Context window of the summarising model, in tokens. */
  window: number;
  instructions?: string | undefined;
  signal?: AbortSignal | undefined;
}

async function ask(o: SummariseOptions, prompt: string, maxTokens: number): Promise<string> {
  const { message } = await assemble(
    o.provider.stream({
      model: o.model,
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      tools: [],
      maxTokens,
      ...(o.signal ? { signal: o.signal } : {}),
    }),
  );
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

/**
 * Summarise by folding chunks into a running summary, so the input to every model call fits the
 * summariser's window no matter how long the conversation is (important for small local models).
 */
export async function summarise(messages: Message[], o: SummariseOptions): Promise<string> {
  const window = Math.max(2048, o.window);
  const targetTokens = Math.max(250, Math.min(1500, Math.floor(window * 0.08)));
  const budgetChars = Math.max(2000, Math.floor(window * 0.4 * CHARS_PER_TOKEN));
  const focus = o.instructions ? `Focus: ${o.instructions}\n` : '';
  const limit = `Keep the summary under about ${Math.floor(targetTokens * 0.7)} words.`;

  const chunks: string[] = [];
  let cur = '';
  for (const p of pieces(messages)) {
    const piece = truncateMiddle(p, Math.floor(budgetChars * 0.5));
    if (cur && cur.length + piece.length + 1 > budgetChars) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + piece;
  }
  if (cur) chunks.push(cur);

  let summary = '';
  for (const chunk of chunks) {
    const prompt = summary
      ? `Existing summary so far:\n${summary}\n\nMerge in this later part of the conversation:\n${chunk}\n\n${focus}${limit}\nWrite the updated summary now.`
      : `${chunk}\n\n${focus}${limit}\nWrite the summary now.`;
    // Reasoning models can spend the whole budget thinking; retry once with a larger one before giving up.
    let text = await ask(o, prompt, targetTokens * 2);
    if (!text) text = await ask(o, prompt, Math.min(targetTokens * 6, Math.floor(window * 0.4)));
    if (!text) throw new Error('The model returned an empty summary.');
    summary = text;
  }
  return summary;
}

export interface CompactResult {
  summary: string;
  droppedMessages: number;
  tokensBefore: number;
  tokensAfter: number;
}

export class CompactionError extends Error {
  constructor(
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'CompactionError';
  }
}

/**
 * Transactional compaction. The summary is produced first from an immutable snapshot; the session is
 * written to (one appended line) only if it is valid, smaller than what it replaces, and the conversation
 * did not change meanwhile. On any failure the session is untouched. Nothing is ever deleted: the full
 * original messages stay in the append-only session file, compaction only changes what is sent to the model.
 */
export async function compact(opts: {
  session: Session;
  provider: Provider;
  model: string;
  window: number;
  keepRecent: number;
  signal?: AbortSignal;
  instructions?: string;
}): Promise<CompactResult | undefined> {
  const plan = planCompaction(opts.session, opts.keepRecent);
  if (!plan) return undefined;

  const summary = await summarise(plan.toSummarise, {
    provider: opts.provider,
    model: opts.model,
    window: opts.window,
    instructions: opts.instructions,
    signal: opts.signal,
  });
  if (summary.length < 20) throw new CompactionError('The summary was too short to be trustworthy.');

  const before = estimateMessages(plan.toSummarise);
  const after = estimateMessages([{ role: 'user', content: [{ type: 'text', text: summary }] }]);
  if (after >= before)
    throw new CompactionError('The summary was not smaller than the text it replaces.', false);

  if (opts.signal?.aborted) throw new CompactionError('Compaction was interrupted.', false);
  if (opts.session.leaf !== plan.leaf) {
    throw new CompactionError(
      'The conversation changed while it was being summarised; nothing was modified.',
    );
  }
  opts.session.appendCompaction(summary, plan.firstKeptId);
  return { summary, droppedMessages: plan.toSummarise.length, tokensBefore: before, tokensAfter: after };
}
