# Security policy

## Reporting a vulnerability

Please report security issues **privately** using GitHub's "Report a vulnerability" button (Security → Advisories) on this
repository, rather than a public issue. Include steps to reproduce and the affected version. We aim to acknowledge reports
within a few days.

Issues of particular interest: sandbox or path-guard escapes, approval-policy bypasses, secret leakage into model
requests or logs, prompt-injection paths that lead to unapproved actions, and trust-model bypasses (project config that
gains privileges without `nacre trust`).

## Scope

Nacreframe runs model-directed actions on your machine. Read [docs/security.md](docs/security.md) for what each sandbox
level does and does not protect against; "the `guard` sandbox does not contain a shell command" is documented behaviour,
not a vulnerability.

## If you committed a credential

Rotate it immediately. Removing it from the latest commit is not enough — it remains in history. `npm run scan-secrets`
and CI check for common credential shapes, but they are a safety net, not a guarantee.
