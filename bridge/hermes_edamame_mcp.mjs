#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { latestTranscriptMtimeMs } from "../adapters/session_prediction_adapter.mjs";
import { loadConfig, loadState } from "../service/config.mjs";
import { applyPairing, buildControlCenterPayload, requestAppPairing, runHostAction } from "../service/control_center.mjs";
import { runLatestExtrapolation } from "../service/hermes_extrapolator.mjs";
import { runHealthcheck } from "../service/health.mjs";
import { readPostureSnapshot, postureSummary } from "../service/posture_facade.mjs";
import { makeEdamameClient } from "./edamame_client.mjs";

const CONTROL_CENTER_RESOURCE_URI = "ui://edamame/control-center.html";
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const CONTROL_CENTER_APP_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "control_center_app.html",
);
const CONTROL_CENTER_TOOL_NAME = "edamame_hermes_control_center";
const CONTROL_CENTER_REFRESH_TOOL_NAME = "edamame_hermes_control_center_refresh";
const CONTROL_CENTER_REFRESH_NOW_TOOL_NAME = "edamame_hermes_control_center_refresh_now";
const CONTROL_CENTER_APPLY_PAIRING_TOOL_NAME = "edamame_hermes_control_center_apply_pairing";
const CONTROL_CENTER_RUN_HOST_ACTION_TOOL_NAME = "edamame_hermes_control_center_run_host_action";
const CONTROL_CENTER_REQUEST_APP_PAIRING_TOOL_NAME = "edamame_hermes_control_center_request_app_pairing";
const REFRESH_TOOL_NAME = "hermes_refresh_behavioral_model";
const LEGACY_REFRESH_TOOL_NAME = "hermes.refresh_behavioral_model";
const HEALTHCHECK_TOOL_NAME = "hermes_healthcheck";
const LEGACY_HEALTHCHECK_TOOL_NAME = "hermes.healthcheck";
const POSTURE_SUMMARY_TOOL_NAME = "hermes_posture_summary";
const LEGACY_POSTURE_SUMMARY_TOOL_NAME = "hermes.posture_summary";

