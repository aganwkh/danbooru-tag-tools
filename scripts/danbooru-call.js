#!/usr/bin/env node
// Danbooru MCP one-shot caller
// Usage:
//   node scripts/danbooru-call.js <tool_name> <json_args>
//   node scripts/danbooru-call.js <tool_name> @args.json   (read JSON from a file — avoids shell quoting pain on Windows)
//   echo <json> | node scripts/danbooru-call.js <tool_name> -   (read JSON from stdin)

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const MCP_URL = process.env.MCP_URL || "";
const toolName = process.argv[2];
const rawArg = process.argv[3];

if (!toolName) {
  console.error("Usage: node scripts/danbooru-call.js <tool_name> <json_args|@file|->");
  console.error("  <json_args>  inline JSON, e.g. '{\"query\":\"1girl\"}'");
  console.error("  @file        read JSON arguments from a file (recommended on Windows PowerShell)");
  console.error("  -            read JSON arguments from stdin");
  console.error("Default transport: local stdio MCP; set MCP_URL for an HTTP MCP endpoint.");
  process.exit(1);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// Resolve the JSON argument text from inline value, @file, or stdin.
async function loadArgsText() {
  if (rawArg === undefined || rawArg === "-") {
    const text = await readStdin();
    if (!text.trim()) return "{}";
    return text;
  }
  if (rawArg.startsWith("@")) {
    return fs.readFileSync(rawArg.slice(1), "utf8");
  }
  return rawArg;
}

function createHttpClient(endpoint) {
  let sessionId = null;
  const url = new URL(endpoint);
  const transport = url.protocol === "https:" ? https : http;

  return {
    request(body) {
      return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = transport.request({
          hostname: url.hostname,
          port: url.port || undefined,
          path: url.pathname + url.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            Accept: "application/json, text/event-stream",
            "Content-Length": Buffer.byteLength(data),
            Connection: "keep-alive",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          timeout: 30000,
        }, (res) => {
          if (res.headers["mcp-session-id"]) sessionId = res.headers["mcp-session-id"];
          let responseBody = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (responseBody += chunk));
          res.on("end", () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(`HTTP ${res.statusCode}: ${responseBody.slice(0, 200)}`));
              return;
            }
            for (const line of responseBody.split("\n")) {
              if (line.startsWith("data: ")) {
                try { resolve(JSON.parse(line.slice(6))); return; } catch {}
              }
            }
            try { resolve(JSON.parse(responseBody)); }
            catch { reject(new Error(`Invalid MCP response: ${responseBody.slice(0, 200)}`)); }
          });
        });
        req.on("timeout", () => req.destroy(new Error("MCP HTTP request timed out")));
        req.on("error", reject);
        req.end(data);
      });
    },
    close() {},
  };
}

function createStdioClient() {
  const child = spawn(process.execPath, [
    path.join(__dirname, "..", "mcp-server", "danbooru-mcp-server.js"),
  ], { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let buffer = Buffer.alloc(0);

  const fail = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    // The local server answers with newline-delimited JSON for newline-delimited requests.
    let newline;
    while ((newline = buffer.indexOf(0x0a)) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const text = line.toString("utf8").trim();
      if (!text) continue;
      let message;
      try { message = JSON.parse(text); } catch (error) { fail(error); continue; }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  });

  child.on("error", fail);
  child.on("exit", (code, signal) => {
    if (pending.size) fail(new Error(`Local MCP exited (${code ?? signal})`));
  });

  return {
    request(body) {
      return new Promise((resolve, reject) => {
        pending.set(body.id, { resolve, reject });
        try { child.stdin.write(JSON.stringify(body) + "\n"); }
        catch (error) { pending.delete(body.id); reject(error); }
      });
    },
    close() { child.stdin.end(); },
  };
}

async function main() {
  // Strip a UTF-8 BOM (Windows Notepad / PowerShell 5.1 often add one; JSON.parse rejects it).
  const argsText = (await loadArgsText()).replace(/^\uFEFF/, "");
  let args;
  try {
    args = JSON.parse(argsText);
  } catch (error) {
    throw new Error(`Invalid JSON arguments: ${error.message}`);
  }

  const client = MCP_URL ? createHttpClient(MCP_URL) : createStdioClient();
  try {
    await client.request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "cli", version: "1.0.1" },
      },
    });

    const response = await client.request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    });

    if (response.result?.isError) {
      throw new Error(response.result.content?.[0]?.text || "MCP tool call failed");
    }
    if (response.result?.content) console.log(response.result.content[0].text);
    else if (response.error) throw new Error(JSON.stringify(response.error));
    else console.log(JSON.stringify(response));
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exitCode = 1;
});
