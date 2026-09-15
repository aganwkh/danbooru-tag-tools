// Offline smoke + unit tests. No network access: protocol framing, input
// validation and pure helpers only. Live API behavior is verified separately.
const assert = require("assert");
const path = require("path");
const { spawn } = require("child_process");

const SERVER_PATH = path.join(__dirname, "..", "mcp-server", "danbooru-mcp-server.js");
const { buildPostTagString, VALID_RATINGS } = require(SERVER_PATH);

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log("ok   - " + name);
  } catch (err) {
    failures++;
    console.error("FAIL - " + name);
    console.error("       " + (err && err.stack ? err.stack.split("\n").slice(0, 3).join("\n       ") : err));
  }
}

// Spawn a server and speak either newline-delimited JSON or Content-Length framing.
function createClient(framing) {
  const proc = spawn(process.execPath, [SERVER_PATH], { stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map();
  let raw = Buffer.alloc(0);
  let nextId = 1;

  function deliver(bodyBuf) {
    const message = JSON.parse(bodyBuf.toString("utf8"));
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  }

  proc.stdout.on("data", (chunk) => {
    raw = Buffer.concat([raw, chunk]);
    if (framing === "header") {
      // Parse one or more Content-Length frames.
      for (;;) {
        const sep = raw.indexOf(Buffer.from("\r\n\r\n"));
        if (sep === -1) break;
        const m = /content-length\s*:\s*(\d+)/i.exec(raw.slice(0, sep).toString("latin1"));
        if (!m) { pending.forEach((p) => p.reject(new Error("bad response header"))); return; }
        const len = parseInt(m[1], 10);
        const bodyStart = sep + 4;
        if (raw.length < bodyStart + len) break;
        const body = raw.slice(bodyStart, bodyStart + len);
        raw = raw.slice(bodyStart + len);
        deliver(body);
      }
    } else {
      let nl;
      while ((nl = raw.indexOf(0x0a)) !== -1) {
        const line = raw.slice(0, nl);
        raw = raw.slice(nl + 1);
        const t = line.toString("utf8").trim();
        if (t) deliver(Buffer.from(t, "utf8"));
      }
    }
  });
  proc.on("error", (e) => pending.forEach((p) => p.reject(e)));

  function frame(obj) {
    const json = JSON.stringify({ jsonrpc: "2.0", ...obj });
    if (framing === "header") {
      const body = Buffer.from(json, "utf8");
      return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
    }
    return Buffer.from(json + "\n", "utf8");
  }

  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("request timed out: " + method)); }, 3000);
        pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        proc.stdin.write(frame({ id, method, params }));
      });
    },
    // Send raw bytes (used to test split / partial delivery).
    sendBytes(buf) { proc.stdin.write(buf); },
    // Expose the first raw response bytes so we can assert the server's framing out.
    async close() { proc.stdin.end(); proc.kill(); },
  };
}

(async () => {
  // ---- Group 1: legacy newline-delimited framing (the bundled CLI uses this) ----
  const nl = createClient("newline");
  await test("newline: initialize returns protocol version", async () => {
    const r = await nl.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
    assert.strictEqual(r.result.protocolVersion, "2024-11-05");
  });
  await test("newline: tools/list exposes 4 tools", async () => {
    const r = await nl.request("tools/list", {});
    assert.strictEqual(r.result.tools.length, 4);
  });
  await test("newline: null query is rejected", async () => {
    const r = await nl.request("tools/call", { name: "search_tags", arguments: { query: null } });
    assert.strictEqual(r.result.isError, true);
    assert.match(r.result.content[0].text, /query must be a non-empty string/);
  });
  await test("newline: over-sized tag array is rejected", async () => {
    const r = await nl.request("tools/call", { name: "get_related_tags", arguments: { tags: ["a", "b", "c", "d", "e", "f"] } });
    assert.strictEqual(r.result.isError, true);
    assert.match(r.result.content[0].text, /at most 5 items/);
  });
  await nl.close();

  // ---- Group 2: standard MCP Content-Length framing (real MCP clients use this) ----
  const hc = createClient("header");
  await test("Content-Length: initialize handshake succeeds", async () => {
    const r = await hc.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
    assert.strictEqual(r.result.protocolVersion, "2024-11-05");
    assert.strictEqual(r.result.serverInfo.name, "danbooru-local");
  });
  await test("Content-Length: tools/list exposes 4 tools", async () => {
    const r = await hc.request("tools/list", {});
    assert.strictEqual(r.result.tools.length, 4);
  });
  await hc.close();

  // ---- Group 3: partial / split delivery must not corrupt a Content-Length frame ----
  await test("Content-Length: frame split across chunks still resolves", async () => {
    const body = Buffer.from(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "split", version: "1" } },
    }), "utf8");
    const whole = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
    const cut = 7; // split inside the header line
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("split frame timed out")), 3000);
      // Capture the raw initialize response once.
      let got = Buffer.alloc(0);
      const proc = spawn(process.execPath, [SERVER_PATH], { stdio: ["pipe", "pipe", "ignore"] });
      proc.stdout.on("data", (c) => {
        got = Buffer.concat([got, c]);
        const sep = got.indexOf(Buffer.from("\r\n\r\n"));
        if (sep !== -1 && /content-length/i.test(got.slice(0, sep).toString("latin1"))) {
          clearTimeout(timer);
          proc.kill();
          assert.match(got.slice(0, sep).toString("latin1"), /^Content-Length:\s*\d+/i);
          resolve();
        }
      });
      proc.on("error", reject);
      proc.stdin.write(whole.slice(0, cut));
      setImmediate(() => proc.stdin.write(whole.slice(cut)));
    });
  });

  // ---- Group 4: pure helper buildPostTagString (regression for the duplicate tags= bug) ----
  await test("buildPostTagString: applies no default rating filter", () => {
    assert.strictEqual(buildPostTagString("1girl", undefined), "1girl");
  });
  await test("buildPostTagString: explicit rating merges into one string", () => {
    assert.strictEqual(buildPostTagString("1girl solo", "g"), "1girl solo rating:g");
  });
  await test("buildPostTagString: respects rating already written by user (no conflict)", () => {
    assert.strictEqual(buildPostTagString("1girl rating:e", undefined), "1girl rating:e");
  });
  await test("buildPostTagString: invalid rating throws", () => {
    assert.throws(() => buildPostTagString("1girl", "x"), /rating must be one of/);
  });
  await test("VALID_RATINGS contains g/s/q/e", () => {
    assert.deepStrictEqual([...VALID_RATINGS].sort(), ["e", "g", "q", "s"]);
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) failed`);
    process.exitCode = 1;
  } else {
    console.log("\nAll smoke tests passed");
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
