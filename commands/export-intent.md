---
name: export-intent
description: Force an immediate behavioral model export from recent Hermes transcripts to EDAMAME Security.
---

# Export Intent Now

Trigger an immediate behavioral model refresh from recent Hermes transcripts.

## Steps

1. Use the `edamame_hermes_control_center_refresh_now` MCP tool to:
   - Read recent Hermes session transcripts
   - Assemble a raw reasoning session payload
   - Forward it to EDAMAME via `upsert_behavioral_model_from_raw_sessions`
   - Return an updated status snapshot

2. After the export, verify the model was accepted by checking that the control center shows a recent "last intent export" timestamp and a healthy behavioral model status.

3. If the export fails, check:
   - Is the EDAMAME MCP endpoint reachable?
   - Is the divergence engine enabled?
   - Are there recent Hermes transcripts to export?
