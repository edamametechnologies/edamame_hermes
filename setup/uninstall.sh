#!/usr/bin/env bash
set -euo pipefail

SLUG="hermes-edamame"
MCP_KEY="edamame"

OS_KERNEL="$(uname -s)"
case "$OS_KERNEL" in
  Darwin)
    CONFIG_HOME="$HOME/Library/Application Support/$SLUG"
    STATE_HOME="$CONFIG_HOME/state"
    DATA_HOME="$HOME/Library/Application Support/$SLUG"
    ;;
  *)
    CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/$SLUG"
    STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}/$SLUG"
    DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/$SLUG"
    ;;
esac

remove_hermes_mcp_entry() {
  local config_path="${HERMES_HOME:-$HOME/.hermes}/config.yaml"
  [[ -f "$config_path" ]] || return 0
  python3 - "$config_path" <<'PYHERMES'
import shutil
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
raw = config_path.read_text(encoding="utf-8")
if "edamame" not in raw:
    sys.exit(0)


def _backup():
    shutil.copy2(config_path, Path(str(config_path) + ".bak"))


# Strategy 1: structural removal via PyYAML.
try:
    import yaml  # type: ignore

    data = yaml.safe_load(raw) if raw.strip() else None
    if not isinstance(data, dict):
        sys.exit(0)
    servers = data.get("mcp_servers")
    if not isinstance(servers, dict) or "edamame" not in servers:
        sys.exit(0)
    servers.pop("edamame", None)
    if servers:
        data["mcp_servers"] = servers
    else:
        data.pop("mcp_servers", None)
    _backup()
    config_path.write_text(
        yaml.safe_dump(data, default_flow_style=False, sort_keys=False),
        encoding="utf-8",
    )
    sys.exit(0)
except ImportError:
    pass
except SystemExit:
    raise
except Exception as exc:
    print(f"WARNING: PyYAML removal failed ({exc}); falling back to text splice")

# Strategy 2: no-dependency line-based splice.
lines = raw.splitlines()
n = len(lines)

ms_idx = None
for i, line in enumerate(lines):
    if line.lstrip() != line:
        continue
    stripped = line.strip()
    if stripped.split(":", 1)[0].strip() == "mcp_servers" and (
        stripped == "mcp_servers:" or stripped.startswith("mcp_servers:")
    ):
        ms_idx = i
        break

if ms_idx is None:
    sys.exit(0)

block_start = ms_idx + 1
block_end = block_start
k = block_start
while k < n:
    ln = lines[k]
    if ln.strip() != "" and (len(ln) - len(ln.lstrip())) == 0:
        break
    block_end = k + 1
    k += 1

# Determine child indent from first non-blank child line.
ci = 2
for ln in lines[block_start:block_end]:
    if ln.strip() == "":
        continue
    ci = len(ln) - len(ln.lstrip())
    break

inner = lines[block_start:block_end]
cleaned = []
skipping = False
found = False
for ln in inner:
    indent = len(ln) - len(ln.lstrip())
    stripped = ln.strip()
    if not skipping:
        if indent == ci and stripped.startswith("edamame:"):
            skipping = True
            found = True
            continue
        cleaned.append(ln)
    else:
        if stripped == "" or indent > ci:
            continue
        skipping = False
        cleaned.append(ln)

if not found:
    sys.exit(0)

_backup()

# If no child entries remain, drop the now-empty mcp_servers: header too.
if any(ln.strip() != "" for ln in cleaned):
    new_lines = lines[:block_start] + cleaned + lines[block_end:]
else:
    new_lines = lines[:ms_idx] + lines[block_end:]

config_path.write_text("\n".join(new_lines).rstrip() + "\n", encoding="utf-8")
PYHERMES
}

remove_hermes_mcp_entry

rm -rf "$DATA_HOME"
if [[ "$CONFIG_HOME" != "$DATA_HOME" ]]; then
  rm -rf "$CONFIG_HOME"
fi
if [[ "$STATE_HOME" != "$DATA_HOME" && "$STATE_HOME" != "$CONFIG_HOME" ]]; then
  rm -rf "$STATE_HOME"
fi

echo "Uninstalled EDAMAME for Hermes from:"
echo "  $DATA_HOME"
