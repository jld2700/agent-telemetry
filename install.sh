#!/usr/bin/env bash
#
# agent-telemetry installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/jld2700/agent-telemetry/main/install.sh | bash
#
# Or clone and run locally:
#   git clone https://github.com/jld2700/agent-telemetry.git
#   cd agent-telemetry && bash install.sh
#
# This script:
#   1. Detects platform (macOS/Linux, arch)
#   2. Builds from source (if bun is available) or downloads binary
#   3. Installs binary to ~/.local/bin/ or /usr/local/bin/
#   4. Creates data directory (~/.agent-telemetry)
#   5. Copies config.yml template
#   6. Installs as background service (launchd on macOS, systemd on Linux)
#   7. Injects OTLP config into Claude Code, Codex, and OpenCode
#   8. Prints next steps
#
set -euo pipefail

# ─── Colors ──────────────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
    BOLD='\033[1m'
    GREEN='\033[32m'
    YELLOW='\033[33m'
    BLUE='\033[34m'
    RED='\033[31m'
    DIM='\033[2m'
    RESET='\033[0m'
else
    BOLD='' GREEN='' YELLOW='' BLUE='' RED='' DIM='' RESET=''
fi

info()  { echo -e "${BLUE}ℹ${RESET} $*"; }
ok()    { echo -e "${GREEN}✓${RESET} $*"; }
warn()  { echo -e "${YELLOW}⚠${RESET} $*"; }
err()   { echo -e "${RED}✗${RESET} $*" >&2; }

# ─── Platform detection ──────────────────────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
    Darwin) PLATFORM="macos" ;;
    Linux)  PLATFORM="linux" ;;
    *)      err "Unsupported OS: $OS"; exit 1 ;;
esac

case "$ARCH" in
    x86_64|amd64) ARCH_NORMALIZED="x64" ;;
    arm64|aarch64) ARCH_NORMALIZED="arm64" ;;
    *) err "Unsupported architecture: $ARCH"; exit 1 ;;
esac

info "Detected: ${PLATFORM} (${ARCH_NORMALIZED})"

# ─── Paths ───────────────────────────────────────────────────────────────────

HOME_DIR="${HOME:-$(eval echo ~)}"
DATA_DIR="${HOME_DIR}/.agent-telemetry"
LOG_DIR="${DATA_DIR}/logs"

# Binary install location: prefer ~/.local/bin (no sudo needed), fall back to /usr/local/bin
if [[ -w "/usr/local/bin" ]]; then
    BIN_DIR="/usr/local/bin"
else
    BIN_DIR="${HOME_DIR}/.local/bin"
fi
BINARY_PATH="${BIN_DIR}/agent-telemetry"

# ─── Step 1: Get the binary ──────────────────────────────────────────────────

echo ""
echo -e "${BOLD}Step 1: Installing binary${RESET}"

# Check if we're running from the source directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SOURCE_CLI="${SCRIPT_DIR}/src/cli.ts"
SOURCE_PACKAGE="${SCRIPT_DIR}/package.json"

get_binary() {
    # Option A: Build from source if bun is available and we have the source
    if command -v bun &>/dev/null && [[ -f "$SOURCE_CLI" ]]; then
        info "Building from source with bun…"
        cd "$SCRIPT_DIR"
        bun install 2>/dev/null || true
        bun build src/cli.ts --compile --target bun --outfile agent-telemetry
        mkdir -p "$BIN_DIR"
        cp agent-telemetry "$BINARY_PATH"
        chmod +x "$BINARY_PATH"
        ok "Built and installed to ${BINARY_PATH}"
        return 0
    fi

    # Option B: If a pre-built binary exists in the source dir, use it
    if [[ -f "${SCRIPT_DIR}/agent-telemetry" ]]; then
        info "Using pre-built binary from source directory…"
        mkdir -p "$BIN_DIR"
        cp "${SCRIPT_DIR}/agent-telemetry" "$BINARY_PATH"
        chmod +x "$BINARY_PATH"
        ok "Installed to ${BINARY_PATH}"
        return 0
    fi

    # Option C: Download from GitHub releases
    local REPO="jld2700/agent-telemetry"
    local GITHUB_LATEST="https://api.github.com/repos/${REPO}/releases/latest"

    info "Downloading latest release from GitHub…"
    local DOWNLOAD_URL=""
    local RELEASE_INFO=""

    if command -v curl &>/dev/null; then
        RELEASE_INFO=$(curl -fsSL "$GITHUB_LATEST" 2>/dev/null || echo "")
    elif command -v wget &>/dev/null; then
        RELEASE_INFO=$(wget -qO- "$GITHUB_LATEST" 2>/dev/null || echo "")
    else
        err "Neither curl nor wget is available. Please install one."
        return 1
    fi

    if [[ -z "$RELEASE_INFO" ]]; then
        warn "Could not fetch release info. Trying to build from source…"
        if command -v bun &>/dev/null; then
            err "bun found but no source code. Clone the repo and run from there."
        else
            err "No binary available and bun not installed. Install bun: https://bun.sh"
        fi
        return 1
    fi

    # Parse the download URL from release info (look for matching asset)
    local ASSET_PATTERN="agent-telemetry-${PLATFORM}-${ARCH_NORMALIZED}"
    DOWNLOAD_URL=$(echo "$RELEASE_INFO" | grep -o "https://[^\"']*${ASSET_PATTERN}[^\"']*" | head -1 || echo "")

    if [[ -z "$DOWNLOAD_URL" ]]; then
        # Try a generic binary name
        DOWNLOAD_URL=$(echo "$RELEASE_INFO" | grep -o '"browser_download_url":\s*"[^"]*"' | grep -o 'https://[^"]*' | head -1 || echo "")
    fi

    if [[ -z "$DOWNLOAD_URL" ]]; then
        err "No matching binary found in latest release for ${PLATFORM}-${ARCH_NORMALIZED}"
        err "Install bun (https://bun.sh) and clone the repo to build from source."
        return 1
    fi

    info "Downloading ${DOWNLOAD_URL}…"
    mkdir -p "$BIN_DIR"
    local TMP_BIN="${BINARY_PATH}.tmp"

    if command -v curl &>/dev/null; then
        curl -fsSL "$DOWNLOAD_URL" -o "$TMP_BIN"
    else
        wget -qO "$TMP_BIN" "$DOWNLOAD_URL"
    fi

    mv "$TMP_BIN" "$BINARY_PATH"
    chmod +x "$BINARY_PATH"
    ok "Downloaded and installed to ${BINARY_PATH}"
}

