#!/usr/bin/env bash
#
# agent-telemetry uninstaller
#
# Usage:
#   bash uninstall.sh [--purge]
#
# This script:
#   1. Stops and unloads the background service
#   2. Removes the service file (plist/systemd)
#   3. Removes the binary
#   4. Removes OTLP env vars from Claude Code's ~/.claude/settings.json
#   5. Removes OTLP config from Codex's ~/.codex/config.toml
#   6. Optionally removes data directory (--purge)
#
set -euo pipefail

# ─── Colors ──────────────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
    BOLD='\033[1m'
    GREEN='\033[32m'
    YELLOW='\033[33m'
    RED='\033[31m'
    DIM='\033[2m'
    RESET='\033[0m'
else
    BOLD='' GREEN='' YELLOW='' RED='' DIM='' RESET=''
fi

info()  { echo -e "${YELLOW}ℹ${RESET} $*"; }
ok()    { echo -e "${GREEN}✓${RESET} $*"; }
warn()  { echo -e "${YELLOW}⚠${RESET} $*"; }
err()   { echo -e "${RED}✗${RESET} $*" >&2; }

# ─── Parse args ──────────────────────────────────────────────────────────────

PURGE=false
for arg in "$@"; do
    case "$arg" in
        --purge) PURGE=true ;;
        -h|--help)
            echo "Usage: bash uninstall.sh [--purge]"
            echo ""
            echo "  --purge    Also remove data directory (~/.agent-telemetry)"
            exit 0
            ;;
    esac
done

# ─── Platform detection ──────────────────────────────────────────────────────

OS="$(uname -s)"
case "$OS" in
    Darwin) PLATFORM="macos" ;;
    Linux)  PLATFORM="linux" ;;
    *)      err "Unsupported OS: $OS"; exit 1 ;;
esac

HOME_DIR="${HOME:-$(eval echo ~)}"
DATA_DIR="${HOME_DIR}/.agent-telemetry"

# ─── Step 1: Stop the service ────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${RED}agent-telemetry uninstaller${RESET}"
echo ""
echo -e "${BOLD}Step 1: Stopping service${RESET}"

if [[ "$PLATFORM" == "macos" ]]; then
    UID_NUM=$(id -u)
    PLIST_PATH="${HOME_DIR}/Library/LaunchAgents/com.agent-telemetry.plist"

    if launchctl bootout "gui/${UID_NUM}/com.agent-telemetry" 2>/dev/null; then
        ok "Service stopped (bootout)"
    else
        # Check if it was running
        if launchctl print "gui/${UID_NUM}/com.agent-telemetry" &>/dev/null; then
            warn "Could not stop service via bootout, trying kill…"
            pkill -f "agent-telemetry" 2>/dev/null || true
        else
            info "Service was not running"
        fi
    fi

elif [[ "$PLATFORM" == "linux" ]]; then
    if systemctl --user stop agent-telemetry 2>/dev/null; then
        ok "Service stopped (systemctl stop)"
    else
        info "Service was not running"
    fi
    systemctl --user disable agent-telemetry 2>/dev/null || true
fi

# ─── Step 2: Remove service file ─────────────────────────────────────────────

echo ""
echo -e "${BOLD}Step 2: Removing service file${RESET}"

if [[ "$PLATFORM" == "macos" ]]; then
    if [[ -f "$PLIST_PATH" ]]; then
        rm -f "$PLIST_PATH"
        ok "Removed: ${PLIST_PATH}"
    else
        info "No service file found"
    fi
elif [[ "$PLATFORM" == "linux" ]]; then
    SERVICE_PATH="${HOME_DIR}/.config/systemd/user/agent-telemetry.service"
    if [[ -f "$SERVICE_PATH" ]]; then
        rm -f "$SERVICE_PATH"
        ok "Removed: ${SERVICE_PATH}"
        systemctl --user daemon-reload 2>/dev/null || true
    else
        info "No service file found"
    fi
fi

# ─── Step 3: Remove binary ───────────────────────────────────────────────────

echo ""
echo -e "${BOLD}Step 3: Removing binary${RESET}"

# Try the installed binary first — it can clean up OTLP injection properly
BINARY_PATHS=(
    "/usr/local/bin/agent-telemetry"
    "${HOME_DIR}/.local/bin/agent-telemetry"
)

BINARY_FOUND=""
for bin_path in "${BINARY_PATHS[@]}"; do
    if [[ -f "$bin_path" ]]; then
        BINARY_FOUND="$bin_path"
        break
    fi
done

# ─── Step 4: Remove OTLP config ──────────────────────────────────────────────

echo ""
echo -e "${BOLD}Step 4: Removing OTLP config${RESET}"

