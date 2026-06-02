#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: bash setup/install.sh [workspace_root]

Installs EDAMAME for Hermes (global per-user install).
Behavioral-model refresh is driven by Hermes's stdio MCP lifecycle --
the bridge refreshes on initialization and tool calls.
EOF
}

WORKSPACE_ROOT=""

while (($# > 0)); do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      if [[ -n "$WORKSPACE_ROOT" ]]; then
        echo "Unexpected extra argument: $1" >&2
        usage >&2
        exit 1
      fi
      WORKSPACE_ROOT="$1"
      ;;
  esac
  shift
done

SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-$PWD}"

OS_KERNEL="$(uname -s)"
case "$OS_KERNEL" in
  Darwin)
    CONFIG_HOME="$HOME/Library/Application Support/hermes-edamame"
    STATE_HOME="$CONFIG_HOME/state"
    DATA_HOME="$HOME/Library/Application Support/hermes-edamame"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    CONFIG_HOME="${APPDATA:-$HOME/AppData/Roaming}/hermes-edamame"
    STATE_HOME="${LOCALAPPDATA:-$HOME/AppData/Local}/hermes-edamame/state"
    DATA_HOME="${LOCALAPPDATA:-$HOME/AppData/Local}/hermes-edamame"
    ;;
  *)
    CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/hermes-edamame"
    STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}/hermes-edamame"
    DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/hermes-edamame"
    ;;
esac

INSTALL_ROOT="$DATA_HOME/current"
CONFIG_PATH="$CONFIG_HOME/config.json"
HERMES_MCP_PATH="$CONFIG_HOME/hermes-mcp.json"
NODE_BIN="$(command -v node)"

mkdir -p "$CONFIG_HOME" "$STATE_HOME" "$DATA_HOME"
rm -rf "$INSTALL_ROOT"
mkdir -p "$INSTALL_ROOT"

cp -R "$SOURCE_ROOT/bridge" "$INSTALL_ROOT/"
cp -R "$SOURCE_ROOT/adapters" "$INSTALL_ROOT/"
cp -R "$SOURCE_ROOT/prompts" "$INSTALL_ROOT/"
cp -R "$SOURCE_ROOT/service" "$INSTALL_ROOT/"
cp -R "$SOURCE_ROOT/docs" "$INSTALL_ROOT/"
cp -R "$SOURCE_ROOT/tests" "$INSTALL_ROOT/"
cp -R "$SOURCE_ROOT/setup" "$INSTALL_ROOT/"
cp "$SOURCE_ROOT/package.json" "$INSTALL_ROOT/"
cp "$SOURCE_ROOT/README.md" "$INSTALL_ROOT/"

cp -R "$SOURCE_ROOT/agents" "$INSTALL_ROOT/"
cp -R "$SOURCE_ROOT/commands" "$INSTALL_ROOT/"
cp -R "$SOURCE_ROOT/assets" "$INSTALL_ROOT/"
cp -R "$SOURCE_ROOT/skills" "$INSTALL_ROOT/"
cp -R "$SOURCE_ROOT/.hermes-plugin" "$INSTALL_ROOT/"
if [[ -f "$SOURCE_ROOT/.mcp.json" ]]; then
  cp "$SOURCE_ROOT/.mcp.json" "$INSTALL_ROOT/"
fi

case "$OS_KERNEL" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *)
    chmod +x "$INSTALL_ROOT/bridge/"*.mjs
    chmod +x "$INSTALL_ROOT/service/"*.mjs
    chmod +x "$INSTALL_ROOT/setup/"*.sh
    ;;
esac

export INSTALL_ROOT CONFIG_PATH HERMES_MCP_PATH WORKSPACE_ROOT STATE_HOME NODE_BIN
python3 - <<'PY'
import hashlib
import json
import os
import socket
import sys
from pathlib import Path

install_root = Path(os.environ["INSTALL_ROOT"])
config_path = Path(os.environ["CONFIG_PATH"])
hermes_mcp_path = Path(os.environ["HERMES_MCP_PATH"])
workspace_root = Path(os.environ["WORKSPACE_ROOT"]).resolve()
state_home = Path(os.environ["STATE_HOME"])
node_bin = os.environ["NODE_BIN"]
default_agent_instance_id = (
    f"{socket.gethostname()}-"
    f"{hashlib.sha256(str(workspace_root).encode('utf-8')).hexdigest()[:12]}"
)
if sys.platform.startswith("linux"):
    default_host_kind = "edamame_posture"
    default_posture_cli_command = "edamame_posture"
