#!/usr/bin/env bash
#
# Unit tests for the multi-distro abstraction libs:
#   scripts/lib/pkg.sh   — package-manager abstraction
#   scripts/lib/init.sh  — init-system / service control
#   scripts/lib/env.sh   — container / WSL / systemd detection
#
# All three are pure, override-friendly, and dry-run aware, so they test
# deterministically on any host (including this Windows/Git-Bash dev box)
# without touching a real package manager, init system, or /proc.
#
# Run:  bash scripts/test/test_lib.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "$SCRIPT_DIR/../lib" && pwd)"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  \033[31m✘\033[0m %s\n' "$1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# shellcheck source=/dev/null
source "$LIB_DIR/pkg.sh"
# shellcheck source=/dev/null
source "$LIB_DIR/init.sh"
# shellcheck source=/dev/null
source "$LIB_DIR/env.sh"

printf '\nmulti-distro lib unit tests\n\n'

# ==========================================================================
# pkg.sh
# ==========================================================================
for mgr in apt dnf yum zypper pacman apk; do
    got="$( set -Eeuo pipefail; PKG_MGR_OVERRIDE="$mgr" pkg_detect )"
    [ "$got" = "$mgr" ] || bad "pkg_detect override $mgr -> [$got]"
done
ok "pkg_detect honors PKG_MGR_OVERRIDE for all six managers"

# Each manager's install command, captured in dry-run.
declare -A expect_install=(
    [apt]="apt-get install -y git"
    [dnf]="dnf install -y git"
    [yum]="yum install -y git"
    [zypper]="zypper --non-interactive install git"
    [pacman]="pacman -S --noconfirm git"
    [apk]="apk add git"
)
allok=1
for mgr in "${!expect_install[@]}"; do
    out="$( set -Eeuo pipefail; PKG_DRY_RUN=1 PKG_MGR_OVERRIDE="$mgr" pkg_install git 2>&1 )"
    printf '%s' "$out" | grep -qF "${expect_install[$mgr]}" || { bad "pkg_install $mgr dry-run: [$out]"; allok=0; }
done
[ "$allok" = "1" ] && ok "pkg_install emits the right command per manager (dry-run)"

if ( set -Eeuo pipefail; PKG_MGR_OVERRIDE="" PKG_DRY_RUN=0 pkg_install git ) 2>/dev/null; then
    bad "pkg_install must fail (return 1) when no manager is detected"
else
    ok "pkg_install returns non-zero when no package manager is present"
fi

# ==========================================================================
# init.sh
# ==========================================================================
for init in systemd openrc runit sysvinit none; do
    got="$( set -Eeuo pipefail; INIT_OVERRIDE="$init" init_detect )"
    [ "$got" = "$init" ] || bad "init_detect override $init -> [$got]"
done
ok "init_detect honors INIT_OVERRIDE for all five init systems"

# Start command per init, captured in dry-run (substring match — sudo prefix
# varies with euid and is irrelevant to the assertion).
allok=1
check_start() { # <init> <expected-substring>
    local out
    out="$( set -Eeuo pipefail; INIT_OVERRIDE="$1" INIT_DRY_RUN=1 init_start serverkit 2>&1 )"
    printf '%s' "$out" | grep -qF "$2" || { bad "init_start $1 dry-run: [$out]"; allok=0; }
}
check_start systemd  "systemctl start serverkit"
check_start openrc   "rc-service serverkit start"
check_start runit    "sv up serverkit"
check_start sysvinit "service serverkit start"
[ "$allok" = "1" ] && ok "init_start emits the right command per init system (dry-run)"

if ( set -Eeuo pipefail; INIT_OVERRIDE=none init_start serverkit ) >/dev/null 2>&1; then
    bad "init_start must return non-zero under 'none'"
else
    ok "init_start returns non-zero (and warns) when no init system is detected"
fi

# init_reload: no service arg under systemd → daemon-reload.
out="$( set -Eeuo pipefail; INIT_OVERRIDE=systemd INIT_DRY_RUN=1 init_reload 2>&1 )"
if printf '%s' "$out" | grep -qF "systemctl daemon-reload"; then
    ok "init_reload (no arg, systemd) runs daemon-reload"
else
    bad "init_reload systemd no-arg: [$out]"
fi

# ==========================================================================
# env.sh
# ==========================================================================
cg="$WORK/cgroup"; printf '0::/system.slice/docker-abc.scope\n' > "$cg"
if ( set -Eeuo pipefail; SERVERKIT_CGROUP_FILE="$cg" is_container ); then
    ok "is_container true via a docker cgroup fixture"
else
    bad "is_container should be true for a docker cgroup"
fi
cg2="$WORK/cgroup-host"; printf '0::/init.scope\n' > "$cg2"
if ( set -Eeuo pipefail; SERVERKIT_IS_CONTAINER="" SERVERKIT_CONTAINERENV_FILE="$WORK/none" SERVERKIT_DOCKERENV_FILE="$WORK/none" SERVERKIT_CGROUP_FILE="$cg2" is_container ); then
    bad "is_container should be false on a plain host cgroup"
else
    ok "is_container false on a non-container cgroup"
fi
if ( set -Eeuo pipefail; SERVERKIT_IS_CONTAINER=1 is_container ) && \
   ! ( set -Eeuo pipefail; SERVERKIT_IS_CONTAINER=0 is_container ); then
    ok "is_container honors the SERVERKIT_IS_CONTAINER force-override"
else
    bad "is_container force-override broken"
fi

osr="$WORK/osrelease"; printf '5.15.0-microsoft-standard-WSL2\n' > "$osr"
if ( set -Eeuo pipefail; SERVERKIT_OSRELEASE_FILE="$osr" is_wsl ); then
    ok "is_wsl true for a microsoft/WSL osrelease fixture"
else
    bad "is_wsl should detect WSL"
fi
osr2="$WORK/osrelease-bare"; printf '6.1.0-generic\n' > "$osr2"
if ( set -Eeuo pipefail; SERVERKIT_IS_WSL="" SERVERKIT_OSRELEASE_FILE="$osr2" is_wsl ); then
    bad "is_wsl should be false for a non-WSL kernel"
else
    ok "is_wsl false for a non-WSL kernel"
fi

if ( set -Eeuo pipefail; SERVERKIT_HAS_SYSTEMD=1 has_systemd ) && \
   ! ( set -Eeuo pipefail; SERVERKIT_HAS_SYSTEMD=0 has_systemd ); then
    ok "has_systemd honors the SERVERKIT_HAS_SYSTEMD force-override"
else
    bad "has_systemd force-override broken"
fi

# --------------------------------------------------------------------------
printf '\n%d passed, %d failed\n\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
