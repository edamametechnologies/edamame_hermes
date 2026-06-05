#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function expandHome(value) {
  if (!value || typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function defaultConfigDir() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "hermes-edamame");
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      "hermes-edamame",
    );
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "hermes-edamame");
}

export function defaultStateDir() {
  if (process.platform === "darwin") {
    return path.join(defaultConfigDir(), "state");
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "hermes-edamame",
      "state",
    );
  }
  return path.join(
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"),
    "hermes-edamame",
  );
}

export function defaultConfigPath() {
  return path.join(defaultConfigDir(), "config.json");
}

function defaultAgentInstanceId(workspaceRoot) {
  const normalizedRoot = path.resolve(workspaceRoot || process.cwd());
  const workspaceHash = crypto.createHash("sha256").update(normalizedRoot, "utf8").digest("hex").slice(0, 12);
  return `${os.hostname()}-${workspaceHash}`;
}

export function defaultHostKind() {
  return process.platform === "linux" ? "edamame_posture" : "edamame_app";
}

export function defaultPostureCliCommand() {
  if (typeof process.env.EDAMAME_POSTURE_COMMAND === "string") {
    const override = process.env.EDAMAME_POSTURE_COMMAND.trim();
    if (override) return override;
  }
  return process.platform === "linux" ? "edamame_posture" : "";
}

export function defaultSystemctlCommand() {
  if (typeof process.env.HERMES_EDAMAME_SYSTEMCTL_COMMAND === "string") {
    const override = process.env.HERMES_EDAMAME_SYSTEMCTL_COMMAND.trim();
    if (override) return override;
  }
  return "systemctl";
}

