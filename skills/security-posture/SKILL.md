---
name: security-posture
description: Check the current security posture of this workstation using EDAMAME Security. Use when the user asks about their security score, open threats, remediation actions, suspicious network sessions, or pwned credentials.
---

# Security Posture Skill

## When to Use

- User asks "what is my security score?" or "am I secure?"
- User wants to see open threats or remediation recommendations
- User asks about suspicious network sessions or anomalous traffic
- User wants to check if their email credentials have been compromised
- User asks about their device security posture before a deployment or review

## Instructions

1. Call `edamame_hermes_control_center` to verify EDAMAME is paired and reachable.
2. If the MCP endpoint is healthy, use the EDAMAME MCP tools exposed by the bridge:
   - `get_score` for the current security score breakdown
   - `advisor_get_todos` for open security recommendations
   - `get_sessions` for active network sessions
   - `get_anomalous_sessions` for ML-flagged suspicious sessions
   - `get_blacklisted_sessions` for known-bad destination traffic
   - `get_breaches` / `get_pwned_emails` for credential compromise checks
3. Summarize findings concisely: score, top threats, and actionable next steps.
4. If remediation is available, explain what `agentic_process_todos` or `agentic_execute_action` would do before suggesting it.
5. Always note that authoritative state lives in EDAMAME -- do not cache or re-derive scores locally.

## Important

- Never expose raw PSK or credential values in responses.
- If the EDAMAME endpoint is unreachable, guide the user to run `edamame_hermes_control_center` for pairing diagnostics.
