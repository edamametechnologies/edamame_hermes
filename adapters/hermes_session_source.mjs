#!/usr/bin/env node

// Extra Hermes session sources beyond the JSONL/TXT file walk performed by
// session_prediction_adapter.mjs. Hermes stores sessions in SQLite+FTS5 with a
// `sessions.json` manifest, so this module adds:
//   1) a tolerant `sessions.json` manifest reader (mirrors the Rust L1 adapter
//      edamame_foundation/src/agent_transcripts/hermes.rs), and
//   2) a best-effort SQLite reader behind the OPTIONAL `better-sqlite3` native
//      module (absent module -> empty result, never throws).
//
// Both sources yield "rawish" records that the adapter finalizes uniformly:
//   { sessionId, sourcePath, sourceFormat, userText, assistantText, rawText,
//     mtimeMs, birthtimeMs }

import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function expandHome(value) {
  if (!value || typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

// Resolve the Hermes home directory from config. The plugin config carries
// `hermesSessionsRoot` (conventionally `<home>/sessions`), so home is its
// parent. This is deterministic for tests (which point the sessions root at a
// temp dir) and never accidentally reads the developer's real `~/.hermes`.
export function resolveHermesHome(config) {
  const root = config && config.hermesSessionsRoot ? String(config.hermesSessionsRoot) : "";
  if (root) {
    return path.dirname(path.resolve(expandHome(root)));
  }
  const envHome = (process.env.HERMES_HOME || "").trim();
  if (envHome) return path.resolve(expandHome(envHome));
  return path.join(os.homedir(), ".hermes");
}

function manifestPathFor(config) {
  return path.join(resolveHermesHome(config), "sessions.json");
}

function statMs(filePath) {
  try {
    const stat = fssync.statSync(filePath);
    const birthtimeMs =
      Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
    return { mtimeMs: stat.mtimeMs, birthtimeMs };
  } catch (_error) {
    return null;
  }
}

// Accept seconds, milliseconds, or ISO strings; always return epoch ms.
function normalizeEpochMs(value) {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e12) return n; // already ms
  if (n >= 1e9) return n * 1000; // seconds since epoch
  return n * 1000; // small values: treat as seconds
}

function fieldTime(obj, keys) {
  for (const key of keys) {
    if (obj == null || obj[key] == null) continue;
    const ms = normalizeEpochMs(obj[key]);
    if (ms) return ms;
  }
  return null;
}

function objStr(obj, keys) {
  for (const key of keys) {
    const value = obj == null ? undefined : obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function messageContentToString(msg) {
  const content = msg ? msg.content : undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === "string" ? item : typeof item?.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (msg && typeof msg.text === "string") return msg.text;
  return "";
}

function textsFromMessages(messages) {
  const user = [];
  const assistant = [];
  const raw = [];
  for (const msg of messages) {
    const role = String(msg && msg.role != null ? msg.role : "").toLowerCase();
    const content = messageContentToString(msg).trim();
    if (!content) continue;
    raw.push(`${role || "message"}: ${content}`);
    if (["user", "human", "operator"].includes(role)) user.push(content);
    else if (["assistant", "ai", "model", "agent"].includes(role)) assistant.push(content);
  }
  return { userText: user.join("\n\n"), assistantText: assistant.join("\n\n"), rawText: raw.join("\n") };
}

function textsFromSessionObject(obj) {
  if (Array.isArray(obj && obj.messages)) {
    return textsFromMessages(obj.messages);
  }
  const content = objStr(obj, ["text", "content", "transcript", "prompt", "body", "summary"]) || "";
  if (!content) return { userText: "", assistantText: "", rawText: "" };
  // No role markers: treat the blob as the user-side intent record so title
  // inference and path/command extraction still have signal.
  return { userText: content, assistantText: "", rawText: content };
}

const SESSION_KEY_HINTS = [
  "id",
  "session_id",
  "sessionId",
  "uuid",
  "title",
  "messages",
  "content",
  "text",
  "transcript",
  "created_at",
  "updated_at",
  "started_at",
];

function looksLikeSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return SESSION_KEY_HINTS.some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

// Normalize the several possible manifest container shapes into a flat list of
// [optionalKeyHint, sessionValue] pairs (mirrors the Rust normalize_manifest_entries).
function normalizeManifestEntries(value) {
  if (Array.isArray(value)) {
    return value.map((item) => [null, item]);
  }
  if (value && typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "sessions")) {
      return normalizeManifestEntries(value.sessions);
    }
    if (looksLikeSession(value)) {
      return [[null, value]];
    }
    return Object.entries(value)
      .filter(([, entry]) => entry && typeof entry === "object" && !Array.isArray(entry))
      .map(([key, entry]) => [key, entry]);
  }
  return [];
}

// Tolerant reader for a Hermes `sessions.json` manifest. Never throws; malformed
// entries are skipped. Returns rawish records filtered by the active window.
export async function collectManifestRawish(config, options = {}) {
  const manifestPath = manifestPathFor(config);
  let raw;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch (_error) {
    return [];
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch (_error) {
    return [];
  }
  const manifestMs = statMs(manifestPath)?.mtimeMs || Date.now();
  const activeCutoff = Number.isFinite(options.activeCutoff) ? options.activeCutoff : 0;

  const out = [];
  for (const [keyHint, obj] of normalizeManifestEntries(value)) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
    const started = fieldTime(obj, ["created_at", "started_at", "created", "start", "timestamp", "ts"]);
    const modified =
      fieldTime(obj, [
        "updated_at",
        "modified_at",
        "modified",
        "last_active",
        "last_activity",
        "updated",
        "ended_at",
        "end",
      ]) ||
      started ||
      manifestMs;
    if (modified < activeCutoff) continue;
    const { userText, assistantText, rawText } = textsFromSessionObject(obj);
    if (!userText.trim() && !assistantText.trim() && !rawText.trim()) continue;
    const sessionId =
      objStr(obj, ["id", "session_id", "sessionId", "uuid", "key"]) ||
      keyHint ||
      `hermes-manifest-${Math.round(modified / 1000)}`;
    out.push({
      sessionId,
      sourcePath: manifestPath,
      sourceFormat: "manifest",
      userText,
      assistantText,
      rawText,
      mtimeMs: modified,
      birthtimeMs: started || modified,
    });
  }
  return out;
}

function loadBetterSqlite3() {
  try {
    return require("better-sqlite3");
  } catch (_error) {
    return null;
  }
}

function sqliteCandidateDirs(config) {
  const home = resolveHermesHome(config);
  return [home, path.join(home, "sessions")];
}

function findSqliteFiles(dirs) {
  const found = [];
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fssync.readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (lower.endsWith(".db") || lower.endsWith(".sqlite") || lower.endsWith(".sqlite3")) {
        found.push(path.join(dir, entry.name));
      }
    }
  }
  return found;
}

