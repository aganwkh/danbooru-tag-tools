#!/usr/bin/env node
// Danbooru MCP one-shot caller
// Usage: node danbooru-call.js <tool_name> <json_args>

const https = require('https');

const MCP_URL = 'https://sakizuki-danboorusearch.hf.space/mcp/mcp';
const toolName = process.argv[2];
const argsJson = process.argv[3] || '{}';

if (!toolName) {
  console.error('Usage: node danbooru-call.js <tool_name> <json_args>');
  process.exit(1);
}

let sessionId = null;

function request(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(MCP_URL);
    const opts = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(data),
        'Connection': 'keep-alive'
      },
      timeout: 30000,
      rejectUnauthorized: false
    };
    if (sessionId) opts.headers['mcp-session-id'] = sessionId;

    const req = https.request(opts, res => {
      const sid = res.headers['mcp-session-id'];
      if (sid) sessionId = sid;
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        for (const line of body.split('\n')) {
          if (line.startsWith('data: ')) {
            try { resolve(JSON.parse(line.slice(6))); return; } catch {}
          }
        }
        try { resolve(JSON.parse(body)); } catch { reject(new Error(body)); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  // Initialize
  await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'cli', version: '1.0.0' }
  }});

  // Call tool
  const resp = await request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: toolName,
    arguments: JSON.parse(argsJson)
  }});

  if (resp.result && resp.result.content) {
    console.log(resp.result.content[0].text);
  } else if (resp.error) {
    console.error('Error:', JSON.stringify(resp.error));
  } else {
    console.log(JSON.stringify(resp));
  }
})();
