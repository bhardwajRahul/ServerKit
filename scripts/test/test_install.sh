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
# A no-op docker stub so the uninstall routine's `command -v docker` succeeds and
# its compose-down branch runs deterministically — the CI containers don't have
# docker installed, and we're only asserting on dry-run output anyway.
printf '#!/usr/bin/env bash\nexit 0\n' > "$STUB_BIN/docker"; chmod +x "$STUB_BIN/docker"
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
# T11 — choose_pkg_manager halts cleanly when no package manager is present
# (empty PATH hides apt/dnf/yum/zypper/pacman/apk). No /etc writes happen
# because the apt branch is never reached.
# --------------------------------------------------------------------------
if ( set -Eeuo pipefail; PATH=""; choose_pkg_manager ) >/dev/null 2>&1; then
    bad "choose_pkg_manager should fail when no package manager exists"
else
    ok "choose_pkg_manager halts cleanly when no package manager is found"
fi

# --------------------------------------------------------------------------
# T12 — the canonical docker-compose.yml is frontend-only. The backend manages
# the host (creates /var/serverkit/apps/*, drives host Docker, reloads nginx),
# which a container cannot do — a backend container fails app creation with
# `Permission denied: /var/serverkit/apps/...` and has no host docker.sock.
# Guard against re-adding a `backend` compose service (the regression that
# broke WordPress/app creation).
# --------------------------------------------------------------------------
compose="$REPO_DIR/docker-compose.yml"
if grep -Eq '^[[:space:]]{2}backend:' "$compose"; then
    bad "docker-compose.yml defines a 'backend' service — the backend must run on the host, not in a container"
elif ! grep -Eq '^[[:space:]]{2}frontend:' "$compose"; then
    bad "docker-compose.yml is missing the 'frontend' service"
elif ! grep -q 'backend:host-gateway' "$compose"; then
    bad "docker-compose.yml frontend is missing the 'backend:host-gateway' alias to reach the host backend"
else
    ok "docker-compose.yml is frontend-only and routes /api to the host backend (backend:host-gateway)"
fi

# --------------------------------------------------------------------------
# T13 — I1: the default no-domain install must survive install_nginx_config_
# for_mode. `[ -n "$PANEL_DOMAIN" ] && printf ...` as the function's LAST
# statement returned 1 on an empty domain and set -e killed every curl-pipe
# install at the nginx phase (shipped broken since v1.6.25).
# --------------------------------------------------------------------------
t="$WORK/t13"; mkdir -p "$t/nginx/sites-available" "$t/nginx/sites-enabled" "$t/cfg"
printf 'server { listen 80; }\n' > "$t/nginx/sites-available/serverkit-insecure.conf"
printf 'ssl_certificate /etc/letsencrypt/live/YOUR_DOMAIN/fullchain.pem;\n' \
    > "$t/nginx/sites-available/serverkit.conf"
if ( set -Eeuo pipefail
     SERVERKIT_NGINX_DIR="$t/nginx" SERVERKIT_CONFIG_DIR="$t/cfg" \
     PANEL_DOMAIN="" SSL_MODE=insecure install_nginx_config_for_mode ) >/dev/null 2>&1; then
    if [ "$(cat "$t/cfg/ssl-mode")" = "insecure" ] && [ ! -f "$t/cfg/panel-domain" ]; then
        ok "install_nginx_config_for_mode survives an empty PANEL_DOMAIN (the v1.6.25 no-domain abort)"
    else
        bad "install_nginx_config_for_mode wrote the wrong mode/domain state for a no-domain install"
    fi
else
    bad "install_nginx_config_for_mode DIED with an empty PANEL_DOMAIN under set -e (I1 regression)"
fi
if ( set -Eeuo pipefail
     SERVERKIT_NGINX_DIR="$t/nginx" SERVERKIT_CONFIG_DIR="$t/cfg" \
     PANEL_DOMAIN="panel.example.com" SSL_MODE=secure install_nginx_config_for_mode ) >/dev/null 2>&1 \
   && grep -q 'live/panel.example.com/' "$t/nginx/sites-available/serverkit.conf" \
   && [ "$(cat "$t/cfg/panel-domain")" = "panel.example.com" ]; then
    ok "install_nginx_config_for_mode (secure) applies the cert path and persists the domain"
