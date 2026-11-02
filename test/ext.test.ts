import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadExtensions, loadPromptTemplates } from '../src/ext/extensions.js';
import { connectMcp } from '../src/ext/mcp.js';
import { SkillStore } from '../src/ext/skills.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { GuardSandbox } from '../src/sandbox/guard.js';
import { testConfig, tmpWorkspace } from './helpers.js';

let ws: ReturnType<typeof tmpWorkspace>;
beforeEach(() => (ws = tmpWorkspace()));
afterEach(() => ws.cleanup());

const ctx = () => ({
  cwd: ws.dir,
  sandbox: new GuardSandbox({ cwd: ws.dir }),
  signal: new AbortController().signal,
  readState: new Map(),
  progress() {},
  config: testConfig(),
  agentId: 't',
});

describe('extensions', () => {
  it('loads a TypeScript extension: tools, commands and hooks', async () => {
    const dir = join(ws.dir, 'ext');
    mkdirSync(dir);
    copyFileSync(resolve('examples/extensions/protect-lockfiles.ts'), join(dir, 'protect-lockfiles.ts'));
    writeFileSync(join(dir, 'broken.js'), 'export default 42;');

    const ext = await loadExtensions([dir], ws.dir, testConfig());
    expect(ext.loaded).toHaveLength(1);
    expect(ext.warnings.join(' ')).toMatch(/broken\.js.*no default export/);
    expect(ext.tools.map((t) => t.name)).toEqual(['word_count']);
    expect(ext.commands.map((c) => c.name)).toEqual(['todo-scan']);

    const blocked = await ext.hooks.beforeTool!({
      agentId: 'a',
      name: 'write',
      input: { path: 'package-lock.json', content: '' },
    });
    expect(blocked).toEqual({ block: expect.stringContaining('Lockfiles') });
    expect(
      await ext.hooks.beforeTool!({ agentId: 'a', name: 'write', input: { path: 'src/a.ts' } }),
    ).toBeUndefined();

    const r = await ext.tools[0]!.execute({ text: 'one two  three' } as never, ctx());
    expect(r.content).toBe('3');
  });

  it('loads skills and expands prompt templates', () => {
    const skills = join(ws.dir, 'skills', 'deploy');
    mkdirSync(skills, { recursive: true });
    writeFileSync(
      join(skills, 'SKILL.md'),
      '---\nname: deploy\ndescription: Deploy the app\n---\nRun the script.\n',
    );
    mkdirSync(join(ws.dir, 'skills', 'bad'));
    writeFileSync(join(ws.dir, 'skills', 'bad', 'SKILL.md'), 'no front matter');
    const store = new SkillStore();
    const warnings = store.load([join(ws.dir, 'skills')]);
    expect(store.names()).toEqual(['deploy']);
    expect(store.get('deploy')).toContain('Run the script.');
    expect(warnings.join(' ')).toMatch(/no description/);

    const prompts = join(ws.dir, 'prompts');
    mkdirSync(prompts);
    writeFileSync(
      join(prompts, 'review.md'),
      '---\ndescription: Review a file\n---\nReview $1 focusing on: $ARGUMENTS',
    );
    const [cmd] = loadPromptTemplates([prompts]);
    let sent = '';
    cmd!.run('src/a.ts security', { cwd: ws.dir, prompt: (t) => (sent = t), notify() {} });
    expect(cmd!.description).toBe('Review a file');
    expect(sent).toBe('Review src/a.ts focusing on: src/a.ts security');
  });
});

describe('MCP client', () => {
  it('connects over stdio, namespaces tools, classifies risk and wraps output as untrusted', async () => {
    const conn = await connectMcp('fixture', {
      command: process.execPath,
      args: [resolve('test/fixtures/mcp-server.mjs')],
    });
    try {
      expect(conn.tools.map((t) => t.name).sort()).toEqual(['mcp__fixture__add', 'mcp__fixture__danger']);
      const add = conn.tools.find((t) => t.name.endsWith('add'))!;
      const danger = conn.tools.find((t) => t.name.endsWith('danger'))!;
      expect(add.risk).toBe('read'); // server declared readOnlyHint
      expect(danger.risk).toBe('exec'); // unknown side effects → needs approval

      const sum = await add.execute({ a: 2, b: 3 } as never, ctx());
      expect(sum.content).toContain('5');

      const out = await danger.execute({} as never, ctx());
      expect(out.content).toMatch(/^<untrusted_content source="mcp:fixture\/danger">/);

      const policy = new PolicyEngine({ mode: 'ask', rules: [] });
      expect(policy.decide(add, {}).action).toBe('allow');
      expect(policy.decide(danger, {}).action).toBe('ask');
    } finally {
      await conn.close();
    }
  });
});
