/// <reference lib="dom" />
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../src/server/app.js';
import { findBrowser, tmpWorkspace } from './helpers.js';
import { startMockLlm } from './mock-llm.js';

const channel = findBrowser();
const TOKEN = 'ui-test-token-0123456789abcdef';
const SHOTS = process.env.NACRE_SHOT_DIR; // set to keep screenshots for design review

describe.skipIf(!channel)('web dashboard in a real browser', () => {
  let mock: Awaited<ReturnType<typeof startMockLlm>>;
  let ws: ReturnType<typeof tmpWorkspace>;
  let srv: RunningServer;
  let browser: Browser;
  let page: Page;
  let work: string;
  const problems: string[] = [];

  const shot = async (name: string) => {
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    }
  };

  beforeAll(async () => {
    mock = await startMockLlm();
    ws = tmpWorkspace();
    const home = join(ws.dir, 'home');
    mkdirSync(join(home, 'config'), { recursive: true });
    writeFileSync(
      join(home, 'config', 'config.json'),
      JSON.stringify({
        browser: { enabled: false },
        providers: { mock: { type: 'openai', baseUrl: mock.url } },
      }),
    );
    work = join(ws.dir, 'work');
    mkdirSync(work);
    srv = await startServer({
      host: '127.0.0.1',
      port: 0,
      roots: [work],
      token: TOKEN,
      staticDir: resolve('web'),
      env: { ...process.env, NACRE_HOME: home },
    });
    browser = await chromium.launch({ channel: channel!, headless: true });
    page = await (await browser.newContext({ viewport: { width: 1360, height: 860 } })).newPage();
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    });
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await srv?.close();
    mock?.server.close();
    ws?.cleanup();
  });

  it('signs in from the URL fragment and removes the token from the address bar', async () => {
    await page.goto(`${srv.url}/#token=${TOKEN}`);
    await page.locator('#app').waitFor({ state: 'visible' });
    expect(page.url()).not.toContain('token');
    expect(await page.locator('.empty h2').innerText()).toContain('What shall we build');
    await shot('01-empty');
  });

  it('creates a session from the dialog with a detected model', async () => {
    await page.getByRole('button', { name: 'New session' }).first().click();
    await page.locator('#new-dialog[open]').waitFor();
    expect(await page.locator('#nf-cwd').inputValue()).toBe(work);
    await page.waitForFunction(() => document.querySelectorAll('#nf-model option').length > 1);
    await page.selectOption('#nf-model', 'mock/mock-1');
    await page.selectOption('#nf-approval', 'auto');
    await shot('02-dialog');
    await page.locator('#nf-create').click();
    await page.waitForSelector('#title small');
    expect(await page.locator('#title').innerText()).toContain('work');
    expect(await page.locator('#model').inputValue()).toBe('mock/mock-1');
    expect(await page.locator('#mode').inputValue()).toBe('auto');
  });

  it('streams a reply, renders markdown safely and never executes model- or user-supplied markup', async () => {
    const payload = '<img src=x onerror="window.__xss=1"> hello';
    await page.fill('#input', payload);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.msg-assistant pre code');
    const transcript = page.locator('#transcript');
    expect(await transcript.locator('.msg-user').first().innerText()).toContain('<img src=x'); // shown as text
    expect(await transcript.locator('img').count()).toBe(0); // …never as an element
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    expect(await transcript.locator('.msg-assistant strong').first().innerText()).toBe('mock');
    expect(await transcript.locator('.msg-assistant li code').first().innerText()).toBe('inline code');
    expect(await transcript.locator('.msg-assistant pre code').first().innerText()).toContain('const x = 1;');
    await page.waitForFunction(() => /\d+%/.test(document.querySelector('#meter-text')?.textContent ?? ''));
    await shot('03-conversation');
  });

  it('asks for approval in ask mode and acts on the keyboard shortcut', async () => {
    await page.selectOption('#mode', 'ask');
    await page.waitForFunction(() => document.querySelector('#mode')?.className === 'mode-ask');
    await page.fill('#input', 'write from-ui.txt');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.card.approval');
    expect(await page.locator('.card.approval').innerText()).toContain('from-ui.txt');
    expect(existsSync(join(work, 'from-ui.txt'))).toBe(false);
    await shot('04-approval');
    await page.locator('#input').blur();
    await page.keyboard.press('y');
    await page.waitForFunction(() => !document.querySelector('.card.approval'));
    expect(existsSync(join(work, 'from-ui.txt'))).toBe(true);
    await page.waitForSelector('.tool.ok');
  });

  it('runs a swarm and shows the roster and channel', async () => {
    await page.selectOption('#mode', 'auto');
    await page.getByRole('button', { name: 'Panel' }).click();
    await shot('05a-panel');
    await page.locator('#panel .pcard', { hasText: 'Swarm' }).getByRole('button', { name: 'duo' }).click();
    await page.waitForSelector('#panel .agent', { timeout: 8000 }).catch(async (e) => {
      await shot('05b-swarm-failed');
      throw e;
    });
    expect(await page.locator('#panel .agent strong').allInnerTexts()).toEqual(['planner', 'builder']);
    await page.fill('#input', 'build the thing');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.channel .text:has-text("build the thing")');
    await page.waitForSelector('.msg-assistant .who:has-text("planner")');
    await shot('05-swarm');
  });

  it('is usable on a phone-sized screen', async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    // No element may stick out past the viewport (the page must not scroll sideways).
    const wide = await page.evaluate(() =>
      [...document.querySelectorAll('body *')]
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.right > window.innerWidth + 1 && !e.closest('#sidebar:not(.open)');
        })
        .slice(0, 6)
        .map((e) => `${e.tagName.toLowerCase()}#${e.id}.${e.className}`),
    );
    expect(wide).toEqual([]);
    await page.locator('#menu-btn').click();
    await page.waitForSelector('#sidebar.open');
    await shot('06-mobile');
    await page.setViewportSize({ width: 1360, height: 860 });
  });

  it('shows the login screen again after signing out, and raised no CSP or script errors', async () => {
    await page.locator('#logout').click();
    await page.locator('#login').waitFor({ state: 'visible' });
    expect(problems).toEqual([]);
  });
});
