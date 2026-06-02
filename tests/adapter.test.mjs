import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRawSessionIngestPayload, collectTranscriptSessions } from "../adapters/session_prediction_adapter.mjs";

async function makeTempFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-edamame-adapter-"));
  const workspaceRoot = path.join(root, "edamame_project");
  const siblingRepo = path.join(root, "edamame_core");
  const hermesSessionsRoot = path.join(root, "claude-projects");
  const transcriptDir = path.join(hermesSessionsRoot, "fixture-workspace");

  await fs.mkdir(path.join(workspaceRoot, "tests"), { recursive: true });
  await fs.mkdir(siblingRepo, { recursive: true });
  await fs.mkdir(transcriptDir, { recursive: true });

  const transcriptPath = path.join(transcriptDir, "session-one.txt");
  await fs.writeFile(
    transcriptPath,
    `user:
<user_query>
update the divergence engine tests and run cargo test
</user_query>

assistant:
[Tool call] ReadFile
  path: ${workspaceRoot}/tests/example_test.sh
[Tool call] Bash
  command: cargo test -p edamame_core
[Tool call] Bash
  command: python3 scripts/report.py --port 3000
[Tool call] WebSearch
  query: cargo flaky test
assistant:
I will only touch \`${workspaceRoot}/tests/example_test.sh\` and \`${workspaceRoot}/src/lib.rs\`.
Do not access ~/.ssh/id_rsa or any sibling repositories.
`,
    "utf8",
  );

  return { root, workspaceRoot, siblingRepo, hermesSessionsRoot, transcriptDir };
}

function makeBaseConfig(fixture, overrides = {}) {
  return {
    workspaceRoot: fixture.workspaceRoot,
    hermesSessionsRoot: fixture.hermesSessionsRoot,
    transcriptProjectHints: ["fixture-workspace"],
    transcriptLimit: 4,
    transcriptRecencyHours: 48,
    transcriptActiveWindowMinutes: 5,
    agentType: "hermes",
    agentInstanceId: "hermes-test-fixture",
    hermesLlmHosts: ["api.anthropic.com:443"],
    ...overrides,
  };
}

test("collectTranscriptSessions parses txt transcript tool calls", async () => {
  const fixture = await makeTempFixture();
  const sessions = await collectTranscriptSessions(makeBaseConfig(fixture));

  assert.equal(sessions.length, 1);
  assert.deepEqual(
    sessions[0].toolNames.sort(),
    ["Bash", "ReadFile", "WebSearch"].sort(),
  );
  assert.equal(sessions[0].commands.length, 2);
});

