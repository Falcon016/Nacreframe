/**
 * Small terminal toolkit for `nexus setup`: colour, symbols, headings and a spinner.
 * No dependencies. Colour and Unicode degrade gracefully (NO_COLOR, dumb terminals, legacy consoles, pipes).
 */

export interface TermOutput {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

export interface TermOptions {
  out?: TermOutput;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Force colour on/off (tests). Default: on for a real terminal unless NO_COLOR is set. */
  color?: boolean;
  /** Force Unicode symbols on/off (tests). */
  unicode?: boolean;
}

export function detectUnicode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return !!(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === 'ON');
  if (env.TERM === 'linux') return false; // the kernel console lacks most of these glyphs
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  return locale === '' || /utf-?8/i.test(locale);
}

const SYMBOLS_UNICODE = {
  ok: '✓',
  warn: '!',
  fail: '✗',
  info: '•',
  title: '●',
  node: '◉',
  pointer: '❯',
  arrow: '→',
  mask: '•',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  hint: '↑/↓',
};
const SYMBOLS_ASCII = {
  ok: '+',
  warn: '!',
  fail: 'x',
  info: '-',
  title: '*',
  node: 'o',
  pointer: '>',
  arrow: '->',
  mask: '*',
  spinner: ['|', '/', '-', '\\'],
  hint: 'up/down',
};
export type Symbols = typeof SYMBOLS_UNICODE;

export class Term {
  readonly out: TermOutput;
  readonly env: NodeJS.ProcessEnv;
  readonly tty: boolean;
  readonly color: boolean;
  readonly unicode: boolean;
  readonly sym: Symbols;
  private truecolor: boolean;

  constructor(opts: TermOptions = {}) {
    this.out = opts.out ?? process.stdout;
    this.env = opts.env ?? process.env;
    const platform = opts.platform ?? process.platform;
    this.tty = !!this.out.isTTY;
    this.color =
      opts.color ??
      (!this.env.NO_COLOR &&
        (this.env.FORCE_COLOR ? this.env.FORCE_COLOR !== '0' : this.tty) &&
        this.env.TERM !== 'dumb');
    this.unicode = opts.unicode ?? detectUnicode(this.env, platform);
    this.sym = this.unicode ? SYMBOLS_UNICODE : SYMBOLS_ASCII;
    this.truecolor = /truecolor|24bit/i.test(this.env.COLORTERM ?? '');
  }

  get columns(): number {
    return Math.max(40, Math.min(this.out.columns ?? 80, 100));
  }

  // ---- styling --------------------------------------------------------------------------------
  private wrap(open: string, s: string): string {
    return this.color ? `\x1b[${open}m${s}\x1b[0m` : s;
  }
  bold = (s: string) => this.wrap('1', s);
  dim = (s: string) => this.wrap('2', s);
  /** The Nexus blue. */
  accent = (s: string) => this.wrap(this.truecolor ? '38;2;92;200;255' : '38;5;81', s);
  good = (s: string) => this.wrap('32', s);
  warn = (s: string) => this.wrap('33', s);
  bad = (s: string) => this.wrap('31', s);

  // ---- output ---------------------------------------------------------------------------------
  write(s: string): void {
    this.out.write(s);
  }
  line(s = ''): void {
    this.out.write(s + '\n');
  }

  banner(title: string, tagline: string): void {
    this.line();
    // The logo in text form: a glowing node in its ring.
    this.line(`  ${this.accent(this.sym.node)} ${this.bold(title)}`);
    this.line(`    ${this.dim(tagline)}`);
    this.line();
  }

  /** A section title, with an optional quiet step counter after it ("1 of 4"). */
  heading(text: string, step?: string): void {
    this.line();
    this.line(`  ${this.bold(text)}${step ? `  ${this.dim(step)}` : ''}`);
  }

  ok(msg: string, detail?: string): void {
    this.line(`  ${this.good(this.sym.ok)} ${msg}${detail ? ' ' + this.dim(detail) : ''}`);
  }
  warning(msg: string, detail?: string): void {
    this.line(`  ${this.warn(this.sym.warn)} ${msg}${detail ? ' ' + this.dim(detail) : ''}`);
  }
  fail(msg: string, detail?: string): void {
    this.line(`  ${this.bad(this.sym.fail)} ${msg}${detail ? ' ' + this.dim(detail) : ''}`);
  }
  info(msg: string): void {
    this.line(`  ${this.dim(this.sym.info)} ${msg}`);
  }
  /** Indented, dimmed explanatory text. */
  note(msg: string): void {
    for (const l of msg.split('\n')) this.line(`    ${this.dim(l)}`);
  }

  /** Aligned `label  value` rows. */
  table(rows: [string, string][]): void {
    const w = Math.max(...rows.map(([k]) => k.length));
    for (const [k, v] of rows) this.line(`    ${this.dim(k.padEnd(w))}  ${v}`);
  }

  /** A line of progress that animates on a terminal and prints once (when finished) elsewhere. */
  spinner(label: string): Spinner {
    return new Spinner(this, label);
  }
}

export class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private i = 0;
  private done = false;

  constructor(
    private term: Term,
    private label: string,
  ) {
    if (term.tty) {
      this.draw();
      this.timer = setInterval(() => this.draw(), 80);
      this.timer.unref();
    }
  }

  private draw(): void {
    const f = this.term.sym.spinner[this.i++ % this.term.sym.spinner.length]!;
    this.term.write(`\r\x1b[2K  ${this.term.accent(f)} ${this.label}`);
  }

  update(label: string): void {
    this.label = label;
  }

  private finish(print: () => void): void {
    if (this.done) return;
    this.done = true;
    if (this.timer) clearInterval(this.timer);
    if (this.term.tty) this.term.write('\r\x1b[2K');
    print();
  }
  succeed(msg = this.label, detail?: string): void {
    this.finish(() => this.term.ok(msg, detail));
  }
  warn(msg = this.label, detail?: string): void {
    this.finish(() => this.term.warning(msg, detail));
  }
  fail(msg = this.label, detail?: string): void {
    this.finish(() => this.term.fail(msg, detail));
  }
  /** Stop without printing anything. */
  stop(): void {
    this.finish(() => {});
  }
}

/** Shorten plain text to `max` visible characters. */
export function truncate(s: string, max: number): string {
  if (max <= 1) return '';
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
