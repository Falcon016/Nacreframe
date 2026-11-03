#!/bin/sh
# Nacreframe installer
#
#   curl -fsSL https://raw.githubusercontent.com/Falcon016/Nacreframe/main/install.sh | sh
#
# Pass options after `-s --`:
#   curl -fsSL .../install.sh | sh -s -- --help
#
# What it does: makes sure Node.js (22.18+) and git are there (installing a private copy of Node.js for you if
# it is missing or too old), downloads Nacreframe to ~/.nacreframe, installs its dependencies, builds it, puts a
# `nacre` command in ~/.local/bin, and offers to run the setup wizard. It never uses sudo unless you say yes to
# installing git, and it only edits your shell profile if you say yes. Run it again at any time to update;
# `--repair` fixes a damaged install; `--uninstall` removes it.
#
# Everything lives inside main(), which is called on the last line, so a download that is cut off halfway
# cannot run a partial script.

set -eu

NACRE_REPO="${NACRE_REPO:-https://github.com/Falcon016/Nacreframe.git}"
NACRE_REF="${NACRE_REF:-main}"
NACRE_INSTALL_DIR="${NACRE_INSTALL_DIR:-}"
NACRE_BIN_DIR="${NACRE_BIN_DIR:-}"

MARK_BEGIN="# >>> nacreframe >>>"
MARK_END="# <<< nacreframe <<<"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=18

ASSUME_YES=0
RUN_SETUP=auto
MODIFY_PATH=auto
UNINSTALL=0
REPAIR=0
NODE_BIN=
NODE_SEEN=
SPIN_PID=
LOG=
OS=
TTY_OK=0

# ---- output ---------------------------------------------------------------------------------------

setup_ui() {
  ESC=$(printf '\033')
  IS_TTY=0
  BOLD=; DIM=; RESET=; RED=; GREEN=; YELLOW=; ACCENT=
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
    IS_TTY=1
    BOLD="${ESC}[1m"; DIM="${ESC}[2m"; RESET="${ESC}[0m"
    RED="${ESC}[31m"; GREEN="${ESC}[32m"; YELLOW="${ESC}[33m"
    case "${COLORTERM:-}" in
      *truecolor* | *24bit*) ACCENT="${ESC}[38;2;157;132;255m" ;;
      *) ACCENT="${ESC}[38;5;141m" ;;
    esac
  fi
  UNI=0
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *[Uu][Tt][Ff]-8* | *[Uu][Tt][Ff]8* | "") UNI=1 ;;
  esac
  if [ "${TERM:-}" = "linux" ]; then UNI=0; fi
  if [ "$UNI" = 1 ]; then
    S_OK="✓"; S_WARN="!"; S_FAIL="✗"; S_TITLE="●"; S_DOT="•"; S_PEARL="●"
  else
    S_OK="+"; S_WARN="!"; S_FAIL="x"; S_TITLE="*"; S_DOT="-"; S_PEARL="o"
  fi
  # Prompts need a person: a terminal for output and a controlling terminal to read answers from.
  TTY_OK=0
  if [ -t 1 ] && ( : </dev/tty ) 2>/dev/null; then TTY_OK=1; fi
}

say() { printf '%s\n' "$*"; }
blank() { printf '\n'; }
ok() { printf '  %s%s%s %s%s%s\n' "$GREEN" "$S_OK" "$RESET" "$1" "${2:+ $DIM}" "${2:+$2$RESET}"; }
warn() { printf '  %s%s%s %s%s%s\n' "$YELLOW" "$S_WARN" "$RESET" "$1" "${2:+ $DIM}" "${2:+$2$RESET}"; }
info() { printf '  %s%s%s %s\n' "$DIM" "$S_DOT" "$RESET" "$1"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }
heading() { printf '\n  %s%s%s\n' "$BOLD" "$1" "$RESET"; }
banner() {
  blank
  # The logo in text form: a pearl held between two brackets.
  printf '  %s[%s%s%s]%s %snacreframe installer%s\n' "$ACCENT" "$RESET" "$S_PEARL" "$ACCENT" "$RESET" "$BOLD" "$RESET"
  note "A terminal AI agent harness - github.com/Falcon016/Nacreframe"
  blank
}

fail() { printf '  %s%s%s %s\n' "$RED" "$S_FAIL" "$RESET" "$1" >&2; }

# die "what went wrong" ["hint line" ...]
die() {
  fail "$1"
  shift
  for _h in "$@"; do printf '    %s%s%s\n' "$DIM" "$_h" "$RESET" >&2; done
  exit 1
}

tilde() {
  # shellcheck disable=SC2088  # a literal "~" for display, not for expansion
  case "$1" in
    "$HOME") printf '~' ;;
    "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

