// Dev helper: render the TUI against the mock model and print the visible screen. `npx tsx scripts/preview-frame.tsx`
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { Runtime } from '../src/runtime.js';
import { App } from '../src/tui/App.js';
import { UiStore } from '../src/tui/store.js';
import { NACRE } from '../src/tui/theme.js';
import { startMockLlm } from '../test/mock-llm.js';

class Tty extends PassThrough {
  isTTY = true;
  columns = 100;
  rows = 40;
  setRawMode() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const keepColor = process.argv.includes('--color');

const mock = await startMockLlm();
const dir = mkdtempSync(join(tmpdir(), 'nacre-prev-'));
const home = join(dir, 'home');
mkdirSync(join(home, 'config'), { recursive: true });
writeFileSync(
  join(home, 'config', 'config.json'),
  JSON.stringify({
    model: 'mock/mock-1',
    browser: { enabled: false },
    providers: { mock: { type: 'openai', baseUrl: mock.url } },
  }),
);
const work = join(dir, 'work');
mkdirSync(work);
writeFileSync(join(work, 'package.json'), '{"name":"demo"}');
const runtime = await Runtime.create({
  cwd: work,
  env: { ...process.env, NACRE_HOME: home },
  ephemeral: true,
});
const store = new UiStore();
const stdin = new Tty();
const stdout = new Tty();
let out = '';
stdout.on('data', (d: Buffer) => (out += d.toString()));
const app = render(<App runtime={runtime} store={store} theme={NACRE} />, {
  stdin: stdin as never,
  stdout: stdout as never,
  stderr: stdout as never,
  exitOnCtrlC: false,
  patchConsole: false,
});
const type = async (s: string) => {
  for (const c of s) {
    stdin.write(c);
    await sleep(3);
  }
};

await sleep(300);
await type('explain this project');
stdin.write('\r');
await sleep(900);
await type('read package.json');
stdin.write('\r');
await sleep(900);
await type('write notes.md');
stdin.write('\r');
await sleep(700);
await type('/sw');
await sleep(200);

const strip = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
const lastFrame = (s: string) => {
  const parts = s.split('\u001b[2K\u001b[1A');
  return parts.length > 1 ? parts.slice(-1)[0]! : s;
};
const dump = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
if (dump) writeFileSync(dump, keepColor ? out : strip(out));
else console.log(keepColor ? out.slice(-6000) : strip(out).split('\n').slice(-60).join('\n'));
void lastFrame;
app.unmount();
await runtime.dispose();
mock.server.close();
process.exit(0);
