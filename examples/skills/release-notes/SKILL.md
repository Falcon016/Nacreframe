---
name: release-notes
description: Write release notes from the git history since the last tag. Use when the user asks for a changelog or release notes.
---

1. Run `git describe --tags --abbrev=0` to find the previous tag, then `git log <tag>..HEAD --oneline`.
2. Group commits into Features, Fixes and Internal. Drop merge commits and noise.
3. Write user-facing bullets in the past tense. Link PR numbers where present.
4. Never invent changes that are not in the log.
