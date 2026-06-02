#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildRawSessionIngestPayload } from "../adapters/session_prediction_adapter.mjs";
import { makeEdamameClient } from "../bridge/edamame_client.mjs";
import { loadConfig, loadState, saveState, summarizeJson } from "./config.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

function parseCliArgs(argv) {
  const args = { dryRun: false, json: false, configPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run") args.dryRun = true;
    if (value === "--json") args.json = true;
    if (value === "--config" && argv[index + 1]) {
      args.configPath = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

function generatedWindowFromResponse(upsertResponse) {
  if (!upsertResponse || typeof upsertResponse !== "object") return null;
  if (upsertResponse.window && typeof upsertResponse.window === "object") {
    return upsertResponse.window;
  }
  return null;
}

function generatedWindowFromState(state) {
  if (!state || typeof state !== "object") return null;
  const candidate = state.lastGeneratedWindow;
  if (!candidate || typeof candidate !== "object") return null;
  if (!Array.isArray(candidate.predictions)) return null;
  if (!String(candidate.agent_type || "").trim()) return null;
  if (!String(candidate.agent_instance_id || "").trim()) return null;
  return candidate;
}

function contributorKey(agentType, agentInstanceId) {
  return `${String(agentType || "").trim()}:${String(agentInstanceId || "").trim()}`;
}

export function remoteContributorHashFromModel(behavioralModel, agentType, agentInstanceId) {
  if (!behavioralModel || typeof behavioralModel !== "object") return null;
  if (Object.prototype.hasOwnProperty.call(behavioralModel, "model") && behavioralModel.model === null) {
    return null;
  }

  const expectedKey = contributorKey(agentType, agentInstanceId);
  const contributors = Array.isArray(behavioralModel.contributors) ? behavioralModel.contributors : [];
  const matchingContributor = contributors.find(
    (contributor) => contributorKey(contributor?.agent_type, contributor?.agent_instance_id) === expectedKey,
  );
  if (matchingContributor && typeof matchingContributor.hash === "string" && matchingContributor.hash.trim()) {
    return matchingContributor.hash.trim();
  }

  if (contributorKey(behavioralModel.agent_type, behavioralModel.agent_instance_id) === expectedKey) {
    const topLevelHash = String(behavioralModel.hash || "").trim();
    return topLevelHash || null;
  }

  return null;
}

export function errorMessage(error) {
  return String(error?.message || error || "").trim();
}

function retryableRawIngestFailure(error) {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("unable to parse behavioral model json from llm response") ||
    message.includes("missing_generated_window_from_edamame")
  );
}

export function classifyExtrapolationFailure(error) {
  const message = errorMessage(error);
  const lower = message.toLowerCase();

  if (
    lower.includes("unable to parse behavioral model json from llm response") ||
    lower.includes("missing_generated_window_from_edamame")
  ) {
    return {
      reason: "behavioral_model_generation_failed",
      message,
    };
  }

  if (
    lower.includes("enoent") ||
    lower.includes("no such file or directory")
  ) {
    return {
      reason: "edamame_mcp_psk_missing",
      message,
    };
  }

  if (
    lower.startsWith("http_401") ||
    lower.startsWith("http_403") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid bearer") ||
    lower.includes("invalid psk")
  ) {
    return {
      reason: "edamame_mcp_auth_failed",
      message,
    };
  }

  if (
    lower.includes("fetch failed") ||
    lower.includes("terminated") ||
    lower.includes("socket closed") ||
    lower === "timeout" ||
    lower.includes("timeout") ||
    lower.startsWith("http_") ||
    lower.startsWith("initialize_error:") ||
    lower === "initialize_missing_response" ||
    lower.includes("unexpected_content_type") ||
    lower.includes("sse_timeout_or_eof_without_response")
  ) {
    return {
      reason: "edamame_mcp_unreachable",
      message,
    };
  }

  if (lower.startsWith("tools_call_error:")) {
    return {
      reason: "edamame_tool_error",
      message,
    };
  }

  return null;
}

export function describeExtrapolationFailure(failure) {
  if (!failure || typeof failure !== "object") {
    return {
      status: "unknown_failure",
      summary: "The Hermes bridge hit an unknown EDAMAME error.",
    };
  }

  switch (failure.reason) {
    case "edamame_mcp_auth_failed":
      return {
        status: "auth_failed",
        summary:
          "The stored MCP PSK was rejected by EDAMAME. Generate a fresh PSK and save pairing again.",
      };
    case "edamame_mcp_psk_missing":
      return {
        status: "psk_missing",
        summary:
          "No local MCP PSK is configured yet. Save pairing before exporting intent to EDAMAME.",
      };
    case "edamame_mcp_unreachable":
      return {
        status: "endpoint_unreachable",
        summary:
          "The Hermes bridge could not reach the configured EDAMAME MCP endpoint.",
      };
    case "behavioral_model_generation_failed":
      return {
        status: "model_generation_failed",
        summary:
          "EDAMAME reached the endpoint, but the internal raw-session model generation failed.",
      };
    case "edamame_tool_error":
      return {
        status: "tool_error",
        summary: "EDAMAME returned a tool-level error while handling the request.",
      };
    default:
      return {
        status: String(failure.reason || "unknown_failure"),
        summary: "The Hermes bridge hit an EDAMAME error.",
      };
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Core raw-session ingest runs an LLM; default MCP tool timeout (60s) is often too short under load. */
const RAW_INGEST_MCP_TIMEOUT_MS = 240_000;

async function invokeRawIngestWithRetry(client, rawSessions, options = {}) {
  const maxAttempts =
    Number.isFinite(options.maxAttempts) && options.maxAttempts > 0 ? options.maxAttempts : 3;
  const ingestTimeoutMs =
    Number.isFinite(options.rawIngestTimeoutMs) && options.rawIngestTimeoutMs > 0
      ? options.rawIngestTimeoutMs
      : RAW_INGEST_MCP_TIMEOUT_MS;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const upsertResponse = await client.invoke(
        "upsert_behavioral_model_from_raw_sessions",
        {
          raw_sessions_json: JSON.stringify(rawSessions),
        },
        ingestTimeoutMs,
      );
      return { upsertResponse, attempts };
    } catch (error) {
      if (attempts >= maxAttempts || !retryableRawIngestFailure(error)) {
        if (error && typeof error === "object") {
          error.attemptCount = attempts;
        }
        throw error;
      }
      await sleep(Math.min(2000, attempts * 500));
    }
  }

  throw new Error("raw_ingest_retry_exhausted");
}

export async function runLatestExtrapolation(config, options = {}) {
  const buildPayload = options.buildPayload || buildRawSessionIngestPayload;
  const makeClient = options.makeClient || makeEdamameClient;
  const loadStateFn = options.loadState || loadState;
  const saveStateFn = options.saveState || saveState;
  const previousState = (await loadStateFn(config, "hermes-extrapolator", {})) || {};
  const previousPayloadHash =
    typeof previousState.lastPayloadHash === "string" && previousState.lastPayloadHash.trim()
      ? previousState.lastPayloadHash.trim()
      : null;
  const previousWindowHash =
    typeof previousState.lastWindowHash === "string" && previousState.lastWindowHash.trim()
      ? previousState.lastWindowHash.trim()
      : null;
  const cachedGeneratedWindow = generatedWindowFromState(previousState);
  const { sessions, rawSessions, rawPayloadHash } = await buildPayload(config, options);

  const result = {
    success: true,
    sessionCount: sessions.length,
    sessionIds: sessions.map((session) => session.sessionId),
    agentType: rawSessions.agent_type,
    agentInstanceId: rawSessions.agent_instance_id,
    sourceKind: rawSessions.source_kind,
    rawPayloadHash,
    windowHash: null,
    remoteContributorHash: null,
    upserted: false,
    reasons: [],
    attemptCount: 0,
    retryCount: 0,
    error: null,
  };

  if (sessions.length === 0 && !cachedGeneratedWindow) {
    if (options.dryRun) {
      result.reasons = ["heartbeat_dry_run"];
      return result;
    }

    let client = null;
    try {
      client = await makeClient(config);
    } catch (error) {
      const failure = classifyExtrapolationFailure(error);
      if (!failure) throw error;
      result.success = false;
      result.error = failure.message;
      result.reasons = [failure.reason];
      return result;
    }

    const now = new Date();
    const windowMinutes = config.transcriptActiveWindowMinutes || 5;
    const priorPredictions = previousState?.lastGeneratedWindow?.predictions ?? [];
    const carryForwardNotExpected = {
      traffic: [...new Set(priorPredictions.flatMap((p) => p.not_expected_traffic || []))],
      sensitive_files: [...new Set(priorPredictions.flatMap((p) => p.not_expected_sensitive_files || []))],
      lan_devices: [...new Set(priorPredictions.flatMap((p) => p.not_expected_lan_devices || []))],
      local_open_ports: [...new Set(priorPredictions.flatMap((p) => p.not_expected_local_open_ports || []))],
      process_paths: [...new Set(priorPredictions.flatMap((p) => p.not_expected_process_paths || []))],
      parent_paths: [...new Set(priorPredictions.flatMap((p) => p.not_expected_parent_paths || []))],
      grandparent_paths: [...new Set(priorPredictions.flatMap((p) => p.not_expected_grandparent_paths || []))],
      open_files: [...new Set(priorPredictions.flatMap((p) => p.not_expected_open_files || []))],
      l7_protocols: [...new Set(priorPredictions.flatMap((p) => p.not_expected_l7_protocols || []))],
      system_config: [...new Set(priorPredictions.flatMap((p) => p.not_expected_system_config || []))],
    };
    const heartbeatWindow = {
      window_start: new Date(now.getTime() - windowMinutes * 60_000).toISOString(),
      window_end: now.toISOString(),
      agent_type: rawSessions.agent_type,
      agent_instance_id: rawSessions.agent_instance_id,
      predictions: [
        {
          agent_type: rawSessions.agent_type,
          agent_instance_id: rawSessions.agent_instance_id,
          session_key: `agent:${rawSessions.agent_instance_id}:cron:heartbeat`,
          action:
            "Periodic Hermes extrapolator cron tick with no new reasoning activity to model.",
          tools_called: [],
          scope_process_paths: config.scopeProcessPaths || [],
          scope_parent_paths: config.scopeParentPaths || [],
          scope_grandparent_paths: config.scopeGrandparentPaths || [],
          scope_any_lineage_paths: config.scopeAnyLineagePaths || [],
          expected_traffic: [...(config.hermesLlmHosts || [])],
          expected_sensitive_files: [],
          expected_lan_devices: [],
          expected_local_open_ports: [],
          expected_process_paths: [],
          expected_parent_paths: config.scopeParentPaths || [],
          expected_grandparent_paths: config.scopeGrandparentPaths || [],
          expected_open_files: [],
          expected_l7_protocols: ["https"],
          expected_system_config: [],
          not_expected_traffic: carryForwardNotExpected.traffic,
          not_expected_sensitive_files: carryForwardNotExpected.sensitive_files,
          not_expected_lan_devices: carryForwardNotExpected.lan_devices,
          not_expected_local_open_ports: carryForwardNotExpected.local_open_ports,
          not_expected_process_paths: carryForwardNotExpected.process_paths,
          not_expected_parent_paths: carryForwardNotExpected.parent_paths,
          not_expected_grandparent_paths: carryForwardNotExpected.grandparent_paths,
          not_expected_open_files: carryForwardNotExpected.open_files,
          not_expected_l7_protocols: carryForwardNotExpected.l7_protocols,
          not_expected_system_config: carryForwardNotExpected.system_config,
        },
      ],
      contributors: [],
      version: PACKAGE_VERSION,
      hash: "",
      ingested_at: now.toISOString(),
    };

    try {
      await client.invoke("upsert_behavioral_model", {
        window_json: JSON.stringify(heartbeatWindow),
      });
      result.upserted = true;
      result.reasons = ["heartbeat"];
      result.generatedWindow = heartbeatWindow;

      await saveStateFn(config, "hermes-extrapolator", {
        lastRunAt: now.toISOString(),
        lastPayloadHash: null,
        lastWindowHash: null,
        lastSessionIds: [],
        lastReasons: result.reasons,
        lastError: null,
        lastAttemptCount: 1,
        lastRetryCount: 0,
        lastGeneratedWindow: heartbeatWindow,
      });

      return result;
    } catch (error) {
      const failure = classifyExtrapolationFailure(error);
      if (!failure) throw error;
      result.success = false;
      result.error = failure.message;
      result.reasons = ["heartbeat_failed", failure.reason];
      return result;
    }
  }

  if (sessions.length === 0 && previousPayloadHash) {
    result.rawPayloadHash = previousPayloadHash;
  }

  if (options.dryRun) {
    result.reasons = sessions.length === 0 ? ["dry_run", "cached_window_recovery_available"] : ["dry_run"];
    if (sessions.length === 0) {
      result.generatedWindow = cachedGeneratedWindow;
    } else {
      result.rawSessions = rawSessions;
    }
    return result;
  }

  let client = null;
  try {
    client = await makeClient(config);
  } catch (error) {
    const failure = classifyExtrapolationFailure(error);
    if (!failure) {
      throw error;
    }
    result.success = false;
    result.error = failure.message;
    result.reasons = [failure.reason];
    result.attemptCount = 0;
    result.retryCount = 0;

    await saveStateFn(config, "hermes-extrapolator", {
      lastRunAt: new Date().toISOString(),
      lastPayloadHash: previousPayloadHash || null,
      lastWindowHash: previousWindowHash,
      lastSessionIds: result.sessionIds,
      lastReasons: result.reasons,
      lastError: result.error,
      lastAttemptCount: 0,
      lastRetryCount: 0,
      lastGeneratedWindow: cachedGeneratedWindow,
    });

    return result;
  }
  const expectedRemoteWindowHash =
    previousWindowHash ||
    (typeof cachedGeneratedWindow?.hash === "string" && cachedGeneratedWindow.hash.trim()
      ? cachedGeneratedWindow.hash.trim()
      : null);

  if (sessions.length === 0) {
    try {
      const behavioralModel = await client.invoke("get_behavioral_model", {});
      result.remoteContributorHash = remoteContributorHashFromModel(
        behavioralModel,
        cachedGeneratedWindow.agent_type,
        cachedGeneratedWindow.agent_instance_id,
      );
      if (expectedRemoteWindowHash && result.remoteContributorHash === expectedRemoteWindowHash) {
        result.windowHash = expectedRemoteWindowHash;
        result.reasons = ["no_active_sessions_remote_current"];
        await saveStateFn(config, "hermes-extrapolator", {
          lastRunAt: new Date().toISOString(),
          lastPayloadHash: previousPayloadHash,
          lastWindowHash: expectedRemoteWindowHash,
          lastSessionIds: Array.isArray(previousState.lastSessionIds) ? previousState.lastSessionIds : [],
          lastReasons: result.reasons,
          lastError: null,
          lastAttemptCount: 0,
          lastRetryCount: 0,
          lastGeneratedWindow: cachedGeneratedWindow,
        });
        return result;
      }
    } catch (_error) {
      // If the read path is unavailable, fall back to a repush.
    }

    await client.invoke("upsert_behavioral_model", {
      window_json: JSON.stringify(cachedGeneratedWindow),
    });
    result.upserted = true;
    result.generatedWindow = cachedGeneratedWindow;
    result.windowHash =
      typeof cachedGeneratedWindow.hash === "string" && cachedGeneratedWindow.hash.trim()
        ? cachedGeneratedWindow.hash.trim()
        : expectedRemoteWindowHash;
    result.reasons = ["cached_window_repush_no_active_sessions"];
    if (expectedRemoteWindowHash) {
      result.reasons.push(
        result.remoteContributorHash ? "repush_remote_mismatch" : "repush_remote_missing",
      );
    }

    try {
      result.engineStatus = await client.invoke("get_divergence_engine_status", {});
    } catch (_error) {
      // Keep recovery tied to the model write path itself.
    }

    await saveStateFn(config, "hermes-extrapolator", {
      lastRunAt: new Date().toISOString(),
      lastPayloadHash: previousPayloadHash,
      lastWindowHash: result.windowHash,
      lastSessionIds: Array.isArray(previousState.lastSessionIds) ? previousState.lastSessionIds : [],
      lastReasons: result.reasons,
      lastError: null,
      lastAttemptCount: 1,
      lastRetryCount: 0,
      lastGeneratedWindow: cachedGeneratedWindow,
    });

    return result;
  }

  if (previousPayloadHash === rawPayloadHash && previousWindowHash) {
    try {
      const behavioralModel = await client.invoke("get_behavioral_model", {});
      result.remoteContributorHash = remoteContributorHashFromModel(
        behavioralModel,
        rawSessions.agent_type,
        rawSessions.agent_instance_id,
      );
      if (result.remoteContributorHash === previousWindowHash) {
        result.windowHash = previousWindowHash;
        result.reasons = ["payload_unchanged_remote_current"];
        await saveStateFn(config, "hermes-extrapolator", {
          lastRunAt: new Date().toISOString(),
          lastPayloadHash: rawPayloadHash,
          lastWindowHash: previousWindowHash,
          lastSessionIds: result.sessionIds,
          lastReasons: result.reasons,
          lastError: null,
          lastAttemptCount: 0,
          lastRetryCount: 0,
          lastGeneratedWindow: cachedGeneratedWindow,
        });
        return result;
      }
    } catch (_error) {
      // If the read path is unavailable, fall back to a repush.
    }
  }

  try {
    const { upsertResponse, attempts } = await invokeRawIngestWithRetry(client, rawSessions, {
      maxAttempts: 3,
    });
    result.attemptCount = attempts;
    result.retryCount = Math.max(0, attempts - 1);

    const generatedWindow = generatedWindowFromResponse(upsertResponse);
    if (!generatedWindow || !Array.isArray(generatedWindow.predictions)) {
      const error = new Error("missing_generated_window_from_edamame");
      error.attemptCount = attempts;
      throw error;
    }
    result.upserted = true;
    result.reasons = ["raw_ingest"];
    if (result.retryCount > 0) {
      result.reasons.push("raw_ingest_retry_success");
    }
    if (previousPayloadHash === rawPayloadHash && previousWindowHash) {
      result.reasons.push(
        result.remoteContributorHash ? "repush_remote_mismatch" : "repush_remote_missing",
      );
    }
    result.upsertResponse = upsertResponse;
    result.generatedWindow = generatedWindow;
    result.windowHash = generatedWindow.hash || null;

    try {
      result.engineStatus = await client.invoke("get_divergence_engine_status", {});
    } catch (_error) {
      // The raw-ingest path should fail only on the ingest itself.
    }

    await saveStateFn(config, "hermes-extrapolator", {
      lastRunAt: new Date().toISOString(),
      lastPayloadHash: rawPayloadHash,
      lastWindowHash: result.windowHash,
      lastSessionIds: result.sessionIds,
      lastReasons: result.reasons,
      lastError: null,
      lastAttemptCount: result.attemptCount,
      lastRetryCount: result.retryCount,
      lastGeneratedWindow: generatedWindow,
    });

    return result;
  } catch (error) {
    const failure = classifyExtrapolationFailure(error);
    if (!failure) {
      throw error;
    }

    result.success = false;
    result.error = failure.message;
    result.reasons = [failure.reason];
    result.attemptCount = Number(error?.attemptCount) || 1;
    result.retryCount = Math.max(0, result.attemptCount - 1);

    await saveStateFn(config, "hermes-extrapolator", {
      lastRunAt: new Date().toISOString(),
      lastPayloadHash: previousPayloadHash || null,
      lastWindowHash: previousWindowHash,
      lastSessionIds: result.sessionIds,
      lastReasons: result.reasons,
      lastError: result.error,
      lastAttemptCount: result.attemptCount,
      lastRetryCount: result.retryCount,
      lastGeneratedWindow: cachedGeneratedWindow,
    });

    return result;
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const config = await loadConfig({ configPath: args.configPath });
  const result = await runLatestExtrapolation(config, {
    dryRun: args.dryRun,
  });

  if (args.json) {
    process.stdout.write(`${summarizeJson(result)}\n`);
  } else {
    process.stdout.write(
      `${result.upserted ? "upserted" : "checked"} ${result.sessionCount} session(s) window_hash=${result.windowHash || "none"} raw_hash=${result.rawPayloadHash || "none"} reasons=${result.reasons.join(",")}\n`,
    );
  }

  if (!result.success) {
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exit(1);
  });
}
