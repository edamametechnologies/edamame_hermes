import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readTextFileWithRetry } from "../service/config.mjs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  createBackgroundRefreshLoop,
  createHermesDrivenRefresh,
  handleRequest,
  tryExtractMessages,
} from "../bridge/hermes_edamame_mcp.mjs";
import { buildControlCenterPayload } from "../service/control_center.mjs";
import { runHealthcheck } from "../service/health.mjs";
import { runLatestExtrapolation } from "../service/hermes_extrapolator.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

async function writeMockPostureCli(root, options = {}) {
  const scriptPath = path.join(root, "mock-edamame-posture.sh");
  const statePath = path.join(root, "mock-edamame-posture.state");
  const generatedPsk = options.generatedPsk || "generated-psk-abcdefghijklmnopqrstuvwxyz012345";
  const script = `#!/usr/bin/env bash
set -euo pipefail

STATE_FILE=${JSON.stringify(statePath)}
GENERATED_PSK=${JSON.stringify(generatedPsk)}

case "\${1:-}" in
  mcp-generate-psk|background-mcp-generate-psk)
    echo "$GENERATED_PSK"
    echo "# Save this PSK securely - it's required for MCP client authentication"
    ;;
  mcp-start|background-mcp-start)
    port="\${2:-3000}"
    psk="\${3:-$GENERATED_PSK}"
    cat > "$STATE_FILE" <<EOF
port=$port
url=http://127.0.0.1:$port/mcp
EOF
    echo "[OK] MCP server started successfully"
    echo "   Port: $port"
    echo "   URL: http://127.0.0.1:$port/mcp"
    echo "   PSK: $psk"
    ;;
  mcp-stop|background-mcp-stop)
    rm -f "$STATE_FILE"
    echo "[OK] MCP server stopped"
    ;;
  mcp-status|background-mcp-status)
    if [[ -f "$STATE_FILE" ]]; then
      # shellcheck disable=SC1090
      source "$STATE_FILE"
      echo "[OK] MCP server is running"
      echo "   Port: $port"
      echo "   URL: $url"
    else
      echo "MCP server is not running"
    fi
    ;;
  *)
    echo "unsupported mock posture command: $*" >&2
    exit 1
    ;;
esac
`;
  await fs.writeFile(scriptPath, script, "utf8");
  await fs.chmod(scriptPath, 0o755);
  return { scriptPath, generatedPsk, statePath };
}

async function writeMockSystemctl(root, options = {}) {
  const scriptPath = path.join(root, "mock-systemctl.sh");
  const loadState = options.loadState || "loaded";
  const unitFileState = options.unitFileState || "enabled";
  const activeState = options.activeState || "active";
  const script = `#!/usr/bin/env bash
set -euo pipefail

case "\${1:-}" in
  show)
    if [[ "\${2:-}" != "edamame_posture.service" ]]; then
      echo "unexpected service name: \${2:-}" >&2
      exit 1
    fi
    echo "LoadState=${loadState}"
    echo "UnitFileState=${unitFileState}"
    echo "ActiveState=${activeState}"
    ;;
  *)
    echo "unsupported mock systemctl command: $*" >&2
    exit 1
    ;;
esac
`;
  await fs.writeFile(scriptPath, script, "utf8");
  await fs.chmod(scriptPath, 0o755);
  return { scriptPath, loadState, unitFileState, activeState };
}

async function makeBridgeFixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-edamame-bridge-"));
  const workspaceRoot = path.join(root, "edamame_project");
  const claudeProjectsRoot = path.join(root, "claude-projects");
  const transcriptDir = path.join(claudeProjectsRoot, "fixture-workspace");
  const configPath = path.join(root, "config.json");
  const pskPath = path.join(root, ".edamame_psk");
  const hostKind = options.hostKind || "edamame_app";
  const endpoint = options.endpoint || "http://127.0.0.1:65535/mcp";
  const postureWrapperPath = path.join(root, "edamame_posture_daemon.sh");
  const postureConfigPath = path.join(root, "edamame_posture.conf");
  const postureFixture = options.withMockPostureCli
    ? await writeMockPostureCli(root, options.mockPostureCliOptions)
    : null;
  const systemctlFixture = options.withMockSystemctl
    ? await writeMockSystemctl(root, options.mockSystemctlOptions)
    : null;

  await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
  await fs.mkdir(transcriptDir, { recursive: true });
  if (options.withPsk !== false) {
    await fs.writeFile(pskPath, `${options.pskValue || "psk-test"}\n`, "utf8");
  }
  if (options.withMockSystemServiceFiles !== false) {
    await fs.writeFile(postureWrapperPath, "#!/usr/bin/env bash\nexit 0\n", "utf8");
    await fs.chmod(postureWrapperPath, 0o755);
    await fs.writeFile(postureConfigPath, "daemon_config=true\n", "utf8");
  }

  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        workspace_root: workspaceRoot,
        hermes_sessions_root: claudeProjectsRoot,
        state_dir: path.join(root, "state"),
        host_kind: hostKind,
        posture_cli_command: postureFixture?.scriptPath,
        systemctl_command: systemctlFixture?.scriptPath,
        posture_daemon_wrapper_path: postureWrapperPath,
        posture_config_path: postureConfigPath,
        edamame_mcp_endpoint: endpoint,
        edamame_mcp_psk_file: pskPath,
      },
      null,
      2,
    ),
    "utf8",
  );

  await fs.writeFile(
    path.join(transcriptDir, "session-two.txt"),
    `user:
<user_query>
inspect src/lib.rs
</user_query>

assistant:
[Tool call] ReadFile
  path: ${workspaceRoot}/src/lib.rs
assistant:
Only inspect ${workspaceRoot}/src/lib.rs
`,
    "utf8",
  );

  return {
    configPath,
    workspaceRoot,
    hermesSessionsRoot: claudeProjectsRoot,
    transcriptProjectHints: ["fixture-workspace"],
    transcriptLimit: 4,
    transcriptRecencyHours: 48,
    transcriptActiveWindowMinutes: 5,
    stateDir: path.join(root, "state"),
    agentType: "hermes",
    agentInstanceId: "hermes-bridge-test",
    hostKind,
    postureCliCommand: postureFixture?.scriptPath,
    systemctlCommand: systemctlFixture?.scriptPath,
    postureDaemonWrapperPath: postureWrapperPath,
    postureConfigPath: postureConfigPath,
    hermesLlmHosts: ["api.anthropic.com:443"],
    edamameMcpEndpoint: endpoint,
    edamameMcpPskFile: pskPath,
    verdictHistoryLimit: 5,
    postureFixture,
    systemctlFixture,
  };
}

