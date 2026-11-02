# Web dashboard (self-hosted)

```bash
nacre serve                       # http://127.0.0.1:7437
```

The first run generates a login token, stores it with owner-only permissions in the state directory, and prints a
sign-in link: `http://127.0.0.1:7437/#token=…`. The token is in the URL _fragment_, which browsers never send to the
server or into its logs; the page signs in and removes it from the address bar.

## What you get

Sessions in the sidebar (several folders at once), streaming chat with Markdown and diffs, tool cards, an approval card
with keyboard shortcuts (<kbd>y</kbd> allow, <kbd>a</kbd> always, <kbd>n</kbd> deny), a **context meter with the 80%
compaction tick** and a banner while compaction holds the chat, model/mode/sandbox switches, a swarm roster, task list
and a live view of the agent's browser. Sessions and swarms can be resumed from the _New session_ dialog. It works on a
phone.

## Options

| Flag                            | Meaning                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `--host`, `--port`              | Default `127.0.0.1:7437` (chosen to avoid common dev/AI-tool ports)                 |
| `--root <dir>` (repeatable)     | Folders sessions may open. Default: the current folder. Anything outside is refused |
| `--token`, `NACRE_SERVER_TOKEN` | Use your own token (≥ 16 chars). `--rotate-token` replaces the stored one           |
| `--no-auth`                     | Only allowed on a loopback address                                                  |
| `--allow-host <name>`           | Accept this `Host` header (your reverse-proxy name); repeatable                     |
| `--tls-cert`, `--tls-key`       | Serve HTTPS directly                                                                |
| `--max-sessions`                | Open sessions at once (default 8)                                                   |
| `--headed-browser`              | Let the agent open a visible window (default on a server: headless)                 |

## Putting it on your homelab

1. Run it: [deploy/docker-compose.yml](../deploy/docker-compose.yml) (with a [Dockerfile](../deploy/Dockerfile)) or
   [deploy/nacreframe.service](../deploy/nacreframe.service) for systemd.
2. **Put TLS in front.** The token and your conversations are sensitive. Use Caddy/Traefik/nginx with a certificate,
   or reach it over Tailscale/WireGuard. Pass `--allow-host <your-name>` so the `Host` check accepts your hostname.
   A minimal Caddyfile: `nacre.example.internal { reverse_proxy 127.0.0.1:7437 }` (SSE needs no special config).
3. Point it at your model server by adding it to the config in the data directory (`NACRE_HOME/config/config.json`),
   e.g. `{"providers":{"llamacpp":{"baseUrl":"http://host.docker.internal:11434/v1"}}}`.
4. In a container the agent's `bash` runs _inside that container_ (the `container` sandbox needs a Docker socket and is
   best left to the non-Docker deployment). The compose file drops capabilities and mounts only `/workspace` and
   `/data`.

## Security model

- **Loopback by default; auth required elsewhere.** Listening on a non-loopback address without a token is refused.
- **Login:** constant-time token comparison, 10 failed attempts per 5 minutes per IP, then locked out. Sessions use a
  random id in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` behind HTTPS). `Authorization: Bearer` also works for
  scripts.
- **Browser-origin protection:** every state-changing request needs a custom `X-Nacre` header and a matching `Origin`
  (blocks CSRF), and the `Host` header is checked when bound to loopback or `--allow-host` is used (blocks DNS
  rebinding).
- **Strict Content-Security-Policy** (`default-src 'self'`, no inline script or style), no external requests, no
  framing. Model output is rendered with DOM text nodes only, never as HTML; only `http(s)` links become clickable.
- **Workspace allow-list:** a session can only be opened on a folder inside a `--root` (symlinks resolved). Session ids
  from the client are validated, so no file path ever reaches the file system through the API; server paths are not
  sent to the browser except the session's own folder.
- **Same agent rules apply:** approvals, the sandbox, the blocklist and secret redaction are the ones described in
  [security.md](security.md). The dashboard does not weaken them — and a signed-in user can still make the agent run
  commands on that machine, so treat the token like an SSH key.
- Static files are served only from `web/`, only known types, no dotfiles.

## Limits

One server process serves one trust domain: everyone with the token can use every open session. There are no
per-user accounts. The live browser view is a screenshot refreshed every ~1.5 s, not an interactive remote desktop;
"Pause agent" stops the agent's browser actions while you look.
