import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  createServer as createHttp,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttps } from 'node:https';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Runtime } from '../runtime.js';
import { VERSION } from '../version.js';
import { HttpError, SessionManager } from './sessions.js';

export interface ServerOptions {
  host: string;
  port: number;
  /** Directories sessions may work in. */
  roots: string[];
  /** Shared secret for login. Omit only when bound to loopback (auth is then disabled). */
  token?: string;
  /** Extra Host header values to accept (your reverse-proxy name). */
  allowHosts?: string[];
  tls?: { cert: string; key: string };
  /** Directory containing index.html, app.js, app.css, fonts/. */
  staticDir: string;
  maxSessions?: number;
  /** Run the agent's browser headless (default on a server). */
  headlessBrowser?: boolean;
  env?: NodeJS.ProcessEnv;
}

const MAX_BODY = 1_000_000;
const COOKIE = 'nacre_sid';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export const isLoopback = (host: string) => /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/.test(host);

const digest = (s: string) => createHash('sha256').update(s).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export interface RunningServer {
  server: Server;
  url: string;
  port: number;
  sessions: SessionManager;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const loopback = isLoopback(opts.host);
  if (!opts.token && !loopback) {
    throw new Error('Refusing to listen on a non-loopback address without a login token.');
  }
  const env = opts.env ?? process.env;
  const roots = opts.roots.map((r) => resolve(r));
  const manager = new SessionManager(roots, {
    maxSessions: opts.maxSessions ?? 8,
    headless: opts.headlessBrowser ?? true,
    env,
  });
  // A throw-away runtime only used to list models and providers for the "new session" form.
  const catalog = await Runtime.create({
    cwd: roots[0]!,
    env,
    ephemeral: true,
    overrides: { browser: { enabled: false } },
  });

  const authed = new Map<string, number>();
  const attempts = new Map<string, { n: number; reset: number }>();
  const allowHosts = new Set(
    ['localhost', '127.0.0.1', '[::1]', ...(opts.allowHosts ?? [])].map((h) => h.toLowerCase()),
  );
  if (loopback) allowHosts.add(opts.host.toLowerCase());
  const strictHost = loopback || (opts.allowHosts?.length ?? 0) > 0;
  const fileCache = new Map<string, Buffer>();
  const staticDir = resolve(opts.staticDir);

  const hostOk = (req: IncomingMessage) => {
    if (!strictHost) return true;
    const h = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    return allowHosts.has(h) || allowHosts.has(`[${h.replace(/^\[|\]$/g, '')}]`);
  };

  const cookieOf = (req: IncomingMessage, name: string) => {
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return undefined;
  };

  const isAuthed = (req: IncomingMessage): boolean => {
    if (!opts.token) return true;
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (bearer && safeEqual(bearer, opts.token)) return true;
    const sid = cookieOf(req, COOKIE);
    const exp = sid ? authed.get(sid) : undefined;
    if (exp && exp > Date.now()) return true;
    if (sid && exp) authed.delete(sid);
    return false;
  };

  const securityHeaders = (res: ServerResponse) => {
    res.setHeader(
      'content-security-policy',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolveBody, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          // Answer first, then close: destroying the socket here would drop the connection with no reply.
          if (chunks.length) chunks.length = 0;
          req.removeAllListeners('data');
          req.pause();
          reject(new HttpError(413, 'Request too large'));
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (!size) return resolveBody({});
        try {
          const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
          resolveBody(v as Record<string, unknown>);
        } catch {
          reject(new HttpError(400, 'Body must be a JSON object'));
        }
      });
      req.on('error', reject);
    });

  const serveStatic = async (res: ServerResponse, pathname: string) => {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = normalize(join(staticDir, rel));
    // Only files under the static dir, only known types: no traversal, no dotfiles.
    if (!(file + sep).startsWith(staticDir + sep) && file !== staticDir)
      throw new HttpError(404, 'Not found');
    const type = TYPES[extname(file)];
    if (!type || rel.split(/[\\/]/).some((p) => p.startsWith('.'))) throw new HttpError(404, 'Not found');
    let data = fileCache.get(file);
    if (!data) {
      try {
        data = await readFile(file);
      } catch {
        throw new HttpError(404, 'Not found');
      }
      fileCache.set(file, data);
    }
    res.writeHead(200, {
      'content-type': type,
      'cache-control': extname(file) === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(data);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    securityHeaders(res);
    if (!hostOk(req))
      throw new HttpError(421, 'Unrecognised Host header. Use --allow-host to permit this name.');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (!path.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return serveStatic(res, path);
    }

    // State-changing requests must be same-origin XHR/fetch: custom header + matching Origin.
    if (method !== 'GET' && method !== 'HEAD') {
      if (req.headers['x-nacre'] !== '1') throw new HttpError(403, 'Missing X-Nacre header');
      const origin = req.headers.origin;
      if (origin) {
        let oh = '';
        try {
          oh = new URL(origin).host.toLowerCase();
        } catch {
          throw new HttpError(403, 'Bad Origin');
        }
        if (oh !== (req.headers.host ?? '').toLowerCase())
          throw new HttpError(403, 'Cross-origin request refused');
      }
    }

    if (path === '/api/login' && method === 'POST') {
      const ip = req.socket.remoteAddress ?? 'unknown';
      const a = attempts.get(ip);
      if (a && a.reset > Date.now() && a.n >= 10)
        throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
      const body = await readBody(req);
      const given = typeof body.token === 'string' ? body.token : '';
      if (opts.token && !safeEqual(given, opts.token)) {
        const cur = a && a.reset > Date.now() ? a : { n: 0, reset: Date.now() + 5 * 60_000 };
        cur.n++;
        attempts.set(ip, cur);
        throw new HttpError(401, 'Wrong token');
      }
      attempts.delete(ip);
      const sid = randomBytes(32).toString('base64url');
      authed.set(sid, Date.now() + SESSION_TTL_MS);
      const secure =
        (req.socket as { encrypted?: boolean }).encrypted || req.headers['x-forwarded-proto'] === 'https';
      res.setHeader(
        'set-cookie',
        `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`,
      );
      return json(res, 200, { ok: true });
    }

    if (path === '/api/logout' && method === 'POST') {
      const sid = cookieOf(req, COOKIE);
      if (sid) authed.delete(sid);
      res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return json(res, 200, { ok: true });
    }

    if (!isAuthed(req)) throw new HttpError(401, 'Login required');

    if (path === '/api/info' && method === 'GET') {
      return json(res, 200, {
        version: VERSION,
        roots,
        authRequired: !!opts.token,
        providers: Object.keys(catalog.config.providers),
        defaults: {
          model: catalog.config.model ?? null,
          approval: catalog.config.approval.mode,
          sandbox: catalog.config.sandbox.mode,
        },
        swarmPresets: ['duo', 'trio', ...(catalog.config.swarm.agents.length ? ['config'] : [])],
      });
    }
    if (path === '/api/models' && method === 'GET')
      return json(res, 200, { models: await catalog.listModels() });
    if (path === '/api/saved' && method === 'GET')
      return json(res, 200, manager.saved(url.searchParams.get('cwd')));
    if (path === '/api/sessions' && method === 'GET') return json(res, 200, { sessions: manager.list() });
    if (path === '/api/sessions' && method === 'POST') {
      const s = await manager.create(await readBody(req));
      return json(res, 201, { id: s.id });
    }

    const m = /^\/api\/sessions\/([\w-]+)(?:\/([\w.]+))?$/.exec(path);
    if (!m) throw new HttpError(404, 'Not found');
    const s = manager.get(m[1]!);
    const action = m[2];

    if (method === 'GET' && action === 'events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      const client = s.addClient(res);
      req.on('close', () => s.clients.delete(client));
      return;
    }
    if (method === 'GET' && action === 'browser.jpg') {
      const img = await s.runtime.browser?.screenshotIfOpen();
      if (!img) throw new HttpError(404, 'The browser is not open');
      res.writeHead(200, { 'content-type': img.mediaType, 'cache-control': 'no-store' });
      return void res.end(Buffer.from(img.data, 'base64'));
    }
    if (method === 'DELETE' && !action) {
      await manager.close(s.id);
      return json(res, 200, { ok: true });
    }
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed');

    const body = await readBody(req);
    const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
    switch (action) {
      case 'prompt':
        s.prompt(str('text'));
        return json(res, 202, { ok: true });
      case 'abort':
        s.abort();
        return json(res, 200, { ok: true });
      case 'approval':
        s.answerApproval(Number(body.id), {
          allow: body.allow === true,
          ...(body.always === true ? { always: true } : {}),
          ...(str('feedback') ? { feedback: str('feedback') } : {}),
        });
        return json(res, 200, { ok: true });
      case 'answer':
        s.answerQuestion(Number(body.id), str('text'));
        return json(res, 200, { ok: true });
      case 'settings':
        await s.settings(body);
        return json(res, 200, { ok: true });
      case 'compact':
        return json(res, 200, { compacted: await s.compact(str('instructions') || undefined) });
      case 'swarm':
        await s.swarm(str('action'), str('arg') || undefined);
        return json(res, 200, { ok: true });
      case 'browser':
        await s.browser(str('action'));
        return json(res, 200, { ok: true });
      case 'new':
        s.newConversation();
        return json(res, 200, { ok: true });
      default:
        throw new HttpError(404, 'Not found');
    }
  };

  const listener = (req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) return void res.end();
      if (e instanceof HttpError) {
        if (e.status === 413) {
          res.setHeader('connection', 'close');
          res.once('finish', () => req.socket.destroy());
        }
        return json(res, e.status, { error: e.message });
      }
      process.stderr.write(`[nacre serve] ${(e as Error).stack ?? e}\n`);
      json(res, 500, { error: 'Internal error' });
    });
  };

  const server = opts.tls
    ? createHttps({ cert: opts.tls.cert, key: opts.tls.key }, listener)
    : createHttp(listener);
  server.requestTimeout = 0; // SSE streams are long-lived
  server.headersTimeout = 15_000;
  const hb = setInterval(() => {
    manager.heartbeat();
    // Forget expired logins and old failed-login counters; otherwise they pile up for as long as the server runs.
    const now = Date.now();
    for (const [sid, exp] of authed) if (exp <= now) authed.delete(sid);
    for (const [ip, a] of attempts) if (a.reset <= now) attempts.delete(ip);
  }, 15_000);
  hb.unref();

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port, opts.host, ok);
  });
  const port = (server.address() as AddressInfo).port;
  const shownHost = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
  return {
    server,
    port,
    sessions: manager,
    url: `${opts.tls ? 'https' : 'http'}://${shownHost}:${port}`,
    async close() {
      clearInterval(hb);
      await manager.disposeAll();
      await catalog.dispose();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