const FTS_SHADOW_SUFFIX = /_(data|idx|content|docsize|config|segments|segdir)$/i;

function tableColumns(db, table) {
  // table is validated against /^[A-Za-z0-9_]+$/ before this call, so inlining
  // it in the PRAGMA (which cannot be parameter-bound) is safe.
  try {
    return db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((row) => String(row.name));
  } catch (_error) {
    return [];
  }
}

function readSessionsFromDb(db, dbPath) {
  const dbMs = statMs(dbPath)?.mtimeMs || Date.now();
  let tableRows = [];
  try {
    tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all();
  } catch (_error) {
    return [];
  }
  const tables = tableRows
    .map((row) => String(row.name))
    .filter((name) => /^[A-Za-z0-9_]+$/.test(name) && !FTS_SHADOW_SUFFIX.test(name));

  // Locate the most likely messages table: has a content-ish column AND either
  // a session reference column or a role column.
  let msgTable = null;
  for (const table of tables) {
    const cols = tableColumns(db, table).map((c) => c.toLowerCase());
    const hasContent = cols.some((c) => /(content|text|message|body|data)/.test(c));
    const hasSession = cols.some((c) => /(session|conversation|thread|chat)/.test(c) && c.includes("id"));
    const hasRole = cols.includes("role");
    if (hasContent && (hasSession || hasRole)) {
      msgTable = table;
      if (hasSession) break; // session-keyed table is the strongest signal
    }
  }
  if (!msgTable) return [];

  const realCols = tableColumns(db, msgTable);
  const sessionCol =
    realCols.find((c) => /(session|conversation|thread|chat)/i.test(c) && /id/i.test(c)) || null;
  const roleCol =
    realCols.find((c) => /^role$/i.test(c)) ||
    realCols.find((c) => /(role|sender|author|speaker)/i.test(c)) ||
    null;
  const contentCol =
    realCols.find((c) => /^content$/i.test(c)) ||
    realCols.find((c) => /(content|text|message|body)/i.test(c)) ||
    null;
  const timeCol = realCols.find((c) => /(updated|created|timestamp|ts|time)/i.test(c)) || null;
  if (!contentCol) return [];

  let rows = [];
  try {
    rows = db.prepare(`SELECT * FROM "${msgTable}"`).all();
  } catch (_error) {
    return [];
  }

  const grouped = new Map();
  for (const row of rows) {
    const sid = sessionCol ? String(row[sessionCol] ?? "") : "";
    const key = sid || `db-${path.basename(dbPath)}`;
    let entry = grouped.get(key);
    if (!entry) {
      entry = { messages: [], mtimeMs: 0 };
      grouped.set(key, entry);
    }
    entry.messages.push({ role: roleCol ? row[roleCol] : "", content: row[contentCol] });
    const tms = timeCol ? normalizeEpochMs(row[timeCol]) : null;
    if (tms && tms > entry.mtimeMs) entry.mtimeMs = tms;
  }

  const out = [];
  for (const [sid, entry] of grouped) {
    const { userText, assistantText, rawText } = textsFromMessages(entry.messages);
    if (!userText.trim() && !assistantText.trim() && !rawText.trim()) continue;
    const mtimeMs = entry.mtimeMs || dbMs;
    out.push({
      sessionId: sid || `hermes-db-${out.length}`,
      sourcePath: dbPath,
      sourceFormat: "sqlite",
      userText,
      assistantText,
      rawText,
      mtimeMs,
      birthtimeMs: mtimeMs,
    });
  }
  return out;
}