test("buildRawSessionIngestPayload forwards transcript context with derived session hints", async () => {
  const fixture = await makeTempFixture();
  const result = await buildRawSessionIngestPayload(
    makeBaseConfig(fixture, {
      scopeParentPaths: ["*/Hermes*", "*/hermes_edamame_mcp.mjs"],
    }),
  );

  assert.equal(result.rawSessions.agent_type, "hermes");
  assert.equal(result.rawSessions.agent_instance_id, "hermes-test-fixture");
  assert.equal(result.rawSessions.source_kind, "hermes");
  assert.equal(result.rawSessions.sessions.length, 1);
  const rawSession = result.rawSessions.sessions[0];

  assert.equal(rawSession.session_key, "session-one");
  assert.equal(rawSession.title, "update the divergence engine tests and run cargo test");
  assert.deepEqual(rawSession.tool_names.sort(), ["Bash", "ReadFile", "WebSearch"].sort());
  assert.ok(rawSession.commands.some((entry) => entry.includes("cargo test -p edamame_core")));
  assert.ok(rawSession.commands.some((entry) => entry.includes("python3 scripts/report.py --port 3000")));
  assert.ok(rawSession.user_text.includes("update the divergence engine tests"));
  assert.ok(rawSession.assistant_text.includes("Do not access ~/.ssh/id_rsa"));
  assert.deepEqual(rawSession.derived_expected_process_paths, ["*/cargo", "*/python*"]);
  const fwd = (p) => p.replace(/\\/g, "/");
  const openFiles = rawSession.derived_expected_open_files.map(fwd);
  assert.deepEqual(rawSession.derived_expected_parent_paths.map(fwd), [fwd(path.join(fixture.workspaceRoot, "scripts/report.py"))]);
  assert.deepEqual(rawSession.derived_scope_parent_paths, ["*/Hermes*", "*/hermes_edamame_mcp.mjs"]);
  assert.deepEqual(rawSession.derived_expected_local_open_ports, [3000]);
  assert.ok(rawSession.derived_expected_traffic.includes("api.anthropic.com:443"));
  assert.ok(rawSession.derived_expected_traffic.includes("crates.io:443"));
  assert.ok(rawSession.derived_expected_traffic.includes("static.crates.io:443"));
  assert.ok(rawSession.derived_expected_traffic.includes("github.com:443"));
  assert.ok(openFiles.includes(fwd(path.join(fixture.workspaceRoot, "src/lib.rs"))));
  assert.ok(
    openFiles.includes(fwd(path.join(fixture.workspaceRoot, "tests/example_test.sh"))),
  );
  assert.ok(openFiles.includes(fwd(path.join(fixture.workspaceRoot, "scripts/report.py"))));
  assert.ok(!rawSession.derived_expected_open_files.includes("~/.ssh/id_rsa"));
  assert.ok(rawSession.raw_text.includes("[Tool call] Bash"));
  assert.ok(rawSession.source_path.endsWith("session-one.txt"));
  assert.ok(result.rawPayloadHash.length > 10);
});

test("collectTranscriptSessions uses the freshest transcript artifact per session", async () => {
  const fixture = await makeTempFixture();
  const txtPath = path.join(fixture.transcriptDir, "session-fresh.txt");
  const jsonlPath = path.join(fixture.transcriptDir, "session-fresh.jsonl");
  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 60_000);

  await fs.writeFile(
    txtPath,
    `user:
<user_query>
older txt session content
</user_query>
`,
    "utf8",
  );
  await fs.writeFile(
    jsonlPath,
    `${JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "newer jsonl session content" }] },
    })}\n`,
    "utf8",
  );
  await fs.utimes(txtPath, oneMinuteAgo, oneMinuteAgo);
  await fs.utimes(jsonlPath, now, now);

  const sessions = await collectTranscriptSessions(makeBaseConfig(fixture));

  const freshSession = sessions.find((session) => session.sessionId === "session-fresh");
  assert.ok(freshSession);
  assert.equal(freshSession.sourcePath, jsonlPath);
  assert.equal(freshSession.sourceFormat, "jsonl");
  assert.ok(freshSession.userText.includes("newer jsonl session content"));
});

test("collectTranscriptSessions excludes sessions inactive beyond the active window", async () => {
  const fixture = await makeTempFixture();
  const stalePath = path.join(fixture.transcriptDir, "session-stale.txt");
  const recentPath = path.join(fixture.transcriptDir, "session-recent.txt");
  const now = new Date();
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60_000);

  await fs.writeFile(
    stalePath,
    `user:
<user_query>
stale session
</user_query>
`,
    "utf8",
  );
  await fs.writeFile(
    recentPath,
    `user:
<user_query>
recent session
</user_query>
`,
    "utf8",
  );
  await fs.utimes(stalePath, tenMinutesAgo, tenMinutesAgo);
  await fs.utimes(recentPath, now, now);

  const sessions = await collectTranscriptSessions(makeBaseConfig(fixture));

  assert.ok(sessions.some((session) => session.sessionId === "session-recent"));
  assert.ok(!sessions.some((session) => session.sessionId === "session-stale"));
});