export const TOOL_DEFINITIONS = [
  {
    name: CONTROL_CENTER_TOOL_NAME,
    title: "Hermes EDAMAME Control Center",
    description:
      "Open an interactive setup and status dashboard for local EDAMAME pairing, extrapolation state, and posture summary.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      title: "Hermes EDAMAME Control Center",
    },
    _meta: {
      ui: {
        resourceUri: CONTROL_CENTER_RESOURCE_URI,
        prefersBorder: true,
      },
      "ui/resourceUri": CONTROL_CENTER_RESOURCE_URI,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: CONTROL_CENTER_REFRESH_TOOL_NAME,
    title: "Refresh Hermes EDAMAME Control Center",
    description: "Refresh the control-center status payload without changing EDAMAME state.",
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      title: "Refresh Hermes EDAMAME Control Center",
    },
    _meta: {
      ui: {
        resourceUri: CONTROL_CENTER_RESOURCE_URI,
        visibility: ["app"],
      },
      "ui/resourceUri": CONTROL_CENTER_RESOURCE_URI,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: CONTROL_CENTER_REFRESH_NOW_TOOL_NAME,
    title: "Refresh Behavioral Model Now",
    description:
      "Run the extrapolator immediately and return an updated control-center snapshot for the current workstation.",
    annotations: {
      idempotentHint: true,
      title: "Refresh Behavioral Model Now",
    },
    _meta: {
      ui: {
        resourceUri: CONTROL_CENTER_RESOURCE_URI,
        visibility: ["app"],
      },
      "ui/resourceUri": CONTROL_CENTER_RESOURCE_URI,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: CONTROL_CENTER_APPLY_PAIRING_TOOL_NAME,
    title: "Apply Hermes EDAMAME Pairing",
    description:
      "Store the local EDAMAME MCP endpoint and credential (PSK or per-client token) for the Hermes bridge, then return an updated control-center snapshot.",
    annotations: {
      title: "Apply Hermes EDAMAME Pairing",
    },
    _meta: {
      ui: {
        resourceUri: CONTROL_CENTER_RESOURCE_URI,
        visibility: ["app"],
      },
      "ui/resourceUri": CONTROL_CENTER_RESOURCE_URI,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["psk"],
      properties: {
        host_kind: {
          type: "string",
          enum: ["edamame_app", "edamame_posture"],
          description: "Select the local EDAMAME host implementation.",
        },
        endpoint: {
          type: "string",
          description: "Local EDAMAME MCP endpoint, typically http://127.0.0.1:3000/mcp.",
        },
        psk: {
          type: "string",
          description: "EDAMAME MCP credential (PSK or per-client token) to store locally for this Hermes bridge.",
        },
      },
    },
  },
  {
    name: CONTROL_CENTER_RUN_HOST_ACTION_TOOL_NAME,
    title: "Run Hermes EDAMAME Host Action",
    description:
      "For supported local hosts, generate or reuse a PSK, start or stop the local MCP endpoint, and return an updated control-center snapshot.",
    annotations: {
      title: "Run Hermes EDAMAME Host Action",
    },
    _meta: {
      ui: {
        resourceUri: CONTROL_CENTER_RESOURCE_URI,
        visibility: ["app"],
      },
      "ui/resourceUri": CONTROL_CENTER_RESOURCE_URI,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["generate_and_start", "start", "stop"],
          description: "Host-side action to run for supported local EDAMAME hosts.",
        },
        host_kind: {
          type: "string",
          enum: ["edamame_app", "edamame_posture"],
          description: "Select the local EDAMAME host implementation.",
        },
        endpoint: {
          type: "string",
          description: "Local EDAMAME MCP endpoint, typically http://127.0.0.1:3000/mcp.",
        },
        psk: {
          type: "string",
          description: "Optional pasted PSK to use when starting a supported local host.",
        },
      },
    },
  },
  {
    name: CONTROL_CENTER_REQUEST_APP_PAIRING_TOOL_NAME,
    title: "Request App-Mediated Pairing",
    description:
      "Request pairing from the EDAMAME Security app. Sends an unauthenticated pairing request to the local MCP endpoint; the user approves or rejects in the app. On approval the per-client credential is stored automatically.",
    annotations: {
      title: "Request App-Mediated Pairing",
    },
    _meta: {
      ui: {
        resourceUri: CONTROL_CENTER_RESOURCE_URI,
        visibility: ["app"],
      },
      "ui/resourceUri": CONTROL_CENTER_RESOURCE_URI,
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        endpoint: {
          type: "string",
          description: "Local EDAMAME MCP endpoint, typically http://127.0.0.1:3000/mcp.",
        },
        client_name: {
          type: "string",
          description: "Display name shown in the app approval dialog.",
        },
      },
    },
  },
  {
    name: REFRESH_TOOL_NAME,
    description:
      "Read recent Hermes transcripts, forward raw reasoning sessions to EDAMAME, and let EDAMAME's configured LLM build and upsert the BehavioralWindow.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        dry_run: { type: "boolean", description: "Assemble the raw session payload without sending it upstream." },
      },
    },
  },
  {
    name: HEALTHCHECK_TOOL_NAME,
    description:
      "Check local Hermes package configuration, EDAMAME MCP reachability, divergence-engine status, and behavioral-model presence.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        strict: { type: "boolean", description: "Return failure when any check is unhealthy." },
      },
    },
  },
  {
    name: POSTURE_SUMMARY_TOOL_NAME,
    description:
      "Return a compact summary of divergence verdict, engine status, score, todos, and suspicious sessions for the current workstation.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "edamame_get_divergence_verdict",
    description: "Read the latest divergence verdict from EDAMAME Security.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "edamame_get_divergence_history",
    description: "Read rolling divergence verdict history from EDAMAME Security.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "number", description: "Maximum number of history entries to return." },
      },
    },
  },
  {
    name: "edamame_get_divergence_engine_status",
    description: "Read the current divergence-engine status from EDAMAME Security.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "edamame_get_behavioral_model",
    description: "Read the currently stored BehavioralWindow from EDAMAME Security.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "edamame_get_score",
    description: "Read the current EDAMAME workstation score summary.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        full: {
          type: "boolean",
          description:
            "Return full threat details including descriptions and remediation (default: false, trimmed).",
        },
      },
    },
  },
  {
    name: "edamame_get_sessions",
    description: "Read trimmed observed sessions from EDAMAME Security.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        active_only: { type: "boolean" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "edamame_get_anomalous_sessions",
    description: "Read anomalous sessions from EDAMAME Security.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "edamame_get_blacklisted_sessions",
    description: "Read blacklisted sessions from EDAMAME Security.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "edamame_advisor_get_todos",
    description: "Read prioritized security todos from EDAMAME Security.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
  },
];

