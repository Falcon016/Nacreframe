// Try a real model with the harness: `npm run live-check -- <provider>/<model> [contextWindow]`
//
//   1. replies            can it answer at all?
//   2. uses tools         does it call the read tool and use the result?
//   3. auto-compaction    shrinks the context window artificially, fills the conversation past 80%, and checks that
//                         compaction fires, nothing is lost on disk, and the model still remembers an early fact.
//
// It works in a throw-away folder with an isolated session store, and never writes outside it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent } from '../src/agent/agent.js';
import { Runtime } from '../src/runtime.js';

const spec = process.argv[2];
const window = Number(process.argv[3] ?? 8192);
if (!spec || !spec.includes('/')) {
  console.error(
    'Usage: npm run live-check -- <provider>/<model> [contextWindowTokens]\nSee `nacre models` for what is available.',
  );
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'nacre-live-'));
const work = join(dir, 'work');
mkdirSync(work);
// Keep the user's config (providers, keys) but isolate sessions/state from their real ones.
const env = { ...process.env, NACRE_HOME: join(dir, 'home') };
const userCfg = join(process.env.NACRE_HOME ?? '', 'config', 'config.json');
mkdirSync(join(dir, 'home', 'config'), { recursive: true });
try {
  writeFileSync(join(dir, 'home', 'config', 'config.json'), readFileSync(userCfg));
} catch {
  /* no user config: built-in providers only */
}

const rt = await Runtime.create({
  cwd: work,
  env,
  overrides: {
    model: spec,
    approval: { mode: 'auto' },
    browser: { enabled: false },
    contextWindows: { [spec]: window },
  },
});

const events: AgentEvent[] = [];
rt.agent.events.on('event', (e) => events.push(e));
const lastText = () => {
  const msgs = rt.agent.session.messages();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role === 'assistant')
      return m.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
  }
  return '';
};
const errors = () =>
  events
    .filter((e) => e.type === 'error' || e.type === 'paused')
    .map((e) => (e.type === 'error' ? e.message : e.type === 'paused' ? e.reason : ''));

interface Result {
  name: string;
  ok: boolean;
  seconds: number;
  detail: string;
}
const results: Result[] = [];
async function check(name: string, fn: () => Promise<{ ok: boolean; detail: string }>) {
  const t = Date.now();
  process.stdout.write(`• ${name} … `);
  events.length = 0;
  let r: { ok: boolean; detail: string };
  try {
    r = await fn();
  } catch (e) {
    r = { ok: false, detail: (e as Error).message };
  }
  const seconds = Math.round((Date.now() - t) / 100) / 10;
  results.push({ name, seconds, ...r });
  console.log(`${r.ok ? 'ok' : 'FAILED'} (${seconds}s)${r.detail ? ' — ' + r.detail : ''}`);
}

const m = rt.agent.model;
const lim = rt.agent.limits();
console.log(
  `Model ${spec}\nContext window ${m.contextWindow.toLocaleString()} tokens (${m.contextSource}); compaction starts at ${lim.target.toLocaleString()}\n`,
);

await check('replies', async () => {
  await rt.agent.run('Reply with exactly one word: pong');
  const t = lastText();
  return { ok: /pong/i.test(t) && !errors().length, detail: errors()[0] ?? `"${t.slice(0, 60)}"` };
});

await check('uses tools', async () => {
  writeFileSync(join(work, 'facts.txt'), 'The magic number is 4721.\n');
  await rt.agent.run('Use the read tool to read facts.txt, then tell me the magic number.');
  const used = events.some((e) => e.type === 'tool_start' && e.name === 'read');
  const t = lastText();
  return {
    ok: used && t.includes('4721'),
    detail: used ? `answer: "${t.slice(0, 60)}"` : 'never called the read tool',
  };
});

await check('auto-compaction', async () => {
  const session = rt.agent.session;
  // An early fact the model must still know after the history around it has been summarised away.
  session.append({
    role: 'user',
    content: [{ type: 'text', text: 'Please remember this: my project codename is TURQUOISE-17.' }],
  });
  session.append({
    role: 'assistant',
    content: [{ type: 'text', text: 'Noted: your project codename is TURQUOISE-17.' }],
  });
  const topics = [
    'database indexing',
    'garden irrigation',
    'sourdough starters',
    'rust lifetimes',
    'bicycle gearing',
    'tide tables',
  ];
  let i = 0;
  while (true) {
    const topic = topics[i % topics.length]!;
    session.append({
      role: 'user',
      content: [{ type: 'text', text: `Tell me something about ${topic} (#${i}).` }],
    });
    session.append({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: `About ${topic} (#${i}): ${`it depends on the details, the constraints and the goals. `.repeat(18)}`,
        },
      ],
    });
    i++;
    // stop once the next request would be past the 80% trigger
    const estimate = session.messages().reduce((n, msg) => n + JSON.stringify(msg).length, 0) / 3.5;
    if (estimate > lim.target + 400) break;
  }
  const before = session.messageEntries().length;
  await rt.agent.run('What is my project codename? Answer with the codename only.');
  const started = events.some((e) => e.type === 'compaction' && e.phase === 'start');
  const ended = events.find((e) => e.type === 'compaction' && e.phase === 'end');
  const compacted = session.path().some((e) => e.type === 'compaction');
  const kept = session.messageEntries().length >= before; // history only grows; nothing deleted
  const remembered = /TURQUOISE-17/i.test(lastText());
  const detail = `${started ? `compacted ${ended && ended.type === 'compaction' && ended.phase === 'end' ? `${ended.beforePct}% → ${ended.afterPct}%` : ''}` : 'compaction did NOT trigger'}; history kept on disk: ${kept ? 'yes' : 'NO'}; remembered the codename: ${remembered ? 'yes' : `no ("${lastText().slice(0, 50)}")`}${errors().length ? `; ${errors()[0]}` : ''}`;
  return { ok: started && compacted && kept && !events.some((e) => e.type === 'paused'), detail };
});

await rt.dispose();
rmSync(dir, { recursive: true, force: true });

console.log('\nSummary');
for (const r of results)
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(16)} ${String(r.seconds).padStart(6)}s`);
const memory = results.at(-1)?.detail.includes('remembered the codename: yes');
if (results.every((r) => r.ok) && !memory)
  console.log(
    "\nNote: compaction worked, but this model's summary did not keep the early fact. Try a stronger model for summarising (smallModel).",
  );
process.exit(results.every((r) => r.ok) ? 0 : 1);