test("collectTranscriptSessions extracts tools and commands from JSONL assistant text", async () => {
  const fixture = await makeTempFixture();
  const jsonlPath = path.join(fixture.transcriptDir, "session-jsonl-tools.jsonl");

  const assistantText = [
    "I need to read the divergence engine config. Let me use the Read tool to look at the file.",
    "Now I'll run cargo build --features standalone,swiftrs to verify it compiles.",
    "The Bash command showed compilation errors. Let me fix them with StrReplace.",
    "I'll also run flutter analyze to check for lint issues.",
    "Let me use Grep to search for the function definition across the codebase.",
    "I need to check git status to see what files have changed.",
  ].join("\n\n");

  const lines = [
    JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "fix the divergence engine and run cargo build" }] },
    }),
    JSON.stringify({
      role: "assistant",
      message: { content: [{ type: "text", text: assistantText }] },
    }),
  ].join("\n");

  await fs.writeFile(jsonlPath, lines, "utf8");

  const sessions = await collectTranscriptSessions(
    makeBaseConfig(fixture, { hermesLlmHosts: [] }),
  );

  const session = sessions.find((s) => s.sessionId === "session-jsonl-tools");
  assert.ok(session, "JSONL session should be found");
  assert.equal(session.sourceFormat, "jsonl");

  assert.ok(session.toolNames.includes("Read"), `toolNames should include Read, got: ${session.toolNames}`);
  assert.ok(session.toolNames.includes("Bash"), `toolNames should include Bash, got: ${session.toolNames}`);
  assert.ok(session.toolNames.includes("StrReplace"), `toolNames should include StrReplace, got: ${session.toolNames}`);
  assert.ok(session.toolNames.includes("Grep"), `toolNames should include Grep, got: ${session.toolNames}`);

  assert.ok(
    session.commands.some((cmd) => cmd.includes("cargo build")),
    `commands should include cargo build, got: ${JSON.stringify(session.commands)}`,
  );
  assert.ok(
    session.commands.some((cmd) => cmd.includes("flutter analyze")),
    `commands should include flutter analyze, got: ${JSON.stringify(session.commands)}`,
  );
  assert.ok(
    session.commands.some((cmd) => cmd.includes("git status")),
    `commands should include git status, got: ${JSON.stringify(session.commands)}`,
  );
});

test("buildRawSessionIngestPayload populates derived hints from JSONL prose extraction", async () => {
  const fixture = await makeTempFixture();
  const jsonlPath = path.join(fixture.transcriptDir, "session-jsonl-derive.jsonl");

  const assistantText = [
    "I need to run cargo test --features standalone to verify the changes.",
    "Let me also run npm install in the frontend directory.",
    `The file ${fixture.workspaceRoot}/src/divergence.rs needs a StrReplace fix.`,
    "I'll use the Bash tool to execute the build.",
    "The service runs on localhost:8080 for the MCP endpoint.",
  ].join("\n\n");

  const lines = [
    JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "build and test the divergence module" }] },
    }),
    JSON.stringify({
      role: "assistant",
      message: { content: [{ type: "text", text: assistantText }] },
    }),
  ].join("\n");

  await fs.writeFile(jsonlPath, lines, "utf8");

  const result = await buildRawSessionIngestPayload(
    makeBaseConfig(fixture, {
      hermesLlmHosts: [],
      scopeParentPaths: [],
    }),
  );

  const session = result.rawSessions.sessions.find((s) => s.session_key === "session-jsonl-derive");
  assert.ok(session, "JSONL derive session should be found");

  assert.ok(session.tool_names.includes("Bash"), `tool_names should have Bash: ${session.tool_names}`);
  assert.ok(session.tool_names.includes("StrReplace"), `tool_names should have StrReplace: ${session.tool_names}`);

  assert.ok(
    session.commands.some((cmd) => cmd.includes("cargo test")),
    `commands should have cargo test: ${JSON.stringify(session.commands)}`,
  );
  assert.ok(
    session.commands.some((cmd) => cmd.includes("npm install")),
    `commands should have npm install: ${JSON.stringify(session.commands)}`,
  );

  assert.ok(
    session.derived_expected_process_paths.includes("*/cargo"),
    `process paths should have */cargo: ${session.derived_expected_process_paths}`,
  );
  assert.ok(
    session.derived_expected_process_paths.includes("*/node"),
    `process paths should have */node: ${session.derived_expected_process_paths}`,
  );

  assert.ok(
    session.derived_expected_traffic.includes("crates.io:443"),
    `traffic should have crates.io: ${session.derived_expected_traffic}`,
  );
  assert.ok(
    session.derived_expected_traffic.includes("registry.npmjs.org:443"),
    `traffic should have npm registry: ${session.derived_expected_traffic}`,
  );

  assert.ok(
    session.derived_expected_local_open_ports.includes(8080),
    `ports should have 8080: ${session.derived_expected_local_open_ports}`,
  );
});

