import { truncate, type Term } from './ui.js';

/** Thrown when the user presses Ctrl+C at a prompt. */
export class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

export interface Choice<T> {
  value: T;
  label: string;
  /** Dimmed text after the label. */
  hint?: string;
  /** When set the choice is shown greyed out with this reason and cannot be picked. */
  disabled?: string;
}

export interface SelectOptions<T> {
  message: string;
  choices: Choice<T>[];
  /** Index highlighted at the start. */
  initial?: number;
  help?: string;
}
export interface ConfirmOptions {
  message: string;
  initial?: boolean;
  help?: string;
}
export interface TextOptions {
  message: string;
  initial?: string;
  placeholder?: string;
  help?: string;
  /** Return an error message to reject the value. */
  validate?: (value: string) => string | undefined;
}

/** What the wizard needs from a terminal. The real one is `TtyPrompter`; tests script their own. */
export interface Prompter {
  select<T>(opts: SelectOptions<T>): Promise<T>;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  text(opts: TextOptions): Promise<string>;
  /** Like `text`, but echoes dots and never shows the value afterwards. */
  secret(opts: Omit<TextOptions, 'initial' | 'placeholder'>): Promise<string>;
}

// ---- key parsing ---------------------------------------------------------------------------------

export type Key =
  | { name: 'char'; char: string }
  | {
      name:
        | 'up'
        | 'down'
        | 'left'
        | 'right'
        | 'home'
        | 'end'
        | 'enter'
        | 'backspace'
        | 'delete'
        | 'ctrl-c'
        | 'ctrl-u'
        | 'ctrl-w'
        | 'escape';
    };

/** Turn a chunk of raw terminal input into keys. Handles pasted text, CRLF and arrow-key escape sequences. */
export function parseKeys(data: string): Key[] {
  const keys: Key[] = [];
  const chars = [...data];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c === '\x1b') {
      const next = chars[i + 1];
      if (next === '[' || next === 'O') {
        let j = i + 2;
        let params = '';
        while (j < chars.length && /[0-9;]/.test(chars[j]!)) params += chars[j++];
        const final = chars[j] ?? '';
        i = j; // skip the whole sequence even if we do not know it
        const byFinal: Record<string, Key['name']> = {
          A: 'up',
          B: 'down',
          C: 'right',
          D: 'left',
          H: 'home',
          F: 'end',
        };
        if (final === '~') {
          if (params === '3') keys.push({ name: 'delete' });
          else if (params === '1' || params === '7') keys.push({ name: 'home' });
          else if (params === '4' || params === '8') keys.push({ name: 'end' });
        } else if (byFinal[final]) keys.push({ name: byFinal[final] } as Key);
      } else keys.push({ name: 'escape' });
    } else if (c === '\r') {
      if (chars[i + 1] === '\n') i++;
      keys.push({ name: 'enter' });
    } else if (c === '\n') keys.push({ name: 'enter' });
    else if (c === '\x7f' || c === '\b') keys.push({ name: 'backspace' });
    else if (c === '\x03') keys.push({ name: 'ctrl-c' });
    else if (c === '\x15') keys.push({ name: 'ctrl-u' });
    else if (c === '\x17') keys.push({ name: 'ctrl-w' });
    else if (c === '\x01') keys.push({ name: 'home' });
    else if (c === '\x05') keys.push({ name: 'end' });
    else if (c < ' ')
      continue; // other control characters (tab, ctrl-d, ...)
    else keys.push({ name: 'char', char: c });
  }
  return keys;
}

// ---- the interactive prompter --------------------------------------------------------------------

export interface TtyInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  setEncoding(enc: BufferEncoding): unknown;
  on(event: 'data', cb: (chunk: string) => void): unknown;
  off(event: 'data', cb: (chunk: string) => void): unknown;
}

/**
 * Arrow-key menus, y/n questions, text and hidden input on a real terminal.
 * Everything redraws in place and collapses to one summary line when answered.
 */
export class TtyPrompter implements Prompter {
  constructor(
    private stdin: TtyInput,
    private term: Term,
  ) {}