async function runScript(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function withMockMcpAuthServer(handler) {
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/mcp") {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("not found");
      return;
    }
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "invalid PSK" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;

  try {
    return await handler(endpoint);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test("handleRequest returns MCP initialize and tool list responses", async () => {
  const config = await makeBridgeFixture();

  const initializeResponse = await handleRequest(config, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  });
  assert.equal(initializeResponse.result.serverInfo.name, "edamame");
  assert.deepEqual(initializeResponse.result.capabilities.resources, {});

  const toolsResponse = await handleRequest(config, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  assert.ok(
    toolsResponse.result.tools.some((tool) => tool.name === "hermes_refresh_behavioral_model"),
  );
  const controlCenterTool = toolsResponse.result.tools.find(
    (tool) => tool.name === "edamame_hermes_control_center",
  );
  assert.ok(controlCenterTool, "control center tool should be defined");
  const appPairingTool = toolsResponse.result.tools.find(
    (tool) => tool.name === "edamame_hermes_control_center_request_app_pairing",
  );
  assert.ok(appPairingTool, "app pairing tool should be defined");
  assert.equal(
    Object.prototype.hasOwnProperty.call(appPairingTool.inputSchema?.properties || {}, "client_name"),
    true,
  );
  assert.equal(
    toolsResponse.result.tools.some((tool) => tool.name === "edamame_hermes_control_center_apply_pairing"),
    true,
  );
  assert.equal(
    toolsResponse.result.tools.some((tool) => tool.name === "edamame_hermes_control_center_run_host_action"),
    true,
  );
  const invalidToolNames = toolsResponse.result.tools
    .map((tool) => tool.name)
    .filter((name) => !/^[a-zA-Z0-9_-]{1,64}$/.test(name));
  assert.deepEqual(invalidToolNames, []);
});

test("tryExtractMessages accepts LF-only framed MCP messages", () => {
  const message = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
    },
  };
  const payload = JSON.stringify(message);
  const framed = `Content-Length: ${Buffer.byteLength(payload, "utf8")}\n\n${payload}`;

  const extracted = tryExtractMessages(framed);

  assert.deepEqual(extracted.messages, [message]);
  assert.equal(extracted.remaining, "");
});

test("tryExtractMessages accepts raw JSON MCP messages", () => {
  const message = {
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {
        roots: {
          listChanged: false,
        },
      },
    },
    jsonrpc: "2.0",
    id: 1,
  };

  const extracted = tryExtractMessages(JSON.stringify(message));

  assert.deepEqual(extracted.messages, [message]);
  assert.equal(extracted.remaining, "");
});

test("bridge can dispatch dry-run extrapolation and healthcheck tools", async () => {
  const config = await makeBridgeFixture();

  const extrapolatorResponse = await handleRequest(config, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "hermes_refresh_behavioral_model",
      arguments: { dry_run: true },
    },
  });
  const extrapolatorPayload = JSON.parse(extrapolatorResponse.result.content[0].text);
  assert.equal(extrapolatorPayload.sessionCount, 1);
  assert.deepEqual(extrapolatorPayload.reasons, ["dry_run"]);
  assert.equal(extrapolatorPayload.agentType, "hermes");
  assert.equal(extrapolatorPayload.agentInstanceId, "hermes-bridge-test");
  assert.equal(extrapolatorPayload.rawSessions.agent_type, "hermes");
  assert.equal(extrapolatorPayload.rawSessions.agent_instance_id, "hermes-bridge-test");
  assert.equal(extrapolatorPayload.rawSessions.source_kind, "hermes");
  assert.equal(extrapolatorPayload.rawSessions.sessions.length, 1);

  const healthResponse = await handleRequest(config, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "hermes_healthcheck",
      arguments: { strict: true },
    },
  });
  const healthPayload = JSON.parse(healthResponse.result.content[0].text);
  assert.equal(Array.isArray(healthPayload.checks), true);
  assert.equal(healthPayload.checks.some((check) => check.name === "psk.file"), true);
});

