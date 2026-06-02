#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, loadState, saveState, summarizeJson } from "./config.mjs";
import { postureSummary, readPostureSnapshot } from "./posture_facade.mjs";

function parseCliArgs(argv) {
  const args = { json: false, configPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") args.json = true;
    if (value === "--config" && argv[index + 1]) {
      args.configPath = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

export async function readLatestVerdict(config) {
  const previousState = await loadState(config, "verdict-reader", {});
  const snapshot = await readPostureSnapshot(config);
  const latestHistory = snapshot.history[0] || null;
  const verdictKey = [
    snapshot.verdictLabel,
    latestHistory?.timestamp || snapshot.verdict?.timestamp || "",
    latestHistory?.decision_source || snapshot.verdict?.decision_source || "",
  ].join(":");

  const result = {
    summary: postureSummary(snapshot),
    verdict: snapshot.verdict,
    history: snapshot.history,
    engineStatus: snapshot.engineStatus,
    changed: previousState.lastVerdictKey !== verdictKey,
    alertable: typeof snapshot.verdict?.alertable === "boolean"
      ? snapshot.verdict.alertable
      : snapshot.verdictLabel === "DIVERGENCE",
  };

  await saveState(config, "verdict-reader", {
    lastReadAt: new Date().toISOString(),
    lastVerdictKey: verdictKey,
    lastVerdictLabel: snapshot.verdictLabel,
    lastSummary: result.summary,
  });

  return result;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const config = await loadConfig({ configPath: args.configPath });
  const result = await readLatestVerdict(config);

  if (args.json) {
    process.stdout.write(`${summarizeJson(result)}\n`);
  } else {
    process.stdout.write(`${result.summary}${result.changed ? " changed" : ""}\n`);
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