export const DEFAULT_CONFIG = Object.freeze({
  workspaceRoot: process.cwd(),
  hermesSessionsRoot: path.join(process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"), "sessions"),
  transcriptProjectHints: [],
  transcriptLimit: 6,
  transcriptRecencyHours: 48,
  transcriptActiveWindowMinutes: 5,
  stateDir: defaultStateDir(),
  agentType: "hermes",
  agentInstanceId: defaultAgentInstanceId(process.cwd()),
  hostKind: defaultHostKind(),
  postureCliCommand: defaultPostureCliCommand(),
  systemctlCommand: defaultSystemctlCommand(),
  postureDaemonWrapperPath: "/usr/bin/edamame_posture_daemon.sh",
  postureConfigPath: "/etc/edamame_posture.conf",
  edamameMcpEndpoint: process.env.EDAMAME_MCP_ENDPOINT || "http://127.0.0.1:3000/mcp",
  edamameMcpPskFile:
    process.env.EDAMAME_MCP_PSK_FILE || path.join(defaultStateDir(), "edamame-mcp.psk"),
  divergenceIntervalSecs: 120,
  verdictHistoryLimit: 10,
  // Keep in sync with HERMES_LLM_HOSTS in
  // edamame_foundation/src/agent_transcripts/hermes.rs (L1 host observer).
  hermesLlmHosts: [
    "api.anthropic.com:443",
    "api.openai.com:443",
    "openrouter.ai:443",
    "api.nousresearch.com:443",
    "inference.nousresearch.com:443",
    // Hermes/Nous LLM traffic routes through AWS + Cloudflare. Many sessions
    // resolve only to raw IPs without reverse DNS, so domain suffix matching
    // against amazonaws.com misses them; ASN matching catches the rest.
    "amazonaws.com:443",
    "asn:CLOUDFLARENET",
    "asn:AMAZON",
  ],
  scopeProcessPaths: [],
  // Keep in sync with HERMES_SCOPE_PARENT_PATHS in
  // edamame_foundation/src/agent_transcripts/hermes.rs (L1 host observer).
  scopeParentPaths: [
    // Hermes launchers (Unix-style separators)
    "*/hermes",
    "*/bin/hermes",
    "/usr/bin/hermes",
    "/usr/local/bin/hermes",
    "*/.hermes/",
    "*/.local/bin/hermes",
    // Hermes uses Python plugins + an embedded Node MCP bridge
    "*/python",
    "*/python3",
    "*/.venv/bin/python",
    "*/node",
    // Windows L7 paths (backslashes; see divergence_engine rule_matches)
    "*\\hermes.exe",
    "*\\hermes.cmd",
    "*\\bin\\hermes",
    "*\\python.exe",
    "*\\node.exe",
    // Linux: snap
    "*/snap/hermes/",
    "/snap/bin/hermes",
    // MCP bridge
    "*/hermes_edamame_mcp.mjs",
  ],
  scopeGrandparentPaths: [],
  scopeAnyLineagePaths: [],
  debugBridgeLog: false,
  debugBridgeLogFile: path.join(defaultStateDir(), "bridge-debug.log"),
});

function toArray(value) {
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim());
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function toBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function firstDefined(source, ...keys) {
  for (const key of keys) {
    if (source && source[key] !== undefined && source[key] !== null) {
      return source[key];
    }
  }
  return undefined;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function inferTranscriptHints(workspaceRoot, explicitHints) {
  const hints = [...explicitHints];
  if (!workspaceRoot) return uniqueStrings(hints);

  const baseName = path.basename(workspaceRoot);
  if (baseName) {
    hints.push(baseName);
    hints.push(`${baseName}.code-workspace`);
    hints.push(baseName.replace(/[_\s]+/g, "-"));
  }

  const parentName = path.basename(path.dirname(workspaceRoot));
  if (parentName) {
    hints.push(`${parentName}-${baseName}`);
  }

  hints.push("code-workspace");
  return uniqueStrings(hints);
}

function toPositiveNumberOrDefault(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toPositiveIntOrDefault(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeConfig(raw = {}, overrides = {}) {
  const merged = { ...raw, ...overrides };
  const configuredScopeProcessPaths = toArray(
    firstDefined(merged, "scopeProcessPaths", "scope_process_paths"),
  );
  const configuredScopeParentPaths = toArray(
    firstDefined(merged, "scopeParentPaths", "scope_parent_paths"),
  );
  const configuredScopeGrandparentPaths = toArray(
    firstDefined(merged, "scopeGrandparentPaths", "scope_grandparent_paths"),
  );
  const configuredScopeAnyLineagePaths = toArray(
    firstDefined(merged, "scopeAnyLineagePaths", "scope_any_lineage_paths"),
  );
  const workspaceRoot = path.resolve(
    expandHome(firstDefined(merged, "workspaceRoot", "workspace_root")) || DEFAULT_CONFIG.workspaceRoot,
  );
  const agentType = String(firstDefined(merged, "agentType", "agent_type") || DEFAULT_CONFIG.agentType).trim() ||
    DEFAULT_CONFIG.agentType;
  const agentInstanceId =
    String(firstDefined(merged, "agentInstanceId", "agent_instance_id") || defaultAgentInstanceId(workspaceRoot))
      .trim() || defaultAgentInstanceId(workspaceRoot);
  const hostKind =
    String(firstDefined(merged, "hostKind", "host_kind") || DEFAULT_CONFIG.hostKind).trim() ||
    DEFAULT_CONFIG.hostKind;
  const postureCliCommand =
    String(firstDefined(merged, "postureCliCommand", "posture_cli_command") || DEFAULT_CONFIG.postureCliCommand).trim() ||
    DEFAULT_CONFIG.postureCliCommand;
  const systemctlCommand =
    String(firstDefined(merged, "systemctlCommand", "systemctl_command") || DEFAULT_CONFIG.systemctlCommand).trim() ||
    DEFAULT_CONFIG.systemctlCommand;
  const explicitHints = toArray(
    firstDefined(merged, "transcriptProjectHints", "transcript_project_hints"),
  );

  return {
    workspaceRoot,
    hermesSessionsRoot: path.resolve(
      expandHome(firstDefined(merged, "hermesSessionsRoot", "hermes_sessions_root")) ||
        DEFAULT_CONFIG.hermesSessionsRoot,
    ),
    transcriptProjectHints: inferTranscriptHints(workspaceRoot, explicitHints),
    transcriptLimit: toPositiveIntOrDefault(firstDefined(merged, "transcriptLimit", "transcript_limit"), DEFAULT_CONFIG.transcriptLimit),
    transcriptRecencyHours:
      toPositiveNumberOrDefault(firstDefined(merged, "transcriptRecencyHours", "transcript_recency_hours"),
      DEFAULT_CONFIG.transcriptRecencyHours),
    transcriptActiveWindowMinutes:
      toPositiveNumberOrDefault(
        firstDefined(
          merged,
          "transcriptActiveWindowMinutes",
          "transcript_active_window_minutes",
        ),
      DEFAULT_CONFIG.transcriptActiveWindowMinutes),
    stateDir: path.resolve(
      expandHome(firstDefined(merged, "stateDir", "state_dir")) || DEFAULT_CONFIG.stateDir,
    ),
    agentType,
    agentInstanceId,
    hostKind,
    postureCliCommand,
    systemctlCommand,
    postureDaemonWrapperPath: path.resolve(
      expandHome(firstDefined(merged, "postureDaemonWrapperPath", "posture_daemon_wrapper_path")) ||
        DEFAULT_CONFIG.postureDaemonWrapperPath,
    ),
    postureConfigPath: path.resolve(
      expandHome(firstDefined(merged, "postureConfigPath", "posture_config_path")) ||
        DEFAULT_CONFIG.postureConfigPath,
    ),
    edamameMcpEndpoint:
      firstDefined(merged, "edamameMcpEndpoint", "edamame_mcp_endpoint") ||
      DEFAULT_CONFIG.edamameMcpEndpoint,
    edamameMcpPskFile: path.resolve(
      expandHome(firstDefined(merged, "edamameMcpPskFile", "edamame_mcp_psk_file")) ||
        DEFAULT_CONFIG.edamameMcpPskFile,
    ),
    divergenceIntervalSecs:
      toPositiveNumberOrDefault(firstDefined(merged, "divergenceIntervalSecs", "divergence_interval_secs"),
      DEFAULT_CONFIG.divergenceIntervalSecs),
    verdictHistoryLimit:
      toPositiveIntOrDefault(firstDefined(merged, "verdictHistoryLimit", "verdict_history_limit"),
      DEFAULT_CONFIG.verdictHistoryLimit),
    hermesLlmHosts: uniqueStrings(
      toArray(firstDefined(merged, "hermesLlmHosts", "hermes_llm_hosts")).concat(DEFAULT_CONFIG.hermesLlmHosts),
    ),
    scopeProcessPaths: uniqueStrings(
      configuredScopeProcessPaths.length > 0 ? configuredScopeProcessPaths : DEFAULT_CONFIG.scopeProcessPaths,
    ),
    scopeParentPaths: uniqueStrings(
      configuredScopeParentPaths.length > 0 ? configuredScopeParentPaths : DEFAULT_CONFIG.scopeParentPaths,
    ),
    scopeGrandparentPaths: uniqueStrings(
      configuredScopeGrandparentPaths.length > 0 ? configuredScopeGrandparentPaths : DEFAULT_CONFIG.scopeGrandparentPaths,
    ),
    scopeAnyLineagePaths: uniqueStrings(
      configuredScopeAnyLineagePaths.length > 0 ? configuredScopeAnyLineagePaths : DEFAULT_CONFIG.scopeAnyLineagePaths,
    ),
    debugBridgeLog: toBoolean(
      firstDefined(merged, "debugBridgeLog", "debug_bridge_log"),
      DEFAULT_CONFIG.debugBridgeLog,
    ),
    debugBridgeLogFile: path.resolve(
      expandHome(firstDefined(merged, "debugBridgeLogFile", "debug_bridge_log_file")) ||
        DEFAULT_CONFIG.debugBridgeLogFile,
    ),
  };
}

export async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readTextFileWithRetry(filePath, encoding = "utf8") {
  // Windows briefly locks a just-written file (Defender / search indexer / lazy
  // handle release), surfacing as EBUSY/EPERM on the next open. Retry with a
  // short backoff so freshly-written transcript/config reads survive that window.
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await fs.readFile(filePath, encoding);
    } catch (error) {
      if (error && (error.code === "EBUSY" || error.code === "EPERM")) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export async function readJsonFile(filePath, fallback = null) {
  try {
    const raw = await readTextFileWithRetry(filePath);
    return JSON.parse(raw);
  } catch (_error) {
    return fallback;
  }
}

export async function writeJsonFile(filePath, value) {
  await ensureDirectory(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function loadConfig(options = {}) {
  const configPath = path.resolve(expandHome(options.configPath || process.env.HERMES_EDAMAME_CONFIG || defaultConfigPath()));
  const fileConfig = (await readJsonFile(configPath, {})) || {};
  return {
    ...normalizeConfig(fileConfig, options.overrides || {}),
    configPath,
  };
}

export function stateFilePath(config, name) {
  return path.join(config.stateDir, `${name}.json`);
}

export async function loadState(config, name, fallback = {}) {
  return (await readJsonFile(stateFilePath(config, name), fallback)) || fallback;
}

export async function saveState(config, name, value) {
  await writeJsonFile(stateFilePath(config, name), value);
}

export function sha256(input) {
  return crypto.createHash("sha256").update(String(input), "utf8").digest("hex");
}

export function summarizeJson(value) {
  return JSON.stringify(value, null, 2);
}