test("control center pairing stores PSK and updates config", async () => {
  const config = await makeBridgeFixture({ withPsk: false });

  const response = await handleRequest(config, {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: {
      name: "edamame_hermes_control_center_apply_pairing",
      arguments: {
        host_kind: "edamame_posture",
        endpoint: "http://127.0.0.1:4010/mcp",
        psk: "pairing-secret",
      },
    },
  });

  const payload = response.result.structuredContent;
  const storedPsk = await fs.readFile(config.edamameMcpPskFile, "utf8");
  const storedConfig = JSON.parse(await readTextFileWithRetry(config.configPath));

  assert.equal(storedPsk.trim(), "pairing-secret");
  assert.equal(storedConfig.host_kind, "edamame_posture");
  assert.equal(storedConfig.edamame_mcp_endpoint, "http://127.0.0.1:4010/mcp");
  assert.equal(storedConfig.edamame_mcp_psk_file, config.edamameMcpPskFile);
  assert.equal(payload.pairing.configured, true);
  assert.equal(payload.config.hostKind, "edamame_posture");
});

test("control center app pairing keeps the canonical Hermes client name", async () => {
  const requestId = "req-app-pair";
  const credential = "edm_mcp_testcredential";
  const pairingBodies = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/mcp/pair") {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      pairingBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ request_id: requestId }));
      return;
    }

    if (request.method === "GET" && request.url === `/mcp/pair/${requestId}`) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "approved", credential }));
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;
  const config = await makeBridgeFixture({ withPsk: false, endpoint });

  try {
    const response = await handleRequest(config, {
      jsonrpc: "2.0",
      id: 10.5,
      method: "tools/call",
      params: {
        name: "edamame_hermes_control_center_request_app_pairing",
        arguments: {
          endpoint,
          client_name: "Hermes",
        },
      },
    });

    const payload = response.result.structuredContent;
    const storedPsk = await fs.readFile(config.edamameMcpPskFile, "utf8");

    assert.equal(storedPsk.trim(), credential);
    assert.equal(payload.pairingMethod, "app_mediated");
    assert.equal(pairingBodies.length, 1);
    assert.equal(pairingBodies[0].client_name, "Hermes");
    assert.equal(pairingBodies[0].agent_type, "hermes");
    assert.equal(pairingBodies[0].agent_instance_id, "hermes-bridge-test");
    assert.equal(pairingBodies[0].requested_endpoint, endpoint);
    assert.equal(pairingBodies[0].workspace_hint, config.workspaceRoot);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("control center can auto-pair a local posture host", { skip: process.platform === "win32" }, async () => {
  const config = await makeBridgeFixture({
    withPsk: false,
    hostKind: "edamame_posture",
    withMockPostureCli: true,
    withMockSystemctl: true,
  });

  const response = await handleRequest(config, {
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {
      name: "edamame_hermes_control_center_run_host_action",
      arguments: {
        action: "generate_and_start",
        host_kind: "edamame_posture",
        endpoint: "http://127.0.0.1:4010/mcp",
      },
    },
  });

  const payload = response.result.structuredContent;
  const storedPsk = await fs.readFile(config.edamameMcpPskFile, "utf8");
  const storedConfig = JSON.parse(await readTextFileWithRetry(config.configPath));

  assert.equal(storedPsk.trim(), config.postureFixture.generatedPsk);
  assert.equal(storedConfig.host_kind, "edamame_posture");
  assert.equal(storedConfig.edamame_mcp_endpoint, "http://127.0.0.1:4010/mcp");
  assert.equal(payload.pairing.configured, true);
  assert.equal(payload.hostController.running, true);
});

test("background refresh loop runs on startup and interval without overlap", async () => {
  const calls = [];
  let concurrentCalls = 0;
  let maxConcurrentCalls = 0;

  const loop = createBackgroundRefreshLoop(
    { divergenceIntervalSecs: 120 },
    {
      intervalMs: 15,
      startupDelayMs: 0,
      runExtrapolation: async () => {
        concurrentCalls += 1;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCalls);
        calls.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrentCalls -= 1;
        return {
          success: true,
          sessionCount: 1,
          upserted: true,
          reasons: ["test_refresh"],
        };
      },
    },
  );

  loop.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  loop.stop();

  assert.ok(calls.length >= 2);
  assert.equal(maxConcurrentCalls, 1);
});

test("hermes-driven refresh skips recent persisted runs", async () => {
  const refresh = createHermesDrivenRefresh(
    { divergenceIntervalSecs: 120 },
    {
      loadState: async () => ({
        lastRunAt: new Date().toISOString(),
      }),
      runExtrapolation: async () => {
        throw new Error("runExtrapolation should not be called");
      },
      logRefresh: false,
    },
  );

  const result = await refresh.maybeRun("tool_call:test");
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "recent_persisted");
});

