#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, summarizeJson } from "./config.mjs";
import { runHealthcheck } from "./health.mjs";

function parseCliArgs(argv) {
  const args = { json: false, strict: false, configPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") args.json = true;
    if (value === "--strict") args.strict = true;
    if (value === "--config" && argv[index + 1]) {
      args.configPath = argv[index + 1];
      index += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const config = await loadConfig({ configPath: args.configPath });
  const result = await runHealthcheck(config, { strict: args.strict });

  if (args.json) {
    process.stdout.write(`${summarizeJson(result)}\n`);
  } else {
    for (const check of result.checks) {
      process.stdout.write(`${check.ok ? "OK" : "FAIL"} ${check.name} ${JSON.stringify(check.detail)}\n`);
    }
  }

  if (!result.ok) {
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