  /** Feed keys to `onKey` until it returns a value; always restores the terminal. */
  private session<R>(onKey: (key: Key, finish: (r: R) => void) => void): Promise<R> {
    const { stdin } = this;
    return new Promise<R>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        stdin.off('data', onData);
        try {
          stdin.setRawMode?.(false);
        } catch {
          /* terminal already gone */
        }
        stdin.pause();
      };
      const finish = (r: R) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(r);
      };
      const onData = (chunk: string) => {
        for (const key of parseKeys(String(chunk))) {
          if (settled) return; // keys typed after the answer belong to the next prompt, not this one
          if (key.name === 'ctrl-c') {
            settled = true;
            cleanup();
            reject(new Cancelled());
            return;
          }
          onKey(key, finish);
        }
      };
      stdin.setEncoding('utf8');
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.on('data', onData);
    });
  }

  private clear(lines: number): void {
    if (lines > 0) this.term.write(`\x1b[${lines}A`);
    this.term.write('\r\x1b[J');
  }

  private done(message: string, answer: string): void {
    const t = this.term;
    const room = t.columns - 6 - message.length;
    t.line(`  ${t.good(t.sym.ok)} ${message}  ${t.accent(truncate(answer, Math.max(10, room)))}`);
  }

  async select<T>(o: SelectOptions<T>): Promise<T> {
    const t = this.term;
    const usable = o.choices.map((c, i) => (c.disabled ? -1 : i)).filter((i) => i >= 0);
    if (usable.length === 0) throw new Error('No selectable choices');
    let cur = o.initial !== undefined && usable.includes(o.initial) ? o.initial : usable[0]!;
    const labelW = Math.max(...o.choices.map((c) => c.label.length));
    const numW = String(o.choices.length).length;
    let drawn = 0;

    const draw = () => {
      if (drawn) this.clear(drawn);
      const lines: string[] = [`  ${t.accent(t.sym.title)} ${t.bold(o.message)}`];
      if (o.help) lines.push(`    ${t.dim(truncate(o.help, t.columns - 6))}`);
      o.choices.forEach((c, i) => {
        const active = i === cur;
        const num = `${i + 1}.`.padStart(numW + 1);
        const pointer = active ? t.accent(t.sym.pointer) : ' ';
        const hintRoom = t.columns - 8 - numW - 1 - labelW - 2;
        const hint = c.disabled ?? c.hint;
        const hintText = hint && hintRoom > 8 ? '  ' + t.dim(truncate(hint, hintRoom)) : '';
        const label = c.label.padEnd(labelW);
        const styled = c.disabled ? t.dim(label) : active ? t.accent(t.bold(label)) : label;
        lines.push(`  ${pointer} ${t.dim(num)} ${styled}${hintText}`);
      });
      for (const l of lines) t.line(l);
      drawn = lines.length;
    };
    const move = (dir: 1 | -1) => {
      let n = cur;
      do n = (n + dir + o.choices.length) % o.choices.length;
      while (o.choices[n]!.disabled);
      cur = n;
    };

    draw();
    const picked = await this.session<number>((key, finish) => {
      if (key.name === 'up') move(-1);
      else if (key.name === 'down') move(1);
      else if (key.name === 'home') cur = usable[0]!;
      else if (key.name === 'end') cur = usable[usable.length - 1]!;
      else if (key.name === 'char' && /^[1-9]$/.test(key.char)) {
        const n = Number(key.char) - 1;
        if (n < o.choices.length && !o.choices[n]!.disabled) cur = n;
      } else if (key.name === 'enter') return finish(cur);
      else return;
      draw();
    }).catch((e: unknown) => {
      this.clear(drawn);
      throw e;
    });
    this.clear(drawn);
    const chosen = o.choices[picked]!;
    this.done(o.message, chosen.label);
    return chosen.value;
  }

  async confirm(o: ConfirmOptions): Promise<boolean> {
    const t = this.term;
    const initial = o.initial ?? true;
    const hint = initial ? 'Y/n' : 'y/N';
    let drawn = 0;
    const draw = () => {
      const lines = [`  ${t.accent(t.sym.title)} ${t.bold(o.message)} ${t.dim(`(${hint})`)}`];
      if (o.help) lines.push(`    ${t.dim(truncate(o.help, t.columns - 6))}`);
      for (const l of lines) t.line(l);
      drawn = lines.length;
    };
    draw();
    const answer = await this.session<boolean>((key, finish) => {
      if (key.name === 'enter') finish(initial);
      else if (key.name === 'char' && /^[yY]$/.test(key.char)) finish(true);
      else if (key.name === 'char' && /^[nN]$/.test(key.char)) finish(false);
    }).catch((e: unknown) => {
      this.clear(drawn);
      throw e;
    });
    this.clear(drawn);
    this.done(o.message, answer ? 'Yes' : 'No');
    return answer;
  }

  text(o: TextOptions): Promise<string> {
    return this.input(o, false);
  }
  secret(o: Omit<TextOptions, 'initial' | 'placeholder'>): Promise<string> {
    return this.input(o, true);
  }

  private async input(o: TextOptions, hidden: boolean): Promise<string> {
    const t = this.term;
    let value = o.initial ?? '';
    let pos = [...value].length;
    let error: string | undefined;
    let headerLines = 0;
    const promptPrefix = '    ' + t.sym.pointer + ' ';
    const prefixWidth = 4 + t.sym.pointer.length + 1;

    const shown = () => {
      const chars = [...value];
      if (!hidden) return chars.join('');
      return (
        t.sym.mask.repeat(Math.min(chars.length, 32)) + (chars.length > 32 ? `… ${chars.length} chars` : '')
      );
    };

    const draw = (first = false) => {
      if (!first) this.clear(headerLines);
      const header = [`  ${t.accent(t.sym.title)} ${t.bold(o.message)}`];
      if (error) header.push(`    ${t.bad(truncate(error, t.columns - 6))}`);
      else if (o.help) header.push(`    ${t.dim(truncate(o.help, t.columns - 6))}`);
      for (const l of header) t.line(l);
      headerLines = header.length;
      const body = value
        ? t.accent(truncate(shown(), t.columns - prefixWidth - 1))
        : o.placeholder
          ? t.dim(truncate(o.placeholder, t.columns - prefixWidth - 1))
          : '';
      t.write(`${t.accent(promptPrefix)}${body}`);
      // Put the cursor back where the text caret is (hidden input keeps it at the end).
      const back = value ? (hidden ? 0 : [...value].length - pos) : (o.placeholder ?? '').length;
      if (back > 0) t.write(`\x1b[${back}D`);
    };

    draw(true);
    const result = await this.session<string>((key, finish) => {
      const chars = [...value];
      if (key.name === 'enter') {
        const trimmed = value.trim();
        const problem = o.validate?.(trimmed);
        if (problem) {
          error = problem;
          t.write('\r\x1b[2K'); // leave the input line, then redraw everything
          draw();
          return;
        }
        return finish(trimmed);
      }
      if (key.name === 'char') {
        chars.splice(pos, 0, key.char);
        pos++;
      } else if (key.name === 'backspace') {
        if (pos > 0) chars.splice(--pos, 1);
      } else if (key.name === 'delete') chars.splice(pos, 1);
      else if (key.name === 'left') pos = Math.max(0, pos - 1);
      else if (key.name === 'right') pos = Math.min(chars.length, pos + 1);
      else if (key.name === 'home') pos = 0;
      else if (key.name === 'end') pos = chars.length;
      else if (key.name === 'ctrl-u') {
        chars.splice(0, pos);
        pos = 0;
      } else if (key.name === 'ctrl-w') {
        let start = pos;
        while (start > 0 && chars[start - 1] === ' ') start--;
        while (start > 0 && chars[start - 1] !== ' ') start--;
        chars.splice(start, pos - start);
        pos = start;
      } else return;
      value = chars.join('');
      error = undefined;
      t.write('\r\x1b[2K');
      draw();
    }).catch((e: unknown) => {
      t.write('\r\x1b[2K');
      this.clear(headerLines);
      throw e;
    });
    t.write('\r\x1b[2K');
    this.clear(headerLines);
    this.done(o.message, hidden ? t.sym.mask.repeat(8) : result || '(none)');
    return result;
  }
}