get_binary || { err "Failed to install binary"; exit 1; }

# Ensure bin dir is in PATH
if [[ ":${PATH}:" != *":${BIN_DIR}:"* ]]; then
    warn "${BIN_DIR} is not in your PATH."
    echo -e "  Add this to your shell profile (${DIM}~/.zshrc${RESET} or ${DIM}~/.bashrc${RESET}):"
    echo -e "  ${BOLD}export PATH=\"${BIN_DIR}:\$PATH\"${RESET}"
fi

# ─── Step 2: Create data directory ───────────────────────────────────────────

echo ""
echo -e "${BOLD}Step 2: Creating data directory${RESET}"
mkdir -p "$DATA_DIR" "$LOG_DIR"
ok "Data directory: ${DATA_DIR}"

# ─── Step 3: Copy config template ────────────────────────────────────────────

echo ""
echo -e "${BOLD}Step 3: Setting up config${RESET}"

if [[ -f "${SCRIPT_DIR}/config.yml" ]] && [[ ! -f "${DATA_DIR}/config.yml" ]]; then
    cp "${SCRIPT_DIR}/config.yml" "${DATA_DIR}/config.yml"
    ok "Copied config.yml → ${DATA_DIR}/config.yml"
elif [[ -f "${DATA_DIR}/config.yml" ]]; then
    info "Config already exists, skipping: ${DATA_DIR}/config.yml"
else
    warn "No config template found, using defaults"
fi

# ─── Step 4: Install service file ────────────────────────────────────────────

echo ""
echo -e "${BOLD}Step 4: Installing ${PLATFORM} service${RESET}"

if [[ "$PLATFORM" == "macos" ]]; then
    PLIST_PATH="${HOME_DIR}/Library/LaunchAgents/com.agent-telemetry.plist"
    PLIST_DIR="$(dirname "$PLIST_PATH")"
    mkdir -p "$PLIST_DIR"

    cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agent-telemetry</string>
    <key>ProgramArguments</key>
    <array>
        <string>${BINARY_PATH}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/agent-telemetry.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/agent-telemetry.stderr.log</string>
    <key>WorkingDirectory</key>
    <string>${DATA_DIR}</string>
</dict>
</plist>
EOF
    ok "Service file: ${PLIST_PATH}"

    # Start the service
    echo ""
    echo -e "${BOLD}Step 5: Starting service${RESET}"
    UID_NUM=$(id -u)

    # Try kickstart first (in case it's already bootstrapped)
    if launchctl kickstart -k "gui/${UID_NUM}/com.agent-telemetry" 2>/dev/null; then
        ok "Service started (kickstart)"
    elif launchctl bootstrap "gui/${UID_NUM}" "$PLIST_PATH" 2>/dev/null; then
        ok "Service started (bootstrap)"
    else
        # Already bootstrapped, try kickstart without -k
        if launchctl kickstart "gui/${UID_NUM}/com.agent-telemetry" 2>/dev/null; then
            ok "Service started (kickstart)"
        else
            warn "Could not auto-start service. Start manually with:"
            echo -e "  ${BOLD}launchctl bootstrap gui/${UID_NUM} ${PLIST_PATH}${RESET}"
        fi
    fi

elif [[ "$PLATFORM" == "linux" ]]; then
    SERVICE_PATH="${HOME_DIR}/.config/systemd/user/agent-telemetry.service"
    SERVICE_DIR="$(dirname "$SERVICE_PATH")"
    mkdir -p "$SERVICE_DIR"

    cat > "$SERVICE_PATH" << EOF
[Unit]
Description=Agent Telemetry - OTLP collector for AI coding agents
After=network.target