have() { command -v "$1" >/dev/null 2>&1; }

# ---- running things with a spinner ----------------------------------------------------------------

spin_frame() {
  if [ "$UNI" = 1 ]; then
    case $(($1 % 10)) in
      0) FRAME="⠋" ;; 1) FRAME="⠙" ;; 2) FRAME="⠹" ;; 3) FRAME="⠸" ;; 4) FRAME="⠼" ;;
      5) FRAME="⠴" ;; 6) FRAME="⠦" ;; 7) FRAME="⠧" ;; 8) FRAME="⠇" ;; *) FRAME="⠏" ;;
    esac
  else
    # shellcheck disable=SC1003  # a lone backslash is the fourth spinner frame
    case $(($1 % 4)) in
      0) FRAME='|' ;; 1) FRAME='/' ;; 2) FRAME='-' ;; *) FRAME='\' ;;
    esac
  fi
}

# run_step "label" command [args...]   Output goes to the log; returns the command's exit status.
run_step() {
  _label=$1
  shift
  _rc=0
  if [ "$IS_TTY" = 1 ]; then
    printf '%s[?25l' "$ESC"
    "$@" </dev/null >>"$LOG" 2>&1 &
    SPIN_PID=$!
    _i=0
    while kill -0 "$SPIN_PID" 2>/dev/null; do
      spin_frame "$_i"
      printf '\r%s[2K  %s%s%s %s' "$ESC" "$ACCENT" "$FRAME" "$RESET" "$_label"
      _i=$((_i + 1))
      sleep 0.1 2>/dev/null || sleep 1
    done
    wait "$SPIN_PID" || _rc=$?
    SPIN_PID=
    printf '\r%s[2K%s[?25h' "$ESC" "$ESC"
  else
    "$@" </dev/null >>"$LOG" 2>&1 || _rc=$?
  fi
  return "$_rc"
}

# Show the tail of the log and stop.
step_failed() {
  fail "$1"
  if [ -n "$LOG" ] && [ -s "$LOG" ]; then
    blank >&2
    tail -n 15 "$LOG" | while IFS= read -r _line; do printf '    %s%s%s\n' "$DIM" "$_line" "$RESET" >&2; done
    blank >&2
    printf '    %sFull log: %s%s\n' "$DIM" "$LOG" "$RESET" >&2
  fi
  shift
  for _h in "$@"; do printf '    %s%s%s\n' "$DIM" "$_h" "$RESET" >&2; done
  exit 1
}

cleanup() {
  _status=$?
  if [ -n "$SPIN_PID" ]; then kill "$SPIN_PID" 2>/dev/null || true; fi
  if [ "$IS_TTY" = 1 ]; then printf '%s[?25h' "$ESC"; fi
  if [ "$_status" -eq 0 ] && [ -n "$LOG" ]; then rm -f "$LOG"; fi
}

# ask_yes_no "question" default(y|n) default-without-a-person(y|n)
ask_yes_no() {
  if [ "$ASSUME_YES" = 1 ]; then [ "$2" = y ]; return; fi
  if [ "$TTY_OK" != 1 ]; then [ "$3" = y ]; return; fi
  if [ "$2" = y ]; then _hint="Y/n"; else _hint="y/N"; fi
  printf '  %s%s%s %s%s%s %s(%s)%s ' "$ACCENT" "$S_TITLE" "$RESET" "$BOLD" "$1" "$RESET" "$DIM" "$_hint" "$RESET" >/dev/tty
  _ans=
  read -r _ans </dev/tty || _ans=
  case "$_ans" in
    [Yy]*) return 0 ;;
    [Nn]*) return 1 ;;
    *) [ "$2" = y ] ;;
  esac
}

# ---- usage ----------------------------------------------------------------------------------------

