#!/usr/bin/env node
// Danbooru MCP Server - stdio transport.
// Supports BOTH standard MCP Content-Length framing AND newline-delimited JSON.
// The output framing is chosen by the first inbound frame (standard clients use
// Content-Length; the bundled CLI/legacy callers send one JSON object per line).

const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const LOG = process.env.MCP_DEBUG === "1";
const logFile = path.join(os.tmpdir(), "danbooru-mcp.log");
function log(msg) {
  if (LOG) fs.appendFileSync(logFile, new Date().toISOString() + " " + msg + "\n");
}

const DANBOORU_API = "https://danbooru.donmai.us";
const DANBOORU_LOGIN = process.env.DANBOORU_LOGIN || "";
const DANBOORU_API_KEY = process.env.DANBOORU_API_KEY || "";
const AUTH_HEADERS = DANBOORU_LOGIN && DANBOORU_API_KEY
  ? { Authorization: `Basic ${Buffer.from(`${DANBOORU_LOGIN}:${DANBOORU_API_KEY}`).toString("base64")}` }
  : {};
const API_HEADERS = {
  "User-Agent": "DanbooruTagTools/1.0.1 (local MCP)",
  ...AUTH_HEADERS,
};
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const CATEGORY_NAMES = Object.freeze({
  0: "general",
  1: "artist",
  3: "copyright",
  4: "character",
  5: "meta",
});
// Danbooru's `search[category]` only accepts the NUMERIC id, not the name.
// Passing a name (e.g. "character") makes the API return an empty array.
const CATEGORY_IDS = Object.freeze({
  general: 0,
  artist: 1,
  copyright: 3,
  character: 4,
  meta: 5,
});
const VALID_CATEGORIES = new Set(Object.values(CATEGORY_NAMES));
const VALID_RATINGS = new Set(["g", "s", "q", "e"]);

function categoryName(category) {
  return CATEGORY_NAMES[category] || "unknown";
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function requiredTags(value, max) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("tags must be a non-empty array");
  }
  if (value.length > max) throw new Error(`tags must contain at most ${max} items`);
  return value.map((tag, index) => requiredString(tag, `tags[${index}]`));
}

function requestLimit(value, fallback, max = 100) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`limit must be an integer from 1 to ${max}`);
  }
  return Math.min(value, max);
}

