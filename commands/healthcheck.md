---
name: healthcheck
description: Run the EDAMAME Security health check to verify pairing, endpoint reachability, divergence engine, and behavioral model status.
---

# Health Check

Run the EDAMAME Security health check for this workstation.

## Steps

1. Execute the health check script:

```bash
bash setup/healthcheck.sh --strict --json
```

2. Review the output for any failing checks:
   - `config_present`: package configuration file exists
   - `credential_present`: MCP authentication credential is stored
   - `mcp_reachable`: EDAMAME MCP endpoint responds
   - `engine_running`: divergence engine is active
   - `model_present`: behavioral model has been pushed

3. If any check fails, run `edamame_hermes_control_center` to diagnose and repair pairing.
