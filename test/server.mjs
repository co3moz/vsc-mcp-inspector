#!/usr/bin/env node
// Development MCP server used to exercise the inspector.
//
//   node test/server.mjs stdio                 # stdio transport
//   node test/server.mjs http [port]           # Streamable HTTP on /mcp and SSE on /sse (default port 3001)
//
// Set REQUIRE_TOKEN=secret to require "Authorization: Bearer secret" on HTTP requests.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';

// 16x16 red/blue checkerboard PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAJUlEQVR4nGPQrr8GR089fOEIlzjDINRAjCJk8cGoYRAG60iMBwCDuX0QpNjAlAAAAABJRU5ErkJggg==';

function buildServer() {
  const server = new McpServer({ name: 'inspector-test-server', version: '1.2.3' }, { instructions: 'Test server for the VS Code MCP Inspector.' });

  server.registerTool(
    'echo',
    { title: 'Echo', description: 'Returns the message you send.', inputSchema: { message: z.string().describe('Text to echo back') } },
    async ({ message }) => ({ content: [{ type: 'text', text: message }] }),
  );

  server.registerTool(
    'add',
    {
      description: 'Adds two numbers and returns structured output.',
      inputSchema: { a: z.number().describe('First addend'), b: z.number().describe('Second addend') },
      outputSchema: { sum: z.number() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }], structuredContent: { sum: a + b } }),
  );

  server.registerTool(
    'echo_headers',
    { description: 'Returns the HTTP request headers the server received.', inputSchema: {} },
    async (_args, extra) => ({ content: [{ type: 'text', text: JSON.stringify(extra.requestInfo?.headers ?? {}) }] }),
  );

  server.registerTool(
    'complex_input',
    {
      description: 'Accepts many parameter types and echoes them back as JSON.',
      inputSchema: {
        name: z.string().describe('A required string'),
        count: z.number().int().min(1).max(10).describe('Integer between 1 and 10'),
        mode: z.enum(['fast', 'safe', 'debug']).describe('Execution mode'),
        verbose: z.boolean().optional().describe('Optional flag'),
        tags: z.array(z.string()).optional().describe('List of tags'),
        options: z.object({ depth: z.number(), label: z.string().optional() }).optional().describe('Nested options'),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] }),
  );

  server.registerTool('tiny_image', { description: 'Returns a small PNG image and a text block.', inputSchema: {} }, async () => ({
    content: [
      { type: 'text', text: 'Here is an image:' },
      { type: 'image', data: PNG, mimeType: 'image/png' },
      { type: 'resource_link', uri: 'test://readme', name: 'README', mimeType: 'text/markdown' },
    ],
  }));

  server.registerTool(
    'slow',
    { description: 'Reports progress while it works.', inputSchema: { steps: z.number().int().min(1).max(50).describe('Number of steps') } },
    async ({ steps }, extra) => {
      const token = extra._meta?.progressToken;
      for (let i = 1; i <= steps; i++) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (extra.signal.aborted) {
          throw new Error('cancelled');
        }
        if (token !== undefined) {
          await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: i, total: steps, message: `step ${i}` } });
        }
      }
      return { content: [{ type: 'text', text: `done after ${steps} steps` }] };
    },
  );

  server.registerTool('fail', { description: 'Always returns an error result.', inputSchema: {} }, async () => ({
    isError: true,
    content: [{ type: 'text', text: 'Something went wrong on purpose.' }],
  }));

  server.registerTool('crash', { description: 'Exits the server process shortly after replying (stdio only).', inputSchema: {} }, async () => {
    setTimeout(() => process.exit(1), 50);
    return { content: [{ type: 'text', text: 'bye' }] };
  });

  server.registerPrompt(
    'greeting',
    { description: 'Builds a greeting prompt.', argsSchema: { name: z.string().describe('Who to greet'), style: z.string().optional().describe('formal or casual') } },
    ({ name, style }) => ({
      description: 'A greeting',
      messages: [{ role: 'user', content: { type: 'text', text: `Say hello to ${name}${style ? ` in a ${style} way` : ''}.` } }],
    }),
  );

  server.registerResource('readme', 'test://readme', { description: 'Project readme', mimeType: 'text/markdown' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: '# Test server\n\nHello from a resource.' }],
  }));

  server.registerResource('logo', 'test://logo', { description: 'A binary image resource', mimeType: 'image/png' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'image/png', blob: PNG }],
  }));

  server.registerResource(
    'user',
    new ResourceTemplate('test://users/{id}', { list: undefined }),
    { description: 'User by id', mimeType: 'application/json' },
    async (uri, { id }) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ id, name: `User ${id}` }) }] }),
  );

  return server;
}

const mode = process.argv[2] ?? 'stdio';

if (mode === 'stdio') {
  console.error('inspector-test-server: starting on stdio');
  if (process.env.CRASH_ON_START) {
    console.error('fatal: CRASH_ON_START is set');
    process.exit(3);
  }
  await buildServer().connect(new StdioServerTransport());
} else {
  const port = Number(process.argv[3] ?? 3001);
  const token = process.env.REQUIRE_TOKEN;
  /** @type {Map<string, WebStandardStreamableHTTPServerTransport>} */
  const httpSessions = new Map();
  /** @type {Map<string, SSEServerTransport>} */
  const sseSessions = new Map();

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : undefined);
        } catch (err) {
          reject(err);
        }
      });
    });

  /** @param {import('node:http').IncomingMessage} req @param {URL} url */
  const toWebRequest = (req, url) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE';
    return new Request(url, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half' });
  };

  /** @param {Response} response @param {import('node:http').ServerResponse} res */
  const pipeWebResponse = async (response, res) => {
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body) {
      res.end();
      return;
    }
    const reader = response.body.getReader();
    res.on('close', () => void reader.cancel().catch(() => undefined));
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      // client went away
    }
    res.end();
  };

  const http = createServer(async (req, res) => {
    try {
      if (token && req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);

      if (url.pathname === '/mcp') {
        const sessionId = req.headers['mcp-session-id'];
        let transport = typeof sessionId === 'string' ? httpSessions.get(sessionId) : undefined;
        if (!transport) {
          if (sessionId) {
            res.writeHead(404).end('unknown session');
            return;
          }
          transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => httpSessions.set(id, transport),
          });
          transport.onclose = () => transport.sessionId && httpSessions.delete(transport.sessionId);
          await buildServer().connect(transport);
        }
        // The web-standard transport plus a small Node bridge is used instead of the Node
        // StreamableHTTPServerTransport, whose adapter sends broken chunked responses on Node 24.
        await pipeWebResponse(await transport.handleRequest(toWebRequest(req, url)), res);
        return;
      }

      if (url.pathname === '/sse' && req.method === 'GET') {
        const transport = new SSEServerTransport('/messages', res);
        sseSessions.set(transport.sessionId, transport);
        res.on('close', () => sseSessions.delete(transport.sessionId));
        await buildServer().connect(transport);
        return;
      }

      if (url.pathname === '/messages' && req.method === 'POST') {
        const transport = sseSessions.get(url.searchParams.get('sessionId') ?? '');
        if (!transport) {
          res.writeHead(404).end('unknown session');
          return;
        }
        await transport.handlePostMessage(req, res, await readBody(req));
        return;
      }

      res.writeHead(404).end('not found');
    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        res.writeHead(500).end(String(err));
      }
    }
  });

  http.listen(port, '127.0.0.1', () => {
    console.error(`inspector-test-server: http://127.0.0.1:${port}/mcp (Streamable HTTP), http://127.0.0.1:${port}/sse (SSE)`);
  });
}