test("handleRequest serves the control-center app resource", async () => {
  const config = await makeBridgeFixture();

  const resourcesResponse = await handleRequest(config, {
    jsonrpc: "2.0",
    id: 8,
    method: "resources/read",
    params: {
      uri: "ui://edamame/control-center.html",
    },
  });

  assert.equal(resourcesResponse.result.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(resourcesResponse.result.contents[0].text, /Hermes EDAMAME Control Center/);
});

test("healthcheck flags posture system service when expected but not ready", { skip: process.platform === "win32" }, async () => {
  const config = await makeBridgeFixture({
    hostKind: "edamame_posture",
    withMockSystemctl: true,
    mockSystemctlOptions: {
      loadState: "loaded",
      unitFileState: "disabled",
      activeState: "inactive",
    },
    withMockSystemServiceFiles: false,
  });

  const result = await runHealthcheck(config, { strict: true });
  const serviceCheck = result.checks.find((check) => check.name === "posture.system_service");

  assert.equal(serviceCheck?.ok, false);
  assert.equal(serviceCheck?.detail?.unitLoaded, true);
  assert.equal(serviceCheck?.detail?.enabled, false);
  assert.equal(serviceCheck?.detail?.active, false);
  assert.equal(serviceCheck?.detail?.wrapperPresent, false);
  assert.equal(serviceCheck?.detail?.configPresent, false);
});

test("bridge can dispatch the control center tool with structured content", async () => {
  const config = await makeBridgeFixture();

  const response = await handleRequest(config, {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "edamame_hermes_control_center",
      arguments: {},
    },
  });

  assert.equal(typeof response.result.structuredContent.summaryLine, "string");
  assert.equal(response.result.structuredContent.config.hostKind, "edamame_app");
  assert.equal(response.result.structuredContent.pairing.configured, true);
});

test("legacy control center aliases are rejected", async () => {
  const config = await makeBridgeFixture();

  const dottedAliasResponse = await handleRequest(config, {
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: {
      name: "edamame.hermes_control_center",
      arguments: {},
    },
  });

  assert.equal(dottedAliasResponse.error.message, "unsupported_tool:edamame.hermes_control_center");

  const response = await handleRequest(config, {
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: {
      name: "hermes.control_center",
      arguments: {},
    },
  });

  assert.equal(response.error.message, "unsupported_tool:hermes.control_center");
});

test("handleRequest uses Hermes lifecycle refresh hooks", async () => {
  const config = await makeBridgeFixture();
  const calls = [];
  const autoRefresh = {
    kick: (trigger) => calls.push({ type: "kick", trigger }),
    maybeRun: async (trigger) => {
      calls.push({ type: "maybeRun", trigger });
      return { skipped: true, reason: "test_skip" };
    },
  };

  await handleRequest(
    config,
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    },
    { autoRefresh },
  );

  await handleRequest(
    config,
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/list",
      params: {},
    },
    { autoRefresh },
  );

  await handleRequest(
    config,
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "hermes_healthcheck",
        arguments: { strict: false },
      },
    },
    { autoRefresh },
  );

  assert.deepEqual(calls, [
    { type: "kick", trigger: "notifications_initialized" },
    { type: "kick", trigger: "tools_list" },
    { type: "maybeRun", trigger: "tool_call:hermes_healthcheck" },
  ]);
});

test("handleRequest uses ping refresh hook", async () => {
  const config = await makeBridgeFixture();
  const calls = [];
  const autoRefresh = {
    kick: (trigger) => calls.push({ type: "kick", trigger }),
    maybeRun: async () => ({ skipped: true, reason: "test_skip" }),
  };

  const response = await handleRequest(
    config,
    {
      jsonrpc: "2.0",
      id: 7,
      method: "ping",
    },
    { autoRefresh },
  );

  assert.deepEqual(calls, [{ type: "kick", trigger: "ping" }]);
  assert.deepEqual(response.result, {});
});

test("handleRequest skips lifecycle refresh for explicit refresh tool", async () => {
  const config = await makeBridgeFixture();
  let maybeRunCalled = false;
  const autoRefresh = {
    kick: () => {},
    maybeRun: async () => {
      maybeRunCalled = true;
      return { skipped: false };
    },
  };

  const response = await handleRequest(
    config,
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "hermes_refresh_behavioral_model",
        arguments: { dry_run: true },
      },
    },
    { autoRefresh },
  );

  assert.equal(maybeRunCalled, false);
  const payload = JSON.parse(response.result.content[0].text);
  assert.deepEqual(payload.reasons, ["dry_run"]);
});

test("hermes-driven refresh reruns when transcript changed after recent persisted run", async () => {
  const now = Date.now();
  let runExtrapolationCalls = 0;

  const refresh = createHermesDrivenRefresh(
    { divergenceIntervalSecs: 120 },
    {
      loadState: async () => ({
        lastRunAt: new Date(now - 1_000).toISOString(),
      }),
      latestTranscriptMtimeMs: async () => now,
      runExtrapolation: async () => {
        runExtrapolationCalls += 1;
        return {
          success: true,
          sessionCount: 1,
          upserted: true,
          reasons: ["transcript_updated"],
        };
      },
      logRefresh: false,
    },
  );

  const result = await refresh.maybeRun("ping");

  assert.equal(runExtrapolationCalls, 1);
  assert.equal(result.skipped, false);
  assert.deepEqual(result.result?.reasons, ["transcript_updated"]);
});

