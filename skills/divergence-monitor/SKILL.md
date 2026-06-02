---
name: divergence-monitor
description: Monitor and diagnose behavioral divergence between Hermes intent and observed system activity. Use when the user asks about divergence verdicts, behavioral model status, or wants to debug why EDAMAME flagged an alert.
---

# Divergence Monitor Skill

## When to Use

- User asks "why did I get a divergence alert?"
- User wants to check the current divergence verdict (CLEAN, DIVERGENCE, NO_MODEL, STALE)
- User asks about the behavioral model or what EDAMAME thinks Hermes is doing
- User wants to force-refresh the behavioral model from recent transcripts
- User asks about the divergence engine status or history

## Instructions

1. Start by calling `edamame_hermes_control_center` to get the full status snapshot including:
   - Pairing and endpoint health
   - Divergence engine running state
   - Current behavioral model presence and last update time
   - Latest divergence verdict
2. For deeper diagnosis, use these EDAMAME MCP tools:
   - `get_divergence_verdict` for the current verdict with details
   - `get_divergence_history` for recent verdict timeline
   - `get_behavioral_model` for the current merged behavioral model
   - `get_divergence_engine_status` for engine configuration and health
3. If the verdict is `DIVERGENCE`, explain what the engine observed versus what the model predicted. Check which sessions or processes caused the mismatch.
4. If the verdict is `NO_MODEL`, guide the user to export intent:
   - Use `edamame_hermes_control_center_refresh_now` to push current transcripts
   - Wait for the model to appear (EDAMAME processes it with its LLM provider)
5. If the verdict is `STALE`, the model has not been updated recently. Trigger a refresh.

## Important

- Verdicts are authoritative from EDAMAME only. Never fabricate or cache verdicts locally.
- The behavioral model is generated server-side by EDAMAME's LLM provider from raw transcripts this package sends. The package itself does not run LLM inference.
- Multiple agent contributors (Hermes, Cursor, OpenClaw, etc.) may be merged into one model. The Hermes slice is identified by `agent_type=hermes`.
