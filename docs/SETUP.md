# Setup

## Prerequisites

- Node.js 18+ with `fetch` support.
- A local EDAMAME host on the same machine:
  - macOS / Windows: the EDAMAME Security app
  - Linux: `edamame_posture`

## Install via Hermes Marketplace Plugin

The recommended install path. Add the marketplace and install:

```shell
/plugin marketplace add edamametechnologies/edamame_hermes
/plugin install edamame@edamame-security
/reload-plugins
```

The plugin registers:

- the MCP server (stdio bridge to EDAMAME),
- skills for posture assessment and divergence diagnosis,
- a security-monitor agent,
- healthcheck and export-intent commands.

After installation, run `/edamame:healthcheck` to verify the connection.

The plugin uses `${HERMES_PLUGIN_ROOT}` in `.mcp.json` so the MCP server
resolves its bridge path from the plugin cache automatically. Set the
`HERMES_EDAMAME_CONFIG` environment variable to point at a custom
config file, or let it auto-resolve to the default platform path.

## Install via EDAMAME app / posture CLI

EDAMAME downloads the latest release from GitHub (HTTP zipball -- no `git`
required) and copies files using native Rust file operations (no `bash` or
`python` required). Works on macOS, Linux, and Windows:

```bash
edamame-posture install-agent-plugin hermes
edamame-posture agent-plugin-status hermes
```

The provisioning engine automatically registers the `edamame` MCP server
entry in Hermes's global configuration (`~/.hermes/config.yaml`). Existing
servers in that file are preserved. Uninstalling the plugin
(`edamame-posture uninstall-agent-plugin hermes`) removes the `edamame`
entry from the global config.

The EDAMAME Security app also exposes an "Agent Plugins" section in AI
Settings with one-click install, status display, and intent injection test
buttons.

## Install From Source (bash)

```bash
bash setup/install.sh [/optional/path/to/workspace]
```

The workspace argument is **optional**. When provided, it seeds
`transcript_project_hints` and derives the `agent_instance_id`. When omitted,
the plugin monitors transcripts from **all** workspaces.

The installer:

- copies the package into a **global per-user** install directory (one copy per
  machine, shared across all workspaces),
- renders a default package config (only on first install -- existing config
  is preserved),
- renders a Hermes MCP snippet with fully resolved paths (including absolute `node` path),
- automatically injects the `edamame` server entry into Hermes's global configuration (`~/.hermes/config.yaml`), preserving any existing servers.

Once Hermes launches the MCP bridge, the bridge itself refreshes the
behavioral model on the configured cadence while the session remains
connected. There is no need to reinstall when switching workspaces.

## Install From Source (PowerShell, Windows)

```powershell
.\setup\install.ps1 [-WorkspaceRoot "C:\Users\me\projects\myapp"]
```

PowerShell equivalent of `install.sh` for native Windows environments. The
`-WorkspaceRoot` parameter is optional (same semantics as the bash installer).
Does the same file copy + template rendering without requiring bash or python.

## Config Paths

Primary config file:

- macOS: `~/Library/Application Support/hermes-edamame/config.json`
- Windows: `%APPDATA%\hermes-edamame\config.json`
- Linux: `~/.config/hermes-edamame/config.json`

Default state directory:

- macOS: `~/Library/Application Support/hermes-edamame/state`
- Windows: `%LOCALAPPDATA%\hermes-edamame\state`
- Linux: `~/.local/state/hermes-edamame`

The default local credential file lives inside the package state directory as
`edamame-mcp.psk`. This file should be readable only by the owning user
(mode `0600` on Unix). Avoid world-readable permissions, as the PSK grants
full access to the local EDAMAME MCP endpoint.

Key fields:

- `workspace_root` - workspace this package monitors.
- `hermes_sessions_root` - Hermes project storage, typically `~/.hermes/sessions`.
- `agent_type` - producer name attached to each behavioral-model slice. Default: `hermes`.
- `agent_instance_id` - stable unique producer instance identifier.
- `host_kind` - `edamame_app` on macOS/Windows, `edamame_posture` on Linux.
- `edamame_mcp_endpoint` - local EDAMAME MCP endpoint, default `http://127.0.0.1:3000/mcp`.
- `edamame_mcp_psk_file` - package-local file where the credential is stored.