test("runLatestExtrapolation skips unchanged payload when matching contributor is already remote", async () => {
  const config = await makeBridgeFixture();
  const invocations = [];
  const savedStates = [];

  const result = await runLatestExtrapolation(config, {
    buildPayload: async () => ({
      sessions: [{ sessionId: "session-stable" }],
      rawSessions: {
        agent_type: "hermes",
        agent_instance_id: "hermes-bridge-test",
        source_kind: "hermes",
        sessions: [{ session_key: "session-stable" }],
      },
      rawPayloadHash: "payload-123",
    }),
    loadState: async (_cfg, name) => {
      assert.equal(name, "hermes-extrapolator");
      return {
        lastPayloadHash: "payload-123",
        lastWindowHash: "window-123",
      };
    },
    saveState: async (_cfg, name, value) => {
      assert.equal(name, "hermes-extrapolator");
      savedStates.push(value);
    },
    makeClient: async () => ({
      invoke: async (toolName) => {
        invocations.push(toolName);
        if (toolName === "get_behavioral_model") {
          return {
            contributors: [
              {
                agent_type: "hermes",
                agent_instance_id: "hermes-bridge-test",
                hash: "window-123",
              },
            ],
          };
        }
        throw new Error(`unexpected_tool:${toolName}`);
      },
    }),
  });

  assert.equal(result.upserted, false);
  assert.deepEqual(result.reasons, ["payload_unchanged_remote_current"]);
  assert.equal(result.windowHash, "window-123");
  assert.equal(result.remoteContributorHash, "window-123");
  assert.deepEqual(invocations, ["get_behavioral_model"]);
  assert.equal(savedStates.length, 1);
  assert.equal(savedStates[0].lastWindowHash, "window-123");
});

test("runLatestExtrapolation repushes unchanged payload when contributor is missing remotely", async () => {
  const config = await makeBridgeFixture();
  const invocations = [];
  const savedStates = [];

  const result = await runLatestExtrapolation(config, {
    buildPayload: async () => ({
      sessions: [{ sessionId: "session-stable" }],
      rawSessions: {
        agent_type: "hermes",
        agent_instance_id: "hermes-bridge-test",
        source_kind: "hermes",
        sessions: [{ session_key: "session-stable" }],
      },
      rawPayloadHash: "payload-123",
    }),
    loadState: async () => ({
      lastPayloadHash: "payload-123",
      lastWindowHash: "window-123",
    }),
    saveState: async (_cfg, _name, value) => {
      savedStates.push(value);
    },
    makeClient: async () => ({
      invoke: async (toolName) => {
        invocations.push(toolName);
        if (toolName === "get_behavioral_model") {
          return { model: null };
        }
        if (toolName === "upsert_behavioral_model_from_raw_sessions") {
          return {
            window: {
              hash: "window-456",
              predictions: [],
            },
          };
        }
        if (toolName === "get_divergence_engine_status") {
          return { running: true };
        }
        throw new Error(`unexpected_tool:${toolName}`);
      },
    }),
  });

  assert.equal(result.upserted, true);
  assert.deepEqual(result.reasons, ["raw_ingest", "repush_remote_missing"]);
  assert.equal(result.windowHash, "window-456");
  assert.equal(result.remoteContributorHash, null);
  assert.deepEqual(invocations, [
    "get_behavioral_model",
    "upsert_behavioral_model_from_raw_sessions",
    "get_divergence_engine_status",
  ]);
  assert.equal(savedStates.length, 1);
  assert.equal(savedStates[0].lastWindowHash, "window-456");
});

test("runLatestExtrapolation restores cached window when no active sessions remain", async () => {
  const config = await makeBridgeFixture();
  const invocations = [];
  const cachedWindow = {
    window_start: "2026-03-08T14:00:00.000Z",
    window_end: "2026-03-08T14:05:00.000Z",
    agent_type: "hermes",
    agent_instance_id: "hermes-bridge-test",
    predictions: [],
    contributors: [
      {
        agent_type: "hermes",
        agent_instance_id: "hermes-bridge-test",
        prediction_count: 0,
        hash: "window-cached",
        window_start: "2026-03-08T14:00:00.000Z",
        window_end: "2026-03-08T14:05:00.000Z",
        ingested_at: "2026-03-08T14:05:00.000Z",
      },
    ],
    version: "raw-session-llm/1",
    hash: "window-cached",
    ingested_at: "2026-03-08T14:05:00.000Z",
  };
  const savedStates = [];

  const result = await runLatestExtrapolation(config, {
    buildPayload: async () => ({
      sessions: [],
      rawSessions: {
        agent_type: "hermes",
        agent_instance_id: "hermes-bridge-test",
        source_kind: "hermes",
        sessions: [],
      },
      rawPayloadHash: "payload-empty",
    }),
    loadState: async () => ({
      lastPayloadHash: "payload-123",
      lastWindowHash: "window-cached",
      lastSessionIds: ["session-stable"],
      lastGeneratedWindow: cachedWindow,
    }),
    saveState: async (_cfg, _name, value) => {
      savedStates.push(value);
    },
    makeClient: async () => ({
      invoke: async (toolName, args) => {
        invocations.push(toolName);
        if (toolName === "get_behavioral_model") {
          return { model: null };
        }
        if (toolName === "upsert_behavioral_model") {
          assert.equal(JSON.parse(args.window_json).hash, "window-cached");
          return { success: true };
        }
        if (toolName === "get_divergence_engine_status") {
          return { running: true };
        }
        throw new Error(`unexpected_tool:${toolName}`);
      },
    }),
  });

  assert.equal(result.success, true);
  assert.equal(result.upserted, true);
  assert.equal(result.sessionCount, 0);
  assert.equal(result.rawPayloadHash, "payload-123");
  assert.equal(result.windowHash, "window-cached");
  assert.deepEqual(result.reasons, [
    "cached_window_repush_no_active_sessions",
    "repush_remote_missing",
  ]);
  assert.deepEqual(invocations, [
    "get_behavioral_model",
    "upsert_behavioral_model",
    "get_divergence_engine_status",
  ]);
  assert.equal(savedStates.length, 1);
  assert.equal(savedStates[0].lastWindowHash, "window-cached");
});

