#!/usr/bin/env bash
# Lead Generator (mgli) - installer and updater for macOS and Linux.
# Safe to run any time: no extractor yet = it installs one, extractor already there = it updates it.
#
#   curl -fsSL https://raw.githubusercontent.com/itsMannuYadav/mgli/main/install.sh | bash
#
# Windows users: use install.ps1 instead (see the README).
#
# Automation switches (optional): MGLI_DIR, MGLI_BIN_DIR, MGLI_YES=1 (answer yes to every question),
# MGLI_NO_PROFILE=1 (never edit shell profile), MGLI_NO_DEPS=1 (skip Linux system libraries).

set -euo pipefail

REPO="itsMannuYadav/mgli"
BRANCH="main"
DIR="${MGLI_DIR:-$HOME/mgli}"
BIN_DIR="${MGLI_BIN_DIR:-$HOME/.local/bin}"

say()  { printf '  %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# Ask a yes/no question (default yes). Reads from the terminal even when the script is piped.
# With no terminal at all, answers "no" unless MGLI_YES=1, so nothing changes silently.
ask_yes() {
    if [ "${MGLI_YES:-}" = "1" ]; then return 0; fi
    if [ ! -r /dev/tty ]; then return 1; fi
    local answer=""
    read -r -p "  $1 [Y/n] " answer </dev/tty || true
    [[ -z "$answer" || "$answer" =~ ^[Yy] ]]
}

echo
say "Lead Generator (mgli) - install / update"
echo

case "$(uname -s)" in
    Darwin) OS_NAME="macOS" ;;
    Linux)  OS_NAME="Linux" ;;
    *) say "This installer is for macOS and Linux. On Windows, use install.ps1 (see the README)."; exit 1 ;;
esac

have curl || { say "curl is required. Please install it and run this again."; exit 1; }
have tar  || { say "tar is required. Please install it and run this again."; exit 1; }

# 1. Node.js 18+
node_ok() { have node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; }

if ! node_ok; then
    say "Node.js 18 or newer is not installed."
    if ask_yes "Install Node.js LTS for your user account (using nvm)?"; then
        curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
        export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
        set +u
        # shellcheck disable=SC1091
        . "$NVM_DIR/nvm.sh"
        nvm install --lts
        set -u
    fi
    if ! node_ok; then
        say "Please install Node.js LTS from https://nodejs.org, open a NEW terminal and run this command again."
        exit 1
    fi
fi

# 2. Install or update
if [ -f "$DIR/cli.js" ] && [ -f "$DIR/updater.js" ]; then
    say "Found an existing install: $DIR"
    ( cd "$DIR" && node cli.js update )
else
    if [ -f "$DIR/cli.js" ]; then say "Upgrading an older install: $DIR"; else say "Installing to: $DIR"; fi
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    say "Downloading..."
    curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz -C "$TMP" --strip-components=1
    mkdir -p "$DIR/exports"
    cp -R "$TMP"/. "$DIR"/
    # Remember which version this is, so "mgli update" knows when something newer exists
    curl -fsSL -H "Accept: application/vnd.github.sha" "https://api.github.com/repos/$REPO/commits/$BRANCH" > "$DIR/.version" 2>/dev/null || true

    say "Installing packages (a minute or two)..."
    ( cd "$DIR" && npm install --no-audit --no-fund --loglevel=error )

    say "Installing the browser (one time, about 150 MB)..."
    ( cd "$DIR" && npx playwright install chromium )

    # Linux needs some system libraries for the browser (needs admin rights)
    if [ "$OS_NAME" = "Linux" ] && [ "${MGLI_NO_DEPS:-}" != "1" ]; then
        if [ "$(id -u)" = "0" ]; then
            ( cd "$DIR" && npx playwright install-deps chromium ) || say "Could not install system libraries. If the browser fails to start, run: sudo env \"PATH=\$PATH\" npx playwright install-deps chromium"
        elif have sudo; then
            if ask_yes "Install the system libraries the browser needs (uses sudo)?"; then
                ( cd "$DIR" && sudo env "PATH=$PATH" npx playwright install-deps chromium ) || say "Could not install system libraries. If the browser fails to start, run: sudo env \"PATH=\$PATH\" npx playwright install-deps chromium"
            else
                say "Skipped. If the browser fails to start later, run: sudo env \"PATH=\$PATH\" npx playwright install-deps chromium"
            fi
        else
            say "If the browser fails to start, ask an admin to run: npx playwright install-deps chromium"
        fi
    fi
fi

# 3. The "mgli" command: a small launcher script (no admin rights needed)
mkdir -p "$BIN_DIR"
NODE_BIN="$(command -v node)"
cat > "$BIN_DIR/mgli" <<EOF
#!/usr/bin/env bash
if [ -x "$NODE_BIN" ]; then exec "$NODE_BIN" "$DIR/cli.js" "\$@"; fi
exec node "$DIR/cli.js" "\$@"
EOF
chmod +x "$BIN_DIR/mgli"

# Make sure the launcher folder is on PATH
case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
        if [ "${MGLI_NO_PROFILE:-}" != "1" ]; then
            case "${SHELL:-}" in
                */zsh) PROFILE="$HOME/.zshrc" ;;
                *)     PROFILE="$HOME/.bashrc"; [ "$OS_NAME" = "macOS" ] && PROFILE="$HOME/.bash_profile" ;;
            esac
            if ask_yes "Add $BIN_DIR to your PATH (edits $PROFILE) so you can type mgli anywhere?"; then
                printf '\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$PROFILE"
                say "Added to $PROFILE"
            else
                say "To use it, add this to your shell profile:  export PATH=\"$BIN_DIR:\$PATH\""
            fi
        fi
        ;;
esac

echo
say "All set!"
say "Open a NEW terminal and type:  mgli          to start"
say "                                mgli update   to update later"
say "                                mgli help     to see all commands"
echo
