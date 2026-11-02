/**
 * Secret redaction. Applied to tool output before it reaches the model or the session log,
 * so a stray `env` or `cat .env` does not leak credentials into a third-party API.
 */
const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{32,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{40,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(?<=\bBearer\s)[A-Za-z0-9._~+/=-]{20,}/g,
];

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

export function isSecretEnvName(name: string): boolean {
  return SECRET_NAME.test(name);
}

export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 12 && SECRET_NAME.test(name)) {
      out = out.split(value).join(`[REDACTED:${name}]`);
    }
  }
  for (const p of PATTERNS) out = out.replace(p, '[REDACTED]');
  return out;
}

/** Environment safe to hand to child processes: secret-looking variables are removed. */
export function scrubEnv(env: NodeJS.ProcessEnv, keep: string[] = []): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_NAME.test(k) && !keep.includes(k)) continue;
    out[k] = v;
  }
  return out;
}