# Use the binary to remove OTLP injection (handles JSON/TOML properly)
if [[ -n "$BINARY_FOUND" ]]; then
    if "$BINARY_FOUND" uninstall --skip-service 2>/dev/null; then
        ok "OTLP config removed via agent-telemetry CLI"
    else
        warn "CLI removal failed, trying manual removal…"
        manual_remove_otlp
    fi
else
    manual_remove_otlp
fi

# ─── Step 5: Remove binary ───────────────────────────────────────────────────

for bin_path in "${BINARY_PATHS[@]}"; do
    if [[ -f "$bin_path" ]]; then
        rm -f "$bin_path"
        ok "Removed: ${bin_path}"
    fi
done

# ─── Step 6: Optionally purge data ───────────────────────────────────────────

echo ""
if [[ "$PURGE" == "true" ]]; then
    echo -e "${BOLD}Step 5: Purging data directory${RESET}"
    if [[ -d "$DATA_DIR" ]]; then
        rm -rf "$DATA_DIR"
        ok "Removed: ${DATA_DIR}"
    else
        info "Data directory not found"
    fi
else
    echo -e "${BOLD}Step 5: Data directory preserved${RESET}"
    info "Data directory kept: ${DATA_DIR}"
    echo -e "  ${DIM}Use --purge to remove all data${RESET}"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${GREEN}✓ Uninstall complete!${RESET}"
echo ""
echo -e "${BOLD}Note:${RESET}"
echo -e "  ${DIM}•${RESET} Restart Claude Code / Codex for env changes to take effect"
if [[ "$PURGE" != "true" ]]; then
    echo -e "  ${DIM}•${RESET} Data directory kept. Run ${BOLD}bash uninstall.sh --purge${RESET} to remove it."
fi
echo ""

# ─── Manual OTLP removal (fallback) ──────────────────────────────────────────

manual_remove_otlp() {
    # Claude Code settings.json — remove OTEL_* keys from env section
    CLAUDE_SETTINGS="${HOME_DIR}/.claude/settings.json"

    if [[ -f "$CLAUDE_SETTINGS" ]]; then
        if command -v jq &>/dev/null; then
            # Remove all agent-telemetry-managed keys
            jq 'del(
                .env.CLAUDE_CODE_ENABLE_TELEMETRY,
                .env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA,
                .env.OTEL_TRACES_EXPORTER,
                .env.OTEL_METRICS_EXPORTER,
                .env.OTEL_LOGS_EXPORTER,
                .env.OTEL_EXPORTER_OTLP_PROTOCOL,
                .env.OTEL_EXPORTER_OTLP_ENDPOINT,
                .env.OTEL_LOG_TOOL_DETAILS,
                .env.OTEL_SERVICE_NAME,
                .env.CLAUDE_CODE_PROPAGATE_TRACEPARENT,
                .env.ENABLE_BETA_TRACING_DETAILED,
                .env.BETA_TRACING_ENDPOINT,
                .env.OTEL_RESOURCE_ATTRIBUTES
            )' "$CLAUDE_SETTINGS" > "${CLAUDE_SETTINGS}.tmp" 2>/dev/null && mv "${CLAUDE_SETTINGS}.tmp" "$CLAUDE_SETTINGS"
            ok "Removed OTLP env from Claude Code: ${CLAUDE_SETTINGS}"
        else
            warn "jq not found, cannot remove OTLP env from Claude Code automatically"
            warn "Manually edit ${CLAUDE_SETTINGS} and remove OTEL_* keys from the env section"
        fi
    else
        info "Claude Code settings not found, skipping"
    fi

    # Codex config.toml — remove [otel*] sections
    CODEX_CONFIG="${HOME_DIR}/.codex/config.toml"

    if [[ -f "$CODEX_CONFIG" ]]; then
        # Remove all [otel...] sections and their contents
        # This sed removes lines from [otel...] until the next [section] or end of file
        if sed -i.bak '/^\[otel/,/^\[/{/^\[otel/!{/^\[/!d}}' "$CODEX_CONFIG" 2>/dev/null; then
            # Also remove empty [otel...] lines that remain
            sed -i.bak2 '/^\[otel[^\]]*\]$/d' "$CODEX_CONFIG" 2>/dev/null || true
            rm -f "${CODEX_CONFIG}.bak" "${CODEX_CONFIG}.bak2"
            ok "Removed OTLP sections from Codex: ${CODEX_CONFIG}"
        else
            warn "Could not automatically edit Codex config"
            warn "Manually edit ${CODEX_CONFIG} and remove [otel*] sections"
        fi
    else
        info "Codex config not found, skipping"
    fi
}