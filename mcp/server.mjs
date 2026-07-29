// mcp/server.mjs
// Local stdio MCP server for the proto-share local-AI integration. Thin ESM
// wrapper: it wires six tools to the (CommonJS, unit-tested) handlers. All
// rules live in the deployed /api/v1 REST layer — this process only translates
// tool calls into HTTP requests. Run locally and registered with Claude Code.
//
//   PROTOSHARE_TOKEN     required — the API token from the admin "API Tokens" panel
//   PROTOSHARE_MANIFEST  optional — path to .protoshare.json (default ./.protoshare.json)
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import manifestLib from './lib/manifest.cjs';
import clientLib from './lib/client.cjs';
import handlers from './lib/handlers.cjs';

const { ProtoshareClient } = clientLib;

const manifestPath = path.resolve(process.env.PROTOSHARE_MANIFEST || './.protoshare.json');
const token = process.env.PROTOSHARE_TOKEN;

if (!token) {
  process.stderr.write('Fatal: PROTOSHARE_TOKEN is not set. Generate one in the admin "API Tokens" panel.\n');
  process.exit(1);
}

let manifest;
try {
  manifest = manifestLib.load(manifestPath);
} catch (err) {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
}

const client = new ProtoshareClient({ baseUrl: manifest.remote, token });
const ctx = {
  client,
  manifest,
  manifestPath,
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  writeFile: (p, data) => fs.writeFileSync(p, data),
};

// Wrap a handler so a thrown error becomes an MCP error result rather than
// crashing the server; the message is surfaced to the calling agent.
function tool(fn) {
  return async (args) => {
    try {
      return { content: [{ type: 'text', text: await fn(ctx, args) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  };
}

const server = new McpServer({ name: 'protoshare', version: '1.0.0' });

server.tool('protoshare_list', 'List the prototypes this token can access, with their published/draft versions.',
  {}, tool(handlers.list));

server.tool('protoshare_pull', 'Fetch all feedback (comments, replies, explanations) for a prototype. Accepts a local file name from the manifest or a prototype id.',
  { file_or_id: z.string().describe('Local HTML file (from .protoshare.json) or prototype id') },
  tool(handlers.pull));

server.tool('protoshare_source', 'Download the published (or a specific) version HTML. If the argument is a known local file, it is written to that file.',
  { file_or_id: z.string().describe('Local HTML file or prototype id'),
    version: z.number().int().optional().describe('Specific version number (defaults to published)') },
  tool(handlers.source));

server.tool('protoshare_push', 'Upload the local HTML file as a new DRAFT version (does not affect the live share link). Sends the manifest baseVersion for conflict detection.',
  { file: z.string().describe('Local HTML file to upload (must be a key in .protoshare.json)'),
    note: z.string().optional().describe('Optional note describing the change') },
  tool(handlers.push));

server.tool('protoshare_publish', 'Promote a draft to live. The share link starts serving it. Defaults to the latest draft.',
  { file_or_id: z.string().describe('Local HTML file or prototype id'),
    version: z.number().int().optional().describe('Version to publish (defaults to latest draft)') },
  tool(handlers.publish));

server.tool('protoshare_status', 'Show the local (manifest) vs remote version summary for a prototype.',
  { file_or_id: z.string().describe('Local HTML file or prototype id') },
  tool(handlers.status));

server.tool('protoshare_resolve', 'Mark a comment as addressed (resolved) in a given version. Run after pushing a fix so future pulls surface only open feedback.',
  { file_or_id: z.string().describe('Local HTML file or prototype id'),
    comment_id: z.string().describe('The comment id from protoshare_pull'),
    version: z.number().int().optional().describe('The version that addressed it (defaults to none)') },
  tool(handlers.resolve));

try {
  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (err) {
  process.stderr.write(`Fatal: failed to start MCP server: ${err}\n`);
  process.exit(1);
}
