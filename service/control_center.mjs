#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  defaultConfigPath,
  defaultHostKind,
  defaultPostureCliCommand,
  defaultSystemctlCommand,
  ensureDirectory,
  loadConfig,
  loadState,
  saveState,
  readJsonFile,
  writeJsonFile,
} from "./config.mjs";
import { runLatestExtrapolation } from "./hermes_extrapolator.mjs";
import { runHealthcheck } from "./health.mjs";
import { postureSummary } from "./posture_facade.mjs";

const execFileAsync = promisify(execFile);
const LOCAL_MCP_ENDPOINT = "http://127.0.0.1:3000/mcp";
const POSTURE_CLI_TIMEOUT_MS = 30_000;
const SYSTEMCTL_TIMEOUT_MS = 15_000;
const POSTURE_SYSTEMD_SERVICE = "edamame_posture.service";

function normalizeHostKind(value) {
  return String(value || "").trim() === "edamame_posture" ? "edamame_posture" : "edamame_app";
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (_error) {
    return false;
  }
}

function postureCliCommand(config) {
  const configured = String(config?.postureCliCommand || "").trim();
  if (configured) return configured;
  const fallback = String(defaultPostureCliCommand() || "").trim();
  return fallback || null;
}

function systemctlCommand(config) {
  const configured = String(config?.systemctlCommand || "").trim();
  if (configured) return configured;
  const fallback = String(defaultSystemctlCommand() || "").trim();
  return fallback || null;
}

function parseKeyValueLines(text) {
  const entries = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key) entries[key] = value;
  }
  return entries;
}

function extractFirstContentLine(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.find((line) => !line.startsWith("#")) || null;
}

function extractLabelValue(text, label) {
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${label}:`)) continue;
    const value = trimmed.slice(label.length + 1).trim();
    return value || null;
  }
  return null;
}

function parseLocalEndpoint(endpoint) {
  const value = String(endpoint || "").trim() || LOCAL_MCP_ENDPOINT;
  let parsedUrl;
  try {
    parsedUrl = new URL(value);
  } catch (_error) {
    throw new Error(`invalid_endpoint:${value}`);
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error(`unsupported_endpoint_protocol:${parsedUrl.protocol}`);
  }

  const port = Number(parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid_endpoint_port:${value}`);
  }

  const host = parsedUrl.hostname.toLowerCase();
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  const allInterfaceHosts = new Set(["0.0.0.0", "::"]);
  if (!loopbackHosts.has(host) && !allInterfaceHosts.has(host)) {
    throw new Error(`host_action_requires_local_endpoint:${value}`);
  }

  return {
    endpoint: parsedUrl.toString(),
    host,
    port,
    allInterfaces: allInterfaceHosts.has(host),
  };
}

function parsePostureStatus(stdout) {
  const running = String(stdout || "").includes("[OK] MCP server is running");
  const port = Number(extractLabelValue(stdout, "Port")) || null;
  const url = extractLabelValue(stdout, "URL");
  return {
    running,
    port,
    url,
    summary: running
      ? `Local posture MCP is running${url ? ` at ${url}` : ""}.`
      : "Local posture MCP is not running.",
  };
}

function parsePostureStart(stdout) {
  const port = Number(extractLabelValue(stdout, "Port")) || null;
  const url = extractLabelValue(stdout, "URL");
  return {
    port,
    url,
    summary: `Started local posture MCP${url ? ` at ${url}` : ""}.`,
  };
}

async function execPostureCli(config, args) {
  const command = postureCliCommand(config);
  if (!command) {
    throw new Error("posture_cli_command_unconfigured");
  }

  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: POSTURE_CLI_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return { command, stdout, stderr };
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`posture_cli_not_found:${command}`);
    }
    const stderr = String(error?.stderr || error?.message || error).trim() || "posture_cli_failed";
    throw new Error(`posture_cli_failed:${stderr}`);
  }
}

async function execSystemctl(config, args) {
  const command = systemctlCommand(config);
  if (!command) {
    throw new Error("systemctl_command_unconfigured");
  }

  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: SYSTEMCTL_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return { command, stdout, stderr };
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`systemctl_not_found:${command}`);
    }
    const stderr = String(error?.stderr || error?.message || error).trim() || "systemctl_failed";
    const normalized = stderr.toLowerCase();
    if (
      normalized.includes("system has not been booted with systemd") ||
      normalized.includes("failed to connect to bus") ||
      normalized.includes("running in chroot")
    ) {
      throw new Error(`systemd_unavailable:${stderr}`);
    }
    throw new Error(`systemctl_failed:${stderr}`);
  }
}