test("JSONL nmap session extracts commands, traffic targets, ports, and process paths", async () => {
  const fixture = await makeTempFixture();
  const jsonlPath = path.join(fixture.transcriptDir, "session-nmap.jsonl");

  const assistantText = [
    "I'll run a port scan against `www.edamame.tech` using `nmap`.",
    "",
    "Here are the results:",
    "**Host:** `www.edamame.tech` (35.71.142.77)",
    "- Also resolves to: 52.223.52.2",
    "- rDNS: `a0b1d980e1f2226c6.awsglobalaccelerator.com` (AWS Global Accelerator)",
    "",
    "**Open Ports (2 of 1000 scanned):**",
    "",
    "| Port | State | Service |",
    "|------|-------|---------|",
    "| 80/tcp | open | HTTP |",
    "| 443/tcp | open | HTTPS |",
    "",
    "**998 ports** are filtered (no response), which is expected behind AWS Global Accelerator.",
  ].join("\n");

  const lines = [
    JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "port scan www.edamame.tech" }] },
    }),
    JSON.stringify({
      role: "assistant",
      message: { content: [{ type: "text", text: assistantText }] },
    }),
  ].join("\n");

  await fs.writeFile(jsonlPath, lines, "utf8");

  const result = await buildRawSessionIngestPayload(
    makeBaseConfig(fixture, {
      hermesLlmHosts: [],
      scopeParentPaths: [],
    }),
  );

  const session = result.rawSessions.sessions.find((s) => s.session_key === "session-nmap");
  assert.ok(session, "nmap session should be found");

  assert.ok(
    session.commands.some((cmd) => cmd.includes("nmap")),
    `commands should include nmap: ${JSON.stringify(session.commands)}`,
  );

  assert.ok(
    session.derived_expected_process_paths.includes("*/nmap"),
    `process paths should have */nmap: ${session.derived_expected_process_paths}`,
  );

  assert.ok(
    session.derived_expected_traffic.some((t) => t.includes("www.edamame.tech")),
    `traffic should include www.edamame.tech: ${session.derived_expected_traffic}`,
  );

  assert.ok(
    session.derived_expected_traffic.some((t) => t.includes("awsglobalaccelerator.com")),
    `traffic should include rDNS host: ${session.derived_expected_traffic}`,
  );

  assert.ok(
    session.derived_expected_local_open_ports.includes(80),
    `ports should include 80: ${session.derived_expected_local_open_ports}`,
  );
  assert.ok(
    session.derived_expected_local_open_ports.includes(443),
    `ports should include 443: ${session.derived_expected_local_open_ports}`,
  );
});