else
    bad "install_nginx_config_for_mode (secure) did not apply the cert path / persist the domain"
fi

# --------------------------------------------------------------------------
# T14 — I2: plain Enter at the interactive domain prompt must not abort.
# Same end-of-function `[ -n ] && ...` shape as I1. SERVERKIT_FORCE_PROMPT=1
# lets the test drive the prompt from a pipe instead of a tty.
# --------------------------------------------------------------------------
if printf '\n' | ( set -Eeuo pipefail
                   PANEL_DOMAIN="" SERVERKIT_FORCE_PROMPT=1 prompt_for_domain ) >/dev/null 2>&1; then
    ok "prompt_for_domain survives a blank answer (plain Enter, the no-domain default)"
else
    bad "prompt_for_domain DIED on a blank answer under set -e (I2 regression)"
fi
res="$(printf 'panel.example.com\n' | (
    set -Eeuo pipefail
    PANEL_DOMAIN=""; PANEL_PORT=""; SERVERKIT_FORCE_PROMPT=1
    prompt_for_domain >/dev/null 2>&1
    printf '%s|%s' "$PANEL_DOMAIN" "$PANEL_PORT"
))"
if [ "$res" = "panel.example.com|80" ]; then
    ok "prompt_for_domain accepts a typed domain and sets the port"
else
    bad "prompt_for_domain returned [$res], expected panel.example.com|80"
fi

# --------------------------------------------------------------------------
# T15 — I4 (detection half): should_default_to_release must see an EXISTING
# install. The old check probed backend/src (never exists — the tree is
# backend/app), so every re-run picked release mode and fetch_release
# rm -rf'd the live install, .env + SQLite DB included.
# --------------------------------------------------------------------------
t="$WORK/t15"
mkdir -p "$t/fresh" "$t/existing/backend/app" "$t/envonly"
printf 'SECRET_KEY=x\n' > "$t/envonly/.env"
det_ok=1
( set -Eeuo pipefail; INSTALL_DIR="$t/fresh"; BUILD_FROM_SOURCE=0; SERVERKIT_VERSION=""
  should_default_to_release ) || { bad "fresh box should default to a release install"; det_ok=0; }
( set -Eeuo pipefail; INSTALL_DIR="$t/existing"; BUILD_FROM_SOURCE=0; SERVERKIT_VERSION=""
  should_default_to_release ) && { bad "existing backend/app tree must NOT default to release (data loss)"; det_ok=0; }
( set -Eeuo pipefail; INSTALL_DIR="$t/envonly"; BUILD_FROM_SOURCE=0; SERVERKIT_VERSION=""
  should_default_to_release ) && { bad "existing .env must NOT default to release (data loss)"; det_ok=0; }
( set -Eeuo pipefail; INSTALL_DIR="$t/fresh"; BUILD_FROM_SOURCE=1; SERVERKIT_VERSION=""
  should_default_to_release ) && { bad "BUILD_FROM_SOURCE=1 must force the source path"; det_ok=0; }
[ "$det_ok" = "1" ] && ok "should_default_to_release detects an existing install (backend/app or .env)"

# --------------------------------------------------------------------------
# T16 — I4 (preservation half): live state survives a slot rewrite
# byte-identical. First the helpers in isolation, then the real fetch_release
# offline-tarball path over a symlinked blue/green layout (Linux CI; skipped
# where symlinks are unsupported, same convention as test_update.sh T4).
# --------------------------------------------------------------------------
t="$WORK/t16"; mkdir -p "$t/slot/backend/instance"
printf 'SECRET_KEY=sentinel-abc123\nSERVERKIT_ENCRYPTION_KEY=k\n' > "$t/slot/.env"
printf 'SQLITE-SENTINEL-BYTES\n' > "$t/slot/backend/instance/serverkit.db"
cp "$t/slot/.env" "$t/env.orig"
cp "$t/slot/backend/instance/serverkit.db" "$t/db.orig"
if (
    set -Eeuo pipefail
    stash="$(stash_live_state "$t/slot")"
    [ -n "$stash" ]
    rm -rf "$t/slot"                 # the rewrite
    mkdir -p "$t/slot/backend"       # fresh tree: no .env, no instance/
    restore_live_state "$stash" "$t/slot"
    cmp -s "$t/slot/.env" "$t/env.orig"
    cmp -s "$t/slot/backend/instance/serverkit.db" "$t/db.orig"
) >/dev/null 2>&1; then
    ok "stash/restore_live_state carries .env + instance DB byte-identical across a rewrite"