// Best-effort SQLite reader. Returns [] when better-sqlite3 is unavailable or
// any DB cannot be opened/introspected. Never throws.
export function collectSqliteRawish(config, options = {}) {
  const Database = loadBetterSqlite3();
  if (!Database) return [];
  const activeCutoff = Number.isFinite(options.activeCutoff) ? options.activeCutoff : 0;
  const out = [];
  for (const dbPath of findSqliteFiles(sqliteCandidateDirs(config))) {
    let db = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      for (const record of readSessionsFromDb(db, dbPath)) {
        if (record.mtimeMs >= activeCutoff) out.push(record);
      }
    } catch (_error) {
      // Tolerant: skip unreadable / unexpected-schema DBs.
    } finally {
      try {
        if (db) db.close();
      } catch (_closeError) {
        // ignore
      }
    }
  }
  return out;
}

// Manifest first (cheap, dependency-free), then SQLite. The adapter dedups by
// sessionId with file transcripts taking priority over both.
export async function collectExtraRawishSessions(config, options = {}) {
  const manifest = await collectManifestRawish(config, options);
  const sqlite = collectSqliteRawish(config, options);
  return [...manifest, ...sqlite];
}

// Newest mtime across the manifest file and any SQLite DBs, so SQLite-only /
// manifest-only installs still drive the bridge's refresh detection.
export function latestExtraSourceMtimeMs(config) {
  let latest = null;
  const manifestStat = statMs(manifestPathFor(config));
  if (manifestStat) latest = manifestStat.mtimeMs;
  for (const dbPath of findSqliteFiles(sqliteCandidateDirs(config))) {
    const dbStat = statMs(dbPath);
    if (dbStat && (latest == null || dbStat.mtimeMs > latest)) latest = dbStat.mtimeMs;
  }
  return latest;
}