// Pure helper: merge a user tag query with an OPTIONAL rating filter into ONE
// Danbooru tag string. Fixes the previous bug that emitted two duplicate
// `tags=` query params (Rails then kept only the last one and dropped the
// user's tags).
//
// NOTE: no default rating filter is applied. Results are returned in full;
// callers may opt into filtering by explicitly passing `rating`.
function buildPostTagString(tagQuery, rating) {
  const parts = tagQuery.split(/\s+/).filter(Boolean);
  if (rating !== undefined) {
    if (!VALID_RATINGS.has(rating)) {
      throw new Error("rating must be one of: g, s, q, e");
    }
    parts.push(`rating:${rating}`);
  }
  return parts.join(" ");
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: API_HEADERS, timeout: 15000 }, (res) => {
      let data = "";
      let responseBytes = 0;
      let tooLarge = false;
      res.setEncoding("utf8");
      res.on("data", (c) => {
        if (tooLarge) return;
        responseBytes += Buffer.byteLength(c);
        if (responseBytes > MAX_RESPONSE_BYTES) {
          tooLarge = true;
          res.destroy();
          reject(new Error(`Danbooru API response exceeded ${MAX_RESPONSE_BYTES} bytes`));
          return;
        }
        data += c;
      });
      res.on("end", () => {
        if (tooLarge) return;
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`Danbooru API HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
          error.statusCode = res.statusCode;
          error.retryAfter = res.headers["retry-after"];
          reject(error);
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
      });
      res.on("error", (error) => { if (!tooLarge) reject(error); });
    });
    req.on("timeout", () => req.destroy(new Error("Danbooru API request timed out")));
    req.on("error", reject);
  });
}

async function fetchJson(url) {
  try {
    return await requestJson(url);
  } catch (error) {
    if (error.statusCode !== 429) throw error;
    const retryAfter = Number(error.retryAfter);
    const delay = Number.isFinite(retryAfter) ? Math.min(Math.max(retryAfter, 0), 3) * 1000 : 1000;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return requestJson(url);
  }
}

async function fetchTagList(url) {
  const tags = await fetchJson(url);
  if (!Array.isArray(tags)) throw new Error("Danbooru API returned a non-array tag result");
  return tags;
}

const TOOLS = [
  {
    name: "search_tags",
    description: "Search Danbooru tags by keyword. Returns tags sorted by popularity.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword (supports wildcards with *)" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max results (default 20)", default: 20 },
        category: { type: "string", enum: ["general", "character", "copyright", "artist", "meta"], description: "Filter by category" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_related_tags",
    description: "Get tags that frequently co-occur with given tags.",
    inputSchema: {
      type: "object",
      properties: {
        tags: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" }, description: "Tags to find related tags for" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max results per tag (default 20)", default: 20 },
      },
      required: ["tags"],
    },
  },
  {
    name: "get_tag_info",
    description: "Get detailed info about specific tags.",
    inputSchema: {
      type: "object",
      properties: {
        tags: { type: "array", minItems: 1, maxItems: 10, items: { type: "string" }, description: "Tag names to look up" },
      },
      required: ["tags"],
    },
  },
  {
    name: "search_posts",
    description: "Search Danbooru posts/images by tags. Returns all rating levels by default with no filtering; pass rating to narrow results.",
    inputSchema: {
      type: "object",
      properties: {
        tags: { type: "string", description: "Tag search string (space-separated tags)" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max results (default 5)", default: 5 },
        rating: { type: "string", enum: ["g", "s", "q", "e"], description: "Optional: narrow results to a single rating (g, s, q, e)" },
      },
      required: ["tags"],
    },
  },
];

async function handleToolCall(name, args) {
  switch (name) {
    case "search_tags": {
      const { query, limit, category } = args || {};
      const searchQuery = requiredString(query, "query");
      const safeLimit = requestLimit(limit, 20);
      if (category !== undefined && !VALID_CATEGORIES.has(category)) {
        throw new Error("category must be one of: general, character, copyright, artist, meta");
      }
      const hasWildcard = searchQuery.includes("*") || searchQuery.includes("?");
      let tags = [];
      if (hasWildcard) {
        let url = `${DANBOORU_API}/tags.json?search[name_matches]=${encodeURIComponent(searchQuery)}&limit=${safeLimit}&order=count`;
        if (category) url += `&search[category]=${CATEGORY_IDS[category]}`;
        tags = await fetchTagList(url);
      } else {
        let url = `${DANBOORU_API}/tags.json?search[name]=${encodeURIComponent(searchQuery)}&limit=${safeLimit}&order=count`;
        if (category) url += `&search[category]=${CATEGORY_IDS[category]}`;
        tags = await fetchTagList(url);
        if (tags.length === 0) {
          url = `${DANBOORU_API}/tags.json?search[name_matches]=*${encodeURIComponent(searchQuery)}*&limit=${safeLimit}&order=count`;
          if (category) url += `&search[category]=${CATEGORY_IDS[category]}`;
          tags = await fetchTagList(url);
        }
      }
      return {
        content: [{ type: "text", text: JSON.stringify({
          query: searchQuery,
          results: tags.map((t) => ({
            tag: t.name,
            category: categoryName(t.category),
            count: t.post_count,
          })),
        }, null, 2) }],
      };
    }
    case "get_related_tags": {
      const { tags, limit } = args || {};
      const sourceTags = requiredTags(tags, 5);
      const safeLimit = requestLimit(limit, 20);
      const results = [];
      for (const tag of sourceTags.slice(0, 5)) {
        try {
          const url = `${DANBOORU_API}/related_tag.json?search[query]=${encodeURIComponent(tag)}&limit=${safeLimit}`;
          const data = await fetchJson(url);
          results.push({
            source_tag: tag,
            related: (data.related_tags || []).map((r) => ({
              tag: r.tag?.name || "unknown",
              count: r.tag?.post_count || 0,
              overlap: r.cosine_similarity || 0,
            })),
          });
        } catch (e) {
          results.push({ source_tag: tag, error: e.message });
        }
      }
      return { content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }] };
    }
    case "get_tag_info": {
      const { tags } = args || {};
      const sourceTags = requiredTags(tags, 10);
      const results = [];
      for (const tag of sourceTags.slice(0, 10)) {
        try {
          const url = `${DANBOORU_API}/tags.json?search[name]=${encodeURIComponent(tag)}&limit=1`;
          const info = await fetchJson(url);
          if (!Array.isArray(info)) throw new Error("Danbooru API returned a non-array tag result");
          if (info.length > 0) {
            results.push({
              tag: info[0].name,
              category: categoryName(info[0].category),
              count: info[0].post_count,
            });
          } else {
            results.push({ tag, found: false });
          }
        } catch (e) {
          results.push({ tag, error: e.message });
        }
      }
      return { content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }] };
    }
    case "search_posts": {
      const { tags, limit, rating } = args || {};
      const tagQuery = requiredString(tags, "tags");
      const safeLimit = requestLimit(limit, 5);
      // Merge every constraint into a SINGLE tags parameter so nothing is dropped.
      const mergedTags = buildPostTagString(tagQuery, rating);
      const url = `${DANBOORU_API}/posts.json?tags=${encodeURIComponent(mergedTags)}&limit=${safeLimit}`;
      const posts = await fetchJson(url);
      if (!Array.isArray(posts)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ results: [], error: posts.error || "API returned non-array", message: posts.message || "" }, null, 2) }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({
          applied_tags: mergedTags,
          results: posts.map((p) => ({
            id: p.id,
            tags: p.tag_string?.split(" ") || [],
            rating: p.rating,
            score: p.score,
            url: `${DANBOORU_API}/posts/${p.id}`,
            file_url: p.file_url,
            preview_url: p.preview_file_url,
          })),
        }, null, 2) }],
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---- stdio transport: dual framing ---------------------------------------

// null = undecided, true = standard Content-Length framing, false = newline JSON.
// Locked in by the first inbound frame and reused for output.
let useHeaderFraming = null;
let inbound = Buffer.alloc(0);

function sendMessage(obj) {
  const line = JSON.stringify(obj);
  log("OUT: " + line.slice(0, 200));
  if (useHeaderFraming === true) {
    const body = Buffer.from(line, "utf8");
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    process.stdout.write(body);
  } else {
    process.stdout.write(line + "\n");
  }
}

// Locate the header/body separator (\r\n\r\n preferred, \n\n tolerated).
function findHeaderEnd(buf) {
  const crlf = buf.indexOf(Buffer.from("\r\n\r\n"));
  const lf = buf.indexOf(Buffer.from("\n\n"));
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) return { end: crlf, sepLen: 4 };
  if (lf !== -1) return { end: lf, sepLen: 2 };
  return { end: -1, sepLen: 0 };
}

// If buf holds a (possibly still incomplete) Content-Length frame, return the
// parsed byte length and total header length; null otherwise.
function matchContentLengthHeader(buf) {
  const { end, sepLen } = findHeaderEnd(buf);
  if (end === -1) return null;
  const headerText = buf.slice(0, end).toString("latin1");
  const m = /content-length\s*:\s*(\d+)/i.exec(headerText);
  if (!m) return null;
  return { headerLen: end + sepLen, contentLength: parseInt(m[1], 10) };
}

// True while the bytes received so far look like the start of a Content-Length
// header but its terminator has not arrived yet (so we must not fall back to
// newline parsing and mangle it).
function looksLikeIncompleteHeader(buf) {
  return buf.slice(0, Math.min(buf.length, 32)).toString("latin1").trimStart().toLowerCase()
    .startsWith("content-length");
}

function dispatchText(text) {
  log("IN: " + text.slice(0, 200));
  try {
    handleMessage(JSON.parse(text));
  } catch (e) {
    log("PARSE ERR: " + e.message);
  }
}

function processInbound() {
  while (inbound.length > 0) {
    const header = matchContentLengthHeader(inbound);
    if (header) {
      if (inbound.length < header.headerLen + header.contentLength) return; // wait for full body
      const body = inbound.slice(header.headerLen, header.headerLen + header.contentLength);
      inbound = inbound.slice(header.headerLen + header.contentLength);
      useHeaderFraming = true;
      dispatchText(body.toString("utf8"));
      continue;
    }
    if (looksLikeIncompleteHeader(inbound)) return; // header still streaming in

    const nl = inbound.indexOf(0x0a);
    if (nl === -1) return; // wait for newline
    const line = inbound.slice(0, nl);
    inbound = inbound.slice(nl + 1);
    const text = line.toString("utf8").trim();
    if (!text) continue;
    useHeaderFraming = false;
    dispatchText(text);
  }
}

async function handleMessage(request) {
  const { id, method, params } = request;
  log("METHOD: " + method + " id=" + id);

  if (method === "initialize") {
    sendMessage({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "danbooru-local", version: "1.0.1" },
      },
    });
  } else if (method === "notifications/initialized") {
    log("Client initialized");
  } else if (method === "tools/list") {
    log("Sending " + TOOLS.length + " tools");
    sendMessage({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    const { name, arguments: args } = params;
    try {
      const result = await handleToolCall(name, args);
      sendMessage({ jsonrpc: "2.0", id, result });
    } catch (error) {
      sendMessage({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true },
      });
    }
  } else if (id !== undefined) {
    sendMessage({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

function start() {
  process.stdin.on("data", (chunk) => {
    inbound = Buffer.concat([inbound, chunk]);
    processInbound();
  });
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));

  log("Server started");
  // IMPORTANT: startup banner goes to stderr only, never stdout (stdout is the protocol channel).
  process.stderr.write("Danbooru MCP Server running on stdio\n");
}

// Expose pure helpers for offline unit tests; do not start the transport when required as a module.
module.exports = { buildPostTagString, VALID_RATINGS };

if (require.main === module) {
  start();
}
