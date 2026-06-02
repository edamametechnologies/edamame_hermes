# Validation Matrix

| Area | Check | Mechanism | Expected result |
|---|---|---|---|
| Transcript contract | Parse Hermes transcript fixtures into raw-session payloads | `node --test tests/adapter.test.mjs` | transcript parsing yields valid `RawReasoningSessionPayload` rows with correct `agent_type`, `agent_instance_id`, tools, commands, paths, ports, and expected traffic hints |
| Bridge contract | Exercise MCP lifecycle, tool dispatch, resources, pairing, refresh hooks, and retry behavior | `node --test tests/bridge.test.mjs` | `initialize`, `tools/list`, `resources/read`, control-center tools, `hermes_refresh_behavioral_model`, and `hermes_healthcheck` behave consistently |
| Package install | Render a per-user install and MCP snippet | `bash setup/install.sh <workspace>` or `pwsh ./setup/install.ps1 -WorkspaceRoot <workspace>` | package files, config, and Hermes MCP registration are created without clobbering unrelated user settings |
| Local health | Validate config, credentials, endpoint reachability, divergence engine, and model presence | `bash setup/healthcheck.sh --strict --json` | all checks report healthy when Hermes is paired to a running EDAMAME host |
| Raw ingest E2E | Inject synthetic Hermes transcripts and poll the merged behavioral model | `bash tests/e2e_inject_intent.sh` | every injected `session_key` appears under the correct `agent_type=hermes` and `agent_instance_id` |
| Workflow parity | Verify install/unit contract in CI | `.github/workflows/tests.yml` | manifest, structure, install, unit tests, and bridge contract checks pass on Linux, macOS, and Windows |
| Workflow E2E | Verify posture-backed intent injection in CI | `.github/workflows/test_e2e.yml` | provision, pairing, extrapolation, and behavioral-model polling succeed in the CI topology |
| Pairing UX | Validate app-mediated and posture-hosted pairing flows manually | workstation exercise | control-center status becomes healthy and persisted credentials let the bridge reconnect cleanly |
| Restart recovery | Restart the EDAMAME host with an empty remote model store | workstation exercise | the next Hermes refresh restores or repushes the local contributor slice |

## Recommended Local Sequence

1. `node --test tests/*.test.mjs`
2. `bash setup/healthcheck.sh --strict --json`
3. `bash tests/e2e_inject_intent.sh`
