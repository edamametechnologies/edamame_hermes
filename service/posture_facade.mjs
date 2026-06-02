#!/usr/bin/env node

import { makeEdamameClient } from "../bridge/edamame_client.mjs";

function summarizeVerdict(verdict) {
  if (!verdict || verdict.verdict === null || verdict.verdict === undefined) {
    return "NO_VERDICT";
  }
  return String(verdict.verdict);
}

function settledValue(result) {
  return result.status === "fulfilled" ? result.value : null;
}

function settledError(toolName, result) {
  if (result.status !== "rejected") return null;
  return {
    toolName,
    message: String(result.reason?.message || result.reason || "").trim(),
  };
}

export async function readPostureSnapshot(config, options = {}) {
  const client = await makeEdamameClient(config);
  const historyLimit = options.historyLimit || config.verdictHistoryLimit || 10;
  const toolNames = [
    "get_divergence_engine_status",
    "get_behavioral_model",
    "get_divergence_verdict",
    "get_divergence_history",
    "get_score",
    "advisor_get_todos",
    "get_anomalous_sessions",
    "get_blacklisted_sessions",
  ];

  const results = await Promise.allSettled([
    client.invoke(toolNames[0], {}),
    client.invoke(toolNames[1], {}),
    client.invoke(toolNames[2], {}),
    client.invoke(toolNames[3], { limit: historyLimit }),
    client.invoke(toolNames[4], {}),
    client.invoke(toolNames[5], {}),
    client.invoke(toolNames[6], {}),
    client.invoke(toolNames[7], {}),
  ]);

  const [engineStatus, behavioralModel, verdict, history, score, todos, anomalous, blacklisted] =
    results.map(settledValue);
  const toolErrors = results
    .map((result, index) => settledError(toolNames[index], result))
    .filter(Boolean);

  return {
    engineStatus,
    behavioralModel,
    verdict,
    verdictLabel: summarizeVerdict(verdict),
    history: Array.isArray(history) ? history : [],
    score,
    todos: Array.isArray(todos) ? todos : [],
    anomalousSessions: Array.isArray(anomalous) ? anomalous : [],
    blacklistedSessions: Array.isArray(blacklisted) ? blacklisted : [],
    toolErrors,
    succeededToolCount: results.filter((result) => result.status === "fulfilled").length,
    failedToolCount: toolErrors.length,
    firstToolError: toolErrors[0] || null,
  };
}

export function postureSummary(snapshot) {
  const findings = [];
  findings.push(`engine=${snapshot.engineStatus?.running ? "enabled" : "disabled"}`);
  findings.push(`verdict=${snapshot.verdictLabel}`);
  findings.push(`todos=${snapshot.todos.length}`);
  findings.push(`anomalous=${snapshot.anomalousSessions.length}`);
  findings.push(`blacklisted=${snapshot.blacklistedSessions.length}`);
  return findings.join(" ");
}