test("JSONL session with ssh, ping, and dig extracts all commands and traffic", async () => {
  const fixture = await makeTempFixture();
  const jsonlPath = path.join(fixture.transcriptDir, "session-network.jsonl");

  const assistantText = [
    "I'll check connectivity to the server first.",
    "Running ping api.example.com to verify it's reachable.",
    "Now let me run dig api.example.com to check DNS resolution.",
    "The server is up. Let me ssh deploy@api.example.com to check the logs.",
    "I'll also use curl https://api.example.com/health to check the API endpoint.",
  ].join("\n\n");

  const lines = [
    JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "check server health and deploy" }] },
    }),
    JSON.stringify({
      role: "assistant",
      message: { content: [{ type: "text", text: assistantText }] },
    }),
  ].join("\n");

  await fs.writeFile(jsonlPath, lines, "utf8");

  const result = await buildRawSessionIngestPayload(
    makeBaseConfig(fixture, {
      hermesLlmHosts: [],
      scopeParentPaths: [],
    }),
  );

  const session = result.rawSessions.sessions.find((s) => s.session_key === "session-network");
  assert.ok(session, "network session should be found");

  assert.ok(
    session.commands.some((cmd) => cmd.includes("ping")),
    `commands should include ping: ${JSON.stringify(session.commands)}`,
  );
  assert.ok(
    session.commands.some((cmd) => cmd.includes("dig")),
    `commands should include dig: ${JSON.stringify(session.commands)}`,
  );
  assert.ok(
    session.commands.some((cmd) => cmd.includes("ssh")),
    `commands should include ssh: ${JSON.stringify(session.commands)}`,
  );
  assert.ok(
    session.commands.some((cmd) => cmd.includes("curl")),
    `commands should include curl: ${JSON.stringify(session.commands)}`,
  );

  assert.ok(
    session.derived_expected_process_paths.includes("*/ping"),
    `process paths should have */ping: ${session.derived_expected_process_paths}`,
  );
  assert.ok(
    session.derived_expected_process_paths.includes("*/dig"),
    `process paths should have */dig: ${session.derived_expected_process_paths}`,
  );
  assert.ok(
    session.derived_expected_process_paths.includes("*/ssh"),
    `process paths should have */ssh: ${session.derived_expected_process_paths}`,
  );
  assert.ok(
    session.derived_expected_process_paths.includes("*/curl"),
    `process paths should have */curl: ${session.derived_expected_process_paths}`,
  );

  assert.ok(
    session.derived_expected_traffic.some((t) => t.includes("api.example.com")),
    `traffic should include api.example.com: ${session.derived_expected_traffic}`,
  );
});

test("TXT transcript with nmap extracts structured tool calls and port results", async () => {
  const fixture = await makeTempFixture();
  const txtPath = path.join(fixture.transcriptDir, "session-nmap-txt.txt");

  await fs.writeFile(
    txtPath,
    `user:
<user_query>
port scan www.edamame.tech
</user_query>

A:
[Tool call] Bash
  command: nmap -p 1-1000 www.edamame.tech
assistant:
Here are the results:
Host: www.edamame.tech (35.71.142.77)
80/tcp open HTTP
443/tcp open HTTPS
998 ports filtered
`,
    "utf8",
  );

  const result = await buildRawSessionIngestPayload(
    makeBaseConfig(fixture, {
      hermesLlmHosts: [],
      scopeParentPaths: [],
    }),
  );

  const session = result.rawSessions.sessions.find((s) => s.session_key === "session-nmap-txt");
  assert.ok(session, "nmap txt session should be found");

  assert.ok(session.tool_names.includes("Bash"), `tool_names should have Bash: ${session.tool_names}`);

  assert.ok(
    session.commands.some((cmd) => cmd.includes("nmap")),
    `commands should include nmap: ${JSON.stringify(session.commands)}`,
  );

  assert.ok(
    session.derived_expected_process_paths.includes("*/nmap"),
    `process paths should have */nmap: ${session.derived_expected_process_paths}`,
  );

  assert.ok(
    session.derived_expected_traffic.some((t) => t.includes("www.edamame.tech")),
    `traffic should include scan target: ${session.derived_expected_traffic}`,
  );

  assert.ok(
    session.derived_expected_local_open_ports.includes(80),
    `ports should include 80: ${session.derived_expected_local_open_ports}`,
  );
  assert.ok(
    session.derived_expected_local_open_ports.includes(443),
    `ports should include 443: ${session.derived_expected_local_open_ports}`,
  );
});

