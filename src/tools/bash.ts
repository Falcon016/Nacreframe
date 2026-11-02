import { spawn } from 'node:child_process';
import { z } from 'zod';
import { detectShell, killTree } from '../sandbox/shell.js';
import { redact } from '../util/redact.js';
import { truncateHead } from '../util/text.js';
import { defineTool } from './types.js';

const MAX_BUFFER = 1_000_000;
const OUTPUT_LIMIT = 30_000;

export const bashTool = defineTool({
  name: 'bash',
  description: `Run a shell command in the workspace and return its combined output and exit code. Each call is a fresh shell (no state carries over), so use absolute paths or chain with &&. Shell on this machine: ${detectShell().name}. Commands that wait for input will hang until the timeout; pass non-interactive flags. Output is truncated to the last ${OUTPUT_LIMIT} characters.`,
  risk: 'exec',
  schema: z.object({
    command: z.string().min(1).describe('The command to run'),
    description: z.string().optional().describe('Short human-readable summary of what this does'),
    timeout_ms: z.number().int().min(1000).max(600_000).optional().describe('Timeout, default 120000'),
  }),
  primaryArg: (i) => i.command,
  describe: (i) => i.description ?? i.command.split('\n')[0]!,
  async execute(input, ctx) {
    const wrapped = ctx.sandbox.wrapExec({ command: input.command, cwd: ctx.cwd, env: process.env });
    const timeout = input.timeout_ms ?? 120_000;
    return new Promise((resolve) => {
      const child = spawn(wrapped.file, wrapped.args, {
        cwd: wrapped.cwd,
        env: wrapped.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      let buf = '';
      let dropped = 0;
      let timedOut = false;
      let aborted = false;
      let lastProgress = 0;

      const onData = (d: Buffer) => {
        buf += d.toString('utf8');
        if (buf.length > MAX_BUFFER) {
          dropped += buf.length - MAX_BUFFER;
          buf = buf.slice(buf.length - MAX_BUFFER);
        }
        const now = Date.now();
        if (now - lastProgress > 100) {
          lastProgress = now;
          ctx.progress(redact(buf.slice(-2000)));
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);

      const kill = () => {
        killTree(child.pid);
        wrapped.kill?.();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeout);
      const onAbort = () => {
        aborted = true;
        kill();
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      const finish = (code: number | null, err?: Error) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        let out = redact(buf);
        if (dropped) out = `[… ${dropped} earlier characters dropped …]\n${out}`;
        out = truncateHead(out, OUTPUT_LIMIT);
        if (err) return resolve({ content: `Failed to start command: ${err.message}`, isError: true });
        if (aborted) return resolve({ content: `${out}\n[interrupted by user]`.trim(), isError: true });
        if (timedOut)
          return resolve({
            content: `${out}\n[timed out after ${timeout}ms and was killed]`.trim(),
            isError: true,
          });
        const status = code === 0 ? '' : `\n[exit code ${code}]`;
        resolve({ content: (out + status).trim() || '(no output)', isError: code !== 0 });
      };
      child.on('error', (e) => finish(null, e));
      child.on('close', (code) => finish(code));
    });
  },
});

/**
 * Commands that only inspect state. These are auto-approved in `ask` mode.
 * Deliberately conservative: anything with redirection, substitution or chaining outside plain
 * pipes of known read-only commands falls through to normal approval.
 */
const READ_ONLY = new Set([
  'ls',
  'dir',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'echo',
  'which',
  'where',
  'whoami',
  'date',
  'uname',
  'file',
  'stat',
  'tree',
  'du',
  'df',
  'sort',
  'uniq',
  'cut',
  'basename',
  'dirname',
  'type',
]);
const READ_ONLY_GIT = new Set([
  'status',
  'diff',
  'log',
  'show',
  'branch',
  'remote',
  'rev-parse',
  'ls-files',
  'blame',
  'describe',
]);

export function isReadOnlyCommand(command: string): boolean {
  if (/[<>`\n\r]|\$\(|\$\{/.test(command)) return false;
  if (/(^|[^|])&(?!&)/.test(command)) return false;
  const segments = command.split(/\|\||&&|;|\|/).map((s) => s.trim());
  return segments.every((seg) => {
    const [bin, sub, ...rest] = seg.split(/\s+/);
    if (!bin) return false;
    if (bin === 'git') {
      return (
        !!sub &&
        READ_ONLY_GIT.has(sub) &&
        !rest.some((a) => /^(--output|-o|--ext-diff)/.test(a)) &&
        !(sub === 'branch' && rest.some((a) => /^-[dDmMcC]|--delete|--move|--copy/.test(a)))
      );
    }
    if (bin === 'find') return !/-(exec|execdir|delete|ok|fprint)/.test(seg);
    return READ_ONLY.has(bin);
  });
}

/** Patterns that are never run, in any approval mode. */
const HARD_DENY: [RegExp, string][] = [
  [
    /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(--no-preserve-root\s+)?(\/|~|\$HOME|\*)(\s|$)/,
    'recursive delete of root or home',
  ],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork bomb'],
  [/\bmkfs(\.\w+)?\b/, 'filesystem formatting'],
  [/\bdd\b[^|;&]*\bof=\/dev\/(sd|nvme|hd|disk)/, 'raw disk write'],
  [/>\s*\/dev\/(sd|nvme|hd|disk)/, 'raw disk write'],
  [/\bformat\s+[a-zA-Z]:/i, 'drive formatting'],
  [/\bRemove-Item\b[^|;]*-Recurse[^|;]*\s+[a-zA-Z]:\\\s*$/i, 'recursive delete of a drive root'],
  [/\bdel\s+\/[fsq]+\s+[a-zA-Z]:\\/i, 'recursive delete of a drive root'],
];

/** Patterns that always require a human, even in auto mode. */
const ESCALATE: [RegExp, string][] = [
  [/\bsudo\b|\bsu\s+-?\w*\b|\bdoas\b/, 'privilege escalation'],
  [
    /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|;]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/i,
    'piping a download into a shell',
  ],
  [/\bgit\s+push\b/, 'pushing to a remote'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|restore\s+\.)/, 'discarding local changes'],
  [
    /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgh\s+release\b/,
    'publishing a package or release',
  ],
  [/\brm\s+-[a-zA-Z]*r/, 'recursive delete'],
  [/\bchmod\s+-R\b|\bchown\s+-R\b/, 'recursive permission change'],
  [/\b(shutdown|reboot|halt|poweroff)\b/, 'system power command'],
  [/\bdocker\s+(run|exec)\b[^|;]*--privileged/, 'privileged container'],
];

export function hardDenyReason(command: string): string | undefined {
  return HARD_DENY.find(([re]) => re.test(command))?.[1];
}

export function escalationReason(command: string): string | undefined {
  return ESCALATE.find(([re]) => re.test(command))?.[1];
}