test("runLatestExtrapolation skips cached recovery when remote contributor is still current", async () => {
  const config = await makeBridgeFixture();
  const invocations = [];
  const cachedWindow = {
    window_start: "2026-03-08T14:00:00.000Z",
    window_end: "2026-03-08T14:05:00.000Z",
    agent_type: "hermes",
    agent_instance_id: "hermes-bridge-test",
    predictions: [],
    contributors: [],
    version: "raw-session-llm/1",
    hash: "window-cached",
    ingested_at: "2026-03-08T14:05:00.000Z",
  };
  const savedStates = [];

  const result = await runLatestExtrapolation(config, {
    buildPayload: async () => ({
      sessions: [],
      rawSessions: {
        agent_type: "hermes",
        agent_instance_id: "hermes-bridge-test",
        source_kind: "hermes",
        sessions: [],
      },
      rawPayloadHash: "payload-empty",
    }),
    loadState: async () => ({
      lastPayloadHash: "payload-123",
      lastWindowHash: "window-cached",
      lastSessionIds: ["session-stable"],
      lastGeneratedWindow: cachedWindow,
    }),
    saveState: async (_cfg, _name, value) => {
      savedStates.push(value);
    },
    makeClient: async () => ({
      invoke: async (toolName) => {
        invocations.push(toolName);
        if (toolName === "get_behavioral_model") {
          return {
            contributors: [
              {
                agent_type: "hermes",
                agent_instance_id: "hermes-bridge-test",
                hash: "window-cached",
              },
            ],
          };
        }
        throw new Error(`unexpected_tool:${toolName}`);
      },
    }),
  });

  assert.equal(result.success, true);
  assert.equal(result.upserted, false);
  assert.equal(result.windowHash, "window-cached");
  assert.deepEqual(result.reasons, ["no_active_sessions_remote_current"]);
  assert.deepEqual(invocations, ["get_behavioral_model"]);
  assert.equal(savedStates.length, 1);
  assert.equal(savedStates[0].lastWindowHash, "window-cached");
});

test("runLatestExtrapolation retries retryable behavioral-model parse failures", async () => {
  const config = await makeBridgeFixture();
  const invocations = [];
  const savedStates = [];
  let rawIngestAttempts = 0;

  const result = await runLatestExtrapolation(config, {
    buildPayload: async () => ({
      sessions: [{ sessionId: "session-retry" }],
      rawSessions: {
        agent_type: "hermes",
        agent_instance_id: "hermes-bridge-test",
        source_kind: "hermes",
        sessions: [{ session_key: "session-retry" }],
      },
      rawPayloadHash: "payload-retry",
    }),
    loadState: async () => ({}),
    saveState: async (_cfg, _name, value) => {
      savedStates.push(value);
    },
    makeClient: async () => ({
      invoke: async (toolName) => {
        invocations.push(toolName);
        if (toolName === "upsert_behavioral_model_from_raw_sessions") {
          rawIngestAttempts += 1;
          if (rawIngestAttempts < 3) {
            throw new Error("tools_call_error:Unable to parse behavioral model JSON from LLM response");
          }
          return {
            window: {
              hash: "window-retry",
              predictions: [],
            },
          };
        }
        if (toolName === "get_divergence_engine_status") {
          return { running: true };
        }
        throw new Error(`unexpected_tool:${toolName}`);
      },
    }),
  });

  assert.equal(result.success, true);
  assert.equal(result.upserted, true);
  assert.equal(result.windowHash, "window-retry");
  assert.equal(result.attemptCount, 3);
  assert.equal(result.retryCount, 2);
  assert.deepEqual(result.reasons, ["raw_ingest", "raw_ingest_retry_success"]);
  assert.deepEqual(invocations, [
    "upsert_behavioral_model_from_raw_sessions",
    "upsert_behavioral_model_from_raw_sessions",
    "upsert_behavioral_model_from_raw_sessions",
    "get_divergence_engine_status",
  ]);
  assert.equal(savedStates.length, 1);
  assert.equal(savedStates[0].lastAttemptCount, 3);
  assert.equal(savedStates[0].lastRetryCount, 2);
  assert.equal(savedStates[0].lastError, null);
});