[Service]
Type=simple
ExecStart=${BINARY_PATH}
WorkingDirectory=${DATA_DIR}
Restart=on-failure
RestartSec=5
StandardOutput=append:${LOG_DIR}/agent-telemetry.stdout.log
StandardError=append:${LOG_DIR}/agent-telemetry.stderr.log

[Install]
WantedBy=default.target
EOF
    ok "Service file: ${SERVICE_PATH}"

    # Start the service
    echo ""
    echo -e "${BOLD}Step 5: Starting service${RESET}"
    systemctl --user daemon-reload
    if systemctl --user enable --now agent-telemetry 2>/dev/null; then
        ok "Service started (systemctl enable --now)"
    else
        warn "Could not auto-start service. Start manually with:"
        echo -e "  ${BOLD}systemctl --user enable --now agent-telemetry${RESET}"
    fi
fi

# ─── Step 6: Inject OTLP config ──────────────────────────────────────────────

echo ""
echo -e "${BOLD}Step 6: Injecting OTLP config${RESET}"

OTLP_ENDPOINT="http://127.0.0.1:9911/api/otel"

# Use the installed binary to do the injection (it handles JSON/TOML properly)
if "$BINARY_PATH" install --skip-service 2>/dev/null; then
    ok "OTLP config injected via agent-telemetry CLI"
else
    # Fallback: do basic injection manually with jq/python
    warn "CLI injection failed, trying manual injection…"

    # Claude Code settings.json
    CLAUDE_SETTINGS="${HOME_DIR}/.claude/settings.json"
    CLAUDE_DIR="${HOME_DIR}/.claude"

    if mkdir -p "$CLAUDE_DIR" 2>/dev/null; then
        if command -v jq &>/dev/null; then
            # Create file if doesn't exist
            if [[ ! -f "$CLAUDE_SETTINGS" ]]; then
                echo '{}' > "$CLAUDE_SETTINGS"
            fi

            # Merge OTEL env vars
            jq --arg endpoint "$OTLP_ENDPOINT" '
                .env = (.env // {}) | .env += {
                    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
                    "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
                    "OTEL_TRACES_EXPORTER": "otlp",
                    "OTEL_METRICS_EXPORTER": "otlp",
                    "OTEL_LOGS_EXPORTER": "otlp",
                    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
                    "OTEL_EXPORTER_OTLP_ENDPOINT": $endpoint,
                    "OTEL_LOG_TOOL_DETAILS": "1"
                }
            ' "$CLAUDE_SETTINGS" > "${CLAUDE_SETTINGS}.tmp" && mv "${CLAUDE_SETTINGS}.tmp" "$CLAUDE_SETTINGS"
            ok "Injected OTLP env into Claude Code: ${CLAUDE_SETTINGS}"
        else
            warn "jq not found, skipping Claude Code OTLP injection"
            warn "Install jq or run: ${BINARY_PATH} install --skip-service"
        fi
    fi

    # Codex config.toml — only if ~/.codex exists
    CODEX_CONFIG="${HOME_DIR}/.codex/config.toml"
    if [[ -d "${HOME_DIR}/.codex" ]]; then
        # Remove existing [otel*] sections and append new one
        if [[ -f "$CODEX_CONFIG" ]]; then
            # Remove existing otel sections
            sed -i.bak '/^\[otel[^\]]*\]/,/^\[/ { /^\[otel[^\]]*\]/d; /^\[/!d; }' "$CODEX_CONFIG" 2>/dev/null || true
            rm -f "${CODEX_CONFIG}.bak"
        fi

        cat >> "$CODEX_CONFIG" << EOF

[otel]
environment = "production"

[otel.exporter.otlp-http]
endpoint = "${OTLP_ENDPOINT}/v1/logs"
protocol = "json"

[otel.metrics_exporter.otlp-http]
endpoint = "${OTLP_ENDPOINT}/v1/metrics"
protocol = "json"
EOF
        ok "Injected OTLP config into Codex: ${CODEX_CONFIG}"
    else
        info "Codex not detected (~/.codex not found), skipping"
    fi
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${GREEN}✓ Installation complete!${RESET}"
echo ""
echo -e "${BOLD}Next steps:${RESET}"
echo -e "  ${DIM}•${RESET} Check status:    ${BOLD}agent-telemetry status${RESET}"
echo -e "  ${DIM}•${RESET} View logs:       ${BOLD}agent-telemetry logs${RESET}"
echo -e "  ${DIM}•${RESET} Edit config:     ${BOLD}agent-telemetry config${RESET}"
echo -e "  ${DIM}•${RESET} Restart Claude Code / Codex / OpenCode for OTLP env vars to take effect"
echo ""
echo -e "${BOLD}How to verify it's working:${RESET}"
echo -e "  ${DIM}•${RESET} Run any Claude Code session, then check:"
echo -e "    ${BOLD}agent-telemetry status${RESET} ${DIM}(should show event count > 0)${RESET}"
echo ""
echo -e "${BOLD}To uninstall:${RESET}"
echo -e "  ${BOLD}agent-telemetry uninstall${RESET} ${DIM}(or bash uninstall.sh)${RESET}"
echo ""