test("collectTranscriptSessions ingests sessions from the sessions.json manifest", async () => {
  const fixture = await makeTempFixture();
  // resolveHermesHome(config) derives <home> from the parent of
  // hermesSessionsRoot, so the manifest lives next to the sessions root.
  const hermesHome = path.dirname(fixture.hermesSessionsRoot);
  const nowIso = new Date().toISOString();
  const manifest = {
    sessions: [
      {
        id: "manifest-session-a",
        updated_at: nowIso,
        messages: [
          { role: "user", content: "investigate the lanscan regression and run cargo test" },
          {
            role: "assistant",
            content:
              "Let me use the Read tool, then run cargo test -p flodbadd to reproduce the failure.",
          },
        ],
      },
    ],
  };
  await fs.writeFile(
    path.join(hermesHome, "sessions.json"),
    JSON.stringify(manifest),
    "utf8",
  );

  const sessions = await collectTranscriptSessions(
    makeBaseConfig(fixture, { hermesLlmHosts: [] }),
  );

  const manifestSession = sessions.find((s) => s.sessionId === "manifest-session-a");
  assert.ok(manifestSession, "manifest session should be ingested");
  assert.equal(manifestSession.sourceFormat, "manifest");
  assert.ok(manifestSession.userText.includes("lanscan regression"));
  assert.ok(manifestSession.toolNames.includes("Read"));
  assert.ok(
    manifestSession.commands.some((cmd) => cmd.includes("cargo test -p flodbadd")),
    `manifest commands should include cargo test: ${JSON.stringify(manifestSession.commands)}`,
  );
});

test("collectTranscriptSessions prefers a file transcript over a manifest entry with the same id", async () => {
  const fixture = await makeTempFixture();
  const hermesHome = path.dirname(fixture.hermesSessionsRoot);
  const nowIso = new Date().toISOString();
  // session-one also exists as a .txt file from makeTempFixture(); the manifest
  // entry must NOT clobber the richer file-based record.
  const manifest = {
    sessions: [
      {
        id: "session-one",
        updated_at: nowIso,
        messages: [{ role: "user", content: "stale manifest copy that should be ignored" }],
      },
    ],
  };
  await fs.writeFile(
    path.join(hermesHome, "sessions.json"),
    JSON.stringify(manifest),
    "utf8",
  );

  const sessions = await collectTranscriptSessions(makeBaseConfig(fixture));
  const collisions = sessions.filter((s) => s.sessionId === "session-one");
  assert.equal(collisions.length, 1, "session-one must not be duplicated");
  assert.equal(collisions[0].sourceFormat, "txt", "file transcript must win the collision");
  assert.ok(collisions[0].userText.includes("update the divergence engine tests"));
});

test("collectTranscriptSessions parses sample_session.jsonl fixture file", async () => {
  const fixture = await makeTempFixture();
  const fixtureSource = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "fixtures/sample_session.jsonl",
  );
  const destPath = path.join(fixture.transcriptDir, "sample-session.jsonl");
  await fs.copyFile(fixtureSource, destPath);

  const sessions = await collectTranscriptSessions(
    makeBaseConfig(fixture, { hermesLlmHosts: [] }),
  );

  const session = sessions.find((s) => s.sessionId === "sample-session");
  assert.ok(session, "sample-session should be found");
  assert.equal(session.sourceFormat, "jsonl");
  assert.ok(session.userText.includes("divergence engine wrappers"));
  assert.ok(session.assistantText.includes("Read tool"));
  assert.ok(session.toolNames.includes("Read"));
  assert.ok(session.toolNames.includes("Grep"));
  assert.ok(session.toolNames.includes("StrReplace"));

  assert.ok(
    session.commands.some((cmd) => cmd.includes("cargo test")),
    `commands should have cargo test: ${JSON.stringify(session.commands)}`,
  );
  assert.ok(
    session.commands.some((cmd) => cmd.includes("flutter analyze")),
    `commands should have flutter analyze: ${JSON.stringify(session.commands)}`,
  );
});
