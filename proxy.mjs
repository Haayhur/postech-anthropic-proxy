import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.PORT || 4145);
const TARGET_ORIGIN = process.env.POSTECH_TARGET_ORIGIN || "https://genai.postech.ac.kr";
const TARGET_PREFIX = process.env.POSTECH_TARGET_PREFIX || "/agent/api/a45/anthropic";
const DEBUG_DIR = process.env.PROXY_DEBUG_DIR || path.join(os.homedir(), ".claude");

const MODELS = [
  "claude-sonnet-4-6",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-sonnet-4-20250514",
  "claude-opus-4-20250514",
  "claude-opus-4-1-20250805",
];

function debugPath(name) {
  return path.join(DEBUG_DIR, name);
}

function writeDebugJson(name, value) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.writeFileSync(debugPath(name), JSON.stringify(value, null, 2));
  } catch {
    // Debug snapshots are best-effort and must not block requests.
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function targetPath(pathname) {
  if (pathname === "/v1/messages" || pathname === "/messages") {
    return `${TARGET_PREFIX}/messages`;
  }
  if (pathname === "/v1/models" || pathname === "/models") {
    return null;
  }
  return `${TARGET_PREFIX}${pathname.replace(/^\/v1/, "")}`;
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function stringifyToolInput(input) {
  try {
    return JSON.stringify(input || {});
  } catch {
    return "{}";
  }
}

function textBlock(text) {
  return { type: "text", text };
}

function rewriteRequestBody(headers, bodyBuffer) {
  const contentType = String(headers["content-type"] || "");
  if (!bodyBuffer.length || !contentType.includes("application/json")) {
    return bodyBuffer;
  }

  try {
    const payload = JSON.parse(bodyBuffer.toString("utf8"));
    writeDebugJson("original_req.json", payload);

    let changed = false;
    const needsAdaptiveThinking =
      (payload.model === "claude-fable-5" || payload.model === "claude-opus-4-8") &&
      payload.thinking?.type === "enabled";

    if (needsAdaptiveThinking) {
      payload.thinking = { type: "adaptive" };
      payload.output_config = {
        ...(payload.output_config || {}),
        effort: payload.output_config?.effort || "high",
      };
      changed = true;
    }

    for (const message of payload.messages || []) {
      if (!Array.isArray(message.content)) {
        continue;
      }

      const newContent = [];
      for (const block of message.content) {
        if (!block || typeof block !== "object") {
          newContent.push(block);
          continue;
        }

        if (block.type === "thinking") {
          changed = true;
          continue;
        }

        if (block.type === "tool_use") {
          newContent.push(textBlock(
            `Previous assistant tool request. Tool: ${block.name || "tool"}. ` +
              `ID: ${block.id || "unknown"}. Input: ${stringifyToolInput(block.input)}`
          ));
          changed = true;
          continue;
        }

        if (block.type === "tool_result") {
          newContent.push(textBlock(
            `Previous tool result${block.is_error ? " with error" : ""}. ` +
              `Tool request ID: ${block.tool_use_id || "unknown"}.\n${block.content || ""}`
          ));
          changed = true;
          continue;
        }

        newContent.push(block);
      }
      message.content = newContent;
    }

    writeDebugJson("last_req.json", payload);
    if (!changed) {
      return bodyBuffer;
    }

    const rewritten = Buffer.from(JSON.stringify(payload));
    headers["content-length"] = String(rewritten.length);
    return rewritten;
  } catch {
    return bodyBuffer;
  }
}

async function writeAnthropicSse(upstream, res) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || "";

    for (const frame of frames) {
      const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith("data:"));
      if (!dataLine) {
        res.write(`${frame}\n\n`);
        continue;
      }

      const data = dataLine.slice(5).trimStart();
      try {
        const event = JSON.parse(data);
        if (event?.type) {
          res.write(`event: ${event.type}\n`);
        }
      } catch {
        // Keep non-JSON SSE payloads unchanged.
      }
      res.write(`data: ${data}\n\n`);
    }
  }

  if (buffer.trim()) {
    res.write(buffer);
    if (!buffer.endsWith("\n\n")) {
      res.write("\n\n");
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if ((url.pathname === "/v1/models" || url.pathname === "/models") && req.method === "GET") {
      return sendJson(res, 200, {
        data: MODELS.map((id) => ({ id, type: "model", display_name: id })),
        has_more: false,
      });
    }

    const path = targetPath(url.pathname);
    if (!path) {
      return sendJson(res, 404, { error: { type: "not_found_error", message: "Not Found" } });
    }

    const target = new URL(`${path}${url.search}`, TARGET_ORIGIN);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers["content-length"];

    const apiKey = headers["x-api-key"] || headers["X-Api-Key"];
    if (apiKey) {
      headers["x-api-key"] = Array.isArray(apiKey) ? apiKey[0] : apiKey;
    }
    delete headers.authorization;

    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const originalBody = await readRequestBody(req);
      body = rewriteRequestBody(headers, originalBody);
    }

    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      duplex: "half",
    });

    const responseHeaders = {};
    upstream.headers.forEach((value, key) => {
      if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key)) {
        responseHeaders[key] = value;
      }
    });
    res.writeHead(upstream.status, responseHeaders);

    if (upstream.body && responseHeaders["content-type"]?.includes("text/event-stream")) {
      await writeAnthropicSse(upstream, res);
    } else if (upstream.body) {
      for await (const chunk of upstream.body) {
        res.write(chunk);
      }
    }
    res.end();
  } catch (error) {
    sendJson(res, 500, {
      error: {
        type: "proxy_error",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`POSTECH Anthropic proxy listening on http://127.0.0.1:${PORT}`);
});