const TOOL_NAME_MAP = {
  "edamame_get_divergence_verdict": "get_divergence_verdict",
  "edamame.get_divergence_verdict": "get_divergence_verdict",
  "edamame_get_divergence_history": "get_divergence_history",
  "edamame.get_divergence_history": "get_divergence_history",
  "edamame_get_divergence_engine_status": "get_divergence_engine_status",
  "edamame.get_divergence_engine_status": "get_divergence_engine_status",
  "edamame_get_behavioral_model": "get_behavioral_model",
  "edamame.get_behavioral_model": "get_behavioral_model",
  "edamame_get_score": "get_score",
  "edamame.get_score": "get_score",
  "edamame_get_sessions": "get_sessions",
  "edamame.get_sessions": "get_sessions",
  "edamame_get_anomalous_sessions": "get_anomalous_sessions",
  "edamame.get_anomalous_sessions": "get_anomalous_sessions",
  "edamame_get_blacklisted_sessions": "get_blacklisted_sessions",
  "edamame.get_blacklisted_sessions": "get_blacklisted_sessions",
  "edamame_advisor_get_todos": "advisor_get_todos",
  "edamame.advisor_get_todos": "advisor_get_todos",
};

export const RESOURCE_DEFINITIONS = [
  {
    uri: CONTROL_CENTER_RESOURCE_URI,
    name: "Hermes EDAMAME Control Center",
    description:
      "Interactive setup and status dashboard for Hermes-to-EDAMAME pairing, extrapolation state, and posture summary.",
    mimeType: RESOURCE_MIME_TYPE,
  },
];

export const AUTO_REFRESH_EXEMPT_TOOLS = new Set([
  REFRESH_TOOL_NAME,
  LEGACY_REFRESH_TOOL_NAME,
  CONTROL_CENTER_REFRESH_TOOL_NAME,
  CONTROL_CENTER_REFRESH_NOW_TOOL_NAME,
  CONTROL_CENTER_APPLY_PAIRING_TOOL_NAME,
  CONTROL_CENTER_RUN_HOST_ACTION_TOOL_NAME,
  CONTROL_CENTER_REQUEST_APP_PAIRING_TOOL_NAME,
]);

function parseCliArgs(argv) {
  const args = { configPath: null, backgroundRefresh: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--config" && argv[index + 1]) {
      args.configPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (argv[index] === "--background-refresh") {
      args.backgroundRefresh = true;
      continue;
    }
    if (argv[index] === "--no-background-refresh") {
      args.backgroundRefresh = false;
    }
  }
  return args;
}

function stderrLog(message) {
  process.stderr.write(`[edamame] ${message}\n`);
}

function previewText(value, limit = 240) {
  const text = String(value || "")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function createBridgeLogger(config) {
  if (config?.debugBridgeLog !== true) return null;

  const logPath =
    String(config?.debugBridgeLogFile || "").trim() ||
    path.join(String(config?.stateDir || process.cwd()), "bridge-debug.log");
  let writeQueue = Promise.resolve();

  return {
    path: logPath,
    log(event, details = {}) {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        event,
        ...details,
      });
      writeQueue = writeQueue
        .then(async () => {
          await fs.mkdir(path.dirname(logPath), { recursive: true });
          await fs.appendFile(logPath, `${line}\n`, "utf8");
        })
        .catch(() => {});
    },
    flush() {
      return writeQueue;
    },
  };
}

function formatRefreshReasons(result) {
  return Array.isArray(result?.reasons) && result.reasons.length > 0
    ? result.reasons.join(",")
    : "none";
}

function backgroundRefreshLoggingEnabled(config) {
  if (config?.logBackgroundRefresh === true) return true;
  const envValue = String(process.env.HERMES_EDAMAME_LOG_REFRESH || "")
    .trim()
    .toLowerCase();
  return envValue === "1" || envValue === "true" || envValue === "yes";
}