usage() {
  cat <<'EOF'
Nacreframe installer

Usage
  curl -fsSL https://raw.githubusercontent.com/Falcon016/Nacreframe/main/install.sh | sh
  curl -fsSL https://raw.githubusercontent.com/Falcon016/Nacreframe/main/install.sh | sh -s -- [options]

Options
  -y, --yes             Do not ask anything; accept the defaults (adds nacre to your PATH, skips the wizard)
      --no-setup        Do not offer the setup wizard at the end
      --no-modify-path  Never edit shell profile files
      --ref <ref>       Install a branch, tag or commit            (default: main)
      --dir <path>      Where to install                           (default: ~/.nacreframe)
      --bin-dir <path>  Where to put the `nacre` command           (default: ~/.local/bin)
      --repair          Reinstall dependencies, rebuild and relink; use it if something stopped working
      --uninstall       Remove Nacreframe (your settings and sessions are kept)
  -h, --help            Show this help

Environment
  NACRE_REF, NACRE_INSTALL_DIR, NACRE_BIN_DIR   Same as the options above
  NACRE_REPO                                    Git URL to install from
  NACRE_NODE_DIST                               Where to download Node.js from if it is missing
                                                (default: https://nodejs.org/dist/latest-v22.x)
  NO_COLOR                                      Plain output

Run it again at any time to update to the latest version.
EOF
}

# ---- steps ----------------------------------------------------------------------------------------

detect_os() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Linux*)
      OS=Linux
      if [ -r /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null; then OS="Linux (WSL)"; fi
      ;;
    Darwin*) OS=macOS ;;
    MINGW* | MSYS* | CYGWIN*)
      fail "This installer is for Linux, macOS and WSL."
      note "On Windows, open a WSL terminal and run the same command there, or install by hand:"
      note "  git clone https://github.com/Falcon016/Nacreframe.git && cd Nacreframe"
      note "  npm ci && npm run build && npm link"
      note "Details: https://github.com/Falcon016/Nacreframe/blob/main/docs/install.md"
      exit 1
      ;;
    *) OS=other ;;
  esac
}

# node_version_ok <node binary>   Sets NODE_SEEN to the version it reports; succeeds when it is new enough.
node_version_ok() {
  NODE_SEEN=
  _v=$("$1" --version 2>/dev/null || true)
  _v=${_v#v}
  NODE_SEEN=$_v
  _major=${_v%%.*}
  _rest=${_v#*.}
  _minor=${_rest%%.*}
  case "$_major$_minor" in
    "" | *[!0-9]*) return 1 ;;
  esac
  [ "$_major" -gt "$MIN_NODE_MAJOR" ] && return 0
  [ "$_major" -eq "$MIN_NODE_MAJOR" ] && [ "$_minor" -ge "$MIN_NODE_MINOR" ]
}

# Which platform's Node.js build to download. Fails where nodejs.org has no official build for us.
node_platform() {
  case "$(uname -s 2>/dev/null)" in
    Linux*) NP_OS=linux ;;
    Darwin*) NP_OS=darwin ;;
    *) return 1 ;;
  esac
  case "$(uname -m 2>/dev/null)" in
    x86_64 | amd64) NP_ARCH=x64 ;;
    aarch64 | arm64) NP_ARCH=arm64 ;;
    armv7l) NP_ARCH=armv7l ;;
    ppc64le) NP_ARCH=ppc64le ;;
    s390x) NP_ARCH=s390x ;;
    *) return 1 ;;
  esac
  # The official Linux builds need glibc; Alpine and other musl systems should use their own package.
  if [ "$NP_OS" = linux ] && { ldd --version 2>&1 || true; } | grep -qi musl; then return 1; fi
  return 0
}

sha256_of() {
  if have sha256sum; then sha256sum "$1" | cut -d ' ' -f 1
  elif have shasum; then shasum -a 256 "$1" | cut -d ' ' -f 1
  elif have openssl; then openssl dgst -sha256 -r "$1" | cut -d ' ' -f 1
  else return 1
  fi
}

# Download, verify (SHA-256 from nodejs.org's SHASUMS256.txt) and unpack Node.js into the install folder.
do_node_download() {
  _base="${NACRE_NODE_DIST:-https://nodejs.org/dist/latest-v22.x}"
  _tmp="$INSTALL_DIR/runtime/.download"
  rm -rf "$_tmp"
  mkdir -p "$_tmp"
  curl -fsSL "$_base/SHASUMS256.txt" -o "$_tmp/SHASUMS256.txt" || return 1
  _file=$(grep -E " node-v[0-9.]+-$NP_OS-$NP_ARCH\.tar\.gz\$" "$_tmp/SHASUMS256.txt" | head -n 1 | tr -s ' ' | cut -d ' ' -f 2)
  [ -n "$_file" ] || { echo "No Node.js build for $NP_OS-$NP_ARCH in $_base"; return 1; }
  _want=$(grep -F " $_file" "$_tmp/SHASUMS256.txt" | head -n 1 | cut -d ' ' -f 1)
  curl -fsSL "$_base/$_file" -o "$_tmp/$_file" || return 1
  _got=$(sha256_of "$_tmp/$_file") || { echo "No sha256sum, shasum or openssl to verify the download with"; return 1; }
  if [ -z "$_want" ] || [ "$_got" != "$_want" ]; then
    echo "Checksum mismatch for $_file (expected $_want, got $_got)"
    return 1
  fi
  tar -xzf "$_tmp/$_file" -C "$_tmp" || return 1
  rm -rf "$INSTALL_DIR/runtime/node"
  mv "$_tmp/${_file%.tar.gz}" "$INSTALL_DIR/runtime/node" || return 1
  rm -rf "$_tmp"
}

