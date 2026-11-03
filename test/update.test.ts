import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ThinkTagSplitter } from '../src/llm/openai.js';
import type { StreamEvent } from '../src/llm/types.js';
import { checkForUpdate } from '../src/update.js';
import { tmpWorkspace } from './helpers.js';

const ws = tmpWorkspace();
afterAll(() => ws.cleanup());

describe.skipIf(process.platform === 'win32')('checkForUpdate', () => {
  it('explains how to update a copy the installer did not make, instead of touching it', async () => {
    const root = join(ws.dir, 'checkout');
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'install.sh'), '#!/bin/sh\n');
    const r = await checkForUpdate(root, { PATH: '/usr/bin' }, join(ws.dir, 'home'));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('git pull && npm ci && npm run build');
  });

  it('points a copy without git at the install command', async () => {
    const root = join(ws.dir, 'unpacked');
    mkdirSync(root, { recursive: true });
    const r = await checkForUpdate(root, { PATH: '/usr/bin' }, join(ws.dir, 'home'));
    expect(!r.ok && r.error).toContain('install.sh | sh');
  });
});

describe('inline <think> reasoning from local models', () => {
  const run = (chunks: string[]) => {
    const s = new ThinkTagSplitter();
    const ev: StreamEvent[] = [];
    for (const c of chunks) ev.push(...s.push(c));
    ev.push(...s.flush());
    const out = { thinking: '', text: '' };
    for (const e of ev) if (e.type === 'thinking' || e.type === 'text') out[e.type] += e.delta;
    return out;
  };

  it('separates a leading <think> block from the answer, even when tags are split across chunks', () => {
    expect(run(['<think>I should ', 'add</thi', 'nk>\n\nHello ', 'world'])).toEqual({
      thinking: 'I should add',
      text: 'Hello world',
    });
    expect(run(['<', 'think>a</think>b'])).toEqual({ thinking: 'a', text: 'b' });
  });

  it('leaves text alone when the reply does not start with reasoning', () => {
    expect(run(['Hello <think>not reasoning</think> ok'])).toEqual({
      thinking: '',
      text: 'Hello <think>not reasoning</think> ok',
    });
    expect(run(['plain ', 'answer <', 'b>bold'])).toEqual({ thinking: '', text: 'plain answer <b>bold' });
  });

  it('keeps reasoning that never closes as reasoning', () => {
    expect(run(['<think>never closed'])).toEqual({ thinking: 'never closed', text: '' });
  });
});
