#!/usr/bin/env node

import fs from "node:fs/promises";
import { readPostureSnapshot } from "./posture_facade.mjs";
import { loadState } from "./config.mjs";
import {
  classifyExtrapolationFailure,
  describeExtrapolationFailure,
} from "./hermes_extrapolator.mjs";

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

function authRecoveryHint(config) {
  if (String(config?.hostKind || "").trim() === "edamame_posture") {
    return "Generate a fresh PSK with `edamame_posture mcp-generate-psk`, then save pairing again.";
  }
  return "Generate a fresh MCP PSK from the EDAMAME Security app, then save pairing again.";
}

function failureDetail(config, failure, extra = {}) {
  const description = describeExtrapolationFailure(failure);
  return {
    endpoint: config.edamameMcpEndpoint,
    status: description.status,
    reason: failure.reason,
    summary: description.summary,
    message: failure.message,
    recovery:
      failure.reason === "edamame_mcp_auth_failed" || failure.reason === "edamame_mcp_psk_missing"
        ? authRecoveryHint(config)
        : undefined,
    ...extra,
  };
}

export async function runHealthcheck(config, options = {}) {
  const result = {
    ok: true,
    checks: [],
  };

  const addCheck = (name, ok, detail) => {
    result.checks.push({ name, ok, detail });
    if (!ok) result.ok = false;
  };

  addCheck("config.workspaceRoot", !!config.workspaceRoot, config.workspaceRoot);
  addCheck("config.hermesSessionsRoot", !!config.hermesSessionsRoot, config.hermesSessionsRoot);

  const hasPsk = await fileExists(config.edamameMcpPskFile);
  addCheck("psk.file", hasPsk, config.edamameMcpPskFile);

  if (!hasPsk) {
    result.ok = !options.strict;
    result.message = "awaiting_pairing";
    return result;
  }

  if (String(config?.hostKind || "").trim() === "edamame_posture") {
    const {
      readPostureSystemServiceStatus,
      isPostureSystemServiceExpected,
      isPostureSystemServiceReady,
    } = await import("./control_center.mjs");
    const serviceManager = await readPostureSystemServiceStatus(config, "edamame_posture");
    const serviceExpected = isPostureSystemServiceExpected(serviceManager);
    const serviceReady = isPostureSystemServiceReady(serviceManager);
    addCheck(
      "posture.system_service",
      !serviceExpected || serviceReady,
      serviceManager,
    );
  }

  const extrapolatorState = await loadState(config, "hermes-extrapolator", null);
  if (extrapolatorState) {
    const lastError =
      typeof extrapolatorState.lastError === "string" && extrapolatorState.lastError.trim()
        ? extrapolatorState.lastError.trim()
        : null;
    addCheck("hermes.extrapolator", !lastError, {
      lastRunAt: extrapolatorState.lastRunAt || null,
      lastReasons: Array.isArray(extrapolatorState.lastReasons) ? extrapolatorState.lastReasons : [],
      lastError,
      lastAttemptCount:
        Number.isFinite(extrapolatorState.lastAttemptCount) ? extrapolatorState.lastAttemptCount : null,
      lastRetryCount:
        Number.isFinite(extrapolatorState.lastRetryCount) ? extrapolatorState.lastRetryCount : null,
    });
  }

  try {
    const snapshot = await readPostureSnapshot(config, options);
    const behavioralModel = snapshot.behavioralModel;
    const hasBehavioralModel =
      !!behavioralModel &&
      !(
        Object.prototype.hasOwnProperty.call(behavioralModel, "model") &&
        behavioralModel.model === null
      );
    result.snapshot = snapshot;
    const primaryFailure =
      snapshot.succeededToolCount === 0 && snapshot.firstToolError
        ? classifyExtrapolationFailure(snapshot.firstToolError.message)
        : null;
    if (primaryFailure) {
      addCheck(
        "mcp.endpoint",
        false,
        failureDetail(config, primaryFailure, {
          failedTool: snapshot.firstToolError.toolName,
        }),
      );
      if (primaryFailure.reason === "edamame_mcp_auth_failed") {
        addCheck(
          "mcp.authentication",
          false,
          failureDetail(config, primaryFailure, {
            failedTool: snapshot.firstToolError.toolName,
          }),
        );
      }
    } else {
      addCheck("mcp.endpoint", true, config.edamameMcpEndpoint);
    }
    addCheck(
      "divergence.engine",
      snapshot.engineStatus?.running === true,
      snapshot.engineStatus,
    );
    addCheck(
      "behavioral.model",
      hasBehavioralModel,
      behavioralModel,
    );
  } catch (error) {
    const failure = classifyExtrapolationFailure(error);
    if (failure) {
      addCheck("mcp.endpoint", false, failureDetail(config, failure));
      if (failure.reason === "edamame_mcp_auth_failed") {
        addCheck("mcp.authentication", false, failureDetail(config, failure));
      }
    } else {
      addCheck("mcp.endpoint", false, String(error?.message || error));
    }
  }

  if (options.strict) {
    result.ok =
      result.ok &&
      result.checks.every((check) => check.ok);
  }

  return result;
}
