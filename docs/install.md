# Installing and setting up

## One command (Linux, macOS, WSL)

```bash
curl -fsSL https://raw.githubusercontent.com/Falcon016/Nacreframe/main/install.sh | sh
```

Nacreframe needs **Node.js 22.18+** and **git**. The installer looks after both for you (see step 1).
If you would like to read it before running it, download it first: `curl -fsSL <url> -o install.sh`, then `sh install.sh`.

What happens, in order:

1. **Checks your system and installs what is missing.**
   - **Node.js 22.18+**: if it is missing or too old, the installer offers a private copy from nodejs.org
     (about 40 MB, kept in `~/.nacreframe/runtime`, verified against nodejs.org's published SHA-256). It touches nothing
     system-wide and needs no `sudo`. The `nacre` command uses it automatically.
   - **git**: if it is missing, the installer shows the command for your package manager (`apt`, `dnf`, `brew`,
     `pacman`, ...) and runs it only if you say yes, because that step needs `sudo`. With `--yes` it never runs it.
   - **npm** comes with Node.js; the project's own dependencies are installed in step 2.
2. **Downloads and builds** Nacreframe into `~/.nacreframe` (a shallow git checkout), installs its dependencies,
   builds it, then trims the build tools.
3. **Adds the `nacre` command** to `~/.local/bin`. It is a small launcher: it picks the right Node.js and, if
   Nacreframe's files have gone missing, repairs them before starting.
4. **Asks before touching your shell profile** to put `~/.local/bin` on your `PATH` (only if it is not already there).
5. **Offers the setup wizard** (below).

It never uses `sudo` unless you agree to installing git, never writes outside those two folders without asking, and
shows the tail of a log if a step fails.
The whole script runs from one function called on its last line, so a download that is cut short cannot run half a script.

### Options

Pass them after `sh -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/Falcon016/Nacreframe/main/install.sh | sh -s -- --yes --no-setup
```

| Option             | Meaning                                                                      |
| ------------------ | ---------------------------------------------------------------------------- |
| `-y`, `--yes`      | Ask nothing: accept the defaults (adds `PATH`, skips the wizard)             |
| `--no-setup`       | Do not offer the wizard                                                      |
| `--no-modify-path` | Never edit shell profile files; the installer prints the line to add instead |
| `--ref <ref>`      | Install a branch, tag or commit (default `main`)                             |
| `--dir <path>`     | Install location (default `~/.nacreframe`)                                   |
| `--bin-dir <path>` | Where the `nacre` command goes (default `~/.local/bin`)                      |
| `--uninstall`      | Remove Nacreframe                                                            |

The same settings exist as environment variables: `NACRE_REF`, `NACRE_INSTALL_DIR`, `NACRE_BIN_DIR`, and
`NACRE_REPO` (the git URL). `NO_COLOR=1` gives plain output.

### Updating and uninstalling

Update from inside Nacreframe with `/update`, or from a shell with `nacre update` (`nacre update --check` only
looks). It checks the branch you installed from (`main` unless you used `--ref`), shows the new version and the
latest change, and asks before installing. After `/update` you can restart straight into the new version; it
continues the conversation you were in (a swarm comes back with `/swarm resume`). Your settings, keys and saved
conversations are not touched.

Running the install command again does the same thing. It rebuilds only if something changed and does not repeat
the `PATH` entry. Copies made by hand (`git clone` + `npm link`) update with `git pull && npm ci && npm run build`;
`/update` says so instead of touching them.

```bash
curl -fsSL https://raw.githubusercontent.com/Falcon016/Nacreframe/main/install.sh | sh -s -- --uninstall
```

Uninstalling removes the program, the `nacre` command and the `PATH` entry it added. Your settings, API keys and
sessions stay where they are; the command prints the exact `rm -rf` line if you want those gone too.

### Windows

The script is for Linux, macOS and WSL. In WSL, run the command above in your Linux shell. On native Windows, install by hand:

```powershell
git clone https://github.com/Falcon016/Nacreframe.git
cd Nacreframe
npm ci
npm run build
npm link
nacre setup
```

### If something goes wrong

| You see                               | Do this                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `Node.js is too old` / not found      | Say yes when it offers a private copy. (Alpine and other non-glibc Linux: `apk add nodejs npm`.) |
| Anything stopped working              | Run `nacre doctor --fix`. If `nacre` itself will not start, run the install command again.       |
| `nacre: command not found`            | Open a new terminal, or add `~/.local/bin` to `PATH` (the installer prints the exact line).      |
| `Could not download Nacreframe`       | Check your connection. For a private repository, sign git in first (`gh auth login`).            |
| Installing dependencies fails         | The last lines of the log are shown; usually a proxy or registry setting for npm.                |
| Another `nacre` comes first on `PATH` | Remove it, or put `~/.local/bin` earlier in `PATH`.                                              |

## `nacre doctor`: check and repair

`nacre doctor` checks Node.js, git, Chrome/Edge, Docker/Podman, your config, your provider keys, the key file's
permissions, and (for an installer-made copy) the `nacre` command and your `PATH`. When something can be repaired it
says so and asks; `nacre doctor --fix` goes ahead, and `-y` / `--yes` answers every question for you.

| Problem                                              | What `--fix` does                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Settings file is not valid JSON or settings          | Moves it aside (`config.json.broken-<time>`, nothing is deleted); defaults apply   |
| No API key for the model you use                     | Asks for it (hidden) and stores it with owner-only permissions                     |
| No default model yet                                 | Runs the setup wizard                                                              |
| Key file readable by other users                     | Makes it owner-only                                                                |
| Settings or data folder missing                      | Creates it                                                                         |
| `nacre` command missing, not on `PATH`, Node too old | Runs the installer in repair mode: re-downloads, reinstalls, rebuilds, relinks     |
| No Chrome or Edge for the browser tool               | Downloads Chromium (about 150 MB) after asking, and points `browser.channel` at it |
| Ollama is your default and is not running            | Starts `ollama serve`                                                              |

It cannot install git or Docker for you (that needs `sudo`); it says what to run.

If `nacre` will not even start because its files are damaged, the launcher notices and repairs them on the spot. To do
that by hand: `sh ~/.nacreframe/install.sh --repair`.

## The setup wizard

```bash
nacre setup
```

A short, guided walkthrough. Arrow keys (or number keys) move, <kbd>Enter</kbd> accepts, <kbd>Ctrl</kbd>+<kbd>C</kbd>
quits. **Nothing is written until the last step**, and you can start over from the review screen.

1. **Your system**: what was found (Node, git, Chrome/Edge, Docker/Podman).
2. **Provider**: Anthropic, OpenAI, Ollama, LM Studio, llama.cpp, or any OpenAI-compatible server. Local servers
   that are already running are detected. For a cloud provider you paste your API key (shown as dots); the wizard
   checks it with the provider straight away and tells you if it is rejected. A key already in your environment
   (`ANTHROPIC_API_KEY`) is offered for reuse instead of being copied anywhere. If a local server is not running you
   get a hint on how to start it, and can retry, change the address, or continue anyway.
3. **Model**: the models your provider reports, with context sizes, or type a name. You can also decide later; the
   app shows a model picker.
4. **Safety**: approval mode (`ask` / `edits` / `auto` / `plan`), sandbox level (`guard` / `container` / `off`;
   `container` is only offered when Docker or Podman is running) and whether the agent may drive a browser.

Then it shows a summary and saves:

- choices go to your user `config.json` (path shown at the end). Existing settings the wizard does not manage are
  kept, and the previous file is copied to `config.json.bak`;
- API keys go to `auth.json` next to it, with owner-only permissions. Keys are never written to `config.json`.

Run it again whenever you like to switch provider or tighten safety.

### Without a terminal (scripts, CI, provisioning)

`--yes` asks nothing and applies only the options you pass:

```bash
printf '%s' "$ANTHROPIC_API_KEY" | nacre setup --yes --provider anthropic --key-stdin \
  --model claude-sonnet-5-5 --approval edits --sandbox guard --no-browser

nacre setup --yes --provider ollama --model qwen3:8b
nacre setup --yes --provider vllm --base-url http://gpu-box:8000/v1 --model my-model
```

| Option                       | Meaning                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `--provider <id>`            | `anthropic`, `openai`, `ollama`, `lmstudio`, `llamacpp`, or a name of your own   |
| `--base-url <url>`           | Server address; required for a name of your own, optional to move a built-in one |
| `-m`, `--model <spec>`       | `provider/model`, or just the model together with `--provider`                   |
| `--approval <mode>`          | `ask`, `edits`, `auto`, `plan`                                                   |
| `--sandbox <level>`          | `off`, `guard`, `container`                                                      |
| `--browser` / `--no-browser` | Allow or forbid browser control                                                  |
| `--key-stdin`                | Read the API key for `--provider` from stdin (keeps it out of the process list)  |

Mistakes (unknown mode, a model naming an unknown provider, a key with no provider) exit with status 2 and a message.