else
    bad "stash/restore_live_state lost or altered the live state"
fi

t="$WORK/t16r"; slotA="$t/sk-a"; slotB="$t/sk-b"; inst="$t/sk"
mkdir -p "$slotA/backend/instance"
printf 'SECRET_KEY=keep-me\n' > "$slotA/.env"
printf 'DB-SENTINEL\n' > "$slotA/backend/instance/serverkit.db"
cp "$slotA/.env" "$t/env.orig"; cp "$slotA/backend/instance/serverkit.db" "$t/db.orig"
ln -sfn "$slotA" "$inst" 2>/dev/null || true
if [ ! -L "$inst" ]; then
    skip "fetch_release live-state carry — symlinks unsupported here (runs on Linux CI)"
else
    stage="$t/stage"; mkdir -p "$stage/serverkit/backend/app" "$stage/serverkit/scripts"
    printf '#!/bin/sh\n' > "$stage/serverkit/serverkit"
    printf '9.9.9\n' > "$stage/serverkit/VERSION"
    tar czf "$t/rel.tar.gz" -C "$stage" serverkit
    if (
        set -Eeuo pipefail
        INSTALL_DIR="$inst"; DIR_A="$slotA"; DIR_B="$slotB"; FIRST_SLOT="$slotA"
        SERVERKIT_OFFLINE_TARBALL="$t/rel.tar.gz"
        fetch_release
        cmp -s "$slotA/.env" "$t/env.orig"
        cmp -s "$slotA/backend/instance/serverkit.db" "$t/db.orig"
        [ -d "$slotA/backend/app" ]
    ) >/dev/null 2>&1; then
        ok "fetch_release re-run preserves .env + database byte-identical (the data-loss bug)"
    else
        bad "fetch_release re-run destroyed or altered .env / the database (I4 regression)"
    fi
fi

# --------------------------------------------------------------------------
# T17 — I20: snapshot_existing must refresh a stale .backup instead of
# silently keeping a months-old tree (which revert_install would then
# restore over a much newer install).
# --------------------------------------------------------------------------
t="$WORK/t17"; mkdir -p "$t/inst"
printf 'v1\n' > "$t/inst/marker"
( set -Eeuo pipefail; INSTALL_DIR="$t/inst"; snapshot_existing ) >/dev/null 2>&1
if [ -f "$t/inst.backup/marker" ] && grep -q v1 "$t/inst.backup/marker"; then
    ok "snapshot_existing creates the first backup"
else
    bad "snapshot_existing did not create a backup"
fi
printf 'v2\n' > "$t/inst/marker"
( set -Eeuo pipefail; INSTALL_DIR="$t/inst"; snapshot_existing ) >/dev/null 2>&1
if grep -q v2 "$t/inst.backup/marker" 2>/dev/null && [ ! -d "$t/inst.backup.new" ]; then
    ok "snapshot_existing refreshes a stale .backup on re-run (no months-old rollback source)"
else
    bad "snapshot_existing kept the stale backup (I20 regression) or left .backup.new behind"
fi

# --------------------------------------------------------------------------
# T18 — I3: the release-venv install must not delete its own copy source. In
# the default layout $VENV_DIR resolves to $FIRST_SLOT/venv, so the old
# rm -rf + cp deleted the venv then failed to copy it. Same-path → keep in
# place; distinct path → still copies.
# --------------------------------------------------------------------------
t="$WORK/t18"; mkdir -p "$t/slot/venv/bin" "$t/elsewhere"
: > "$t/slot/venv/bin/activate"
printf '#!/bin/sh\n' > "$t/slot/venv/bin/python"; chmod +x "$t/slot/venv/bin/python"
if (
    set -Eeuo pipefail
    INSTALL_FROM_RELEASE=1; FIRST_SLOT="$t/slot"; VENV_DIR="$t/slot/venv"
    build_virtualenv
    [ -f "$t/slot/venv/bin/activate" ]
) >/dev/null 2>&1; then
    ok "build_virtualenv keeps the venv when source and destination are the same directory"
else
    bad "build_virtualenv deleted its own venv on the same-path layout (I3 regression)"
