# shellcheck shell=bash
#
# scripts/lib/state.sh — tiny install-state tracker.
#
# ServerKit makes a handful of global, host-wide changes during install
# (firewall ports, an apt lock-wait drop-in, an nginx TLS snippet). For uninstall
# to be reliable and for re-runs to be idempotent, we record exactly what we
# touched in /etc/serverkit/install-state.json and undo only those things on the
# way out — never a rule or file the operator added themselves (Goal G8).
#
# Backed by python3, which is a hard ServerKit dependency (the whole backend is
# Python), so it is present on any installed box. If python3 is somehow missing
# the helpers degrade to warn-and-no-op rather than aborting the caller.
#
# API:
#   state_set    <key> <value>     set a scalar
#   state_get    <key>             print a scalar ("" if absent)
#   state_append <key> <value>     append to an array (deduped)
#   state_list   <key>             print array items, one per line
#   state_unset  <key>             remove a key entirely
#
# Override the file location with SERVERKIT_STATE_FILE (used by tests).

SERVERKIT_STATE_FILE="${SERVERKIT_STATE_FILE:-/etc/serverkit/install-state.json}"

_state_have_py() { command -v python3 >/dev/null 2>&1; }

_state_py() {
    # Args: <action> <key> [value]
    SERVERKIT_STATE_FILE="$SERVERKIT_STATE_FILE" python3 - "$@" <<'PY'
import json, os, sys

path = os.environ["SERVERKIT_STATE_FILE"]
action = sys.argv[1] if len(sys.argv) > 1 else ""
key = sys.argv[2] if len(sys.argv) > 2 else ""
value = sys.argv[3] if len(sys.argv) > 3 else ""

try:
    with open(path) as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        data = {}
except (FileNotFoundError, ValueError):
    data = {}

def save():
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)

if action == "set":
    data[key] = value
    save()
elif action == "get":
    v = data.get(key, "")
    if v is not None:
        sys.stdout.write(str(v))
elif action == "append":
    arr = data.get(key)
    if not isinstance(arr, list):
        arr = []
    if value not in arr:
        arr.append(value)
    data[key] = arr
    save()
elif action == "list":
    arr = data.get(key)
    if isinstance(arr, list):
        for item in arr:
            sys.stdout.write(str(item) + "\n")
elif action == "unset":
    data.pop(key, None)
    save()
else:
    sys.exit(2)
PY
}

state_set() {
    _state_have_py || { printf '  [state] python3 unavailable — not recording %s\n' "$1" >&2; return 0; }
    _state_py set "$1" "$2"
}

state_get() {
    _state_have_py || return 0
    _state_py get "$1"
}

state_append() {
    _state_have_py || { printf '  [state] python3 unavailable — not recording %s\n' "$1" >&2; return 0; }
    _state_py append "$1" "$2"
}

state_list() {
    _state_have_py || return 0
    _state_py list "$1"
}

state_unset() {
    _state_have_py || return 0
    _state_py unset "$1"
}
