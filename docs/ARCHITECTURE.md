# Architecture

`edamame_hermes` is the Hermes Agent (Nous Research, an OpenClaw successor) workstation package in the EDAMAME agent-plugin family.

## Runtime Model

1. Hermes stores session history in a SQLite+FTS5 database under `~/.hermes` (or `$HERMES_HOME`, `%LOCALAPPDATA%\hermes` on Windows), alongside a `sessions.json` manifest and -- in some builds -- per-session JSON/JSONL/`.txt` transcript files under `~/.hermes/sessions/`.
2. `adapters/session_prediction_adapter.mjs` (with `adapters/hermes_session_source.mjs`) discovers recent sessions from the transcript files and the `sessions.json` manifest -- and, when the optional `better-sqlite3` module is present, the SQLite store -- and converts them into `RawReasoningSessionPayload`.
3. `service/hermes_extrapolator.mjs` forwards the raw payload to the local EDAMAME MCP endpoint via `upsert_behavioral_model_from_raw_sessions`.
4. EDAMAME generates or updates the merged behavioral model, evaluates divergence, and exposes read-only posture and verdict state.
5. `bridge/hermes_edamame_mcp.mjs` exposes the local control center, healthcheck, posture-summary, and EDAMAME passthrough tools to Hermes.

## External Transcript Observer

EDAMAME core 1.2.3 ships an EDAMAME-side observer that reads `~/.hermes/sessions/` directly and feeds the same ingest pipeline. The observer is the security primitive: divergence detection works as soon as Hermes is **discovered** on disk, regardless of whether this Node-side package is installed. When the package **is** installed, its bridge also pushes models in-process and the observer hash-skips on duplicate payloads -- so the two paths are purely additive. Operators can pause, resume, or run the observer per agent (discovered or not) from the EDAMAME app's AI / Config tab. When the observer is paused while Hermes is discovered on disk, the `unsecured_hermes` internal threat becomes active on the next score cycle (the threat keys on discovery, not plugin install).

## Host Modes

| Platform | Host of record | Notes |
|---|---|---|
| macOS / Windows | EDAMAME Security app | App-mediated pairing is preferred. |
| Linux | `edamame_posture` | Local CLI/daemon hosts the MCP endpoint. |

## Package Layout

| Path | Responsibility |
|---|---|
| `bridge/hermes_edamame_mcp.mjs` | stdio MCP bridge, tool registration, control-center resource, refresh hooks |
| `bridge/edamame_client.mjs` | local HTTP MCP client for the EDAMAME host |
| `adapters/session_prediction_adapter.mjs` | Hermes transcript discovery, parsing, derived hint extraction, raw-session payload build |
| `service/hermes_extrapolator.mjs` | raw-session ingest orchestration, repush/recovery behavior |
| `service/control_center.mjs` | pairing, status, host actions, control-center payload |
| `service/health.mjs` | config, credential, endpoint, divergence-engine, and model health checks |
| `service/posture_facade.mjs` | compact read-only posture and verdict summary |
| `service/verdict_reader.mjs` | CLI-readable verdict and score output |
| `service/config.mjs` | config loading, path resolution, state persistence |
| `setup/install.sh` / `setup/install.ps1` | per-user installation and Hermes MCP registration in `~/.hermes/config.yaml` |
| `tests/` | adapter, bridge, health, retry/recovery, and intent-injection coverage |
