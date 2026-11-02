import { mkdirSync } from 'node:fs';
import type * as PlaywrightModule from 'playwright-core';
import type { BrowserContext, Page } from 'playwright-core';
import type { Config } from '../config/schema.js';
import type { ImageData } from '../llm/types.js';
import { Emitter } from '../util/emitter.js';
import { globMatch } from '../util/glob.js';
import { redact } from '../util/redact.js';
import { truncateMiddle } from '../util/text.js';
import { wrapUntrusted } from '../util/untrusted.js';

export type BrowserEvent =
  | { type: 'opened' }
  | { type: 'closed' }
  | { type: 'navigated'; url: string; title: string }
  | { type: 'action'; text: string }
  | { type: 'control'; holder: 'agent' | 'user' }
  | { type: 'blocked'; url: string; reason: string };

export type BrowserConfig = Config['browser'];

type Playwright = typeof PlaywrightModule;

export class BrowserError extends Error {}

const SNAPSHOT_LIMIT = 14_000;

/** Pure URL policy so it can be unit tested without a browser. */
export function checkUrl(raw: string, cfg: Pick<BrowserConfig, 'allowedHosts' | 'blockedHosts'>): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BrowserError(`Invalid URL: ${raw}`);
  }
  if (u.protocol === 'about:' && u.href === 'about:blank') return;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new BrowserError(`Blocked scheme "${u.protocol}". Only http(s) pages can be opened.`);
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '169.254.169.254' || host.startsWith('169.254.') || host === 'metadata.google.internal') {
    throw new BrowserError('Blocked: cloud metadata addresses are never reachable from the browser.');
  }
  if (cfg.blockedHosts.some((g) => globMatch(g, host)))
    throw new BrowserError(`Host ${host} is blocked by browser.blockedHosts.`);
  if (cfg.allowedHosts.length && !cfg.allowedHosts.some((g) => globMatch(g, host))) {
    throw new BrowserError(`Host ${host} is not in browser.allowedHosts.`);
  }
}

/**
 * Live browser session driven by the agent. A real (headed) Chrome/Edge window opens so the user can
 * watch every step, and can take control at any time with /browser takeover.
 */
export class BrowserService {
  readonly events = new Emitter<{ event: BrowserEvent }>();
  private context: BrowserContext | undefined;
  private launching: Promise<BrowserContext> | undefined;
  private holder: 'agent' | 'user' = 'agent';
  private activePage: Page | undefined;

  constructor(
    private cfg: BrowserConfig,
    private profileDir: string,
    private load: () => Promise<Playwright> = () => import('playwright-core'),
  ) {}

  get isOpen(): boolean {
    return !!this.context;
  }
  get controlledBy(): 'agent' | 'user' {
    return this.holder;
  }
  get currentUrl(): string | undefined {
    return this.activePage?.url();
  }

  private emit(e: BrowserEvent) {
    this.events.emit('event', e);
  }

  setControl(holder: 'agent' | 'user'): void {
    this.holder = holder;
    this.emit({ type: 'control', holder });
  }

  private assertAgentControl(): void {
    if (this.holder === 'user') {
      throw new BrowserError(
        'The user has taken control of the browser. Wait for them to hand it back, or ask them what to do.',
      );
    }
  }

  private async ensure(): Promise<Page> {
    this.assertAgentControl();
    if (!this.context) {
      this.launching ??= this.launch();
      try {
        this.context = await this.launching;
      } finally {
        this.launching = undefined;
      }
    }
    const pages = this.context.pages();
    if (!this.activePage || this.activePage.isClosed())
      this.activePage = pages.at(-1) ?? (await this.context.newPage());
    return this.activePage;
  }

