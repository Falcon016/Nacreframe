---
name: security-review
description: Review code or a change for security problems (secrets, injection, unsafe shell and file use, weak auth, vulnerable dependencies) and report findings with severity and a fix. Use when asked for a security review or audit, before publishing or deploying, or as a swarm's security advisor.
---

Review what you were asked to review: a diff, a set of files, or the whole project. Report findings; do not edit files
unless you were asked to fix them. Every finding must point at a real file and line you have read. Do not report
something you only suspect without checking it.

## 1. Scope

- For a change, run `git diff` (or `git diff <base>...HEAD`) and review only what changed, plus the code it calls.
- For a project, list the entry points that take outside input: HTTP routes, CLI arguments, message or bot
  handlers, file uploads, webhooks, anything read from the network or from users.

## 2. Secrets

- Search for keys, tokens and passwords committed to the code. Patterns worth grepping:
  - `api[_-]?key`, `secret`, `token`, `passw`, `BEGIN .*PRIVATE KEY`
  - `AKIA[0-9A-Z]{16}`, `ghp_`, `sk-`, `xox[bp]-`
  - long base64 or hex strings assigned to variables
- Check `.env` files and config samples, and whether `.gitignore` covers them.
- Check that secrets are not logged, printed in errors, or returned in API responses.

## 3. Injection and unsafe execution

- **Shell:** `subprocess` with `shell=True`, `os.system`, `exec`/`execSync` with string commands, backticks.
  Untrusted input must not reach a shell string. Prefer argument lists.
- **SQL:** queries built with string formatting or concatenation instead of parameters.
- **Code:** `eval`, `exec`, `new Function`, `pickle.loads`, `yaml.load` without `SafeLoader`, and deserialising
  untrusted data.
- **Paths:** user input joined into file paths without normalising and checking it stays inside the intended folder
  (`../` traversal). Archive extraction (zip slip).
- **Web:** HTML built from user input without escaping (XSS); redirects to user-supplied URLs; server-side
  requests to user-supplied URLs (SSRF), especially to `localhost` or `169.254.169.254`.

## 4. Authentication and access

- Every route or command that changes state checks who is asking.
- Comparisons of secrets use constant-time compares.
- Sessions and cookies are `HttpOnly`, `Secure` and `SameSite`.
- Tokens expire, and logout invalidates them.
- Bots and webhooks verify the sender (allow-lists, signatures). An open bot is an open shell if it can run tools.
- Look for default credentials, debug endpoints left on, and admin features without checks.

## 5. Dependencies

- **Node:** `npm audit --omit=dev` (or `pnpm audit`, `yarn npm audit`).
- **Python:** `pip-audit`. If it is missing, install it in the project's venv: `python -m pip install pip-audit`.
- **Containers:** pinned base images; not running as root unless needed.
- Report only vulnerabilities that are reachable or plausible in this project. Include the fixed version.

## 6. Severity

- **Critical:** remote code execution, auth bypass, or exposed production secrets.
- **High:** injection or path traversal reachable from outside input, or missing auth on a state-changing action.
- **Medium:** problems that need extra conditions to exploit, or information leaks.
- **Low:** hardening and defence-in-depth.

## Report

One block per finding, most severe first:

```
[High] Command injection in scripts/deploy.py:42
What: the branch name from the webhook is put into a shell string (shell=True).
Impact: anyone who can send the webhook can run commands on the server.
Fix: pass an argument list without shell=True, and validate the branch name against ^[\w./-]+$.
```

End with what you checked and found clean, so the reader knows the coverage, and what you could not check.
