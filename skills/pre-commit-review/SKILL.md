---
name: pre-commit-review
description: Check a change before it is committed. Runs the project's tests, linters and type checks, reads the diff for bugs and leftovers, and writes the commit message. Use when the user asks to review, check or commit their changes, or before you commit your own work.
---

Do not commit until every step passes, or the user has accepted what is left. Never skip hooks (`--no-verify`)
unless the user asks.

## 1. See the change

```sh
git status --short
git diff --stat
git diff            # unstaged
git diff --cached   # staged
```

- Note untracked files that should be in the commit, and files that should not be: build output, `.env`,
  logs, large binaries, editor folders.
- Read the whole diff. Big diffs: go file by file.

## 2. Run the project's own checks

- Find them first; don't invent commands. Look in:
  - `package.json` scripts (`test`, `lint`, `typecheck`, `check`);
  - `Makefile` / `justfile`;
  - `pyproject.toml` (pytest, ruff, mypy);
  - `Cargo.toml`, `go.mod`;
  - `.pre-commit-config.yaml`;
  - CI files under `.github/workflows`, which show what must pass.
- Run tests, linting, type checking and formatting checks. If the formatter can fix things, run it and include
  the result.
- On a failure, read the output and fix the cause (or report it). Rerunning a failing test until it passes is not
  a fix. A flaky test is worth reporting.

## 3. Read the diff for problems the checks miss

- Leftovers: debug prints, `console.log`, commented-out code, `TODO` added without a reason, `.only`/`skip` in
  tests, hard-coded local paths, temporary files.
- Secrets or personal data in code, tests or fixtures.
- Logic: off-by-one errors, missing `await`, unhandled errors, changed behaviour for existing callers, edge cases
  (empty input, `None`/`null`, very large input).
- Tests: new behaviour has a test; changed behaviour updated its tests rather than deleting them.
- Docs: README, changelog or comments that the change makes wrong.

## 4. Write the commit message

- Match the repository's style. Check `git log --oneline -10`; for example, conventional commits (`fix:`, `feat:`)
  if the repo uses them.
- Subject: imperative, at most about 72 characters, saying what changes (`Fix crash when the config is empty`).
- Body, when the change is not obvious: why it was needed and anything a reviewer should know. Wrap at 72
  characters.
- One logical change per commit. If the diff mixes unrelated work, suggest splitting it (`git add -p`).

## 5. Commit, if you were asked to

```sh
git add <the files that belong>
git commit -m "<subject>" -m "<body>"
```

- Stage files by name; avoid `git add -A` unless you checked everything it picks up.
- Do not push unless asked.

## Report

- **Checks:** each command, and whether it passed.
- **Findings:** problems you fixed, and problems left for the user.
- **Commit:** the message you used or propose.