test("runLatestExtrapolation returns structured failure when EDAMAME MCP is unreachable", async () => {
  const config = await makeBridgeFixture();
  const savedStates = [];

  const result = await runLatestExtrapolation(config, {
    buildPayload: async () => ({
      sessions: [{ sessionId: "session-unreachable" }],
      rawSessions: {
        agent_type: "hermes",
        agent_instance_id: "hermes-bridge-test",
        source_kind: "hermes",
        sessions: [{ session_key: "session-unreachable" }],
      },
      rawPayloadHash: "payload-unreachable",
    }),
    loadState: async () => ({
      lastPayloadHash: "payload-previous",
      lastWindowHash: "window-previous",
    }),
    saveState: async (_cfg, _name, value) => {
      savedStates.push(value);
    },
    makeClient: async () => ({
      invoke: async () => {
        throw new TypeError("fetch failed");
      },
    }),
  });

  assert.equal(result.success, false);
  assert.equal(result.upserted, false);
  assert.equal(result.error, "fetch failed");
  assert.deepEqual(result.reasons, ["edamame_mcp_unreachable"]);
  assert.equal(result.attemptCount, 1);
  assert.equal(result.retryCount, 0);
  assert.equal(savedStates.length, 1);
  assert.equal(savedStates[0].lastPayloadHash, "payload-previous");
  assert.equal(savedStates[0].lastWindowHash, "window-previous");
  assert.equal(savedStates[0].lastError, "fetch failed");
});

test("runLatestExtrapolation classifies MCP auth failures separately", async () => {
  const config = await makeBridgeFixture();
  const savedStates = [];

  const result = await runLatestExtrapolation(config, {
    buildPayload: async () => ({
      sessions: [{ sessionId: "session-auth-failure" }],
      rawSessions: {
        agent_type: "hermes",
        agent_instance_id: "hermes-bridge-test",
        source_kind: "hermes",
        sessions: [{ session_key: "session-auth-failure" }],
      },
      rawPayloadHash: "payload-auth-failure",
    }),
    loadState: async () => ({
      lastWindowHash: "window-previous",
    }),
    saveState: async (_cfg, _name, value) => {
      savedStates.push(value);
    },
    makeClient: async () => ({
      invoke: async () => {
        throw new Error("http_401:unauthorized");
      },
    }),
  });

  assert.equal(result.success, false);
  assert.equal(result.upserted, false);
  assert.equal(result.error, "http_401:unauthorized");
  assert.deepEqual(result.reasons, ["edamame_mcp_auth_failed"]);
  assert.equal(result.attemptCount, 1);
  assert.equal(result.retryCount, 0);
  assert.equal(savedStates.length, 1);
  assert.equal(savedStates[0].lastWindowHash, "window-previous");
  assert.equal(savedStates[0].lastError, "http_401:unauthorized");
});