elif sys.platform == "win32":
    default_host_kind = "edamame_app"
    default_posture_cli_command = ""
else:
    default_host_kind = "edamame_app"
    default_posture_cli_command = ""
default_psk_path = state_home / "edamame-mcp.psk"
edamame_mcp_psk_file = str(default_psk_path)

def portable_path(p):
    """Forward slashes on all platforms for JSON/config compatibility."""
    return str(p).replace("\\", "/")

def render_template(src: Path, dst: Path) -> None:
    content = src.read_text(encoding="utf-8")
    content = (
        content.replace("__PACKAGE_ROOT__", portable_path(install_root))
        .replace("__CONFIG_PATH__", portable_path(config_path))
        .replace("__WORKSPACE_ROOT__", portable_path(workspace_root))
        .replace("__WORKSPACE_BASENAME__", workspace_root.name)
        .replace("__DEFAULT_AGENT_INSTANCE_ID__", default_agent_instance_id)
        .replace("__DEFAULT_HOST_KIND__", default_host_kind)
        .replace("__DEFAULT_POSTURE_CLI_COMMAND__", portable_path(default_posture_cli_command) if default_posture_cli_command else "")
        .replace("__STATE_DIR__", portable_path(state_home))
        .replace("__EDAMAME_MCP_PSK_FILE__", portable_path(edamame_mcp_psk_file))
        .replace("__NODE_BIN__", portable_path(node_bin))
    )
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(content, encoding="utf-8")

if not config_path.exists():
    render_template(
        install_root / "setup" / "hermes-edamame-config.template.json",
        config_path,
    )

render_template(
    install_root / "setup" / "hermes-mcp.template.json",
    hermes_mcp_path,
)


def _yaml_quote(value) -> str:
    """A JSON double-quoted scalar is also a valid YAML double-quoted scalar."""
    return json.dumps(str(value))


def _render_edamame_yaml_entry(command, args, child_indent: str):
    """Render the `edamame:` server sub-block at the given child indentation."""
    item_indent = child_indent + "  "
    arg_indent = item_indent + "  "
    lines = [
        f"{child_indent}edamame:",
        f"{item_indent}type: stdio",
        f"{item_indent}command: {_yaml_quote(command)}",
        f"{item_indent}args:",
    ]
    for arg in args:
        lines.append(f"{arg_indent}- {_yaml_quote(arg)}")
    return lines


