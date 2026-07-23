#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import adapterCore from '../src/mcp-adapter-core.js';

const { buildApiRequest, toolDefinitions } = adapterCore;
const apiUrl = String(process.env.MURDAWK_UPLINK_API_URL || '').trim();
const apiToken = String(process.env.MURDAWK_UPLINK_TOKEN || '').trim();

if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(apiUrl) || !apiToken) {
  console.error('Murdawk Uplink MCP requires its local API URL and API key. Create a fresh MCP configuration in Connections > Automation access.');
  process.exit(1);
}

async function callUplink(name, input = {}) {
  const request = buildApiRequest(name, input);
  const response = await fetch(new URL(request.path, apiUrl), {
    method: request.method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(request.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: request.body ? JSON.stringify(request.body) : undefined,
  });
  const value = await response.json();
  if (!response.ok || value.ok !== true) throw new Error(value.error || `Murdawk Uplink returned ${response.status}.`);
  return value;
}

function result(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

const descriptions = Object.fromEntries(toolDefinitions().map((tool) => [tool.name, tool.description]));
const server = new McpServer({ name: 'murdawk-uplink', version: '0.1.0' });

server.registerTool('list_capabilities', {
  description: descriptions.list_capabilities,
  inputSchema: {},
}, async () => result(await callUplink('list_capabilities')));

server.registerTool('list_connections', {
  description: descriptions.list_connections,
  inputSchema: {},
}, async () => result(await callUplink('list_connections')));

server.registerTool('list_remote_folder', {
  description: descriptions.list_remote_folder,
  inputSchema: {
    connectionId: z.string().optional().describe('Uplink connection id; omit to use the active connection'),
    prefix: z.string().optional().describe('Remote folder path inside the Space'),
  },
}, async (input) => result(await callUplink('list_remote_folder', input)));

server.registerTool('read_upload_queue', {
  description: descriptions.read_upload_queue,
  inputSchema: {},
}, async () => result(await callUplink('read_upload_queue')));

server.registerTool('queue_local_sources', {
  description: descriptions.queue_local_sources,
  inputSchema: {
    connectionId: z.string().min(1).describe('Uplink connection id'),
    sources: z.array(z.string().min(1)).min(1).max(100).describe('Absolute local file or folder paths'),
    prefix: z.string().optional().describe('Destination folder in the Space'),
    filterMode: z.enum(['all', 'videos-images', 'media-docs', 'custom']).optional(),
    include: z.string().optional().describe('Include pattern when filterMode is custom'),
    folderUploadMode: z.enum(['package', 'contents']).optional(),
    publicRead: z.boolean().optional(),
    checksum: z.enum(['size', 'sha256']).optional(),
  },
}, async (input) => result(await callUplink('queue_local_sources', input)));

server.registerTool('read_activity', {
  description: descriptions.read_activity,
  inputSchema: {},
}, async () => result(await callUplink('read_activity')));

const transport = new StdioServerTransport();
await server.connect(transport);