node_manual_help() {
  blank >&2
  printf '    %sNode.js %s.%s or newer is required%s.%s\n' "$BOLD" "$MIN_NODE_MAJOR" "$MIN_NODE_MINOR" "$1" "$RESET" >&2
  case "$OS" in
    macOS) note "Homebrew:   brew install node" >&2 ;;
    *) note "Your package manager may have it (Alpine: apk add nodejs npm), or use a version manager such as fnm." >&2 ;;
  esac
  note "Version manager (any OS):  https://github.com/Schniz/fnm   then:  fnm install 22" >&2
  note "Or download an installer:  https://nodejs.org/en/download" >&2
  note "Then run this installer again." >&2
  exit 1
}

# Leave nothing behind after a failed Node.js download (rmdir only removes folders that are empty).
node_cleanup() {
  rm -rf "$INSTALL_DIR/runtime/.download" "$INSTALL_DIR/runtime/node"
  rmdir "$INSTALL_DIR/runtime" "$INSTALL_DIR" 2>/dev/null || true
}

# Find a usable Node.js, or install a private copy next to Nacreframe (no sudo, nothing system-wide).
ensure_node() {
  # A private copy from an earlier install comes first: it is the one the `nacre` command will use.
  if [ -x "$INSTALL_DIR/runtime/node/bin/node" ] && node_version_ok "$INSTALL_DIR/runtime/node/bin/node"; then
    NODE_BIN="$INSTALL_DIR/runtime/node/bin/node"
    ok "Node.js" "v$NODE_SEEN (private copy)"
  elif have node && node_version_ok node; then
    NODE_BIN=$(command -v node)
    ok "Node.js" "v$NODE_SEEN"
  else
    _have=
    if have node; then
      node_version_ok node || true
      if [ -n "$NODE_SEEN" ]; then _have=" (you have v$NODE_SEEN)"; fi
    fi
    if [ -n "$_have" ]; then warn "Node.js is too old" "${_have# }"; else warn "Node.js was not found"; fi
    if ! node_platform; then
      fail "There is no official Node.js download for this system"
      node_manual_help "$_have"
    fi
    if ! have curl || ! have tar; then
      fail "curl and tar are needed to download Node.js"
      node_manual_help "$_have"
    fi
    if ! ask_yes_no "Install a private copy of Node.js for Nacreframe? (about 40 MB, kept in $(tilde "$INSTALL_DIR/runtime"))" y y; then
      node_manual_help "$_have"
    fi
    mkdir -p "$INSTALL_DIR/runtime"
    if ! run_step "Downloading Node.js (checksum verified)" do_node_download; then
      node_cleanup
      step_failed "Could not install Node.js" "Check your internet connection, or install Node.js $MIN_NODE_MAJOR.$MIN_NODE_MINOR+ yourself and run this installer again."
    fi
    NODE_BIN="$INSTALL_DIR/runtime/node/bin/node"
    node_version_ok "$NODE_BIN" || { node_cleanup; step_failed "The downloaded Node.js does not run on this system" "Install Node.js $MIN_NODE_MAJOR.$MIN_NODE_MINOR+ yourself and run this installer again."; }
    ok "Installed Node.js" "v$NODE_SEEN, private copy"
  fi
  # npm and everything it runs must use the same Node.js.
  PATH="$(dirname "$NODE_BIN"):$PATH"
  export PATH
}

# Offer to install git with the system package manager. This is the one step that needs sudo, so it only
# happens when you say yes, and never with --yes.
install_git_cmd() {
  _sudo=
  if [ "$(id -u 2>/dev/null || echo 1)" != 0 ]; then
    if have sudo; then _sudo="sudo "; else return 1; fi
  fi
  if have brew; then GIT_CMD="brew install git"
  elif have apt-get; then GIT_CMD="${_sudo}apt-get install -y git"
  elif have dnf; then GIT_CMD="${_sudo}dnf install -y git"
  elif have yum; then GIT_CMD="${_sudo}yum install -y git"
  elif have pacman; then GIT_CMD="${_sudo}pacman -S --noconfirm git"
  elif have zypper; then GIT_CMD="${_sudo}zypper --non-interactive install git"
  elif have apk; then GIT_CMD="${_sudo}apk add git"
  else return 1
  fi
  return 0
}

