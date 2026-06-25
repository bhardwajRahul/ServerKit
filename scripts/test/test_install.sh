#!/usr/bin/env bash
#
# Unit tests for install.sh + scripts/lib/{firewall,state,uninstall}.sh —
# runs in seconds, no server, no install.
#
# install.sh is source-able: when sourced it defines every function and then
# returns *before* main() (the BASH_SOURCE guard). That lets us exercise the
# Python/Node detection, the firewall abstraction, the install-state tracker,
# and the canonical uninstall routine against throwaway fixtures and PATH stubs
# instead of a real distro and a real /etc.
#
# Each unit-under-test runs in a subshell that re-enables `set -Eeuo pipefail`,
# so an unguarded command silently aborting under set -e is caught here as a
# failed assertion rather than on someone's server.
#
# Run:  bash scripts/test/test_install.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_SH="$REPO_DIR/install.sh"
LIB_DIR="$REPO_DIR/scripts/lib"

PASS=0
FAIL=0
SKIP=0
ok()   { PASS=$((PASS + 1)); printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31m✘\033[0m %s\n' "$1"; }
skip() { SKIP=$((SKIP + 1)); printf '  \033[33m∼\033[0m %s (skipped)\n' "$1"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --------------------------------------------------------------------------
# PATH stubs.
#   STUB_BIN  — node/npm fakes, added on the global PATH only during T3.
#   PY_STUB   — fake python interpreters, applied ONLY inside T1's subshell so
#               the real python3 stays available for the state.sh test (T6).
# Each python stub echoes a fixed "major.minor" when called with `-c`.
# --------------------------------------------------------------------------
STUB_BIN="$WORK/bin"
PY_STUB="$WORK/pybin"
mkdir -p "$STUB_BIN" "$PY_STUB"
mkpy() {  # mkpy <name> <major.minor>
    {
        printf '#!/usr/bin/env bash\n'
        printf 'if [ "${1:-}" = "-c" ]; then printf "%s"; fi\n' "$2"
    } > "$PY_STUB/$1"
    chmod +x "$PY_STUB/$1"
}
# python3.12 reports an out-of-range 3.13 (rejected); python3.11 is in range;
# bare python3 is an old 3.10 (rejected). locate_python must therefore pick
# python3.11 — proving it no longer blindly trusts `python3`.
mkpy python3.12 3.13
mkpy python3.11 3.11
mkpy python3     3.10
export PATH="$STUB_BIN:$PATH"

# --------------------------------------------------------------------------
# Source install.sh (functions only). Point the install dir at the sandbox.
# --------------------------------------------------------------------------
export SERVERKIT_DIR="$WORK/opt/serverkit"
# shellcheck disable=SC1090
source "$INSTALL_SH"
set +e +u   # hand control back to the harness; tests re-arm set -e per subshell

printf '\ninstall.sh + lib unit tests\n\n'

# --------------------------------------------------------------------------
# T1 — locate_python prefers a supported minor version over a too-old python3.
# --------------------------------------------------------------------------
res="$( set -Eeuo pipefail; PATH="$PY_STUB:$PATH"; locate_python >/dev/null 2>&1; printf '%s' "$PYTHON_BIN" )"
if [ "$res" = "python3.11" ]; then
    ok "locate_python picks python3.11 when python3 is 3.10 and python3.12 is out of range"
else
    bad "locate_python chose [$res], expected python3.11"
fi

# --------------------------------------------------------------------------
# T2 — ver_in_range gate (3.11/3.12 accepted, 3.10/3.13 rejected).
# --------------------------------------------------------------------------
if ( set -Eeuo pipefail; ver_in_range 3.11 ) && ( set -Eeuo pipefail; ver_in_range 3.12 ) && \
   ! ( set -Eeuo pipefail; ver_in_range 3.10 ) && ! ( set -Eeuo pipefail; ver_in_range 3.13 ); then
    ok "ver_in_range accepts 3.11/3.12 and rejects 3.10/3.13"
else
    bad "ver_in_range gate is wrong"
fi

# --------------------------------------------------------------------------
# T3 — node_ready requires node>=18 AND npm present.
# --------------------------------------------------------------------------
printf '#!/usr/bin/env bash\necho v18.19.0\n' > "$STUB_BIN/node"; chmod +x "$STUB_BIN/node"
printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB_BIN/npm"; chmod +x "$STUB_BIN/npm"
if ( set -Eeuo pipefail; node_ready ); then
    ok "node_ready true for node v18 with npm present"
else
    bad "node_ready should be true for node v18 + npm"
fi
printf '#!/usr/bin/env bash\necho v16.20.0\n' > "$STUB_BIN/node"; chmod +x "$STUB_BIN/node"
if ( set -Eeuo pipefail; node_ready ); then
    bad "node_ready should be false for node v16"
else
    ok "node_ready false for node v16 (below the 18 floor)"
fi
rm -f "$STUB_BIN/node" "$STUB_BIN/npm"

# --------------------------------------------------------------------------
# T4 — configure_firewall dry-run prints the exact firewall commands and
# records nothing (FW_DRY_RUN suppresses state writes).
# --------------------------------------------------------------------------
state_file="$WORK/state-t4.json"
out="$(
    set -Eeuo pipefail
    export SERVERKIT_STATE_FILE="$state_file"
    FW_DRY_RUN=1 FIREWALL_BACKEND=firewalld configure_firewall 2>&1
)"
if printf '%s' "$out" | grep -q 'firewall-cmd --permanent --add-port=80/tcp' && \
   printf '%s' "$out" | grep -q 'firewall-cmd --permanent --add-port=443/tcp'; then
    ok "configure_firewall dry-run prints the expected firewalld commands"
else
    bad "configure_firewall dry-run did not print the expected commands"
fi
if [ ! -f "$state_file" ]; then
    ok "configure_firewall dry-run writes no install-state.json"
else
    bad "configure_firewall dry-run unexpectedly wrote state"
fi

# --------------------------------------------------------------------------
# T5 — firewall_detect honors the FIREWALL_BACKEND override.
# --------------------------------------------------------------------------
res="$( set -Eeuo pipefail; source "$LIB_DIR/firewall.sh"; FIREWALL_BACKEND=ufw firewall_detect )"
if [ "$res" = "ufw" ]; then
    ok "firewall_detect honors FIREWALL_BACKEND override"
else
    bad "firewall_detect ignored the override (got [$res])"
fi

# --------------------------------------------------------------------------
# T6 — state.sh roundtrip: set/get scalar, append dedup, list.
# --------------------------------------------------------------------------
if command -v python3 >/dev/null 2>&1; then
    res="$(
        set -Eeuo pipefail
        export SERVERKIT_STATE_FILE="$WORK/state-t6.json"
        source "$LIB_DIR/state.sh"
        state_set firewall_backend firewalld
        state_append firewall_ports 80/tcp
        state_append firewall_ports 443/tcp
        state_append firewall_ports 80/tcp     # duplicate — must be ignored
        # tr -d '\r' normalizes the CRLF that Python's text-mode stdout emits on
        # Windows; on Linux there is nothing to strip.
        printf '%s|%s' "$(state_get firewall_backend | tr -d '\r')" \
            "$(state_list firewall_ports | tr -d '\r' | tr '\n' ',')"
    )"
    if [ "$res" = "firewalld|80/tcp,443/tcp," ]; then
        ok "state.sh set/get/append(dedup)/list roundtrip"
    else
        bad "state.sh roundtrip wrong: got [$res]"
    fi
else
    skip "state.sh roundtrip — python3 unavailable here"
fi

# --------------------------------------------------------------------------
# T7 — the canonical uninstall routine: default preserves data, --purge
# removes it, --keep-data preserves the config dir. All in dry-run.
# --------------------------------------------------------------------------
inst="$WORK/opt/serverkit"
mkdir -p "$inst/scripts/lib"
cp "$LIB_DIR/firewall.sh" "$LIB_DIR/state.sh" "$inst/scripts/lib/"
touch "$inst/docker-compose.yml"

uninstall_out() {  # uninstall_out <extra-env>
    (
        set -Eeuo pipefail
        source "$LIB_DIR/uninstall.sh"
        export SERVERKIT_DIR="$inst" SERVERKIT_UNINSTALL_DRY_RUN=1
        eval "$1"
        serverkit_uninstall_core 2>&1
    )
}

def_out="$(uninstall_out '')"
if printf '%s' "$def_out" | grep -q 'down --remove-orphans' && \
   ! printf '%s' "$def_out" | grep -q 'down -v' && \
   ! printf '%s' "$def_out" | grep -q 'rm -rf /var/lib/serverkit'; then
    ok "uninstall default: compose down WITHOUT -v and keeps /var/lib/serverkit"
else
    bad "uninstall default behaved wrong (deleted data or used -v)"
fi

purge_out="$(uninstall_out 'export SERVERKIT_PURGE=1')"
if printf '%s' "$purge_out" | grep -q 'down -v' && \
   printf '%s' "$purge_out" | grep -q 'rm -rf /var/lib/serverkit'; then
    ok "uninstall --purge: compose down -v and removes data dirs"
else
    bad "uninstall --purge did not remove volumes/data"
fi

keep_out="$(uninstall_out 'export SERVERKIT_KEEP_DATA=1')"
if printf '%s' "$keep_out" | grep -q 'Preserving data' && \
   ! printf '%s' "$keep_out" | grep -q 'rm -rf /etc/serverkit'; then
    ok "uninstall --keep-data: preserves /etc/serverkit"
else
    bad "uninstall --keep-data removed the config dir"
fi

# --------------------------------------------------------------------------
# T8 — os_family_from: ID mapping + ID_LIKE fallback (incl. rhel-before-fedora).
# --------------------------------------------------------------------------
fam_ok=1
check_fam() { # check_fam <id> <id_like> <expected>
    local got; got="$(os_family_from "$1" "$2")"
    [ "$got" = "$3" ] || { bad "os_family_from('$1','$2') -> [$got], expected $3"; fam_ok=0; }
}
check_fam ubuntu "" debian
check_fam debian "" debian
check_fam rocky "" rhel
check_fam fedora "" fedora
check_fam opensuse-leap "" suse
check_fam arch "" arch
check_fam alpine "" alpine
check_fam mydistro "debian" debian              # unknown ID, debian-like
check_fam clone "rhel centos fedora" rhel        # RHEL clone: rhel wins over fedora
check_fam spin "fedora" fedora                    # pure fedora spin
check_fam suselike "suse opensuse" suse
check_fam wat "" unknown
[ "$fam_ok" = "1" ] && ok "os_family_from maps known IDs and falls back to ID_LIKE (rhel before fedora)"

# --------------------------------------------------------------------------
# T9 — render_service_unit honors a custom SERVERKIT_DIR (no @PLACEHOLDERS@).
# --------------------------------------------------------------------------
inst2="$WORK/custom/srv"
mkdir -p "$inst2/templates"
cp "$REPO_DIR/templates/serverkit-backend.service.in" "$inst2/templates/"
unit_out="$WORK/rendered.service"
(
    set -Eeuo pipefail
    INSTALL_DIR="$inst2"; VENV_DIR="$inst2/venv"; LOG_DIR="/var/log/serverkit"
    render_service_unit "$unit_out"
)
if grep -q "WorkingDirectory=$inst2/backend" "$unit_out" && \
   grep -q "$inst2/venv/bin/gunicorn" "$unit_out" && \
   ! grep -q '@SERVERKIT_DIR@\|@SERVERKIT_VENV_DIR@\|@PORT@' "$unit_out"; then
    ok "render_service_unit substitutes a custom SERVERKIT_DIR and leaves no placeholders"
else
    bad "render_service_unit left placeholders or used the wrong paths"
fi

# --------------------------------------------------------------------------
# T10 — harden_global_tls: conf.d snippet when safe, in-place edit otherwise.
# --------------------------------------------------------------------------
# (A) RHEL-style: no ssl_protocols, has conf.d include → reversible snippet.
ndA="$WORK/nginxA"; mkdir -p "$ndA/conf.d"
printf 'http {\n    include /etc/nginx/conf.d/*.conf;\n}\n' > "$ndA/nginx.conf"
( set -Eeuo pipefail; SERVERKIT_NGINX_DIR="$ndA" harden_global_tls )
if [ -f "$ndA/conf.d/serverkit-tls.conf" ] && \
   grep -q 'TLSv1.2 TLSv1.3' "$ndA/conf.d/serverkit-tls.conf" && \
   ! grep -q 'ssl_protocols' "$ndA/nginx.conf"; then
    ok "harden_global_tls drops a reversible conf.d snippet when nginx.conf has none"
else
    bad "harden_global_tls should have written a conf.d snippet (RHEL-style)"
fi

# (B) Debian-style: ssl_protocols already present → edit in place, NO snippet
# (a second declaration would be a 'duplicate ssl_protocols' error).
ndB="$WORK/nginxB"; mkdir -p "$ndB/conf.d"
printf 'http {\n    ssl_protocols TLSv1.1 TLSv1.2;\n    include /etc/nginx/conf.d/*.conf;\n}\n' > "$ndB/nginx.conf"
( set -Eeuo pipefail; SERVERKIT_NGINX_DIR="$ndB" harden_global_tls )
if [ ! -f "$ndB/conf.d/serverkit-tls.conf" ] && \
   grep -q 'ssl_protocols TLSv1.2 TLSv1.3;' "$ndB/nginx.conf"; then
    ok "harden_global_tls edits nginx.conf in place (no duplicate) when ssl_protocols exists"
else
    bad "harden_global_tls should have edited in place (Debian-style)"
fi

# --------------------------------------------------------------------------
printf '\n%d passed, %d failed, %d skipped\n\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ]