## Pairing

### macOS / Windows

Use `host_kind = edamame_app`.

1. Start the EDAMAME Security app.
2. Enable its local MCP server on port `3000`.
3. **Primary flow**: Use the control center to request pairing from the app, approve in the EDAMAME Security app.
4. **Fallback**: Generate a PSK from the app's MCP controls, paste it into the control center.

### Linux

Use `host_kind = edamame_posture`.

Preferred path from the MCP App:

1. Run `edamame_hermes_control_center`.
2. Use `Generate, start, and pair automatically`.
3. Refresh status until the MCP endpoint, divergence engine, and behavioral model checks go healthy.

Manual fallback:

1. Generate a PSK:

```bash
edamame_posture mcp-generate-psk
```

2. Start the local MCP endpoint with the same PSK:

```bash
edamame_posture mcp-start 3000 "<PSK>"
```

3. Paste the PSK into `edamame_hermes_control_center` and save pairing.
4. Refresh status until the MCP endpoint, divergence engine, and behavioral model checks go healthy.

## Troubleshooting: `env: node: No such file or directory`

Hermes may not inherit your shell's `PATH`. The manual installer
resolves this automatically (it writes the absolute `node` path into the
rendered MCP snippet). If using the marketplace plugin and this error occurs,
ensure `node` is on the system `PATH`.

## Health Check

```bash
bash setup/healthcheck.sh --strict --json
```

This validates:

- local config presence,
- credential file presence,
- EDAMAME MCP reachability,
- divergence-engine running state,
- behavioral-model presence.

## Local E2E: scripted transcript inject and `edamame_cli` verification

Use this when you want to confirm the full path from a **synthetic Hermes transcript**
through the extrapolator into the running EDAMAME app, then read the merged model back via RPC
(the same surface `edamame_cli` uses).

Prerequisites: EDAMAME app running with MCP paired, agentic/LLM available for raw ingest, and a
built `edamame_cli` (or `EDAMAME_CLI` pointing at the binary).

```bash
bash scripts/e2e_inject_intent.sh
```

The script:

1. Checks install layout (`hermes-edamame` config, PSK, optional `~/.hermes/config.yaml` marketplace entry).
2. Writes **three** fresh `.txt` transcripts under `~/.hermes/sessions/<workspace-basename>-edamame-e2e-inject/`
   (API URL + file read, shell/curl to npm, git-remote style). Each file basename is a distinct `session_key`.
3. Runs `hermes_extrapolator.mjs` once against your config (installed package, or repo fallback).
4. Polls `edamame_cli rpc get_behavioral_model` until the merged behavioral model contains a
   `predictions[]` entry **for every** synthetic session (`agent_type`, `agent_instance_id`, and `session_key`).
   This avoids false failures when the merged contributor `hash` differs from a single-ingest `windowHash`.

The script calls `edamame_cli rpc get_behavioral_model --pretty`. For `String`-typed RPC
returns, the CLI emits a JSON string literal; the script parses twice (outer JSON string, then
inner behavioral-model JSON). Without `--pretty`, the CLI uses Rust `Debug` formatting, which is
not JSON and cannot be parsed reliably.

Environment:

| Variable | Purpose |
|----------|---------|
| `EDAMAME_CLI` | Path to `edamame_cli` if not on `PATH` |
| `HERMES_EDAMAME_CONFIG` | Alternate `config.json` |
| `E2E_SKIP_PLUGIN_CHECK=1` | Skip `~/.hermes/config.yaml` marketplace check |
| `E2E_POLL_ATTEMPTS` | Poll count (default 24) |
| `E2E_POLL_INTERVAL_SECS` | Seconds between polls (default 5) |
| `E2E_STRICT_HASH=1` | Also require contributor `hash` equals extrapolator `windowHash` (strict; often false after merges) |
