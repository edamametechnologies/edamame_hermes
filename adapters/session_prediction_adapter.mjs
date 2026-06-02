#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256 } from "../service/config.mjs";
import {
  collectExtraRawishSessions,
  latestExtraSourceMtimeMs,
} from "./hermes_session_source.mjs";

const SENSITIVE_PATH_PATTERNS = [
  "~/.ssh/*",
  "~/.aws/*",
  "~/.config/gcloud/*",
  "~/.kube/*",
  "~/.gnupg/*",
  "~/.docker/config.json",
  "~/.npmrc",
  "~/.netrc",
  "~/.env",
  "~/.env.*",
  "~/.pgpass",
  "~/.pypirc",
  "~/.git-credentials",
  "~/.vault-token",
  "~/.azure/*",
  "~/.my.cnf",
  "~/Library/Keychains/*",
  "~/Library/Application Support/Google/Chrome/*",
  "~/Library/Application Support/Chromium/*",
  "~/Library/Application Support/Firefox/*",
  "~/Library/Application Support/BraveSoftware/*",
  "~/AppData/Local/Google/Chrome/*",
  "~/AppData/Local/Google/Chrome/User Data/*",
  "~/AppData/Local/Chromium/*",
  "~/AppData/Local/Mozilla/Firefox/*",
  "~/AppData/Local/BraveSoftware/*",
  "~/AppData/Roaming/Mozilla/Firefox/Profiles/*",
  "~/AppData/Roaming/Microsoft/Credentials/*",
  "~/AppData/Roaming/Microsoft/Protect/*",
  "~/.config/google-chrome/*",
  "~/.config/chromium/*",
  "~/.mozilla/firefox/*",
];

const PATH_LIKE_REGEX = /(?:file:\/\/\/[^\s"'`)>]+|~\/[^\s"'`)>]+|\/[^\s"'`)>]+|[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.@-]+)+(?:\.[A-Za-z0-9_-]+)?)/g;
const APP_BUNDLE_PATH_REGEX = /\/(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@ ()-]+\.app\/Contents\/[A-Za-z0-9_.@ ()/-]*/g;
const WINDOWS_DRIVE_PATH_REGEX = /[A-Za-z]:[\\\/][^\s"'`)\]>]+/g;
const WINDOWS_SPACED_PATH_REGEX = /[A-Za-z]:\\(?:Program Files(?: \(x86\))?|ProgramData|Users\\[^\\]+\\AppData)(?:\\[A-Za-z0-9_.@ -]+)+/g;
const URL_REGEX = /\bhttps?:\/\/[^\s"'`)>]+/g;
const GIT_REMOTE_REGEX = /\bgit@([A-Za-z0-9.-]+):([^\s"'`)>]+)/g;
const PORT_REGEX = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b|\bport\s+(\d{2,5})\b|\b--port(?:=|\s+)(\d{2,5})\b|\bhttp\.server\s+(\d{2,5})\b|\b(\d{1,5})\/(?:tcp|udp)\b/gi;
const TOOL_CALL_REGEX = /^\[Tool call\]\s*(.+)$/gm;
const COMMAND_REGEX = /^\s*command:\s*(.+)$/gm;
const TOOL_NAME_ARG_REGEX = /^\s*toolName:\s*([A-Za-z0-9_.-]+)\s*$/gm;
const RECIPIENT_REGEX = /^\s*recipient_name:\s*([A-Za-z0-9_.-]+)\s*$/gm;
const HOME_DIR = os.homedir().replace(/\\/g, "/");

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function uniqueNumbers(values) {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0 && value < 65536))].sort(
    (left, right) => left - right,
  );
}

function basenameHint(workspaceRoot) {
  const base = path.basename(workspaceRoot || "");
  return base.toLowerCase();
}

function looksLikeHermesProjectPath(filePath, hints) {
  const normalized = filePath.toLowerCase();
  return hints.length === 0 || hints.some((hint) => normalized.includes(hint.toLowerCase()));
}

async function safeStat(filePath) {
  try {
    return await fs.stat(filePath);
  } catch (_error) {
    return null;
  }
}

async function walkFiles(rootDir, results = []) {
  let entries = [];
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (_error) {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "subagents" || entry.name === "tool-results") continue;
      await walkFiles(fullPath, results);
      continue;
    }
    if (entry.name.endsWith(".jsonl") || entry.name.endsWith(".txt")) {
      results.push(fullPath);
    }
  }

  return results;
}