ensure_git() {
  if have git; then
    ok "git" "$(git --version | sed 's/^git version //')"
    return 0
  fi
  warn "git was not found" "it is used to download Nacreframe"
  if [ "$OS" = macOS ] && ! have brew; then
    note "Install it with:  xcode-select --install   (a window opens; come back when it finishes)" >&2
    note "Then run this installer again." >&2
    exit 1
  fi
  GIT_CMD=
  if install_git_cmd; then
    if [ "$ASSUME_YES" != 1 ] && [ "$TTY_OK" = 1 ] \
      && ask_yes_no "Install git now with \`$GIT_CMD\`?" y n; then
      blank
      # Run in the foreground with your terminal attached, so a sudo password prompt works.
      if sh -c "$GIT_CMD" </dev/tty && have git; then
        ok "Installed git" "$(git --version | sed 's/^git version //')"
        return 0
      fi
      fail "That did not install git"
    fi
    note "To install it yourself:  $GIT_CMD" >&2
  else
    note "Install git with your package manager (for example: sudo apt install git)." >&2
  fi
  note "Then run this installer again." >&2
  exit 1
}

check_prereqs() {
  ensure_node
  ensure_git
  if ! have npm; then
    die "npm was not found" "It normally comes with Node.js. Reinstall Node.js, then run this installer again."
  fi
  ok "npm" "v$(npm --version 2>/dev/null || echo '?')"
}

pkg_version() {
  sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1/package.json" 2>/dev/null | head -n 1
}

is_our_checkout() {
  [ -f "$INSTALL_DIR/package.json" ] && grep -q '"name": *"nacreframe"' "$INSTALL_DIR/package.json" 2>/dev/null
}

do_fetch() {
  mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  if [ ! -d .git ]; then git init -q; fi
  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "$NACRE_REPO"
  else
    git remote add origin "$NACRE_REPO"
  fi
  GIT_TERMINAL_PROMPT=0 git fetch -q --depth 1 origin "$NACRE_REF"
  git -c advice.detachedHead=false checkout -q -f --detach FETCH_HEAD
}

do_deps() {
  cd "$INSTALL_DIR"
  npm ci --no-audit --no-fund --loglevel=error
}

do_build() {
  cd "$INSTALL_DIR"
  npm run build --silent
  # The build tools are not needed to run Nacreframe; drop them to save space.
  npm prune --omit=dev --no-audit --no-fund --loglevel=error
}

# True when the folder holds anything besides the private Node.js copy (runtime/).
dir_has_files() {
  [ -d "$1" ] || return 1
  for _f in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$_f" ] || [ -L "$_f" ] || continue
    [ "${_f##*/}" = runtime ] && continue
    return 0
  done
  return 1
}

download_and_build() {
  UPDATING=0
  OLD_HEAD=
  OLD_VER=
  if dir_has_files "$INSTALL_DIR"; then
    if ! is_our_checkout; then
      die "$(tilde "$INSTALL_DIR") already exists and is not a Nacreframe install" \
        "Choose another place with --dir, or move that folder away."
    fi
    UPDATING=1
    OLD_VER=$(pkg_version "$INSTALL_DIR")
    OLD_HEAD=$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)
  fi

  if ! run_step "Downloading Nacreframe ($NACRE_REF)" do_fetch; then
    if [ "$REPAIR" = 1 ] && is_our_checkout; then
      warn "Could not reach the download server" "repairing from the files already here"
    else
      step_failed "Could not download Nacreframe" \
        "Check your internet connection. If the repository is private, make sure git is signed in" \
        "(for example with \`gh auth login\`), or set NACRE_REPO to an SSH URL."
    fi
  fi
  NEW_HEAD=$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || true)
  NEW_SHORT=$(git -C "$INSTALL_DIR" rev-parse --short HEAD 2>/dev/null || echo "?")
  NEW_VER=$(pkg_version "$INSTALL_DIR")

  if [ "$REPAIR" != 1 ] && [ "$UPDATING" = 1 ] && [ -n "$OLD_HEAD" ] && [ "$OLD_HEAD" = "$NEW_HEAD" ] \
    && [ -f "$INSTALL_DIR/dist/cli.js" ] && [ -d "$INSTALL_DIR/node_modules" ]; then
    ok "Nacreframe ${NEW_VER:-?} is already up to date" "($NACRE_REF @ $NEW_SHORT)"
    return 0
  fi
  if [ "$UPDATING" = 1 ] && [ -n "$OLD_VER" ] && [ "$OLD_VER" != "$NEW_VER" ]; then
    ok "Downloaded Nacreframe ${NEW_VER:-?}" "(was $OLD_VER, $NACRE_REF @ $NEW_SHORT)"
  else
    ok "Downloaded Nacreframe ${NEW_VER:-?}" "($NACRE_REF @ $NEW_SHORT)"
  fi

  if ! run_step "Installing dependencies (about a minute)" do_deps; then
    step_failed "Installing dependencies failed" "Check your connection and npm settings, then run this installer again."
  fi
  ok "Installed dependencies"

  if ! run_step "Building" do_build; then
    step_failed "The build failed" "This is a bug in the installer or the code. Please report it with the log below."
  fi
  if [ ! -f "$INSTALL_DIR/dist/cli.js" ]; then
    step_failed "The build finished but dist/cli.js is missing"
  fi
  ok "Built"
}