fi
if (
    set -Eeuo pipefail
    INSTALL_FROM_RELEASE=1; FIRST_SLOT="$t/slot"; VENV_DIR="$t/elsewhere/venv"
    build_virtualenv
    [ -f "$t/elsewhere/venv/bin/activate" ] && [ -f "$t/slot/venv/bin/activate" ]
) >/dev/null 2>&1; then
    ok "build_virtualenv still copies the release venv to a distinct VENV_DIR"
else
    bad "build_virtualenv failed to copy the release venv to a custom VENV_DIR"
fi
ln -sfn "$t/slot" "$t/link" 2>/dev/null || true
if [ ! -L "$t/link" ]; then
    skip "build_virtualenv symlinked default layout — symlinks unsupported here (runs on Linux CI)"
else
    if (
        set -Eeuo pipefail
        INSTALL_FROM_RELEASE=1; FIRST_SLOT="$t/slot"; VENV_DIR="$t/link/venv"
        build_virtualenv
        [ -x "$t/slot/venv/bin/python" ]
    ) >/dev/null 2>&1; then
        ok "build_virtualenv survives the default symlinked layout (/opt/serverkit → slot)"
    else
        bad "build_virtualenv broke on the symlinked layout (I3 regression)"
    fi
fi

# --------------------------------------------------------------------------
# T19 — I6/I12: pkg_add promises warn-and-continue, so a failing package
# manager must produce a warning and exit 0 — the old body died on the
# out=$(...) assignment under set -e, printing NOTHING. refresh_pkg_index is
# best-effort too, and its yum arm must not use the dnf-only --refresh flag.
# --------------------------------------------------------------------------
t="$WORK/t19"; mkdir -p "$t/bin"
printf '#!/usr/bin/env bash\necho "E: Unable to locate package"\nexit 100\n' > "$t/bin/apt-get"
chmod +x "$t/bin/apt-get"
out="$( set -Eeuo pipefail; PATH="$t/bin:$PATH"; PKG_MGR=apt pkg_add nosuchpkg 2>&1 )"
rc=$?
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'Could not install: nosuchpkg'; then
    ok "pkg_add warns and returns 0 when the package manager fails (errexit-immune body)"
else
    bad "pkg_add rc=$rc (expected 0) or printed no warning: [$out]"
fi
if ( set -Eeuo pipefail; PATH="$t/bin:$PATH"; PKG_MGR=apt refresh_pkg_index ) >/dev/null 2>&1; then
    ok "refresh_pkg_index is best-effort (a failed index refresh never aborts)"
else
    bad "refresh_pkg_index propagated a failure under set -e (I6 regression)"
fi
if ! grep -qE '^[^#]*yum makecache --refresh' "$INSTALL_SH"; then
    ok "refresh_pkg_index yum arm avoids the dnf-only --refresh flag (I12)"
else
    bad "the yum arm uses 'makecache --refresh' again — that flag is dnf-only (I12 regression)"
fi

# --------------------------------------------------------------------------
# T20 — I5: the RHEL-9 upfront openssh+openssl paired upgrade (drops sshd
# 'OpenSSL version mismatch' on Rocky 9) must run the exact paired
# transaction, survive a failing dnf, and no-op on other families.
# --------------------------------------------------------------------------
t="$WORK/t20"; mkdir -p "$t/bin"
DNF_LOG="$t/dnf.log"; : > "$DNF_LOG"
cat > "$t/bin/dnf" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$DNF_LOG"
exit 1
EOF
chmod +x "$t/bin/dnf"
if ( set -Eeuo pipefail; PATH="$t/bin:$PATH"; OS_FAMILY=rhel upgrade_rhel_crypto_stack ) >/dev/null 2>&1 \
   && grep -q 'upgrade -y openssh openssh-server openssh-clients openssl openssl-libs openssl-devel' "$DNF_LOG"; then
    ok "upgrade_rhel_crypto_stack upgrades openssh+openssl in ONE transaction and survives a failing dnf"
else
    bad "upgrade_rhel_crypto_stack missing/wrong dnf transaction or aborted (I5 regression)"
fi
: > "$DNF_LOG"
( set -Eeuo pipefail; PATH="$t/bin:$PATH"; OS_FAMILY=debian upgrade_rhel_crypto_stack ) >/dev/null 2>&1
if [ ! -s "$DNF_LOG" ]; then
    ok "upgrade_rhel_crypto_stack is a no-op outside the RHEL family"