export function createBackgroundRefreshLoop(config, options = {}) {
  const runExtrapolation = options.runExtrapolation || runLatestExtrapolation;
  const intervalMs =
    Number.isFinite(options.intervalMs) && options.intervalMs > 0
      ? options.intervalMs
      : Math.max(1, Number(config?.divergenceIntervalSecs) || 120) * 1000;
  const startupDelayMs =
    Number.isFinite(options.startupDelayMs) && options.startupDelayMs >= 0
      ? options.startupDelayMs
      : 1000;

  let intervalHandle = null;
  let startupHandle = null;
  let inFlight = false;
  let started = false;

  async function runCycle(trigger) {
    if (inFlight) {
      return { skipped: true, reason: "in_flight", trigger };
    }

    inFlight = true;
    try {
      const result = await runExtrapolation(config);
      options.onResult?.({ trigger, result });
      return { skipped: false, trigger, result };
    } catch (error) {
      options.onError?.({ trigger, error });
      return { skipped: false, trigger, error };
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (started) return;
    started = true;

    startupHandle = setTimeout(() => {
      void runCycle("startup");
    }, startupDelayMs);
    intervalHandle = setInterval(() => {
      void runCycle("interval");
    }, intervalMs);

    startupHandle.unref?.();
    intervalHandle.unref?.();
  }

  function stop() {
    if (startupHandle) {
      clearTimeout(startupHandle);
      startupHandle = null;
    }
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    started = false;
  }

  return {
    start,
    stop,
    runCycle,
    isStarted: () => started,
    intervalMs,
  };
}

function parseStateTimestampMs(state) {
  const timestamp = Date.parse(String(state?.lastRunAt || ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function createHermesDrivenRefresh(config, options = {}) {
  const runExtrapolation = options.runExtrapolation || runLatestExtrapolation;
  const loadStateFn = options.loadState || loadState;
  const latestTranscriptMtimeMsFn = options.latestTranscriptMtimeMs || latestTranscriptMtimeMs;
  const minIntervalMs =
    Number.isFinite(options.minIntervalMs) && options.minIntervalMs >= 0
      ? options.minIntervalMs
      : Math.max(1, Number(config?.divergenceIntervalSecs) || 120) * 1000;
  const logRefresh =
    options.logRefresh === undefined
      ? backgroundRefreshLoggingEnabled(config)
      : options.logRefresh === true;

  let inFlight = null;
  let lastAttemptMs = 0;
  let lastResult = null;

  async function transcriptChangedSince(referenceMs) {
    if (!Number.isFinite(referenceMs) || referenceMs <= 0) return false;
    try {
      const latestMtimeMs = await latestTranscriptMtimeMsFn(config);
      return latestMtimeMs !== null && latestMtimeMs > referenceMs;
    } catch (_error) {
      return false;
    }
  }

  async function maybeRun(trigger, options = {}) {
    const force = options.force === true;
    if (inFlight) {
      return { skipped: true, reason: "in_flight", trigger, result: lastResult };
    }

    const now = Date.now();
    if (!force && lastAttemptMs > 0 && now - lastAttemptMs < minIntervalMs) {
      if (!(await transcriptChangedSince(lastAttemptMs))) {
        return { skipped: true, reason: "recent_in_memory", trigger, result: lastResult };
      }
    }

    if (!force) {
      const persistedState = await loadStateFn(config, "hermes-extrapolator", null);
      const lastRunAtMs = parseStateTimestampMs(persistedState);
      if (lastRunAtMs !== null && now - lastRunAtMs < minIntervalMs) {
        if (!(await transcriptChangedSince(lastRunAtMs))) {
          return { skipped: true, reason: "recent_persisted", trigger, result: lastResult };
        }
      }
    }

    const runPromise = (async () => {
      lastAttemptMs = Date.now();
      try {
        const result = await runExtrapolation(config);
        lastResult = result;
        if (logRefresh) {
          stderrLog(
            `hermes_refresh trigger=${trigger} success=${result?.success !== false} upserted=${result?.upserted === true} sessions=${result?.sessionCount ?? 0} reasons=${formatRefreshReasons(result)}`,
          );
        }
        return { skipped: false, trigger, result };
      } catch (error) {
        if (logRefresh) {
          stderrLog(
            `hermes_refresh trigger=${trigger} unexpected_error=${String(error?.stack || error)}`,
          );
        }
        return { skipped: false, trigger, error };
      } finally {
        inFlight = null;
      }
    })();

    inFlight = runPromise;
    if (options.block === false) {
      void runPromise;
      return { skipped: false, pending: true, trigger };
    }
    return runPromise;
  }

  return {
    maybeRun,
    kick(trigger, options = {}) {
      void maybeRun(trigger, { ...options, block: false });
    },
  };
}

function toolResult(value, meta = null) {
  const result = {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };

  if (value && typeof value === "object") {
    result.structuredContent = value;
  }

  if (meta && typeof meta === "object") {
    result._meta = meta;
  }

  return result;
}

function jsonRpcError(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

function jsonRpcResult(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

async function callMappedEdamameTool(config, localToolName, args) {
  const client = await makeEdamameClient(config);
  const upstreamToolName = TOOL_NAME_MAP[localToolName];
  if (!upstreamToolName) {
    throw new Error(`unsupported_tool:${localToolName}`);
  }
  return client.invoke(upstreamToolName, args);
}

let cachedControlCenterHtml = null;

async function readAppResource(resourceUri) {
  if (resourceUri !== CONTROL_CENTER_RESOURCE_URI) {
    throw new Error(`unknown_resource:${resourceUri}`);
  }

  if (cachedControlCenterHtml === null) {
    cachedControlCenterHtml = await fs.readFile(CONTROL_CENTER_APP_PATH, "utf8");
  }

  return {
    contents: [
      {
        uri: CONTROL_CENTER_RESOURCE_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: cachedControlCenterHtml,
        _meta: {
          ui: {
            prefersBorder: true,
          },
        },
      },
    ],
  };
}

export async function dispatchToolCall(config, toolName, args = {}) {
  if (toolName === CONTROL_CENTER_TOOL_NAME) {
    return buildControlCenterPayload(config);
  }

  if (toolName === CONTROL_CENTER_REFRESH_TOOL_NAME) {
    return buildControlCenterPayload(config);
  }

  if (toolName === CONTROL_CENTER_REFRESH_NOW_TOOL_NAME) {
    return buildControlCenterPayload(config, { refreshNow: true });
  }

  if (toolName === CONTROL_CENTER_APPLY_PAIRING_TOOL_NAME) {
    return applyPairing(config, args);
  }

  if (toolName === CONTROL_CENTER_RUN_HOST_ACTION_TOOL_NAME) {
    return runHostAction(config, args);
  }

  if (toolName === CONTROL_CENTER_REQUEST_APP_PAIRING_TOOL_NAME) {
    return requestAppPairing(config, args);
  }

  if (toolName === REFRESH_TOOL_NAME || toolName === LEGACY_REFRESH_TOOL_NAME) {
    return runLatestExtrapolation(config, { dryRun: args.dry_run === true });
  }

  if (toolName === HEALTHCHECK_TOOL_NAME || toolName === LEGACY_HEALTHCHECK_TOOL_NAME) {
    return runHealthcheck(config, { strict: args.strict === true });
  }

  if (toolName === POSTURE_SUMMARY_TOOL_NAME || toolName === LEGACY_POSTURE_SUMMARY_TOOL_NAME) {
    const snapshot = await readPostureSnapshot(config);
    return {
      summary: postureSummary(snapshot),
      snapshot,
    };
  }

  return callMappedEdamameTool(config, toolName, args);
}

function writeMessage(message, mode = "framed") {
  const payload = JSON.stringify(message);
  if (mode === "raw_json") {
    process.stdout.write(`${payload}\n`);
    return;
  }
  const header = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n`;
  process.stdout.write(header);
  process.stdout.write(payload);
}

function locateHeaderBoundary(buffer) {
  const crlfBoundary = buffer.indexOf("\r\n\r\n");
  if (crlfBoundary >= 0) {
    return {
      headerEnd: crlfBoundary,
      boundaryLength: 4,
    };
  }

  const lfBoundary = buffer.indexOf("\n\n");
  if (lfBoundary >= 0) {
    return {
      headerEnd: lfBoundary,
      boundaryLength: 2,
    };
  }

  return null;
}

export function tryExtractMessages(buffer) {
  return tryExtractMessagesWithMode(buffer, {});
}

function extractRawJsonValue(buffer) {
  const leadingWhitespaceLength = buffer.length - buffer.trimStart().length;
  const trimmed = buffer.slice(leadingWhitespaceLength);
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }

    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return {
          valueText: trimmed.slice(0, index + 1),
          consumedLength: leadingWhitespaceLength + index + 1,
        };
      }
    }
  }

  return null;
}

function tryExtractMessagesWithMode(buffer, options = {}) {
  const messages = [];
  let remaining = buffer;
  let mode = options.defaultMode || null;

  while (true) {
    const headerBoundary = locateHeaderBoundary(remaining);
    if (!headerBoundary) {
      const leading = remaining.trimStart();
      if (leading.toLowerCase().startsWith("content-length:")) break;

      const rawJson = extractRawJsonValue(remaining);
      if (!rawJson) break;

      messages.push(JSON.parse(rawJson.valueText));
      remaining = remaining.slice(rawJson.consumedLength).trimStart();
      mode = "raw_json";
      continue;
    }

    const { headerEnd, boundaryLength } = headerBoundary;

    const headerText = remaining.slice(0, headerEnd);
    const headers = Object.fromEntries(
      headerText
        .split(/\r?\n/)
        .map((line) => line.split(":"))
        .filter((parts) => parts.length >= 2)
        .map(([key, ...rest]) => [key.trim().toLowerCase(), rest.join(":").trim()]),
    );

    const contentLength = Number.parseInt(headers["content-length"] || "", 10);
    if (!Number.isFinite(contentLength)) {
      throw new Error("missing_content_length");
    }

    const frameStart = headerEnd + boundaryLength;
    const afterHeader = remaining.slice(frameStart);
    const byteLength = Buffer.byteLength(afterHeader, "utf8");
    if (byteLength < contentLength) break;

    const bodyBuffer = Buffer.from(afterHeader, "utf8");
    const jsonText = bodyBuffer.subarray(0, contentLength).toString("utf8");
    messages.push(JSON.parse(jsonText));
    const consumedChars = Buffer.from(bodyBuffer.subarray(0, contentLength)).toString("utf8").length;
    remaining = remaining.slice(frameStart + consumedChars);
    mode = "framed";
  }

  return { messages, remaining, mode };
}

export async function handleRequest(config, request, runtime = {}) {
  const id = request?.id ?? null;
  const method = request?.method;
  const autoRefresh = runtime.autoRefresh || null;

  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: "2025-11-25",
      capabilities: {
        tools: {},
        resources: {},
      },
      serverInfo: {
        name: "edamame",
        version: "1.0.0",
      },
    });
  }

  if (method === "notifications/initialized") {
    autoRefresh?.kick("notifications_initialized");
    return null;
  }

  if (method === "ping") {
    autoRefresh?.kick("ping");
    return jsonRpcResult(id, {});
  }

  if (method === "tools/list") {
    autoRefresh?.kick("tools_list");
    return jsonRpcResult(id, { tools: TOOL_DEFINITIONS });
  }

  if (method === "resources/list") {
    return jsonRpcResult(id, { resources: RESOURCE_DEFINITIONS });
  }

  if (method === "resources/read") {
    const resourceUri = String(request?.params?.uri || "").trim();
    if (!resourceUri) {
      return jsonRpcError(id, -32602, "missing_resource_uri");
    }

    try {
      return jsonRpcResult(id, await readAppResource(resourceUri));
    } catch (error) {
      return jsonRpcError(id, -32000, String(error?.message || error));
    }
  }

  if (method === "tools/call") {
    const toolName = request?.params?.name;
    const args = request?.params?.arguments || {};
    if (!toolName) {
      return jsonRpcError(id, -32602, "missing_tool_name");
    }

    try {
      if (!AUTO_REFRESH_EXEMPT_TOOLS.has(toolName)) {
        await autoRefresh?.maybeRun(`tool_call:${toolName}`, { block: true });
      }
      const payload = await dispatchToolCall(config, toolName, args);
      return jsonRpcResult(id, toolResult(payload));
    } catch (error) {
      return jsonRpcError(id, -32000, String(error?.message || error));
    }
  }

  return jsonRpcError(id, -32601, `method_not_found:${method}`);
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const config = await loadConfig({ configPath: args.configPath });
  const bridgeLogger = createBridgeLogger(config);
  const autoRefresh = createHermesDrivenRefresh(config);
  const logBackgroundRefresh = backgroundRefreshLoggingEnabled(config);
  let sawStdinData = false;
  const stdinIdleTimer = setTimeout(() => {
    bridgeLogger?.log("stdin_idle_timeout", { seconds: 5 });
  }, 5000);
  stdinIdleTimer.unref?.();

  bridgeLogger?.log("startup", {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    debugLogPath: bridgeLogger?.path || null,
  });

  const refreshLoop = createBackgroundRefreshLoop(config, {
    onResult: logBackgroundRefresh
      ? ({ trigger, result }) => {
          stderrLog(
            `background_refresh trigger=${trigger} success=${result?.success !== false} upserted=${result?.upserted === true} sessions=${result?.sessionCount ?? 0} reasons=${formatRefreshReasons(result)}`,
          );
        }
      : undefined,
    onError: ({ trigger, error }) => {
      stderrLog(
        `background_refresh trigger=${trigger} unexpected_error=${String(error?.stack || error)}`,
      );
    },
  });
  if (args.backgroundRefresh) {
    refreshLoop.start();
  }

  let buffer = "";
  let transportMode = null;
  let resolveStdioClosed = null;
  const stdioClosed = new Promise((resolve) => {
    resolveStdioClosed = resolve;
  });
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk) => {
    try {
      if (!sawStdinData) {
        sawStdinData = true;
        clearTimeout(stdinIdleTimer);
      }
      bridgeLogger?.log("stdin_chunk", {
        length: chunk.length,
        preview: previewText(chunk),
      });
      buffer += chunk;
      const extracted = tryExtractMessagesWithMode(buffer, { defaultMode: transportMode });
      buffer = extracted.remaining;
      transportMode = extracted.mode || transportMode;
      if (extracted.messages.length > 0) {
        bridgeLogger?.log("messages_extracted", {
          count: extracted.messages.length,
          mode: transportMode,
          methods: extracted.messages.map((message) => message?.method || null),
          ids: extracted.messages.map((message) => message?.id ?? null),
        });
      }
      for (const message of extracted.messages) {
        bridgeLogger?.log("request_received", {
          id: message?.id ?? null,
          method: message?.method || null,
          protocolVersion: message?.params?.protocolVersion || null,
          toolName: message?.params?.name || null,
        });
        const response = await handleRequest(config, message, { autoRefresh });
        if (response) {
          bridgeLogger?.log("response_sending", {
            id: response?.id ?? null,
            hasError: Boolean(response?.error),
            errorCode: response?.error?.code ?? null,
            resultKeys: response?.result ? Object.keys(response.result) : [],
          });
          writeMessage(response, transportMode || "framed");
        } else {
          bridgeLogger?.log("notification_handled", {
            id: message?.id ?? null,
            method: message?.method || null,
          });
        }
      }
    } catch (error) {
      bridgeLogger?.log("data_handler_error", {
        message: String(error?.message || error),
        stack: previewText(error?.stack || error, 2000),
        bufferPreview: previewText(buffer, 800),
      });
      writeMessage(jsonRpcError(null, -32700, String(error?.message || error)), transportMode || "framed");
    }
  });
  process.stdin.once("end", () => {
    clearTimeout(stdinIdleTimer);
    refreshLoop.stop();
    bridgeLogger?.log("stdin_end");
    resolveStdioClosed?.();
  });
  process.stdin.once("close", () => {
    clearTimeout(stdinIdleTimer);
    refreshLoop.stop();
    bridgeLogger?.log("stdin_close");
    resolveStdioClosed?.();
  });
  process.stdin.resume();
  await stdioClosed;
  refreshLoop.stop();
  bridgeLogger?.log("shutdown");
  await bridgeLogger?.flush?.();
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