# Single-quote a value for safe use inside a shell script.
sq() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

LAUNCHER_MARK="# nacre launcher written by the Nacreframe installer"

# The `nacre` command is a small launcher, not a bare symlink: it uses the private Node.js when there is one,
# and if Nacreframe's files have gone missing it repairs them before starting.
write_launcher() {
  _q_dir=$(sq "$INSTALL_DIR")
  _q_bin=$(sq "$BIN_DIR")
  cat >"$1" <<EOF
#!/bin/sh
$LAUNCHER_MARK
NACRE_DIR=$_q_dir
NACRE_BIN_DIR=$_q_bin
if [ ! -f "\$NACRE_DIR/dist/cli.js" ] || [ ! -d "\$NACRE_DIR/node_modules" ]; then
  if [ -f "\$NACRE_DIR/install.sh" ]; then
    echo "Nacreframe's files are missing or damaged. Repairing (this needs an internet connection)..." >&2
    sh "\$NACRE_DIR/install.sh" --repair --dir "\$NACRE_DIR" --bin-dir "\$NACRE_BIN_DIR" >&2 || exit 1
  else
    echo "Nacreframe's files are missing. Reinstall with:" >&2
    echo "  curl -fsSL https://raw.githubusercontent.com/Falcon016/Nacreframe/main/install.sh | sh" >&2
    exit 1
  fi
fi
NODE="\$NACRE_DIR/runtime/node/bin/node"
[ -x "\$NODE" ] || NODE=node
exec "\$NODE" "\$NACRE_DIR/dist/cli.js" "\$@"
EOF
  chmod +x "$1"
}

is_our_launcher() {
  [ -f "$1" ] && [ ! -L "$1" ] && grep -qF "$LAUNCHER_MARK" "$1" 2>/dev/null
}

link_binary() {
  _target="$INSTALL_DIR/dist/cli.js"
  _link="$BIN_DIR/nacre"
  chmod +x "$_target"
  mkdir -p "$BIN_DIR"
  if [ -L "$_link" ]; then
    # An older version of this installer made a symlink; the launcher replaces it.
    _old=$(readlink "$_link" 2>/dev/null || true)
    case "$_old" in
      "$_target") ;;
      *) warn "Replacing an older link" "$(tilde "$_link") pointed to $_old" ;;
    esac
    rm -f "$_link"
  elif [ -e "$_link" ]; then
    if is_our_launcher "$_link"; then
      rm -f "$_link"
    else
      die "$(tilde "$_link") already exists and was not made by this installer" \
        "Move or delete it, or pick another place with --bin-dir, then run this installer again."
    fi
  fi
  write_launcher "$_link"
  ok "Added the nacre command" "$(tilde "$_link")"
}