def inject_hermes_mcp_yaml(snippet_path: Path, hermes_config_path: Path) -> None:
    """Merge the rendered edamame stdio server into ~/.hermes/config.yaml.

    Hermes declares MCP servers under a top-level `mcp_servers:` mapping in YAML
    (not the Claude/Cursor JSON shape, nor the Codex TOML shape). We keep a
    rendered JSON snippet for test/debug parity with the sibling packages, then
    write the equivalent YAML entry under the `edamame` key. The key MUST match
    `server_key` in builtin_supported_agents() / index.json ("edamame") so the
    EDAMAME app can list and clean the MCP state.

    Two strategies: prefer a structural PyYAML merge when available; otherwise
    fall back to a line-based splice so a minimal system python3 still works.
    """
    try:
        snippet = json.loads(snippet_path.read_text(encoding="utf-8"))
        entry = snippet.get("mcpServers", {}).get("edamame")
        if entry is None:
            return
    except Exception as exc:
        print(f"WARNING: failed to parse {snippet_path}: {exc}")
        return

    command = entry.get("command") or node_bin
    args = entry.get("args") or []

    hermes_config_path.parent.mkdir(parents=True, exist_ok=True)
    existing = (
        hermes_config_path.read_text(encoding="utf-8")
        if hermes_config_path.exists()
        else ""
    )

    def _backup():
        if hermes_config_path.exists():
            import shutil

            shutil.copy2(hermes_config_path, Path(str(hermes_config_path) + ".bak"))

    # Strategy 1: structural merge via PyYAML (correct for every nesting shape).
    try:
        import yaml  # type: ignore

        data = yaml.safe_load(existing) if existing.strip() else None
        if data is None:
            data = {}
        if not isinstance(data, dict):
            raise ValueError("hermes config.yaml root is not a mapping")
        servers = data.get("mcp_servers")
        if not isinstance(servers, dict):
            servers = {}
        servers["edamame"] = {
            "type": "stdio",
            "command": command,
            "args": list(args),
        }
        data["mcp_servers"] = servers
        _backup()
        hermes_config_path.write_text(
            yaml.safe_dump(data, default_flow_style=False, sort_keys=False),
            encoding="utf-8",
        )
        return
    except ImportError:
        pass
    except Exception as exc:
        print(f"WARNING: PyYAML merge failed ({exc}); falling back to text splice")

    # Strategy 2: no-dependency line-based splice.
    lines = existing.splitlines()

    ms_idx = None
    for i, line in enumerate(lines):
        if line.lstrip() != line:
            continue  # not a top-level key
        stripped = line.strip()
        if stripped == "mcp_servers:" or stripped.startswith("mcp_servers:"):
            if stripped.split(":", 1)[0].strip() == "mcp_servers":
                ms_idx = i
                break

    _backup()

    if ms_idx is None:
        block_lines = ["mcp_servers:"] + _render_edamame_yaml_entry(command, args, "  ")
        block = "\n".join(block_lines)
        if existing.strip():
            new_text = existing.rstrip() + "\n\n" + block + "\n"
        else:
            new_text = block + "\n"
        hermes_config_path.write_text(new_text, encoding="utf-8")
        return

    # Normalize any inline content (`mcp_servers: {}` / trailing value) to block style.
    header_after = lines[ms_idx].split(":", 1)[1].strip()
    if header_after not in ("", "{}"):
        print("WARNING: mcp_servers had inline content; rewriting as block style")
    lines[ms_idx] = "mcp_servers:"

    n = len(lines)
    block_start = ms_idx + 1

    # Learn the child indentation from the first non-blank child line (default 2).
    child_indent = "  "
    j = block_start
    while j < n:
        ln = lines[j]
        if ln.strip() == "":
            j += 1
            continue
        indent = len(ln) - len(ln.lstrip())
        if indent == 0:
            break  # next top-level key; block is empty
        child_indent = ln[:indent]
        break

    # The block runs until the next top-level (indent 0) non-blank line or EOF.
    block_end = block_start
    k = block_start
    while k < n:
        ln = lines[k]
        if ln.strip() != "" and (len(ln) - len(ln.lstrip())) == 0:
            break
        block_end = k + 1
        k += 1

    ci = len(child_indent)
    inner = lines[block_start:block_end]
    cleaned = []
    skipping = False
    for ln in inner:
        indent = len(ln) - len(ln.lstrip())
        stripped = ln.strip()
        if not skipping:
            if indent == ci and stripped.startswith("edamame:"):
                skipping = True
                continue
            cleaned.append(ln)
        else:
            if stripped == "" or indent > ci:
                continue  # still inside the old edamame sub-block
            skipping = False
            cleaned.append(ln)

    new_inner = _render_edamame_yaml_entry(command, args, child_indent) + cleaned
    new_lines = lines[:block_start] + new_inner + lines[block_end:]
    hermes_config_path.write_text("\n".join(new_lines).rstrip() + "\n", encoding="utf-8")


hermes_home = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes")))
inject_hermes_mcp_yaml(hermes_mcp_path, hermes_home / "config.yaml")
PY

cat <<EOF
Installed EDAMAME for Hermes to:
  $INSTALL_ROOT

Primary config:
  $CONFIG_PATH

Hermes MCP snippet:
  $HERMES_MCP_PATH

MCP server registered automatically in ${HERMES_HOME:-$HOME/.hermes}/config.yaml

Next steps:
1. Launch Hermes and run the edamame_hermes_control_center tool.
2. macOS/Windows: click 'Request pairing from app' in the control center, or paste a PSK manually.
   Linux: use the auto-pair action or paste a PSK generated with edamame-posture mcp-generate-psk.
3. Run: "$INSTALL_ROOT/setup/healthcheck.sh" --strict --json
EOF
