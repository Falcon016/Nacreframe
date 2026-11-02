// Fails if anything that looks like a real credential is committed. Run in CI and before publishing.
// Placeholder-looking values (runs of A's, alphabet strings, "example") are ignored so docs and tests stay readable.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const PATTERNS = [
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9_-]{32,}/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ['GitHub fine-grained token', /github_pat_[A-Za-z0-9_]{40,}/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  [
    'Hard-coded credential assignment',
    /\b(?:api[_-]?key|secret|token|passwd|password)\b["']?\s*[:=]\s*["'][A-Za-z0-9/+_=-]{20,}["']/gi,
  ],
];

const PLACEHOLDER = /(A{8,}|abcdefghijklmnop|0123456789|x{8,}|example|placeholder|your[-_ ]?key|<[^>]+>)/i;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|zip|gz|lock)$|package-lock\.json$/i;

function files() {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  } catch {
    const acc = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else acc.push(relative(root, full));
      }
    };
    walk(root);
    return acc;
  }
}

let findings = 0;
for (const rel of files()) {
  if (SKIP_EXT.test(rel)) continue;
  let text;
  try {
    text = readFileSync(join(root, rel), 'utf8');
  } catch {
    continue;
  }
  if (rel === '.env' || /^\.env\.(?!example)/.test(rel)) {
    console.error(`✗ ${rel}: environment file must not be committed`);
    findings++;
    continue;
  }
  text.split('\n').forEach((line, i) => {
    for (const [label, re] of PATTERNS) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        if (PLACEHOLDER.test(m[0]) || PLACEHOLDER.test(line)) continue;
        console.error(`✗ ${rel}:${i + 1}: possible ${label}`);
        findings++;
      }
    }
  });
}

if (findings) {
  console.error(
    `\n${findings} possible secret(s) found. Remove them (and rotate the credential if it was ever pushed).`,
  );
  process.exit(1);
}
console.log('No secrets found.');