async function candidateTranscriptFiles(config) {
  const allFiles = await walkFiles(config.hermesSessionsRoot);
  const recencyCutoff = Date.now() - config.transcriptRecencyHours * 60 * 60 * 1000;
  const hintCandidates = allFiles.filter((filePath) =>
    looksLikeHermesProjectPath(filePath, config.transcriptProjectHints || []),
  );
  const candidates = hintCandidates.length > 0 ? hintCandidates : allFiles;
  const resolved = [];

  for (const filePath of candidates) {
    const stat = await safeStat(filePath);
    if (!stat || stat.mtimeMs < recencyCutoff) continue;
    resolved.push({ filePath, stat });
  }

  return resolved;
}

function transcriptSessionId(filePath) {
  const baseName = path.basename(filePath);
  if (baseName.endsWith(".jsonl")) {
    return baseName.slice(0, -".jsonl".length);
  }
  if (baseName.endsWith(".txt")) {
    return baseName.slice(0, -".txt".length);
  }
  return baseName;
}

function transcriptFormat(filePath) {
  if (filePath.endsWith(".jsonl")) return "jsonl";
  return "txt";
}

function preferredTranscriptSource(candidate) {
  const txtMtimeMs = Number(candidate?.txtMtimeMs || 0);
  const jsonlMtimeMs = Number(candidate?.jsonlMtimeMs || 0);

  if (candidate?.txtPath && (!candidate?.jsonlPath || txtMtimeMs >= jsonlMtimeMs)) {
    return {
      sourcePath: candidate.txtPath,
      sourceFormat: "txt",
    };
  }

  if (candidate?.jsonlPath) {
    return {
      sourcePath: candidate.jsonlPath,
      sourceFormat: "jsonl",
    };
  }

  return {
    sourcePath: candidate?.txtPath || candidate?.jsonlPath || null,
    sourceFormat: candidate?.txtPath ? "txt" : "jsonl",
  };
}

function decodeFilePathToken(token, workspaceRoot) {
  let candidate = token.trim();
  if (!candidate || candidate.startsWith("http://") || candidate.startsWith("https://")) {
    return null;
  }

  candidate = candidate.replace(/[,.:;]+$/g, "");
  while (candidate.endsWith(")")) {
    const opens = (candidate.match(/\(/g) || []).length;
    const closes = (candidate.match(/\)/g) || []).length;
    if (closes > opens) {
      candidate = candidate.slice(0, -1);
    } else {
      break;
    }
  }
  if (candidate.startsWith("file:///")) {
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname);
    } catch (_error) {
      candidate = candidate.replace(/^file:\/\//, "");
    }
  }

  if (candidate.startsWith("~/")) {
    return candidate;
  }

  if (path.isAbsolute(candidate)) {
    return candidate;
  }

  if (candidate.includes("/") && !/^LINE_\d+\|/.test(candidate) && !/^L\d+:/.test(candidate)) {
    if (/\.git$/.test(candidate) && !candidate.startsWith("/") && !candidate.startsWith("~")) {
      return null;
    }
    return path.resolve(workspaceRoot, candidate);
  }

  return null;
}

function cleanTrailingPathJunk(p) {
  return p.replace(/[\s,.:;!?\\]+$/, "");
}

function extractPaths(text, workspaceRoot) {
  const seen = new Set();
  const paths = [];
  const rawAppTokens = [];

  function addPath(raw) {
    const cleaned = cleanTrailingPathJunk(raw);
    let normalized = decodeFilePathToken(cleaned, workspaceRoot);
    if (!normalized) return;
    normalized = normalized.replace(/\\/g, "/");
    if (seen.has(normalized)) return;
    seen.add(normalized);
    paths.push(normalized);
  }

  for (const m of text.matchAll(APP_BUNDLE_PATH_REGEX)) {
    rawAppTokens.push(cleanTrailingPathJunk(m[0]));
    addPath(m[0]);
  }

  for (const m of text.matchAll(PATH_LIKE_REGEX)) {
    const token = cleanTrailingPathJunk(m[0]);
    if (!token) continue;
    const isAppFragment =
      rawAppTokens.some((raw) => raw.includes(token) && raw !== token) ||
      paths.some((existing) => existing.includes(token) && existing !== token);
    if (isAppFragment) continue;
    addPath(m[0]);
  }

  for (const m of text.matchAll(WINDOWS_DRIVE_PATH_REGEX)) addPath(m[0]);
  for (const m of text.matchAll(WINDOWS_SPACED_PATH_REGEX)) addPath(m[0]);

  return paths;
}

function extractUrls(text) {
  return uniqueStrings(text.match(URL_REGEX) || []);
}