else
    bad "upgrade_rhel_crypto_stack ran dnf on a non-RHEL family"
fi

# --------------------------------------------------------------------------
# T21 — I7: sync_source needs git but nothing installed it. Without git and
# with the on-demand install failing, sync_source must halt LOUDLY (clear
# message) before ever attempting the clone. Curated PATH: a failing apt-get
# plus a real tail; no git anywhere.
# --------------------------------------------------------------------------
t="$WORK/t21"; mkdir -p "$t/bin"
printf '#!/usr/bin/env bash\nexit 1\n' > "$t/bin/apt-get"; chmod +x "$t/bin/apt-get"
printf '#!/usr/bin/env bash\nexec %s "$@"\n' "$(command -v tail)" > "$t/bin/tail"; chmod +x "$t/bin/tail"
out="$( set -Eeuo pipefail; PATH="$t/bin"; PKG_MGR=apt sync_source 2>&1 )"
rc=$?
if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'git is required'; then
    ok "sync_source installs git on demand and halts clearly when that fails (never a cryptic clone error)"
else
    bad "sync_source rc=$rc without the 'git is required' halt: [$out]"
fi

# --------------------------------------------------------------------------
# T22 — I8: locate_python must reject an interpreter whose venv module is
# broken (Debian/Ubuntu minimal without pythonX.Y-venv → 'ensurepip is not
# available' much later), and on Debian-family it must first try to install
# the matching pythonX.Y-venv package.
# --------------------------------------------------------------------------
t="$WORK/t22"; PYX="$t/py"; mkdir -p "$PYX" "$t/bin"
mkvless() {  # mkvless <name> <major.minor> — version OK, `-m venv` broken
    {
        printf '#!/usr/bin/env bash\n'
        printf 'if [ "${1:-}" = "-c" ]; then printf "%s"; exit 0; fi\n' "$2"
        printf 'if [ "${1:-}" = "-m" ]; then exit 1; fi\n'
        printf 'exit 0\n'
    } > "$PYX/$1"
    chmod +x "$PYX/$1"
}
mkvless python3.12 3.13     # out of range — rejected before the venv probe
mkvless python3.11 3.11     # in range but venv-less — must be rejected
mkvless python3     3.10    # too old
if ( set -Eeuo pipefail; PATH="$PYX:$PATH"; locate_python ) >/dev/null 2>&1; then
    bad "locate_python accepted a venv-less interpreter (I8 regression)"
else
    ok "locate_python rejects an interpreter whose '-m venv' is broken"
fi
APT_LOG="$t/apt.log"; : > "$APT_LOG"
cat > "$t/bin/apt-get" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$APT_LOG"
exit 1
EOF
chmod +x "$t/bin/apt-get"
( set -Eeuo pipefail; PATH="$t/bin:$PYX:$PATH"; OS_FAMILY=debian PKG_MGR=apt locate_python ) >/dev/null 2>&1
if grep -q 'install -y python3.11-venv' "$APT_LOG"; then
    ok "locate_python (Debian family) tries to install the matching pythonX.Y-venv package"
else
    bad "locate_python never attempted the python3.11-venv fallback; apt saw: $(tr '\n' ';' < "$APT_LOG")"
fi

# --------------------------------------------------------------------------
# T23 — I9: distro-repo Docker (docker.io) has no Docker-repo
# 'docker-compose-plugin'; ensure_compose_plugin must fall back to Ubuntu's
# 'docker-compose-v2' and, when neither lands, warn and continue instead of
# aborting the install.
# --------------------------------------------------------------------------
t="$WORK/t23"; mkdir -p "$t/bin"
APT_LOG="$t/apt.log"; : > "$APT_LOG"
printf '#!/usr/bin/env bash\nexit 1\n' > "$t/bin/docker"; chmod +x "$t/bin/docker"
cat > "$t/bin/apt-get" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$APT_LOG"
exit 100
EOF
chmod +x "$t/bin/apt-get"
out="$( set -Eeuo pipefail; PATH="$t/bin:$PATH"; PKG_MGR=apt ensure_compose_plugin 2>&1 )"
rc=$?
if [ "$rc" -eq 0 ] && grep -q 'install -y docker-compose-plugin' "$APT_LOG" \
   && grep -q 'install -y docker-compose-v2' "$APT_LOG" \
   && printf '%s' "$out" | grep -q 'docker compose'; then
    ok "ensure_compose_plugin tries plugin → docker-compose-v2 → warn-and-continue (never aborts)"