on_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Sets RC (the profile file), RC_KIND (posix|fish) and PATH_LINE.
find_profile() {
  case "$BIN_DIR" in
    "$HOME"/*) _expr="\$HOME/${BIN_DIR#"$HOME"/}" ;;
    *) _expr="$BIN_DIR" ;;
  esac
  RC_KIND=posix
  case "$(basename "${SHELL:-sh}")" in
    zsh) RC="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      if [ "$OS" = macOS ]; then RC="$HOME/.bash_profile"; else RC="$HOME/.bashrc"; fi
      ;;
    fish)
      RC="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/nacreframe.fish"
      RC_KIND=fish
      ;;
    *) RC="$HOME/.profile" ;;
  esac
  if [ "$RC_KIND" = fish ]; then
    PATH_LINE="fish_add_path -g \"$_expr\""
  else
    PATH_LINE="export PATH=\"$_expr:\$PATH\""
  fi
}

setup_path() {
  if on_path; then
    ok "nacre is already on your PATH"
    PATH_READY=1
    return 0
  fi
  PATH_READY=0
  find_profile
  if [ "$MODIFY_PATH" = never ]; then
    warn "$(tilde "$BIN_DIR") is not on your PATH"
    note "Add this line to $(tilde "$RC") yourself:  $PATH_LINE"
    return 0
  fi
  if [ -f "$RC" ] && grep -qF "$MARK_BEGIN" "$RC" 2>/dev/null; then
    ok "Your PATH is already set up in $(tilde "$RC")" "(open a new terminal to pick it up)"
    PATH_READY=1
    return 0
  fi
  if ask_yes_no "Add $(tilde "$BIN_DIR") to your PATH in $(tilde "$RC")?" y n; then
    mkdir -p "$(dirname "$RC")"
    {
      printf '\n%s\n' "$MARK_BEGIN"
      printf '%s\n' "$PATH_LINE"
      printf '%s\n' "$MARK_END"
    } >>"$RC"
    ok "Added $(tilde "$BIN_DIR") to your PATH" "in $(tilde "$RC")"
    PATH_READY=1
    NEED_NEW_SHELL=1
  else
    warn "$(tilde "$BIN_DIR") is not on your PATH"
    note "To use \`nacre\` by name, add this line to $(tilde "$RC"):  $PATH_LINE"
  fi
}

verify_install() {
  _out=$("$BIN_DIR/nacre" --version 2>&1) || step_failed "The installed command does not run" "$_out"
  ok "Checked" "$_out"
  _first=$(command -v nacre 2>/dev/null || true)
  if [ -n "$_first" ] && [ "$_first" != "$BIN_DIR/nacre" ]; then
    warn "Another \`nacre\` comes first on your PATH" "$_first"
    note "Remove it or put $(tilde "$BIN_DIR") earlier in PATH to use this one."
  fi
}

offer_setup() {
  if [ "$RUN_SETUP" = never ] || [ "$ASSUME_YES" = 1 ] || [ "$TTY_OK" != 1 ] || [ "$UPDATING" = 1 ]; then
    return 1
  fi
  blank
  if ask_yes_no "Run the setup wizard now? It takes about a minute." y n; then
    blank
    "$BIN_DIR/nacre" setup </dev/tty || true
    return 0
  fi
  return 1
}

finish() {
  # $1 = 1 when the wizard already printed its own next steps
  blank
  if [ "$REPAIR" = 1 ]; then
    printf '  %s%s%s %sNacreframe is repaired.%s\n' "$GREEN" "$S_OK" "$RESET" "$BOLD" "$RESET"
  elif [ "$UPDATING" = 1 ]; then
    printf '  %s%s%s %sNacreframe is up to date.%s\n' "$GREEN" "$S_OK" "$RESET" "$BOLD" "$RESET"
  else
    printf '  %s%s%s %sNacreframe is installed.%s\n' "$GREEN" "$S_OK" "$RESET" "$BOLD" "$RESET"
  fi
  blank
  if [ "${NEED_NEW_SHELL:-0}" = 1 ]; then
    note "Open a new terminal window so \`nacre\` is on your PATH."
    note "(Or run now:  $PATH_LINE)"
    blank
  elif [ "${PATH_READY:-0}" = 0 ]; then
    note "Until $(tilde "$BIN_DIR") is on your PATH, run it as:  $(tilde "$BIN_DIR")/nacre"
    blank
  fi
  if [ "${1:-0}" != 1 ]; then
    note "Next:"
    note "  nacre setup     guided setup: provider, API key, model, safety"
    note "  nacre doctor    check your environment (add --fix to repair problems)"
  fi
  note "Start it inside a project folder:  cd your-project && nacre"
  note "Update later by running the install command again."
  blank
}

# ---- uninstall ------------------------------------------------------------------------------------

strip_profile_block() {
  [ -f "$1" ] || return 0
  grep -qF "$MARK_BEGIN" "$1" 2>/dev/null || return 0
  _tmp="$1.nacre-tmp.$$"
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    $0 == b { skip = 1; next }
    $0 == e { skip = 0; next }
    !skip { print }
  ' "$1" >"$_tmp"
  cat "$_tmp" >"$1"
  rm -f "$_tmp"
  ok "Removed the PATH entry from $(tilde "$1")"
}

do_uninstall() {
  banner
  _link="$BIN_DIR/nacre"
  if is_our_launcher "$_link" && grep -qF "NACRE_DIR=$(sq "$INSTALL_DIR")" "$_link" 2>/dev/null; then
    rm -f "$_link"
    ok "Removed $(tilde "$_link")"
  elif [ -L "$_link" ]; then
    _t=$(readlink "$_link" 2>/dev/null || true)
    case "$_t" in
      "$INSTALL_DIR"/*)
        rm -f "$_link"
        ok "Removed $(tilde "$_link")"
        ;;
      *) warn "Left $(tilde "$_link") alone" "it points to $_t" ;;
    esac
  elif [ -e "$_link" ]; then
    warn "Left $(tilde "$_link") alone" "it was not made for this install"
  fi
  if is_our_checkout && [ "$INSTALL_DIR" != "/" ] && [ "$INSTALL_DIR" != "$HOME" ]; then
    rm -rf "$INSTALL_DIR"
    ok "Removed $(tilde "$INSTALL_DIR")"
  elif [ -e "$INSTALL_DIR" ]; then
    warn "Left $(tilde "$INSTALL_DIR") alone" "it does not look like a Nacreframe install"
  else
    info "Nothing installed at $(tilde "$INSTALL_DIR")"
  fi
  strip_profile_block "${ZDOTDIR:-$HOME}/.zshrc"
  strip_profile_block "$HOME/.bashrc"
  strip_profile_block "$HOME/.bash_profile"
  strip_profile_block "$HOME/.profile"
  _fish="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/nacreframe.fish"
  if [ -f "$_fish" ]; then
    rm -f "$_fish"
    ok "Removed $(tilde "$_fish")"
  fi

  # Where `nacre` keeps settings, keys and sessions (mirrors src/paths.ts).
  if [ -n "${NACRE_HOME:-}" ]; then
    _keep="\"$NACRE_HOME\""
  elif [ "$OS" = macOS ]; then
    _keep="\"$HOME/Library/Application Support/nacreframe\""
  else
    _keep="\"${XDG_CONFIG_HOME:-$HOME/.config}/nacreframe\" \"${XDG_DATA_HOME:-$HOME/.local/share}/nacreframe\" \"${XDG_STATE_HOME:-$HOME/.local/state}/nacreframe\""
  fi
  blank
  note "Your settings, API keys and sessions were kept. To delete those too:"
  note "  rm -rf $_keep"
  blank
}

# ---- main -----------------------------------------------------------------------------------------

main() {
  setup_ui
  while [ $# -gt 0 ]; do
    case "$1" in
      -y | --yes) ASSUME_YES=1 ;;
      --no-setup) RUN_SETUP=never ;;
      --no-modify-path) MODIFY_PATH=never ;;
      --uninstall) UNINSTALL=1 ;;
      --repair) REPAIR=1; ASSUME_YES=1; RUN_SETUP=never ;;
      --ref) [ $# -ge 2 ] || die "--ref needs a value"; NACRE_REF=$2; shift ;;
      --ref=*) NACRE_REF=${1#--ref=} ;;
      --dir) [ $# -ge 2 ] || die "--dir needs a value"; NACRE_INSTALL_DIR=$2; shift ;;
      --dir=*) NACRE_INSTALL_DIR=${1#--dir=} ;;
      --bin-dir) [ $# -ge 2 ] || die "--bin-dir needs a value"; NACRE_BIN_DIR=$2; shift ;;
      --bin-dir=*) NACRE_BIN_DIR=${1#--bin-dir=} ;;
      -h | --help) usage; exit 0 ;;
      *) die "Unknown option: $1" "Run with --help to see what is available." ;;
    esac
    shift
  done

  if [ -z "${HOME:-}" ]; then die "\$HOME is not set, so there is nowhere to install to."; fi
  INSTALL_DIR="${NACRE_INSTALL_DIR:-$HOME/.nacreframe}"
  BIN_DIR="${NACRE_BIN_DIR:-$HOME/.local/bin}"
  # Absolute paths only, so the symlink and PATH entry keep working from anywhere.
  case "$INSTALL_DIR" in /*) ;; *) INSTALL_DIR="$(pwd)/$INSTALL_DIR" ;; esac
  case "$BIN_DIR" in /*) ;; *) BIN_DIR="$(pwd)/$BIN_DIR" ;; esac

  detect_os

  LOG=$(mktemp "${TMPDIR:-/tmp}/nacreframe-install.XXXXXX")
  trap cleanup EXIT
  trap 'exit 130' INT TERM

  if [ "$UNINSTALL" = 1 ]; then
    do_uninstall
    return 0
  fi

  banner
  note "Installing to $(tilde "$INSTALL_DIR"), with the \`nacre\` command in $(tilde "$BIN_DIR")."
  note "No sudo needed. Nothing outside those two places changes without asking."

  heading "Checking your system"
  ok "$OS"
  check_prereqs

  if [ "$REPAIR" = 1 ]; then heading "Repairing"; else heading "Installing"; fi
  download_and_build
  link_binary

  heading "Finishing up"
  PATH_READY=0
  NEED_NEW_SHELL=0
  setup_path
  verify_install

  _wizard=0
  if offer_setup; then _wizard=1; fi
  finish "$_wizard"
}

main "$@"