  private async launch(): Promise<BrowserContext> {
    let pw: Playwright;
    try {
      pw = await this.load();
    } catch {
      throw new BrowserError(
        'playwright-core is not installed. Run `npm install playwright-core` in the Nacreframe install directory.',
      );
    }
    mkdirSync(this.profileDir, { recursive: true });
    let ctx: BrowserContext;
    try {
      ctx = await pw.chromium.launchPersistentContext(this.profileDir, {
        headless: this.cfg.headless,
        ...(this.cfg.channel === 'chromium' ? {} : { channel: this.cfg.channel }),
        viewport: null,
        acceptDownloads: false,
        permissions: [],
        args: ['--no-first-run', '--no-default-browser-check'],
      });
    } catch (e) {
      throw new BrowserError(
        `Could not start ${this.cfg.channel}: ${(e as Error).message.split('\n')[0]}. ` +
          `Install Google Chrome or Microsoft Edge, or run \`npx playwright-core install chromium\` and set browser.channel to "chromium".`,
      );
    }
    // Enforce the host policy on every top-level navigation, including redirects and link clicks.
    await ctx.route('**/*', async (route) => {
      const req = route.request();
      if (req.resourceType() === 'document') {
        try {
          checkUrl(req.url(), this.cfg);
        } catch (e) {
          const reason = (e as Error).message;
          this.emit({ type: 'blocked', url: req.url(), reason });
          // Answer with a notice instead of aborting, so the tab shows why (not an opaque browser error page).
          return route.fulfill({
            status: 403,
            contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><title>Blocked</title><h1>Blocked by Nacreframe policy</h1><p>${reason.replace(/[<>&]/g, '')}</p>`,
          });
        }
      }
      return route.continue();
    });
    ctx.on('close', () => {
      this.context = undefined;
      this.activePage = undefined;
      this.emit({ type: 'closed' });
    });
    ctx.on('page', (p) => {
      this.activePage = p;
    });
    this.emit({ type: 'opened' });
    return ctx;
  }

  private async afterAction(page: Page, text: string): Promise<string> {
    this.emit({ type: 'action', text });
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
    const title = await page.title().catch(() => '');
    this.emit({ type: 'navigated', url: page.url(), title });
    return `${text}\nPage: ${title || '(untitled)'} — ${page.url()}\n\n${await this.snapshotOf(page)}`;
  }

  private async snapshotOf(page: Page): Promise<string> {
    const snap = await page.ariaSnapshot({ mode: 'ai' });
    return wrapUntrusted(`browser:${page.url()}`, truncateMiddle(redact(snap), SNAPSHOT_LIMIT));
  }

  async navigate(url: string): Promise<string> {
    checkUrl(url, this.cfg);
    const page = await this.ensure();
    this.emit({ type: 'action', text: `navigate ${url}` });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return this.afterAction(page, `Navigated to ${url}`);
  }

  async snapshot(): Promise<string> {
    const page = await this.ensure();
    return `Page: ${await page.title().catch(() => '')} — ${page.url()}\n\n${await this.snapshotOf(page)}`;
  }

  async click(ref: string, element?: string, double = false): Promise<string> {
    const page = await this.ensure();
    const loc = page.getByRef(ref);
    this.emit({ type: 'action', text: `click ${element ?? ref}` });
    await (double ? loc.dblclick({ timeout: 8000 }) : loc.click({ timeout: 8000 }));
    return this.afterAction(page, `Clicked ${element ?? ref}`);
  }

  async type(ref: string, text: string, opts: { submit?: boolean; clear?: boolean } = {}): Promise<string> {
    const page = await this.ensure();
    const loc = page.getByRef(ref);
    this.emit({ type: 'action', text: `type into ${ref}` });
    if (opts.clear ?? true) await loc.fill(text, { timeout: 8000 });
    else await loc.pressSequentially(text, { timeout: 8000 });
    if (opts.submit) await loc.press('Enter', { timeout: 8000 });
    return this.afterAction(page, `Typed into ${ref}${opts.submit ? ' and pressed Enter' : ''}`);
  }

  async press(key: string): Promise<string> {
    const page = await this.ensure();
    this.emit({ type: 'action', text: `press ${key}` });
    await page.keyboard.press(key);
    return this.afterAction(page, `Pressed ${key}`);
  }

  async select(ref: string, values: string[]): Promise<string> {
    const page = await this.ensure();
    this.emit({ type: 'action', text: `select ${values.join(', ')}` });
    await page.getByRef(ref).selectOption(values, { timeout: 8000 });
    return this.afterAction(page, `Selected ${values.join(', ')}`);
  }

  async scroll(direction: 'up' | 'down', pages = 1): Promise<string> {
    const page = await this.ensure();
    const h = Number(await page.evaluate('window.innerHeight')) || 800;
    this.emit({ type: 'action', text: `scroll ${direction}` });
    await page.mouse.wheel(0, (direction === 'down' ? 1 : -1) * h * 0.85 * pages);
    return this.afterAction(page, `Scrolled ${direction}`);
  }

  async back(): Promise<string> {
    const page = await this.ensure();
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 });
    return this.afterAction(page, 'Went back');
  }

  async wait(opts: { seconds?: number; text?: string }): Promise<string> {
    const page = await this.ensure();
    if (opts.text) await page.getByText(opts.text).first().waitFor({ timeout: 15_000 });
    else await page.waitForTimeout(Math.min(30, opts.seconds ?? 2) * 1000);
    return this.afterAction(page, 'Waited');
  }

  /** Screenshot for the dashboard's live view. Never launches the browser, and never blocks on the user's control. */
  async screenshotIfOpen(): Promise<ImageData | undefined> {
    const page = this.activePage;
    if (!this.context || !page || page.isClosed()) return undefined;
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 4000 });
      return { mediaType: 'image/jpeg', data: buf.toString('base64') };
    } catch {
      return undefined;
    }
  }

  async screenshot(fullPage = false): Promise<ImageData> {
    const page = await this.ensure();
    const buf = await page.screenshot({ type: 'jpeg', quality: 70, fullPage });
    return { mediaType: 'image/jpeg', data: buf.toString('base64') };
  }

  async tabs(action: 'list' | 'new' | 'select' | 'close', index?: number, url?: string): Promise<string> {
    await this.ensure();
    const ctx = this.context!;
    if (action === 'new') {
      if (url) checkUrl(url, this.cfg);
      const p = await ctx.newPage();
      this.activePage = p;
      if (url) await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } else if (action === 'select' || action === 'close') {
      const p = ctx.pages()[index ?? -1];
      if (!p) throw new BrowserError(`No tab at index ${index}`);
      if (action === 'close') {
        await p.close();
        this.activePage = ctx.pages().at(-1);
      } else {
        this.activePage = p;
        await p.bringToFront();
      }
    }
    const pages = ctx.pages();
    const lines = await Promise.all(
      pages.map(
        async (p, i) =>
          `${p === this.activePage ? '*' : ' '} [${i}] ${await p.title().catch(() => '')} — ${p.url()}`,
      ),
    );
    return lines.join('\n') || '(no tabs)';
  }

  async close(): Promise<void> {
    const ctx = this.context;
    this.context = undefined;
    this.activePage = undefined;
    await ctx?.close().catch(() => undefined);
  }
}