const DOMAIN_REGEX = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|dev|tech|cloud|co|info|biz|us|uk|eu|fr|de|app|xyz|me|ai|security|local))\b/gi;
const NMAP_INTERESTING_HOST_REGEX = /\bnmap\s+(?:(?:-[^\s]+|-[^\s]+\s+[^\s-][^\s]*)\s+)*([a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,})/g;
const RESOLVED_HOST_REGEX = /\b(?:Also\s+)?resolves?\s+to[:\s]+(\d{1,3}(?:\.\d{1,3}){3})/gi;
const RDNS_REGEX = /rDNS:\s*`?([a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,})`?/g;

function extractHostnamesFromText(text) {
  const hosts = new Set();
  for (const match of text.matchAll(DOMAIN_REGEX)) {
    const domain = match[1].toLowerCase();
    if (!domain.includes(".")) continue;
    if (domain.endsWith(".rs") || domain.endsWith(".py") || domain.endsWith(".js") || domain.endsWith(".ts") || domain.endsWith(".dart") || domain.endsWith(".md") || domain.endsWith(".toml") || domain.endsWith(".yaml") || domain.endsWith(".yml") || domain.endsWith(".json") || domain.endsWith(".html") || domain.endsWith(".css")) continue;
    hosts.add(domain);
  }
  return [...hosts];
}