async function generatePosturePsk(config) {
  const { stdout } = await execPostureCli(config, ["mcp-generate-psk"]);
  const psk = extractFirstContentLine(stdout);
  if (!psk || psk.length < 32) {
    throw new Error("posture_cli_generate_psk_failed");
  }
  return psk;
}

async function startPostureHost(config, { endpoint, psk }) {
  const parsedEndpoint = parseLocalEndpoint(endpoint);
  const args = ["mcp-start", String(parsedEndpoint.port), psk];
  if (parsedEndpoint.allInterfaces) {
    args.push("--all-interfaces");
  }
  const { stdout } = await execPostureCli(config, args);
  return {
    ...parsePostureStart(stdout),
    endpoint: parsedEndpoint.endpoint,
    allInterfaces: parsedEndpoint.allInterfaces,
  };
}

async function stopPostureHost(config) {
  const { stdout } = await execPostureCli(config, ["mcp-stop"]);
  const summary = String(stdout || "").includes("[OK] MCP server stopped")
    ? "Stopped local posture MCP."
    : "Requested local posture MCP stop.";
  return { summary };
}

async function readStoredPsk(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const psk = raw.trim();
    if (!psk) throw new Error("missing_stored_psk");
    return psk;
  } catch (_error) {
    throw new Error("missing_stored_psk");
  }
}

function hasBehavioralModel(behavioralModel) {
  return (
    !!behavioralModel &&
    !(
      Object.prototype.hasOwnProperty.call(behavioralModel, "model") &&
      behavioralModel.model === null
    )
  );
}

function contributorCount(behavioralModel) {
  if (!hasBehavioralModel(behavioralModel)) return 0;
  if (Array.isArray(behavioralModel?.contributors)) return behavioralModel.contributors.length;
  return 1;
}

