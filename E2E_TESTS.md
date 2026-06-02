# Hermes Intent E2E Test

End-to-end test for the Hermes reasoning-plane pipeline: synthetic Hermes
transcripts are injected, processed by the `hermes_extrapolator`, and
verified by polling `get_behavioral_model` until predictions appear for every
expected session key.

## What It Validates

1. **Provision checks** -- installed package layout, version alignment between
   repo and installed copy, MCP snippet presence, PSK file, Hermes plugin
   registration.
2. **Synthetic transcript generation** -- three Hermes-style plain text
   transcript files (`e2e_api_*`, `e2e_shell_*`, `e2e_git_*`) are written under
   the Hermes projects root.
3. **Extrapolator execution** -- `hermes_extrapolator.mjs` processes the
   transcripts and pushes a `RawReasoningSessionPayload` to EDAMAME via
   `upsert_behavioral_model_from_raw_sessions`.
4. **Behavioral model polling** -- `edamame_cli rpc get_behavioral_model` is
   polled until the merged model contains predictions for all three session keys
   with the correct `agent_type` and `agent_instance_id`.

## Prerequisites

- EDAMAME Security app (or `edamame_posture`) running with MCP enabled and paired
- Agentic / LLM configured (raw session ingest uses the core LLM path)
- `edamame_cli` built or installed
- `node` 18+ and `python3`

## Running Locally

```bash
bash tests/e2e_inject_intent.sh
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `EDAMAME_CLI` | auto-detect | Path to `edamame_cli` binary |
| `HERMES_EDAMAME_CONFIG` | platform default | Override `config.json` path |
| `E2E_SKIP_PLUGIN_CHECK` | 0 | If 1, skip Hermes marketplace / MCP path checks |
| `E2E_SKIP_PROVISION_STRICT` | 0 | If 1, skip installed-package validation |
| `E2E_POLL_ATTEMPTS` | 36 | Number of polling attempts |
| `E2E_POLL_INTERVAL_SECS` | 5 | Seconds between polls |
| `E2E_DIAGNOSTICS_FILE` | (none) | Write JSON diagnosis on poll timeout |
| `E2E_PROGRESS_POLL` | 0 | If 1, print progress to stderr each poll |

## CI Integration

The `test_e2e.yml` workflow runs this test on Ubuntu after installing
`edamame_posture`, configuring agentic LLM, and provisioning the plugin.

## Full Cross-Agent E2E Suite

The complete E2E harness (intent injection for all three agents plus CVE/divergence
scenarios) lives in the
[agent_security](https://github.com/edamametechnologies/agent_security) repo
under `tests/e2e/`. Run triggers with `--agent-type hermes`. See
[agent_security E2E_TESTS.md](https://github.com/edamametechnologies/agent_security/blob/main/tests/e2e/E2E_TESTS.md)
for the full architecture.
