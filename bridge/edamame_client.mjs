#!/usr/bin/env node

import fs from "node:fs/promises";

function requireFetch() {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("fetch_unavailable_node18_required");
  }
  return globalThis.fetch;
}

async function readJsonOrSseResponse(response, { requestId, timeoutMs }) {
  const contentType = String(response.headers?.get?.("content-type") || "");
  if (contentType.includes("application/json")) {
    return response.json();
  }

  if (!contentType.includes("text/event-stream")) {
    const body = (await response.text?.()) || "";
    throw new Error(`unexpected_content_type:${contentType || "none"} body=${body.slice(0, 1000)}`);
  }

  const reader = response.body?.getReader?.();
  if (!reader) {
    throw new Error("sse_no_body_reader");
  }

  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffer = "";
  let dataLines = [];

  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;

      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (line === "") {
        if (dataLines.length === 0) continue;
        const payload = dataLines.join("\n");
        dataLines = [];
        if (!payload.trim()) continue;
        try {
          const message = JSON.parse(payload);
          if (message?.id === requestId) {
            return message;
          }
        } catch (_error) {
          // Ignore non-JSON event frames.
        }
        continue;
      }

      if (line.startsWith("data:")) {
        let data = line.slice(5);
        if (data.startsWith(" ")) data = data.slice(1);
        dataLines.push(data);
      }
    }
  }

  throw new Error("sse_timeout_or_eof_without_response");
}

function responseToPayload(responseJson) {
  if (responseJson?.error) {
    throw new Error(`tools_call_error:${responseJson.error.message}`);
  }

  const result = responseJson?.result || {};
  const content = Array.isArray(result.content) ? result.content : [];
  const textParts = [];
  for (const item of content) {
    if (item?.type === "text" && typeof item.text === "string") {
      textParts.push(item.text);
    }
  }

  if (textParts.length > 0) {
    const text = textParts.join("\n").trim();
    try {
      return JSON.parse(text);
    } catch (_error) {
      return text;
    }
  }

  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }

  return result;
}

function looksLikeSessionExpiry(message) {
  const text = String(message || "").toLowerCase();
  return (
    text.includes("session not found") ||
    text.includes("mcp-session-id") ||
    text.includes("http_401") ||
    (text.includes("unauthorized") && text.includes("session"))
  );
}

export async function readPsk(pskFile) {
  const raw = await fs.readFile(pskFile, "utf8");
  return raw.trim();
}

class McpHttpClient {
  constructor({ endpoint, psk }) {
    this.endpoint = endpoint;
    this.psk = psk;
    this.desiredProtocolVersion = "2025-11-25";
    this.protocolVersion = null;
    this.sessionId = null;
    this.nextId = 1;
    this.initPromise = null;
  }

  sameConfig({ endpoint, psk }) {
    return this.endpoint === endpoint && this.psk === psk;
  }

  headers() {
    const headers = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.psk}`,
    };
    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    return headers;
  }

  async post(message, { timeoutMs, expectResponse }) {
    const fetchImpl = requireFetch();
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      const response = await fetchImpl(this.endpoint, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(message),
        signal: abortController.signal,
      });

      if (response.status >= 400) {
        const body = (await response.text?.()) || "";
        throw new Error(`http_${response.status}:${body.slice(0, 1000)}`);
      }

      if (!expectResponse) {
        return { response };
      }

      const responseJson = await readJsonOrSseResponse(response, {
        requestId: message.id,
        timeoutMs,
      });
      return { response, responseJson };
    } catch (error) {
      const messageText = String(error?.message || error);
      if (messageText.includes("aborted")) {
        throw new Error("timeout");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async initializeOnce(timeoutMs) {
    const initId = this.nextId++;
    const request = {
      jsonrpc: "2.0",
      id: initId,
      method: "initialize",
      params: {
        protocolVersion: this.desiredProtocolVersion,
        capabilities: {},
        clientInfo: {
          name: "edamame",
          version: "1.0.0",
        },
      },
    };

    const previousProtocol = this.protocolVersion;
    this.protocolVersion = null;
    const { response, responseJson } = await this.post(request, {
      timeoutMs,
      expectResponse: true,
    });
    this.protocolVersion = previousProtocol;

    if (!responseJson) {
      throw new Error("initialize_missing_response");
    }
    if (responseJson.error) {
      throw new Error(`initialize_error:${responseJson.error.message}`);
    }

    this.protocolVersion =
      String(responseJson.result?.protocolVersion || "").trim() ||
      this.desiredProtocolVersion;
    this.sessionId = String(response.headers?.get?.("mcp-session-id") || "").trim() || null;

    await this.post(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { timeoutMs: Math.min(timeoutMs, 10_000), expectResponse: false },
    );
  }

  async ensureInitialized(timeoutMs) {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      if (this.protocolVersion) return;
      await this.initializeOnce(timeoutMs);
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  async callTool(toolName, args = {}, timeoutMs = 60_000) {
    await this.ensureInitialized(Math.min(timeoutMs, 30_000));
    const request = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
    };

    try {
      const { responseJson } = await this.post(request, {
        timeoutMs,
        expectResponse: true,
      });
      const payload = responseToPayload(responseJson);
      if (looksLikeSessionExpiry(typeof payload === "string" ? payload : "")) {
        this.protocolVersion = null;
        this.sessionId = null;
        await this.ensureInitialized(Math.min(timeoutMs, 30_000));
        const retry = await this.post(request, {
          timeoutMs,
          expectResponse: true,
        });
        return responseToPayload(retry.responseJson);
      }
      return payload;
    } catch (error) {
      const messageText = String(error?.message || error).toLowerCase();
      if (
        messageText.includes("session") ||
        messageText.includes("mcp-session-id") ||
        messageText.startsWith("http_401") ||
        messageText.startsWith("http_404")
      ) {
        this.protocolVersion = null;
        this.sessionId = null;
        await this.ensureInitialized(Math.min(timeoutMs, 30_000));
        const retry = await this.post(request, {
          timeoutMs,
          expectResponse: true,
        });
        return responseToPayload(retry.responseJson);
      }
      throw error;
    }
  }
}

let cachedClient = null;

export async function makeEdamameClient(config) {
  const psk = await readPsk(config.edamameMcpPskFile);
  const settings = {
    endpoint: config.edamameMcpEndpoint,
    psk,
  };

  if (!cachedClient || !cachedClient.sameConfig(settings)) {
    cachedClient = new McpHttpClient(settings);
  }

  return {
    invoke(toolName, args = {}, timeoutMs) {
      return cachedClient.callTool(toolName, args, timeoutMs);
    },
  };
}