function extractScoreValue(score) {
  if (typeof score === "number" && Number.isFinite(score)) return score;
  if (!score || typeof score !== "object") return null;

  for (const key of ["score", "overall_score", "overallScore", "value", "total"]) {
    const candidate = score[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  return null;
}

function compactExtrapolatorState(state) {
  const lastReasons = Array.isArray(state?.lastReasons) ? state.lastReasons : [];
  return {
    lastRunAt: state?.lastRunAt || null,
    lastReasons,
    lastError:
      typeof state?.lastError === "string" && state.lastError.trim() ? state.lastError.trim() : null,
    lastWindowHash:
      typeof state?.lastWindowHash === "string" && state.lastWindowHash.trim()
        ? state.lastWindowHash.trim()
        : null,
    lastPayloadHash:
      typeof state?.lastPayloadHash === "string" && state.lastPayloadHash.trim()
        ? state.lastPayloadHash.trim()
        : null,
    lastAttemptCount: Number.isFinite(state?.lastAttemptCount) ? state.lastAttemptCount : null,
    lastRetryCount: Number.isFinite(state?.lastRetryCount) ? state.lastRetryCount : null,
    authFailed: lastReasons.includes("edamame_mcp_auth_failed"),
  };
}

function compactPosture(snapshot) {
  if (!snapshot) return null;
  return {
    summary: postureSummary(snapshot),
    verdict: snapshot.verdictLabel || "NO_VERDICT",
    engineRunning: snapshot.engineStatus?.running === true,
    score: extractScoreValue(snapshot.score),
    todosCount: Array.isArray(snapshot.todos) ? snapshot.todos.length : 0,
    anomalousCount: Array.isArray(snapshot.anomalousSessions) ? snapshot.anomalousSessions.length : 0,
    blacklistedCount: Array.isArray(snapshot.blacklistedSessions) ? snapshot.blacklistedSessions.length : 0,
    behavioralModelPresent: hasBehavioralModel(snapshot.behavioralModel),
    contributorCount: contributorCount(snapshot.behavioralModel),
  };
}

function compactHealthDetail(name, detail) {
  if (name === "behavioral.model") {
    return {
      present: hasBehavioralModel(detail),
      contributorCount: contributorCount(detail),
      hash:
        typeof detail?.hash === "string" && detail.hash.trim() ? detail.hash.trim() : null,
    };
  }

  if (name === "divergence.engine") {
    return {
      running: detail?.running === true,
      status:
        typeof detail?.status === "string" && detail.status.trim() ? detail.status.trim() : null,
    };
  }

  if (name === "hermes.extrapolator") {
    return compactExtrapolatorState(detail);
  }

  if (name === "mcp.endpoint" || name === "mcp.authentication") {
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
      return detail;
    }
    return {
      endpoint:
        typeof detail.endpoint === "string" && detail.endpoint.trim() ? detail.endpoint.trim() : null,
      status:
        typeof detail.status === "string" && detail.status.trim() ? detail.status.trim() : null,
      reason:
        typeof detail.reason === "string" && detail.reason.trim() ? detail.reason.trim() : null,
      summary:
        typeof detail.summary === "string" && detail.summary.trim() ? detail.summary.trim() : null,
      message:
        typeof detail.message === "string" && detail.message.trim() ? detail.message.trim() : null,
      recovery:
        typeof detail.recovery === "string" && detail.recovery.trim() ? detail.recovery.trim() : null,
      failedTool:
        typeof detail.failedTool === "string" && detail.failedTool.trim()
          ? detail.failedTool.trim()
          : null,
    };
  }

  return detail;
}

function compactHealth(health) {
  const checks = Array.isArray(health?.checks) ? health.checks : [];
  return {
    ok: health?.ok === true,
    checks: checks.map((check) => ({
      name: check.name,
      ok: check.ok === true,
      detail: compactHealthDetail(check.name, check.detail),
    })),
  };
}

export function isPostureSystemServiceExpected(serviceManager) {
  if (serviceManager?.applicable !== true) return false;
  if (serviceManager?.available === true) return true;
  const error = String(serviceManager?.error || "");
  if (error.startsWith("systemctl_not_found:") || error.startsWith("systemd_unavailable:")) {
    return false;
  }
  return false;
}

export function isPostureSystemServiceReady(serviceManager) {
  return (
    serviceManager?.applicable === true &&
    serviceManager?.available === true &&
    !serviceManager?.error &&
    serviceManager?.unitLoaded === true &&
    serviceManager?.enabled === true &&
    serviceManager?.active === true &&
    serviceManager?.wrapperPresent !== false &&
    serviceManager?.configPresent !== false
  );
}

function summarizePostureSystemService(serviceManager) {
  if (serviceManager.applicable === false) {
    return "System service checks are only relevant for the edamame_posture host path.";
  }
  if (serviceManager.available === false) {
    return serviceManager.error?.startsWith("systemd_unavailable:")
      ? "systemd is not available on this host, so service readiness cannot be verified."
      : "systemctl is not available, so the Debian service path cannot be verified.";
  }
  if (serviceManager.error) {
    return `Unable to query service readiness: ${serviceManager.error}`;
  }

  const issues = [];
  if (serviceManager.unitLoaded === false) issues.push("service unit not loaded");
  if (serviceManager.enabled === false) issues.push("service not enabled");
  if (serviceManager.active === false) issues.push("service not active");
  if (serviceManager.unitLoaded === null) issues.push("service unit state unavailable");
  if (serviceManager.enabled === null) issues.push("service enablement state unavailable");
  if (serviceManager.active === null) issues.push("service activity state unavailable");
  if (serviceManager.wrapperPresent === false) issues.push("wrapper script missing");
  if (serviceManager.configPresent === false) issues.push("config file missing");

  if (issues.length === 0) {
    return "The edamame_posture systemd service looks installed and active.";
  }
  return `Service readiness needs attention: ${issues.join(", ")}.`;
}

export async function readPostureSystemServiceStatus(config, hostKind) {
  const wrapperPath = String(config?.postureDaemonWrapperPath || "/usr/bin/edamame_posture_daemon.sh").trim();
  const configPath = String(config?.postureConfigPath || "/etc/edamame_posture.conf").trim();
  const wrapperPresent = wrapperPath ? await fileExists(wrapperPath) : null;
  const configPresent = configPath ? await fileExists(configPath) : null;

  if (hostKind !== "edamame_posture") {
    return {
      applicable: false,
      available: null,
      command: null,
      serviceName: POSTURE_SYSTEMD_SERVICE,
      loadState: null,
      unitFileState: null,
      activeState: null,
      unitLoaded: null,
      enabled: null,
      active: null,
      wrapperPath,
      wrapperPresent,
      configPath,
      configPresent,
      summary: "System service checks are only relevant for the edamame_posture host path.",
      error: null,
    };
  }

  const command = systemctlCommand(config);
  if (!command) {
    return {
      applicable: true,
      available: false,
      command: null,
      serviceName: POSTURE_SYSTEMD_SERVICE,
      loadState: null,
      unitFileState: null,
      activeState: null,
      unitLoaded: null,
      enabled: null,
      active: null,
      wrapperPath,
      wrapperPresent,
      configPath,
      configPresent,
      summary: "Set `systemctl_command` if `systemctl` is not available on PATH.",
      error: "systemctl_command_unconfigured",
    };
  }

  try {
    const { stdout } = await execSystemctl(config, [
      "show",
      POSTURE_SYSTEMD_SERVICE,
      "--property=LoadState,UnitFileState,ActiveState",
      "--no-page",
    ]);
    const parsed = parseKeyValueLines(stdout);
    const serviceManager = {
      applicable: true,
      available: true,
      command,
      serviceName: POSTURE_SYSTEMD_SERVICE,
      loadState: parsed.LoadState || null,
      unitFileState: parsed.UnitFileState || null,
      activeState: parsed.ActiveState || null,
      unitLoaded: parsed.LoadState ? parsed.LoadState === "loaded" : null,
      enabled: parsed.UnitFileState ? parsed.UnitFileState === "enabled" : null,
      active: parsed.ActiveState ? parsed.ActiveState === "active" : null,
      wrapperPath,
      wrapperPresent,
      configPath,
      configPresent,
      error: null,
    };
    serviceManager.summary = summarizePostureSystemService(serviceManager);
    return serviceManager;
  } catch (error) {
    const message = String(error?.message || error);
    const serviceManager = {
      applicable: true,
      available:
        !message.startsWith("systemctl_not_found:") &&
        !message.startsWith("systemd_unavailable:"),
      command,
      serviceName: POSTURE_SYSTEMD_SERVICE,
      loadState: null,
      unitFileState: null,
      activeState: null,
      unitLoaded: null,
      enabled: null,
      active: null,
      wrapperPath,
      wrapperPresent,
      configPath,
      configPresent,
      error: message,
    };
    serviceManager.summary = summarizePostureSystemService(serviceManager);
    return serviceManager;
  }
}

async function readHostControllerStatus(config, hostKind) {
  const serviceManager = await readPostureSystemServiceStatus(config, hostKind);
  if (hostKind !== "edamame_posture") {
    return {
      supported: false,
      available: null,
      command: null,
      running: null,
      port: null,
      url: null,
      summary: "Automatic host control is available only for the edamame_posture path.",
      serviceManager,
      error: null,
    };
  }

  const command = postureCliCommand(config);
  if (!command) {
    return {
      supported: true,
      available: false,
      command: null,
      running: null,
      port: null,
      url: null,
      summary: "Set `posture_cli_command` if `edamame_posture` is not available on PATH.",
      serviceManager,
      error: "posture_cli_command_unconfigured",
    };
  }

  try {
    const { stdout } = await execPostureCli(config, ["mcp-status"]);
    return {
      supported: true,
      available: true,
      command,
      serviceManager,
      error: null,
      ...parsePostureStatus(stdout),
    };
  } catch (error) {
    const message = String(error?.message || error);
    if (message.startsWith("posture_cli_not_found:")) {
      return {
        supported: true,
        available: false,
        command,
        running: null,
        port: null,
        url: null,
        summary: `The configured posture CLI is not available: ${command}`,
        serviceManager,
        error: message,
      };
    }
    return {
      supported: true,
      available: true,
      command,
      running: null,
      port: null,
      url: null,
      summary: "Unable to query local posture MCP status.",
      serviceManager,
      error: message,
    };
  }
}

function pairingInstructions(hostKind) {
  if (hostKind === "edamame_posture") {
    return {
      title: "Linux pairing",
      summary:
        "Use the automatic posture actions below, or run the CLI manually to generate a PSK, start the local MCP server, and store the same PSK here.",
      steps: [
        "Prefer `Generate, start, and pair automatically` to provision the local posture host without echoing the PSK back into tool results.",
        "If you already have a PSK, paste it here and use `Start host` or `Save pairing only`.",
        "Manual fallback: run `edamame_posture mcp-generate-psk`, then `edamame_posture mcp-start 3000 \"<PSK>\"`.",
        "Use Refresh status or the healthcheck script to confirm the endpoint is healthy.",
      ],
      commands: [
        "edamame_posture mcp-generate-psk",
        "edamame_posture mcp-start 3000 \"<PSK>\"",
      ],
    };
  }

  return {
    title: "App pairing",
    summary:
      "Use 'Request pairing from app' for one-click setup, or paste a PSK manually as a fallback.",
    steps: [
      "Open the EDAMAME Security app and ensure its local MCP server is enabled on port 3000.",
      "Click 'Request pairing from app' below -- then approve the pairing request in the EDAMAME app.",
      "The per-client credential is stored automatically on approval.",
      "Fallback: generate a PSK from the app's MCP controls, paste it here, and store manually.",
      "Use Refresh status or the healthcheck script to confirm the endpoint is healthy.",
    ],
    commands: [],
  };
}

function baselineConfigJson(config) {
  return {
    workspace_root: config.workspaceRoot,
    hermes_sessions_root: config.hermesSessionsRoot,
    transcript_project_hints: config.transcriptProjectHints,
    transcript_limit: config.transcriptLimit,
    transcript_recency_hours: config.transcriptRecencyHours,
    transcript_active_window_minutes: config.transcriptActiveWindowMinutes,
    state_dir: config.stateDir,
    agent_type: config.agentType,
    agent_instance_id: config.agentInstanceId,
    host_kind: normalizeHostKind(config.hostKind || defaultHostKind()),
    posture_cli_command: config.postureCliCommand,
    edamame_mcp_endpoint: config.edamameMcpEndpoint,
    edamame_mcp_psk_file: config.edamameMcpPskFile,
    divergence_interval_secs: config.divergenceIntervalSecs,
    verdict_history_limit: config.verdictHistoryLimit,
    hermes_llm_hosts: config.hermesLlmHosts,
    debug_bridge_log: config.debugBridgeLog,
    debug_bridge_log_file: config.debugBridgeLogFile,
  };
}

function setConfigValue(target, snakeKey, camelKey, value) {
  const hasSnake = Object.prototype.hasOwnProperty.call(target, snakeKey);
  const hasCamel = Object.prototype.hasOwnProperty.call(target, camelKey);

  if (hasSnake) target[snakeKey] = value;
  if (hasCamel) target[camelKey] = value;
  if (!hasSnake && !hasCamel) target[snakeKey] = value;
}

function authFailureFromHealth(health) {
  const checks = Array.isArray(health?.checks) ? health.checks : [];
  for (const check of checks) {
    if (check?.ok === true) continue;
    const detail = check?.detail;
    if (
      check?.name === "mcp.authentication" ||
      (check?.name === "mcp.endpoint" && detail?.reason === "edamame_mcp_auth_failed")
    ) {
      return detail || {};
    }
  }
  return null;
}

function authFailureFromRefreshLike(value) {
  const reasons = Array.isArray(value?.reasons)
    ? value.reasons
    : Array.isArray(value?.lastReasons)
      ? value.lastReasons
      : [];
  if (!reasons.includes("edamame_mcp_auth_failed")) return null;
  return {
    summary:
      "The stored MCP PSK was rejected by EDAMAME. Generate a fresh PSK and save pairing again.",
    message:
      typeof value?.error === "string" && value.error.trim()
        ? value.error.trim()
        : typeof value?.lastError === "string" && value.lastError.trim()
          ? value.lastError.trim()
          : null,
  };
}

function summaryLine({ pairingConfigured, posture, health, hostActionResult, refreshResult, extrapolator }) {
  if (hostActionResult?.summary) return hostActionResult.summary;
  if (!pairingConfigured) return "Pair the local Hermes bridge with EDAMAME to enable status reads.";
  const authFailure =
    authFailureFromHealth(health) ||
    authFailureFromRefreshLike(refreshResult) ||
    authFailureFromRefreshLike(extrapolator);
  if (authFailure?.summary) return authFailure.summary;
  if (posture?.summary) return posture.summary;
  if (health?.ok === true) return "Pairing looks healthy.";
  return "Pairing is stored locally, but EDAMAME is not healthy yet.";
}

export async function buildControlCenterPayload(config, options = {}) {
  const hostKind = normalizeHostKind(options.hostKind || config.hostKind || defaultHostKind());
  let refreshResult = null;

  if (options.refreshNow === true) {
    try {
      refreshResult = await runLatestExtrapolation(config);
    } catch (error) {
      refreshResult = {
        success: false,
        upserted: false,
        reasons: ["unexpected_refresh_error"],
        error: String(error?.message || error),
      };
    }
  }

  const pairingConfigured = await fileExists(config.edamameMcpPskFile);
  const extrapolatorState = compactExtrapolatorState(
    await loadState(config, "hermes-extrapolator", {}),
  );
  const hostController = await readHostControllerStatus(config, hostKind);

  let health = null;
  try {
    health = await runHealthcheck(config, { strict: false });
  } catch (error) {
    health = {
      ok: false,
      checks: [
        {
          name: "control_center.health",
          ok: false,
          detail: String(error?.message || error),
        },
      ],
    };
  }

  const posture = compactPosture(health?.snapshot || null);

  return {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    hostKind,
    summaryLine: summaryLine({
      pairingConfigured,
      posture,
      health,
      hostActionResult: options.hostActionResult || null,
      refreshResult,
      extrapolator: extrapolatorState,
    }),
    config: {
      configPath: config.configPath || defaultConfigPath(),
      workspaceRoot: config.workspaceRoot,
      hermesSessionsRoot: config.hermesSessionsRoot,
      stateDir: config.stateDir,
      endpoint: config.edamameMcpEndpoint,
      pskFile: config.edamameMcpPskFile,
      hostKind,
      postureCliCommand: config.postureCliCommand || null,
    },
    pairing: {
      configured: pairingConfigured,
      instructions: pairingInstructions(hostKind),
      actions: {
        manualSaveSupported: true,
        appPairingSupported: hostKind === "edamame_app",
        autoPairSupported: hostKind === "edamame_posture" && hostController.available === true,
        startSupported: hostKind === "edamame_posture" && hostController.available === true,
        stopSupported: hostKind === "edamame_posture" && hostController.available === true,
      },
    },
    hostController,
    extrapolator: extrapolatorState,
    posture,
    health: compactHealth(health),
    refreshResult,
    hostActionResult: options.hostActionResult || null,
  };
}

export async function applyPairing(config, args = {}) {
  const psk = String(args.psk || "").trim();
  if (!psk) {
    throw new Error("missing_psk");
  }

  const configPath = path.resolve(String(config.configPath || defaultConfigPath()));
  const endpoint = String(args.endpoint || config.edamameMcpEndpoint || "").trim() || "http://127.0.0.1:3000/mcp";
  const hostKind = normalizeHostKind(args.host_kind || config.hostKind || defaultHostKind());
  const pskFile = path.resolve(
    String(config.edamameMcpPskFile || path.join(config.stateDir, "edamame-mcp.psk")),
  );

  await ensureDirectory(path.dirname(pskFile));
  await fs.writeFile(pskFile, `${psk}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(pskFile, 0o600).catch(() => {});

  try {
    const extState = await loadState(config, "hermes-extrapolator", {});
    if (
      (Array.isArray(extState.lastReasons) &&
        extState.lastReasons.includes("edamame_mcp_auth_failed")) ||
      (typeof extState.lastError === "string" &&
        extState.lastError.includes("auth"))
    ) {
      extState.lastReasons = [];
      extState.lastError = null;
      await saveState(config, "hermes-extrapolator", extState);
    }
  } catch (_e) {
    // Non-fatal: stale state will be overwritten on the next extrapolation cycle.
  }

  const existingConfig = (await readJsonFile(configPath, {})) || {};
  const nextConfig = {
    ...baselineConfigJson(config),
    ...existingConfig,
  };

  setConfigValue(nextConfig, "host_kind", "hostKind", hostKind);
  setConfigValue(nextConfig, "edamame_mcp_endpoint", "edamameMcpEndpoint", endpoint);
  setConfigValue(nextConfig, "edamame_mcp_psk_file", "edamameMcpPskFile", pskFile);

  await writeJsonFile(configPath, nextConfig);

  const reloadedConfig = await loadConfig({ configPath });
  const payload = await buildControlCenterPayload(reloadedConfig);
  payload.lastPairing = {
    appliedAt: new Date().toISOString(),
    configPath,
    pskFile,
  };
  return payload;
}

const PAIRING_POLL_INTERVAL_MS = 2000;
const PAIRING_TIMEOUT_MS = 60_000;
const APP_PAIRING_CLIENT_NAME = "EDAMAME for Hermes";

export async function requestAppPairing(config, args = {}) {
  const endpoint = String(args.endpoint || config.edamameMcpEndpoint || "").trim() || "http://127.0.0.1:3000/mcp";
  const baseUrl = endpoint.replace(/\/mcp\/?$/, "");
  const pairUrl = `${baseUrl}/mcp/pair`;

  const body = {
    client_name: String(args.client_name || config.clientName || APP_PAIRING_CLIENT_NAME).trim(),
    agent_type: String(config.agentType || "hermes"),
    agent_instance_id: String(config.agentInstanceId || "unknown"),
    requested_endpoint: endpoint,
    workspace_hint: config.workspaceRoot || null,
  };

  const res = await fetch(pairUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`pairing_request_failed:${res.status} ${text.slice(0, 200)}`);
  }

  const { request_id } = await res.json();
  if (!request_id) throw new Error("pairing_request_no_id");

  const deadline = Date.now() + PAIRING_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, PAIRING_POLL_INTERVAL_MS));

    const statusRes = await fetch(`${pairUrl}/${request_id}`).catch(() => null);
    if (!statusRes || !statusRes.ok) continue;

    const statusBody = await statusRes.json().catch(() => null);
    if (!statusBody) continue;

    if (statusBody.status === "approved" && statusBody.credential) {
      const payload = await applyPairing(config, {
        host_kind: "edamame_app",
        endpoint,
        psk: statusBody.credential,
      });
      payload.pairingMethod = "app_mediated";
      return payload;
    }

    if (statusBody.status === "rejected") {
      throw new Error("pairing_rejected");
    }

    if (statusBody.status === "expired") {
      throw new Error("pairing_expired");
    }
  }

  throw new Error("pairing_timeout");
}

export async function runHostAction(config, args = {}) {
  const action = String(args.action || "").trim();
  const hostKind = normalizeHostKind(args.host_kind || config.hostKind || defaultHostKind());
  const endpoint = String(args.endpoint || config.edamameMcpEndpoint || LOCAL_MCP_ENDPOINT).trim() || LOCAL_MCP_ENDPOINT;

  if (hostKind !== "edamame_posture") {
    throw new Error(`host_action_not_supported:${hostKind}`);
  }

  if (!["generate_and_start", "start", "stop"].includes(action)) {
    throw new Error(`unknown_host_action:${action}`);
  }

  if (action === "generate_and_start") {
    const psk = await generatePosturePsk(config);
    const startResult = await startPostureHost(config, { endpoint, psk });
    const payload = await applyPairing(config, {
      host_kind: hostKind,
      endpoint,
      psk,
    });
    payload.hostActionResult = {
      action,
      ok: true,
      summary: "Generated a new PSK, started the local posture MCP endpoint, and stored the pairing locally.",
      endpoint: startResult.endpoint,
      url: startResult.url,
      port: startResult.port,
    };
    return payload;
  }

  if (action === "start") {
    const providedPsk = String(args.psk || "").trim();
    const psk = providedPsk || (await readStoredPsk(config.edamameMcpPskFile));
    const startResult = await startPostureHost(config, { endpoint, psk });
    let payload;
    if (providedPsk) {
      payload = await applyPairing(config, {
        host_kind: hostKind,
        endpoint,
        psk,
      });
    } else {
      const reloadedConfig = await loadConfig({ configPath: config.configPath });
      payload = await buildControlCenterPayload(reloadedConfig);
    }
    payload.hostActionResult = {
      action,
      ok: true,
      summary: providedPsk
        ? "Started the local posture MCP endpoint and stored the pasted PSK locally."
        : "Started the local posture MCP endpoint using the stored PSK.",
      endpoint: startResult.endpoint,
      url: startResult.url,
      port: startResult.port,
    };
    return payload;
  }

  const stopResult = await stopPostureHost(config);
  const reloadedConfig = await loadConfig({ configPath: config.configPath });
  const payload = await buildControlCenterPayload(reloadedConfig);
  payload.hostActionResult = {
    action,
    ok: true,
    summary: stopResult.summary,
  };
  return payload;
}