test("runLatestExtrapolation returns structured failure when local PSK is missing", async () => {
  const config = await makeBridgeFixture({ withPsk: false });
  const savedStates = [];

  const result = await runLatestExtrapolation(config, {
    buildPayload: async () => ({
      sessions: [{ sessionId: "session-missing-psk" }],
      rawSessions: {
        agent_type: "hermes",
        agent_instance_id: "hermes-bridge-test",
        source_kind: "hermes",
        sessions: [{ session_key: "session-missing-psk" }],
      },
      rawPayloadHash: "payload-missing-psk",
    }),
    loadState: async () => ({
      lastWindowHash: "window-previous",
    }),
    saveState: async (_cfg, _name, value) => {
      savedStates.push(value);
    },
    makeClient: async () => {
      throw new Error("ENOENT: no such file or directory, open '/tmp/edamame-mcp.psk'");
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.upserted, false);
  assert.deepEqual(result.reasons, ["edamame_mcp_psk_missing"]);
  assert.match(result.error || "", /ENOENT/i);
  assert.equal(savedStates.length, 1);
  assert.equal(savedStates[0].lastWindowHash, "window-previous");
  assert.equal(savedStates[0].lastAttemptCount, 0);
});

test("runHealthcheck surfaces MCP auth failures clearly", async () => {
  await withMockMcpAuthServer(async (endpoint) => {
    const config = await makeBridgeFixture({
      endpoint,
      pskValue: "wrong-psk",
    });

    const result = await runHealthcheck(config, { strict: false });
    const endpointCheck = result.checks.find((check) => check.name === "mcp.endpoint");
    const authCheck = result.checks.find((check) => check.name === "mcp.authentication");

    assert.equal(endpointCheck?.ok, false);
    assert.equal(endpointCheck?.detail?.reason, "edamame_mcp_auth_failed");
    assert.match(endpointCheck?.detail?.message || "", /http_401/i);
    assert.match(endpointCheck?.detail?.summary || "", /PSK/i);
    assert.equal(authCheck?.ok, false);
    assert.equal(authCheck?.detail?.status, "auth_failed");
  });
});

test("control center prioritizes auth failure summary and refresh result", async () => {
  await withMockMcpAuthServer(async (endpoint) => {
    const config = await makeBridgeFixture({
      endpoint,
      pskValue: "wrong-psk",
    });

    const payload = await buildControlCenterPayload(config, { refreshNow: true });

    assert.match(payload.summaryLine, /PSK/i);
    assert.equal(payload.refreshResult?.success, false);
    assert.deepEqual(payload.refreshResult?.reasons, ["edamame_mcp_auth_failed"]);
    assert.equal(
      payload.health?.checks?.some(
        (check) => check.name === "mcp.authentication" && check.ok === false,
      ),
      true,
    );
    assert.equal(payload.extrapolator?.authFailed, true);
  });
});

test("runLatestExtrapolation returns structured failure after repeated parse failures", async () => {
  const config = await makeBridgeFixture();
  const savedStates = [];
  let rawIngestAttempts = 0;

  const result = await runLatestExtrapolation(config, {
    buildPayload: async () => ({
      sessions: [{ sessionId: "session-parse-failure" }],
      rawSessions: {
        agent_type: "hermes",
        agent_instance_id: "hermes-bridge-test",
        source_kind: "hermes",
        sessions: [{ session_key: "session-parse-failure" }],
      },
      rawPayloadHash: "payload-parse-failure",
    }),
    loadState: async () => ({
      lastPayloadHash: "payload-previous",
      lastWindowHash: "window-previous",
    }),
    saveState: async (_cfg, _name, value) => {
      savedStates.push(value);
    },
    makeClient: async () => ({
      invoke: async (toolName) => {
        if (toolName === "upsert_behavioral_model_from_raw_sessions") {
          rawIngestAttempts += 1;
          throw new Error("tools_call_error:Unable to parse behavioral model JSON from LLM response");
        }
        throw new Error(`unexpected_tool:${toolName}`);
      },
    }),
  });

  assert.equal(result.success, false);
  assert.equal(result.upserted, false);
  assert.deepEqual(result.reasons, ["behavioral_model_generation_failed"]);
  assert.equal(result.attemptCount, 3);
  assert.equal(result.retryCount, 2);
  assert.match(result.error, /Unable to parse behavioral model JSON from LLM response/);
  assert.equal(rawIngestAttempts, 3);
  assert.equal(savedStates.length, 1);
  assert.equal(savedStates[0].lastPayloadHash, "payload-previous");
  assert.equal(savedStates[0].lastWindowHash, "window-previous");
  assert.equal(savedStates[0].lastAttemptCount, 3);
  assert.equal(savedStates[0].lastRetryCount, 2);
});

test("runLatestExtrapolation pushes heartbeat window when no sessions and no cached window", async () => {
  const config = await makeBridgeFixture();
  const invocations = [];
  const savedStates = [];
  let upsertedWindowJson = null;

  const result = await runLatestExtrapolation(config, {
    buildPayload: async () => ({
      sessions: [],
      rawSessions: {
        agent_type: "hermes",
        agent_instance_id: "hermes-bridge-test",
        source_kind: "hermes",
        sessions: [],
      },
      rawPayloadHash: "payload-empty",
    }),
    loadState: async () => ({}),
    saveState: async (_cfg, _name, value) => {
      savedStates.push(value);
    },
    makeClient: async () => ({
      invoke: async (toolName, params) => {
        invocations.push(toolName);
        if (toolName === "upsert_behavioral_model") {
          upsertedWindowJson = params.window_json;
          return { ok: true };
        }
        throw new Error(`unexpected_tool:${toolName}`);
      },
    }),
  });

  assert.equal(result.success, true);
  assert.equal(result.upserted, true);
  assert.deepEqual(result.reasons, ["heartbeat"]);
  assert.equal(result.sessionCount, 0);
  assert.deepEqual(invocations, ["upsert_behavioral_model"]);

  const heartbeat = JSON.parse(upsertedWindowJson);
  assert.equal(heartbeat.agent_type, "hermes");
  assert.equal(heartbeat.agent_instance_id, "hermes-bridge-test");
  assert.equal(heartbeat.predictions.length, 1);
  assert.match(heartbeat.predictions[0].action, /cron tick.*no new reasoning/i);
  assert.match(heartbeat.predictions[0].session_key, /heartbeat/);
  assert.deepEqual(heartbeat.predictions[0].expected_l7_protocols, ["https"]);
  assert.ok(Array.isArray(heartbeat.predictions[0].scope_process_paths));
  assert.ok(Array.isArray(heartbeat.predictions[0].scope_parent_paths));
  assert.ok(Array.isArray(heartbeat.predictions[0].scope_grandparent_paths));
  assert.ok(Array.isArray(heartbeat.predictions[0].scope_any_lineage_paths));
  assert.ok(Array.isArray(heartbeat.predictions[0].expected_grandparent_paths));
  assert.ok(Array.isArray(heartbeat.predictions[0].not_expected_grandparent_paths));

  assert.equal(savedStates.length, 1);
  assert.deepEqual(savedStates[0].lastReasons, ["heartbeat"]);
  assert.equal(savedStates[0].lastGeneratedWindow.agent_type, "hermes");
});

test("healthcheck CLI emits auth failure details for invalid PSK", async () => {
  await withMockMcpAuthServer(async (endpoint) => {
    const config = await makeBridgeFixture({
      endpoint,
      pskValue: "wrong-psk",
    });
    const scriptPath = path.resolve(TEST_DIR, "../setup/healthcheck.sh");
    const { code, stdout, stderr } = await runScript(
      "bash",
      [scriptPath, "--json", "--strict", "--config", config.configPath],
      { cwd: path.resolve(TEST_DIR, ".."), env: process.env },
    );

    assert.equal(code, 1, `expected healthcheck CLI to fail, stderr=${stderr}`);
    const payload = JSON.parse(stdout);
    const authCheck = payload.checks.find((check) => check.name === "mcp.authentication");
    assert.equal(authCheck?.ok, false);
    assert.equal(authCheck?.detail?.reason, "edamame_mcp_auth_failed");
    assert.match(authCheck?.detail?.summary || "", /PSK/i);
  });
});
