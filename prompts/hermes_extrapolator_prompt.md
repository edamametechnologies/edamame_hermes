# Hermes Extrapolator Prompt

Use this prompt when you want an LLM to refine or validate the package's heuristic behavioral window before it is pushed into EDAMAME Security.

## Goal

Convert a Hermes task transcript into a `BehavioralWindow` that preserves the EDAMAME `SessionPrediction` schema:

- `expected_*` fields capture behavior the task explicitly requires.
- `not_expected_*` fields capture safety-floor behavior that should be treated as suspicious on a developer workstation.

## Rules

1. Hermes is the reasoning plane only. Do not invent observed system facts.
2. Prefer narrow allowlists. Only include files, traffic, ports, and processes that are justified by the task.
3. Preserve state isolation. Never store verdicts or security state in workspace files.
4. Use wildcards in `not_expected_*` fields when the EDAMAME matcher benefits from them.
5. Keep unrelated repositories, home-directory secrets, browser profiles, and `/tmp/*` execution out of the expected set unless the task explicitly requires them.

## Hermes Safety Floor

Always treat these as forbidden unless the task explicitly authorizes them:

- `~/.ssh/*`
- cloud credentials such as `~/.aws/*`, `~/.config/gcloud/*`, `~/.kube/*`
- browser profile paths
- unrelated repositories adjacent to the current workspace
- `/tmp/*` process or parent-path execution
- undeclared raw-IP egress
- unexpected public listeners
- destructive git flows outside the approved task

## Output Contract

Return valid JSON matching:

```json
{
  "window_start": "2026-03-06T10:00:00Z",
  "window_end": "2026-03-06T10:05:00Z",
  "predictions": [
    {
      "session_key": "hermes-session-id",
      "action": "Short task summary",
      "tools_called": ["ReadFile", "ApplyPatch", "Shell"],
      "expected_traffic": ["github.com:443", "crates.io:443"],
      "expected_sensitive_files": [],
      "expected_lan_devices": [],
      "expected_local_open_ports": [],
      "expected_process_paths": ["*/cargo", "*/git"],
      "expected_parent_paths": [],
      "expected_open_files": ["/workspace/src/lib.rs"],
      "expected_l7_protocols": ["http"],
      "expected_system_config": [],
      "not_expected_traffic": ["169.254.169.254"],
      "not_expected_sensitive_files": ["~/.ssh/*"],
      "not_expected_lan_devices": [],
      "not_expected_local_open_ports": [22],
      "not_expected_process_paths": ["/tmp/*"],
      "not_expected_parent_paths": ["/tmp/*"],
      "not_expected_open_files": ["/tmp/*"],
      "not_expected_l7_protocols": ["ssh"],
      "not_expected_system_config": []
    }
  ],
  "version": "hermes-package/1.0.0",
  "hash": "",
  "ingested_at": "2026-03-06T10:05:00Z"
}
```
