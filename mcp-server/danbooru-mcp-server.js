#!/usr/bin/env node
// Danbooru MCP Server - stdio transport (single-line JSON per message)

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
const AUTH_PARAMS = DANBOORU_LOGIN && DANBOORU_API_KEY
  ? `login=${DANBOORU_LOGIN}&api_key=${DANBOORU_API_KEY}`
  : "";

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "DanbooruMCP/1.0" }, timeout: 15000 }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
        });
      })
      .on("error", reject);
  });
}

const TOOLS = [
  {
    name: "search_tags",
    description: "Search Danbooru tags by keyword. Returns tags sorted by popularity.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword (supports wildcards with *)" },
        limit: { type: "number", description: "Max results (default 20)", default: 20 },
        category: { type: "string", description: "Filter by category: general, character, copyright, artist, meta" },
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
        tags: { type: "array", items: { type: "string" }, description: "Tags to find related tags for" },
        limit: { type: "number", description: "Max results per tag (default 20)", default: 20 },
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
        tags: { type: "array", items: { type: "string" }, description: "Tag names to look up" },
      },
      required: ["tags"],
    },
  },
  {
    name: "search_posts",
    description: "Search Danbooru posts/images by tags.",
    inputSchema: {
      type: "object",
      properties: {
        tags: { type: "string", description: "Tag search string (space-separated tags)" },
        limit: { type: "number", description: "Max results (default 5)", default: 5 },
        rating: { type: "string", description: "Filter by rating: g (general), s (sensitive), q (questionable), e (explicit)" },
      },
      required: ["tags"],
    },
  },
];

async function handleToolCall(name, args) {
  switch (name) {
    case "search_tags": {
      const { query, limit = 20, category } = args;
      const hasWildcard = query.includes("*") || query.includes("?");
      let tags = [];
      if (hasWildcard) {
        let url = `${DANBOORU_API}/tags.json?search[name_matches]=${encodeURIComponent(query)}&limit=${limit}&order=count&${AUTH_PARAMS}`;
        if (category) url += `&search[category]=${category}`;
        try { tags = await fetchJson(url); } catch (e) {}
      } else {
        let url = `${DANBOORU_API}/tags.json?search[name]=${encodeURIComponent(query)}&limit=${limit}&order=count&${AUTH_PARAMS}`;
        if (category) url += `&search[category]=${category}`;
        try { tags = await fetchJson(url); } catch (e) {}
        if (tags.length === 0) {
          url = `${DANBOORU_API}/tags.json?search[name_matches]=*${encodeURIComponent(query)}*&limit=${limit}&order=count&${AUTH_PARAMS}`;
          if (category) url += `&search[category]=${category}`;
          try { tags = await fetchJson(url); } catch (e) {}
        }
      }
      return {
        content: [{ type: "text", text: JSON.stringify({
          query,
          results: tags.map((t) => ({
            tag: t.name,
            category: ["", "general", "artist", "character", "copyright", "meta"][t.category] || "unknown",
            count: t.post_count,
          })),
        }, null, 2) }],
      };
    }
    case "get_related_tags": {
      const { tags, limit = 20 } = args;
      const results = [];
      for (const tag of tags.slice(0, 5)) {
        try {
          const url = `${DANBOORU_API}/related_tag.json?search[query]=${encodeURIComponent(tag)}&limit=${limit}&${AUTH_PARAMS}`;
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
      const { tags } = args;
      const results = [];
      for (const tag of tags.slice(0, 10)) {
        try {
          const url = `${DANBOORU_API}/tags.json?search[name]=${encodeURIComponent(tag)}&limit=1&${AUTH_PARAMS}`;
          const info = await fetchJson(url);
          if (info.length > 0) {
            results.push({
              tag: info[0].name,
              category: ["", "general", "artist", "character", "copyright", "meta"][info[0].category] || "unknown",
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
      const { tags, limit = 5, rating } = args;
      let url = `${DANBOORU_API}/posts.json?tags=${encodeURIComponent(tags)}&limit=${limit}&${AUTH_PARAMS}`;
      if (rating) url += `&tags=rating:${rating}`;
      const posts = await fetchJson(url);
      if (!Array.isArray(posts)) {
        return {
          content: [{ type: "text", text: JSON.stringify({ results: [], error: posts.error || "API returned non-array", message: posts.message || "" }, null, 2) }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({
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

// MCP stdio transport: single-line JSON per message, NO Content-Length framing
function sendMessage(obj) {
  const line = JSON.stringify(obj);
  log("OUT: " + line.slice(0, 200));
  process.stdout.write(line + "\n");
}

let buffer = "";

function processBuffer() {
  let nlIdx;
  while ((nlIdx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.substring(0, nlIdx).trim();
    buffer = buffer.substring(nlIdx + 1);
    if (!line) continue;
    log("IN: " + line.slice(0, 200));
    try {
      handleMessage(JSON.parse(line));
    } catch (e) {
      log("PARSE ERR: " + e.message);
    }
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
        serverInfo: { name: "danbooru-local", version: "1.0.0" },
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

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  processBuffer();
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

log("Server started");
// IMPORTANT: stderr only, never stdout
process.stderr.write("Danbooru MCP Server running on stdio\n");