function extractTraffic(text, commands, config) {
  const hosts = [];

  for (const urlText of extractUrls(text)) {
    try {
      const url = new URL(urlText);
      const port = url.port || (url.protocol === "http:" ? "80" : "443");
      hosts.push(`${url.hostname}:${port}`);
    } catch (_error) {
      // Ignore malformed URLs.
    }
  }

  for (const match of text.matchAll(GIT_REMOTE_REGEX)) {
    const host = match[1];
    if (host) hosts.push(`${host}:22`);
  }

  for (const host of config.hermesLlmHosts || []) {
    if (host.includes(":")) {
      hosts.push(host);
    } else {
      hosts.push(`${host}:443`);
    }
  }

  for (const domain of extractHostnamesFromText(text)) {
    hosts.push(`${domain}:443`);
  }

  for (const match of text.matchAll(NMAP_INTERESTING_HOST_REGEX)) {
    if (match[1]) hosts.push(`${match[1].toLowerCase()}:*`);
  }
  for (const match of text.matchAll(RESOLVED_HOST_REGEX)) {
    if (match[1]) hosts.push(`${match[1]}:*`);
  }
  for (const match of text.matchAll(RDNS_REGEX)) {
    if (match[1]) hosts.push(`${match[1].toLowerCase()}:443`);
  }

  for (const command of commands) {
    const lower = command.toLowerCase();
    if (lower.includes("cargo ") || lower.startsWith("cargo")) {
      hosts.push("crates.io:443", "static.crates.io:443", "github.com:443");
    }
    if (lower.includes("npm ") || lower.includes("pnpm ") || lower.includes("yarn ")) {
      hosts.push("registry.npmjs.org:443", "github.com:443");
    }
    if (lower.includes("pip ") || lower.includes("uv pip") || lower.includes("python -m pip")) {
      hosts.push("pypi.org:443", "files.pythonhosted.org:443");
    }
    if (lower.includes("git clone") || lower.includes("git fetch") || lower.includes("git pull")) {
      hosts.push("github.com:443");
    }
    if (lower.includes("docker pull") || lower.includes("docker build")) {
      hosts.push("registry-1.docker.io:443");
    }
    if (lower.startsWith("ssh ") || lower.startsWith("scp ") || lower.startsWith("rsync ")) {
      const hostMatch = command.match(/(?:@|ssh\s+)([a-zA-Z0-9.-]+)/);
      if (hostMatch?.[1]) hosts.push(`${hostMatch[1]}:22`);
    }
    if (lower.startsWith("nmap ")) {
      const target = command.match(/nmap\s+(?:-[^\s]+\s+)*([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
      if (target?.[1]) hosts.push(`${target[1].toLowerCase()}:*`);
    }
    if (lower.startsWith("ping ") || lower.startsWith("traceroute ") || lower.startsWith("dig ") || lower.startsWith("nslookup ")) {
      const target = command.match(/(?:ping|traceroute|dig|nslookup)\s+([a-zA-Z0-9.-]+)/i);
      if (target?.[1] && target[1].includes(".")) hosts.push(`${target[1].toLowerCase()}:*`);
    }
    if (lower.startsWith("curl ") || lower.startsWith("wget ")) {
      const urlMatch = command.match(/https?:\/\/([a-zA-Z0-9.-]+)/);
      if (urlMatch?.[1]) hosts.push(`${urlMatch[1].toLowerCase()}:443`);
    }
  }

  return uniqueStrings(hosts);
}

function extractPorts(text, commands) {
  const ports = [];

  for (const match of text.matchAll(PORT_REGEX)) {
    const portValue = match.slice(1).find(Boolean);
    if (portValue) {
      const parsed = Number.parseInt(portValue, 10);
      if (parsed > 0 && parsed < 65536) ports.push(parsed);
    }
  }

  for (const command of commands) {
    const explicit = command.match(/(?:--port(?:=|\s+)|-p\s+)(\d{2,5})/i);
    if (explicit?.[1]) ports.push(Number.parseInt(explicit[1], 10));

    const nmapPorts = command.match(/-p\s+([0-9,\s-]+)/i);
    if (nmapPorts?.[1]) {
      for (const segment of nmapPorts[1].split(",")) {
        const trimmed = segment.trim();
        const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
          const start = Number.parseInt(rangeMatch[1], 10);
          const end = Number.parseInt(rangeMatch[2], 10);
          if (end - start <= 100) {
            for (let port = start; port <= end; port += 1) {
              if (port > 0 && port < 65536) ports.push(port);
            }
          }
        } else {
          const port = Number.parseInt(trimmed, 10);
          if (port > 0 && port < 65536) ports.push(port);
        }
      }
    }
  }

  return uniqueNumbers(ports);
}

function normalizeSensitivePathCandidate(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  if (HOME_DIR && normalized.startsWith(`${HOME_DIR}/`)) {
    return `~/${normalized.slice(HOME_DIR.length + 1)}`;
  }
  return normalized;
}

function matchesSensitivePathPattern(candidate) {
  const normalizedCandidate = normalizeSensitivePathCandidate(candidate).toLowerCase();
  return SENSITIVE_PATH_PATTERNS.some((pattern) => {
    const normalizedPattern = pattern.replace(/\\/g, "/").toLowerCase();
    if (normalizedPattern.endsWith("/*")) {
      const base = normalizedPattern.slice(0, -2);
      return normalizedCandidate === base || normalizedCandidate.startsWith(`${base}/`);
    }
    return normalizedCandidate === normalizedPattern;
  });
}

function normalizeToolName(rawToolName) {
  const trimmed = String(rawToolName || "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("functions.")) return trimmed.replace(/^functions\./, "");
  return trimmed;
}

const HERMES_TOOL_NAMES = new Set([
  "Read", "ReadFile", "Write", "Bash", "Shell", "Grep", "StrReplace", "Glob", "Delete",
  "SemanticSearch", "EditNotebook", "Task", "Subagent", "WebSearch", "WebFetch",
  "GenerateImage", "ReadLints", "SwitchMode", "AskQuestion", "ApplyPatch",
  "CallMcpTool", "FetchMcpResource", "TodoWrite",
]);

const PROSE_COMMAND_REGEX =
  /\b(cargo\s+(?:build|test|run|check|clippy|fmt|bench|doc|publish|install|clean)(?:\s+[^\n]{0,120})?)/g;

const PROSE_COMMAND_PATTERNS = [
  /\b(flutter\s+(?:build|run|test|analyze|gen-l10n|pub\s+\w+)(?:\s+[^\n]{0,80})?)/g,
  /\b(git\s+(?:clone|pull|push|fetch|commit|checkout|merge|rebase|diff|status|log|stash|add|reset|branch)(?:\s+[^\n]{0,80})?)/g,
  /\b(npm\s+(?:install|run|test|build|publish|ci|start)(?:\s+[^\n]{0,80})?)/g,
  /\b(yarn\s+(?:install|add|test|build|start)(?:\s+[^\n]{0,80})?)/g,
  /\b(python3?\s+(?:-m\s+)?[^\s]+(?:\s+[^\n]{0,80})?)/g,
  /\b(make\s+\w+(?:\s+[^\n]{0,80})?)/g,
  /\b(docker\s+(?:build|run|pull|push|compose|exec)(?:\s+[^\n]{0,80})?)/g,
  /\b(curl\s+[^\n]{0,120})/g,
  /\b(wget\s+[^\n]{0,120})/g,
  /\b(sudo\s+\w+(?:\s+[^\n]{0,80})?)/g,
  /\b(nmap(?:\s+[^\n]{0,120})?)/g,
  /\b(ping\s+[^\n]{0,80})/g,
  /\b(traceroute\s+[^\n]{0,80})/g,
  /\b(dig\s+[^\n]{0,80})/g,
  /\b(nslookup\s+[^\n]{0,80})/g,
  /\b(ssh\s+[^\n]{0,120})/g,
  /\b(scp\s+[^\n]{0,120})/g,
  /\b(rsync\s+[^\n]{0,120})/g,
  /\b(nc\s+[^\n]{0,80})/g,
  /\b(netcat\s+[^\n]{0,80})/g,
  /\b(openssl\s+[^\n]{0,120})/g,
  /\b(tcpdump\s+[^\n]{0,120})/g,
  /\b(kubectl\s+(?:get|apply|delete|describe|logs|exec|port-forward)(?:\s+[^\n]{0,80})?)/g,
  /\b(terraform\s+(?:init|plan|apply|destroy|validate)(?:\s+[^\n]{0,80})?)/g,
  /\b(ansible\s+[^\n]{0,80})/g,
  /\b(aws\s+\w+(?:\s+[^\n]{0,80})?)/g,
  /\b(gcloud\s+\w+(?:\s+[^\n]{0,80})?)/g,
  /\b(az\s+\w+(?:\s+[^\n]{0,80})?)/g,
  /\b(go\s+(?:build|test|run|install|mod|get)(?:\s+[^\n]{0,80})?)/g,
  /\b(rustup\s+\w+(?:\s+[^\n]{0,80})?)/g,
  /\b(brew\s+(?:install|uninstall|upgrade|update|list|search)(?:\s+[^\n]{0,80})?)/g,
  /\b(apt(?:-get)?\s+(?:install|update|upgrade|remove)(?:\s+[^\n]{0,80})?)/g,
];

const PROSE_AMBIGUOUS_TOOL_NAMES = new Set([
  "Read", "ReadFile", "Write", "Delete", "Task", "Subagent",
]);

function extractToolNamesFromProse(text) {
  const cleaned = text.replace(/`/g, "");
  const names = [];
  for (const toolName of HERMES_TOOL_NAMES) {
    if (PROSE_AMBIGUOUS_TOOL_NAMES.has(toolName)) {
      const strictPattern = new RegExp(
        `\\b${toolName}\\s+tool\\b|\\bthe\\s+${toolName}\\b|\\busing\\s+${toolName}\\b|\\bcall(?:ed|s|ing)?\\s+${toolName}\\b`,
        "gi",
      );
      if (strictPattern.test(cleaned)) {
        names.push(toolName);
      }
    } else {
      const pattern = new RegExp(
        `\\b${toolName}\\b(?:\\s+tool)?`,
        "g",
      );
      if (pattern.test(cleaned)) {
        names.push(toolName);
      }
    }
  }
  return names;
}

function extractCommandsFromProse(text) {
  const cleaned = text.replace(/`/g, "");
  const commands = [];
  for (const match of cleaned.matchAll(PROSE_COMMAND_REGEX)) {
    commands.push(match[1].trim());
  }
  for (const pattern of PROSE_COMMAND_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of cleaned.matchAll(pattern)) {
      commands.push(match[1].trim());
    }
  }
  return uniqueStrings(
    commands.map((cmd) => cmd.replace(/['"]+/g, "").trim()).filter(Boolean),
  );
}

function extractToolNames(rawText, assistantText) {
  const names = [];

  for (const match of rawText.matchAll(TOOL_CALL_REGEX)) {
    const name = normalizeToolName(match[1]);
    if (name) names.push(name);
  }

  for (const match of rawText.matchAll(TOOL_NAME_ARG_REGEX)) {
    const name = normalizeToolName(match[1]);
    if (name) names.push(name);
  }

  for (const match of rawText.matchAll(RECIPIENT_REGEX)) {
    const name = normalizeToolName(match[1]);
    if (name) names.push(name);
  }

  if (assistantText) {
    names.push(...extractToolNamesFromProse(assistantText));
  }

  return uniqueStrings(names);
}

function extractCommands(rawText, assistantText) {
  const commands = [...rawText.matchAll(COMMAND_REGEX)]
    .map((match) => match[1]?.trim())
    .filter(Boolean);

  if (assistantText) {
    commands.push(...extractCommandsFromProse(assistantText));
  }

  return uniqueStrings(commands);
}

function parseTxtTranscript(rawText) {
  const userSections = [];
  const assistantSections = [];
  let currentRole = null;
  let buffer = [];

  const flush = () => {
    const joined = buffer.join("\n").trim();
    if (!joined) {
      buffer = [];
      return;
    }
    if (currentRole === "user") {
      userSections.push(joined);
    } else if (currentRole === "assistant") {
      assistantSections.push(joined);
    }
    buffer = [];
  };

  for (const line of rawText.split(/\r?\n/)) {
    if (line.trim() === "user:") {
      flush();
      currentRole = "user";
      continue;
    }
    if (line.trim() === "assistant:") {
      flush();
      currentRole = "assistant";
      continue;
    }
    buffer.push(line);
  }
  flush();

  if (rawText.trim() && userSections.length === 0 && assistantSections.length === 0) {
    console.warn("[edamame] parseTxtTranscript: no role markers (user:/assistant:) found in non-empty transcript; format may have changed");
  }

  return {
    userText: userSections.join("\n\n").trim(),
    assistantText: assistantSections.join("\n\n").trim(),
    rawText,
  };
}

function parseJsonlTranscript(rawText) {
  const userSections = [];
  const assistantSections = [];

  for (const line of rawText.split(/\r?\n/).filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      const role = entry?.role;
      const content = Array.isArray(entry?.message?.content) ? entry.message.content : [];
      const text = content
        .filter((item) => item?.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n")
        .trim();

      if (!text) continue;
      if (role === "user") userSections.push(text);
      if (role === "assistant") assistantSections.push(text);
    } catch (_error) {
      // Ignore malformed JSONL rows.
    }
  }

  return {
    userText: userSections.join("\n\n").trim(),
    assistantText: assistantSections.join("\n\n").trim(),
    rawText,
  };
}

function firstNonEmptyLine(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^<[^>]+>$/.test(line));
}

function inferCommandProcessPattern(commandName) {
  const normalized = commandName.toLowerCase();
  switch (normalized) {
    case "cargo":
      return "*/cargo";
    case "git":
      return "*/git";
    case "node":
    case "npm":
    case "pnpm":
    case "yarn":
    case "npx":
      return "*/node";
    case "python":
    case "python3":
    case "uv":
      return "*/python*";
    case "bash":
    case "zsh":
    case "sh":
      return "*/sh";
    case "dart":
      return "*/dart";
    case "flutter":
      return "*/flutter";
    case "make":
      return "*/make";
    case "curl":
      return "*/curl";
    case "wget":
      return "*/wget";
    case "nmap":
      return "*/nmap";
    case "ping":
      return "*/ping";
    case "traceroute":
      return "*/traceroute";
    case "dig":
      return "*/dig";
    case "nslookup":
      return "*/nslookup";
    case "ssh":
      return "*/ssh";
    case "scp":
      return "*/scp";
    case "rsync":
      return "*/rsync";
    case "nc":
    case "netcat":
      return "*/nc";
    case "openssl":
      return "*/openssl";
    case "tcpdump":
      return "*/tcpdump";
    case "kubectl":
      return "*/kubectl";
    case "terraform":
      return "*/terraform";
    case "ansible":
      return "*/ansible";
    case "aws":
      return "*/aws";
    case "gcloud":
      return "*/gcloud";
    case "az":
      return "*/az";
    case "go":
      return "*/go";
    case "rustup":
      return "*/rustup";
    case "brew":
      return "*/brew";
    case "apt":
    case "apt-get":
      return "*/apt";
    default:
      return commandName.startsWith("/") ? commandName : `*/${normalized}`;
  }
}

function inferProcessPaths(commands, workspaceRoot) {
  const processPatterns = [];
  const parentPaths = [];

  for (const command of commands) {
    const parts = command.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;

    processPatterns.push(inferCommandProcessPattern(parts[0]));

    for (let index = 1; index < parts.length; index += 1) {
      const token = parts[index];
      if (token.startsWith("-")) {
        continue;
      }
      const normalized = decodeFilePathToken(token, workspaceRoot);
      if (normalized) {
        parentPaths.push(normalized);
        break;
      }
    }
  }

  return {
    processPaths: uniqueStrings(processPatterns),
    parentPaths: uniqueStrings(parentPaths),
  };
}

function inferExpectedSensitiveFiles(paths, rawText) {
  const sensitive = [];
  for (const candidate of paths) {
    const lower = candidate.toLowerCase();
    if (
      matchesSensitivePathPattern(candidate) ||
      lower.endsWith(".env") ||
      lower.endsWith(".pem") ||
      lower.endsWith(".key") ||
      lower.endsWith(".p12") ||
      lower.endsWith("credentials.json") ||
      lower.includes("mcp_psk") ||
      lower.includes(".edamame_psk")
    ) {
      sensitive.push(candidate);
    }
  }

  if (/\.env\b|credentials|certificate|private key|token|psk/i.test(rawText)) {
    for (const candidate of paths) {
      if (/\.(env|pem|key|p12)$/i.test(candidate) || /credentials|token|psk/i.test(candidate)) {
        sensitive.push(candidate);
      }
    }
  }

  return uniqueStrings(sensitive);
}

function inferExpectedOpenFiles(paths, rawText) {
  const sensitivePaths = new Set(inferExpectedSensitiveFiles(paths, rawText));
  return uniqueStrings(paths.filter((candidate) => !sensitivePaths.has(candidate)));
}

async function inferSiblingRepoGuards(config, rawText) {
  const workspaceParent = path.dirname(config.workspaceRoot);
  let entries = [];

  try {
    entries = await fs.readdir(workspaceParent, { withFileTypes: true });
  } catch (_error) {
    return [];
  }

  const rawLower = rawText.toLowerCase();
  const workspaceBase = path.basename(config.workspaceRoot);
  const guards = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    if (entry.name === workspaceBase) continue;
    if (rawLower.includes(entry.name.toLowerCase())) continue;
    guards.push(path.join(workspaceParent, entry.name, "*"));
  }

  return guards.slice(0, 48);
}

// Turn a "rawish" session record (file / manifest / sqlite) into the finalized
// shape consumers expect, computing combinedText, title, tool names, commands.
function finalizeTranscriptRecord(rawish) {
  const userText = (rawish.userText || "").trim();
  const assistantText = (rawish.assistantText || "").trim();
  const rawTextValue = rawish.rawText || "";
  const combinedText = [userText, assistantText, rawTextValue].filter(Boolean).join("\n\n");

  return {
    sessionId: rawish.sessionId,
    sourcePath: rawish.sourcePath,
    sourceFormat: rawish.sourceFormat,
    txtPath: rawish.txtPath || null,
    jsonlPath: rawish.jsonlPath || null,
    userText,
    assistantText,
    rawText: rawTextValue,
    combinedText,
    modifiedAt: new Date(rawish.mtimeMs),
    startedAt: new Date(rawish.birthtimeMs || rawish.mtimeMs),
    title: firstNonEmptyLine(userText) || `Hermes session ${rawish.sessionId}`,
    toolNames: extractToolNames(rawTextValue, assistantText),
    commands: extractCommands(rawTextValue, assistantText),
  };
}

export async function collectTranscriptSessions(config, options = {}) {
  const candidates = await candidateTranscriptFiles(config);
  const activeCutoff =
    Date.now() - (config.transcriptActiveWindowMinutes || 5) * 60 * 1000;

  const grouped = new Map();
  for (const { filePath, stat } of candidates) {
    const sessionId = transcriptSessionId(filePath);
    const current = grouped.get(sessionId) || {
      sessionId,
      txtPath: null,
      txtMtimeMs: 0,
      jsonlPath: null,
      jsonlMtimeMs: 0,
      mtimeMs: 0,
      birthtimeMs: 0,
    };

    const candidateBirthtimeMs =
      Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
    const format = transcriptFormat(filePath);
    if (format === "txt" && stat.mtimeMs >= current.txtMtimeMs) {
      current.txtPath = filePath;
      current.txtMtimeMs = stat.mtimeMs;
    }
    if (format === "jsonl" && stat.mtimeMs >= current.jsonlMtimeMs) {
      current.jsonlPath = filePath;
      current.jsonlMtimeMs = stat.mtimeMs;
    }
    current.mtimeMs = Math.max(current.mtimeMs, stat.mtimeMs);
    current.birthtimeMs =
      current.birthtimeMs === 0
        ? candidateBirthtimeMs
        : Math.min(current.birthtimeMs, candidateBirthtimeMs);
    grouped.set(sessionId, current);
  }

  // File-based "rawish" records: read + parse the preferred source per session.
  const fileRawish = [];
  for (const candidate of grouped.values()) {
    if (candidate.mtimeMs < activeCutoff) continue;
    const { sourcePath, sourceFormat } = preferredTranscriptSource(candidate);
    if (!sourcePath) continue;
    let rawText;
    try {
      rawText = await fs.readFile(sourcePath, "utf8");
    } catch (_error) {
      continue;
    }
    const parsed = sourceFormat === "txt" ? parseTxtTranscript(rawText) : parseJsonlTranscript(rawText);
    fileRawish.push({
      sessionId: candidate.sessionId,
      sourcePath,
      sourceFormat,
      txtPath: candidate.txtPath,
      jsonlPath: candidate.jsonlPath,
      userText: parsed.userText,
      assistantText: parsed.assistantText,
      rawText: parsed.rawText,
      mtimeMs: candidate.mtimeMs,
      birthtimeMs: candidate.birthtimeMs || candidate.mtimeMs,
    });
  }

  // Extra Hermes sources: sessions.json manifest + optional SQLite. File
  // transcripts take priority on sessionId collision.
  let extraRawish = [];
  try {
    extraRawish = await collectExtraRawishSessions(config, { activeCutoff });
  } catch (_error) {
    extraRawish = [];
  }

  const bySession = new Map();
  for (const rawish of fileRawish) {
    if (!bySession.has(rawish.sessionId)) bySession.set(rawish.sessionId, rawish);
  }
  for (const rawish of extraRawish) {
    if (!bySession.has(rawish.sessionId)) bySession.set(rawish.sessionId, rawish);
  }

  const ranked = [...bySession.values()]
    .filter((rawish) => rawish.mtimeMs >= activeCutoff)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, options.limit || config.transcriptLimit || 6);

  return ranked.map((rawish) => finalizeTranscriptRecord(rawish));
}

export async function latestTranscriptMtimeMs(config) {
  const candidates = await candidateTranscriptFiles(config);
  let latest = candidates.length === 0
    ? null
    : candidates.reduce((acc, candidate) => Math.max(acc, candidate.stat.mtimeMs), 0);
  const extra = latestExtraSourceMtimeMs(config);
  if (extra != null && (latest == null || extra > latest)) latest = extra;
  return latest;
}

export async function buildRawSessionIngestPayload(config, options = {}) {
  const sessions = await collectTranscriptSessions(config, options);
  const agentType = config.agentType || "hermes";
  const agentInstanceId = config.agentInstanceId || "hermes-default";
  const derivedScopeProcessPaths = uniqueStrings(config.scopeProcessPaths || []);
  const derivedScopeParentPaths = uniqueStrings(config.scopeParentPaths || []);
  const derivedScopeGrandparentPaths = uniqueStrings(config.scopeGrandparentPaths || []);
  const derivedScopeAnyLineagePaths = uniqueStrings(config.scopeAnyLineagePaths || []);
  const now = new Date();
  const windowStart = sessions.reduce(
    (earliest, session) => (session.startedAt < earliest ? session.startedAt : earliest),
    sessions[0]?.startedAt || now,
  );
  const windowEnd = sessions.reduce(
    (latest, session) => (session.modifiedAt > latest ? session.modifiedAt : latest),
    sessions[0]?.modifiedAt || now,
  );

  const rawSessions = {
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    agent_type: agentType,
    agent_instance_id: agentInstanceId,
    source_kind: "hermes",
    sessions: sessions.map((session) => {
      const extractedPaths = extractPaths(session.combinedText, config.workspaceRoot);
      const derivedExpectedTraffic = extractTraffic(session.combinedText, session.commands, config);
      const derivedExpectedLocalOpenPorts = extractPorts(session.combinedText, session.commands);
      const { processPaths, parentPaths } = inferProcessPaths(session.commands, config.workspaceRoot);
      const derivedExpectedOpenFiles = inferExpectedOpenFiles(extractedPaths, session.combinedText);

      return {
        session_key: session.sessionId,
        title: session.title,
        user_text: session.userText,
        assistant_text: session.assistantText,
        raw_text: session.rawText,
        tool_names: uniqueStrings(session.toolNames),
        commands: uniqueStrings(session.commands),
        derived_expected_traffic: uniqueStrings([...derivedExpectedTraffic, ...(config.hermesLlmHosts || [])]),
        derived_expected_local_open_ports: derivedExpectedLocalOpenPorts,
        derived_expected_process_paths: processPaths,
        derived_expected_parent_paths: parentPaths,
        derived_expected_grandparent_paths: [],
        derived_scope_process_paths: derivedScopeProcessPaths,
        derived_scope_parent_paths: derivedScopeParentPaths,
        derived_scope_grandparent_paths: derivedScopeGrandparentPaths,
        derived_scope_any_lineage_paths: derivedScopeAnyLineagePaths,
        derived_expected_open_files: derivedExpectedOpenFiles,
        source_path: session.sourcePath,
        started_at: session.startedAt.toISOString(),
        modified_at: session.modifiedAt.toISOString(),
      };
    }),
  };

  return {
    sessions,
    rawSessions,
    rawPayloadHash: sha256(JSON.stringify(rawSessions)),
  };
}