else
    bad "ensure_compose_plugin rc=$rc; apt saw: $(tr '\n' ';' < "$APT_LOG")"
fi

# --------------------------------------------------------------------------
# T24 — I10: dnf5 (Fedora 41+) removed `config-manager --add-repo URL`;
# docker_repo_add must fall back to the dnf5 `addrepo --from-repofile=` form,
# and stay warn-and-continue when both forms fail.
# --------------------------------------------------------------------------
t="$WORK/t24"; mkdir -p "$t/bin"
DNF_LOG="$t/dnf.log"; : > "$DNF_LOG"
cat > "$t/bin/dnf" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$DNF_LOG"
case "\$*" in
    "config-manager --add-repo "*) exit 1 ;;   # dnf5: flag removed
    "config-manager addrepo "*)    exit 0 ;;
esac
exit 0
EOF
chmod +x "$t/bin/dnf"
if ( set -Eeuo pipefail; PATH="$t/bin:$PATH"
     docker_repo_add https://example.invalid/docker-ce.repo ) >/dev/null 2>&1 \
   && grep -q 'config-manager addrepo --from-repofile=https://example.invalid/docker-ce.repo' "$DNF_LOG"; then
    ok "docker_repo_add falls back to the dnf5 addrepo syntax when --add-repo fails"
else
    bad "docker_repo_add never tried the dnf5 syntax; dnf saw: $(tr '\n' ';' < "$DNF_LOG")"
fi
printf '#!/usr/bin/env bash\nexit 1\n' > "$t/bin/dnf"; chmod +x "$t/bin/dnf"
if ( set -Eeuo pipefail; PATH="$t/bin:$PATH"
     docker_repo_add https://example.invalid/docker-ce.repo ) >/dev/null 2>&1; then
    ok "docker_repo_add warns and continues when both config-manager forms fail"
else
    bad "docker_repo_add aborted when both config-manager forms failed (must warn-and-continue)"
fi

# --------------------------------------------------------------------------
# T25 — I21: a failing state_set/state_append (e.g. unwritable
# install-state.json) must not abort the firewall phase whose actual firewall
# work already succeeded. The state file is pointed under a regular FILE so
# state.sh's python genuinely fails; ufw is stubbed so firewall_open runs.
# --------------------------------------------------------------------------
if command -v python3 >/dev/null 2>&1; then
    t="$WORK/t25"; mkdir -p "$t/bin"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$t/bin/ufw"; chmod +x "$t/bin/ufw"
    : > "$t/blocker"                       # regular file — state.json can't live under it
    out="$(
        set -Eeuo pipefail
        export PATH="$t/bin:$PATH"
        export SERVERKIT_STATE_FILE="$t/blocker/state.json"
        FIREWALL_BACKEND=ufw configure_firewall 2>&1
    )"
    rc=$?
    if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q 'Firewall configured'; then
        ok "configure_firewall survives failing state_set/state_append (records are best-effort)"
    else
        bad "configure_firewall rc=$rc when state writes fail (I21 regression): [$out]"
    fi
else
    skip "configure_firewall state-failure guard — python3 unavailable here"
fi

# --------------------------------------------------------------------------
# T26 — regression guards baked into the source (same spirit as
# test_update.sh T26): the audited failure shapes must never creep back in.
# --------------------------------------------------------------------------
guards_ok=1
if grep -qE '^[^#]*backend/src' "$INSTALL_SH"; then
    bad "install.sh probes backend/src again — that path never exists (I4 detection regression)"
    guards_ok=0
fi
if ! grep -qE '^[[:space:]]*upgrade_rhel_crypto_stack$' "$INSTALL_SH"; then
    bad "main() no longer calls upgrade_rhel_crypto_stack (I5 regression)"
    guards_ok=0
fi
[ "$guards_ok" = "1" ] && ok "source guards: no backend/src probe; main runs the RHEL crypto upgrade"

# --------------------------------------------------------------------------
printf '\n%d passed, %d failed, %d skipped\n\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ]
