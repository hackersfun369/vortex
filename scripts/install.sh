#!/usr/bin/env sh
# vortex installer
# usage: curl -fsSL https://hackersfun369.github.io/install.sh | sh
set -e

GITHUB_REPO="hackersfun369/vortex"
INSTALL_DIR="/usr/local/bin"
CF_VERSION="2024.12.2"

BOLD='\033[1m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; RED='\033[0;31m'; NC='\033[0m'

log()  { printf "${CYAN}▸${NC} %s\n" "$1"; }
ok()   { printf "${GREEN}✓${NC} %s\n" "$1"; }
fail() { printf "${RED}✗${NC} %s\n" "$1" >&2; exit 1; }

printf "${BOLD}"
printf ' ██╗   ██╗ ██████╗ ██████╗ ████████╗███████╗██╗  ██╗\n'
printf ' ██║   ██║██╔═══██╗██╔══██╗╚══██╔══╝██╔════╝╚██╗██╔╝\n'
printf ' ╚██╗ ██╔╝██║   ██║██████╔╝   ██║   █████╗   ╚███╔╝ \n'
printf '  ╚████╔╝ ╚██████╔╝██║  ██║   ██║   ███████╗██╔╝ ██╗\n'
printf '   ╚═══╝   ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝\n'
printf "${NC}\n  Installer\n\n"

command -v curl >/dev/null 2>&1 || fail "curl is required"

detect_os() {
  case "$(uname -s)" in
    Linux*)  echo linux ;;
    Darwin*) echo darwin ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *) fail "unsupported OS: $(uname -s)" ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)    echo amd64 ;;
    aarch64|arm64)   echo arm64 ;;
    armv7l|armv6l)   echo arm ;;
    *) fail "unsupported arch: $(uname -m)" ;;
  esac
}

OS=$(detect_os)
ARCH=$(detect_arch)
log "detected ${OS}/${ARCH}"

# ── Install cloudflared ────────────────────────────────────────────────────
install_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then
    ok "cloudflared already installed"
    return
  fi
  log "installing cloudflared ${CF_VERSION}..."
  CF_FILE="cloudflared-${OS}-${ARCH}"
  CF_URL="https://github.com/cloudflare/cloudflared/releases/download/${CF_VERSION}/${CF_FILE}"
  TMP=$(mktemp)
  curl -fsSL "$CF_URL" -o "$TMP" || fail "failed to download cloudflared"
  chmod +x "$TMP"
  if [ -w "$INSTALL_DIR" ]; then mv "$TMP" "${INSTALL_DIR}/cloudflared"
  else sudo mv "$TMP" "${INSTALL_DIR}/cloudflared"; fi
  ok "cloudflared installed → ${INSTALL_DIR}/cloudflared"
}

# ── Install vortex ─────────────────────────────────────────────────────────
install_vortex() {
  log "fetching latest vortex version..."
  LATEST=$(curl -fsSL "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" \
    | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')
  [ -z "$LATEST" ] && fail "could not fetch vortex version"

  log "installing vortex ${LATEST}..."
  VORTEX_FILE="vortex-${OS}-${ARCH}"
  VORTEX_URL="https://github.com/${GITHUB_REPO}/releases/download/${LATEST}/${VORTEX_FILE}"
  TMP=$(mktemp)
  curl -fsSL "$VORTEX_URL" -o "$TMP" || fail "failed to download vortex"
  chmod +x "$TMP"
  if [ -w "$INSTALL_DIR" ]; then mv "$TMP" "${INSTALL_DIR}/vortex"
  else sudo mv "$TMP" "${INSTALL_DIR}/vortex"; fi
  ok "vortex installed → ${INSTALL_DIR}/vortex"
}

install_cloudflared
install_vortex

printf "\n${GREEN}${BOLD}  Done!${NC}\n\n"
printf "  Expose a port:\n"
printf "  ${BOLD}vortex 3000${NC}\n\n"
printf "  Private mode:\n"
printf "  ${BOLD}vortex 3000 --privacy${NC}\n\n"
printf "  Full docs:\n"
printf "  ${BOLD}https://hackersfun369.github.io/docs${NC}\n\n"
