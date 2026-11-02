import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { appPaths } from '../paths.js';
import { BIN, NAME, VERSION } from '../version.js';
import { isLoopback, startServer } from './app.js';

export const DEFAULT_PORT = 7437;

export const SERVE_HELP = `${NAME} dashboard — a self-hosted web UI for the harness

Usage
  ${BIN} serve [options]

Options
      --host <addr>          Address to listen on                (default 127.0.0.1)
      --port <n>             Port                                (default ${DEFAULT_PORT})
      --root <dir>           Folder sessions may work in; repeat for more (default: current folder)
      --token <secret>       Login token (default: generated once and stored; or NACRE_SERVER_TOKEN)
      --rotate-token         Replace the stored login token
      --no-auth              Disable login (only allowed on a loopback address)
      --allow-host <name>    Accept this Host header (your reverse-proxy name); repeat as needed
      --tls-cert <file>      Serve HTTPS with this certificate
      --tls-key <file>       …and this private key
      --max-sessions <n>     Open sessions at once               (default 8)
      --headed-browser       Let the agent open a visible browser window (default: headless)
  -h, --help
`;

/** Where the generated login token is kept (owner-only), so it survives restarts. */
function tokenFile(): string {
  return join(appPaths().state, 'web-token');
}

function loadOrCreateToken(rotate: boolean): { token: string; created: boolean } {
  const file = tokenFile();
  if (!rotate && existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t.length >= 24) return { token: t, created: false };
  }
  const token = randomBytes(24).toString('base64url');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token + '\n', { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* not supported on every filesystem */
  }
  return { token, created: true };
}

/** `dist/server/` and `src/server/` are both two levels below the project root that holds `web/`. */
export function defaultStaticDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
}

export async function serve(args: string[]): Promise<number> {
  let v;
  try {
    v = parseArgs({
      args,
      options: {
        host: { type: 'string' },
        port: { type: 'string' },
        root: { type: 'string', multiple: true },
        token: { type: 'string' },
        'rotate-token': { type: 'boolean' },
        'no-auth': { type: 'boolean' },
        'allow-host': { type: 'string', multiple: true },
        'tls-cert': { type: 'string' },
        'tls-key': { type: 'string' },
        'max-sessions': { type: 'string' },
        'headed-browser': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${SERVE_HELP}`);
    return 2;
  }
  if (v.help) {
    console.log(SERVE_HELP);
    return 0;
  }
  const host = v.host ?? '127.0.0.1';
  const port = v.port === undefined ? DEFAULT_PORT : Number(v.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('--port must be between 0 and 65535');
    return 2;
  }
  if (!!v['tls-cert'] !== !!v['tls-key']) {
    console.error('--tls-cert and --tls-key must be given together');
    return 2;
  }
  if (v['no-auth'] && !isLoopback(host)) {
    console.error(
      '--no-auth is only allowed when listening on a loopback address (127.0.0.1 / localhost / ::1).',
    );
    return 2;
  }

  let token: string | undefined;
  let created = false;
  if (!v['no-auth']) {
    const given = v.token ?? process.env.NACRE_SERVER_TOKEN;
    if (given) {
      if (given.length < 16) {
        console.error('The login token must be at least 16 characters.');
        return 2;
      }
      token = given;
    } else ({ token, created } = loadOrCreateToken(!!v['rotate-token']));
  }

  const roots = (v.root?.length ? v.root : [process.cwd()]).map((r) => resolve(r));
  const max = v['max-sessions'] === undefined ? 8 : Number(v['max-sessions']);

  let running;
  try {
    running = await startServer({
      host,
      port,
      roots,
      ...(token ? { token } : {}),
      ...(v['allow-host']?.length ? { allowHosts: v['allow-host'] } : {}),
      ...(v['tls-cert'] && v['tls-key']
        ? { tls: { cert: readFileSync(v['tls-cert'], 'utf8'), key: readFileSync(v['tls-key'], 'utf8') } }
        : {}),
      staticDir: defaultStaticDir(),
      maxSessions: Number.isInteger(max) && max > 0 ? max : 8,
      headlessBrowser: !v['headed-browser'],
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    console.error(
      err.code === 'EADDRINUSE'
        ? `Port ${port} is already in use. Pick another with --port.`
        : `Could not start the dashboard: ${err.message}`,
    );
    return 1;
  }

  console.log(`${NAME} ${VERSION} dashboard`);
  console.log(`  listening  ${running.url}`);
  console.log(`  folders    ${roots.join(', ')}`);
  if (token) {
    console.log(
      `  sign in    ${running.url}/#token=${token}${created ? '   (new token, stored with owner-only permissions)' : ''}`,
    );
  } else console.log('  auth       disabled (loopback only)');
  if (!isLoopback(host) && !v['tls-cert']) {
    console.log(
      '\n  ! Plain HTTP on a network address: the login token and everything you type cross the network unencrypted.\n' +
        '    Put it behind a TLS reverse proxy (Caddy, Traefik, nginx) or a VPN such as Tailscale, or pass --tls-cert/--tls-key.',
    );
  }

  await new Promise<void>((done) => {
    const stop = () => done();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  console.log('\nShutting down…');
  await running.close();
  return 0;
}
