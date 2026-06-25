#!/usr/bin/env bash
set -Eeuo pipefail

########################################
# ServerKit Uninstaller
#
# Thin wrapper around the canonical teardown routine in
# scripts/lib/uninstall.sh — the same routine `serverkit uninstall` runs, so
# both entry points behave identically (they used to diverge on volume
# deletion).
#
# Usage:
#   sudo ./uninstall.sh                 # remove ServerKit, preserve user data
#   sudo ./uninstall.sh --purge         # also delete Docker volumes, DB, data
#   sudo ./uninstall.sh --keep-data     # also preserve /etc + /var/lib + backups
#   sudo ./uninstall.sh --yes           # skip the confirmation prompt
#   sudo ./uninstall.sh --dry-run       # show what would happen, change nothing
#
# Honors SERVERKIT_DIR for non-default install locations.
########################################

INSTALL_DIR="${SERVERKIT_DIR:-/opt/serverkit}"
LOG_FILE="/var/log/serverkit-uninstall.log"

PURGE=0
KEEP_DATA=0
ASSUME_YES=0
DRY_RUN=0

usage() {
    cat <<EOF
ServerKit uninstaller

Usage: uninstall.sh [OPTIONS]

Options:
  --purge, --delete-volumes  Also remove Docker volumes, the SQLite database,
                             and all data dirs (/var/lib, /var/serverkit, backups)
  --keep-data                Preserve /var/lib/serverkit, /etc/serverkit and
                             /var/backups/serverkit
  --yes, -y                  Do not prompt for confirmation
  --dry-run, -n              Show what would be done without changing anything
  --help, -h                 Show this help

Environment:
  SERVERKIT_DIR              Install directory (default: /opt/serverkit)
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --purge|--delete-volumes) PURGE=1; shift ;;
        --keep-data)              KEEP_DATA=1; shift ;;
        --yes|-y)                 ASSUME_YES=1; shift ;;
        --dry-run|-n)             DRY_RUN=1; shift ;;
        --help|-h)                usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
    esac
done

mkdir -p /var/log
exec > >(tee -a "$LOG_FILE") 2>&1

########################################
# Colors / masthead
########################################

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
    ESC=$'\033'
    RST_TC="${ESC}[0m"; BLD_TC="${ESC}[1m"
    paint() { printf '%s[38;2;%d;%d;%dm' "$ESC" "$1" "$2" "$3"; }
else
    RST_TC=''; BLD_TC=''
    paint() { :; }
fi

V2="$(paint 167 139 250)"; V3="$(paint 139 92 246)"
V4="$(paint 124 58 237)";  V5="$(paint 109 40 217)"
PAPER_TC="$(paint 237 233 254)"; ASH_TC="$(paint 165 160 190)"; FOG_TC="$(paint 113 108 140)"
HUE_WARN_TC="$(paint 250 204 21)"

print_error() { echo -e "${RED}✗ $1${NC}"; }
print_warning() { echo -e "${YELLOW}! $1${NC}"; }

print_header() {
    local ver="unknown"
    [ -f "${INSTALL_DIR}/VERSION" ] && ver=$(tr -d '\r\n ' < "${INSTALL_DIR}/VERSION")
    printf '\n'
    printf '  %s%s▖▌▌%s  %s%sServerKit%s  %sv%s%s  %s•%s %sUninstaller%s\n' \
        "${BLD_TC}" "${V2}" "${RST_TC}" "${BLD_TC}" "${PAPER_TC}" "${RST_TC}" "${FOG_TC}" "$ver" "${RST_TC}" \
        "${HUE_WARN_TC}" "${RST_TC}" "${ASH_TC}" "${RST_TC}"
    printf '  %s%s▌▖▌%s  %sSelf-hosted infrastructure, made simple.%s\n' \
        "${BLD_TC}" "${V3}" "${RST_TC}" "${ASH_TC}" "${RST_TC}"
    printf '  %s%s▌▌▖%s  %sWeb apps · Databases · Docker · Email · DNS · Security%s\n' \
        "${BLD_TC}" "${V4}" "${RST_TC}" "${FOG_TC}" "${RST_TC}"
    printf '  %s%s▘▘▘%s  %sPython + React, one command · serverkit.ai%s\n' \
        "${BLD_TC}" "${V5}" "${RST_TC}" "${FOG_TC}" "${RST_TC}"
    printf '\n'
}

########################################
# Root check
########################################

if [[ $EUID -ne 0 ]]; then
    print_error "Please run as root (sudo)"
    exit 1
fi

print_header

########################################
# Locate and source the canonical routine
########################################

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
UNINSTALL_LIB=""
for d in "$SELF_DIR/scripts/lib" "$INSTALL_DIR/scripts/lib"; do
    if [ -f "$d/uninstall.sh" ]; then
        UNINSTALL_LIB="$d/uninstall.sh"
        break
    fi
done
if [ -z "$UNINSTALL_LIB" ]; then
    print_error "Cannot find scripts/lib/uninstall.sh — is ServerKit installed at $INSTALL_DIR?"
    exit 1
fi

########################################
# Confirm
########################################

echo
if [ "$PURGE" = "1" ]; then
    print_warning "This will remove ServerKit AND delete all data (volumes, database, backups)."
else
    print_warning "This will remove ServerKit. User data (volumes, /var/lib, backups) is preserved."
    echo "  Use --purge to also delete data, or --keep-data to also keep /etc/serverkit."
fi
[ "$DRY_RUN" = "1" ] && print_warning "DRY RUN — nothing will actually be changed."
echo

if [ "$ASSUME_YES" != "1" ]; then
    read -r -p "Remove ServerKit$([ "$PURGE" = "1" ] && echo " and all data")? (y/N): " confirm
    if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
        print_warning "Uninstall cancelled"
        exit 0
    fi
fi

########################################
# Run the canonical teardown
########################################

# shellcheck source=scripts/lib/uninstall.sh
source "$UNINSTALL_LIB"

export SERVERKIT_DIR="$INSTALL_DIR"
export SERVERKIT_PURGE="$PURGE"
export SERVERKIT_KEEP_DATA="$KEEP_DATA"
export SERVERKIT_UNINSTALL_DRY_RUN="$DRY_RUN"

serverkit_uninstall_core

########################################
# Finish
########################################

echo
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ServerKit removed successfully${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo
echo "System packages (Docker, Node.js, nginx, Python) were NOT removed."
echo "Uninstall log: $LOG_FILE"
echo
