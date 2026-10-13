// End-to-end tests for McpSession against test/server.mjs over all three transports.
// Run with: npm run test:core
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import { McpSession, type SessionHost } from '../src/core/session';
import type { ConnectionConfig } from '../src/core/types';

const ROOT = process.cwd();
const SERVER = path.join(ROOT, 'test', 'server.mjs');
const PORT = 3917;
const TOKEN = 'secret-token';

const logs: string[] = [];
const host: SessionHost = {
  log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
  onDidChange: () => undefined,
  requestTimeoutMs: () => 15000,
  logTraffic: () => true,
  resolve: (value) => value.replace(/\$\{env:([^}]+)\}/g, (_m, name: string) => process.env[name] ?? ''),
};

const stdio = (overrides: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: 'stdio',
  name: 'stdio test',
  transport: 'stdio',
  command: process.execPath,
  args: [SERVER, 'stdio'],
  cwd: ROOT,
  env: [],
  ...overrides,
});

const remote = (transport: 'sse' | 'http', headers: ConnectionConfig['headers']): ConnectionConfig => ({
  id: transport,
  name: `${transport} test`,
  transport,
  url: `http://127.0.0.1:${PORT}/${transport === 'sse' ? 'sse' : 'mcp'}`,
  headers,
});

const textOf = (result: { content?: Array<{ type: string; text?: string }> }) => result.content?.find((c) => c.type === 'text')?.text;

describe('stdio transport', () => {
  const session = new McpSession(stdio(), host);
  after(() => session.disconnect());

  it('connects and lists everything', async () => {
    await session.connect();
    assert.equal(session.status, 'connected');
    assert.equal(session.serverInfo?.name, 'inspector-test-server');
    assert.equal(session.serverInfo?.version, '1.2.3');
    assert.ok(session.protocolVersion, 'protocol version captured');
    assert.equal(session.instructions, 'Test server for the VS Code MCP Inspector.');
    assert.deepEqual(
      session.tools.map((t) => t.name).sort(),
      ['add', 'complex_input', 'crash', 'echo', 'echo_headers', 'fail', 'slow', 'tiny_image'],
    );
    assert.deepEqual(session.prompts.map((p) => p.name), ['greeting']);
    assert.deepEqual(session.resources.map((r) => r.uri).sort(), ['test://logo', 'test://readme']);
    assert.deepEqual(session.templates.map((t) => t.uriTemplate), ['test://users/{id}']);
    assert.ok(logs.some((l) => l.includes('stderr: inspector-test-server: starting on stdio')), 'stderr is logged');
    assert.ok(logs.some((l) => l.includes('] → {') && l.includes('"method":"initialize"')), 'outgoing traffic is logged');
    assert.ok(logs.some((l) => l.includes('] ← {') && l.includes('"serverInfo"')), 'incoming traffic is logged');
  });

  it('calls tools', async () => {
    assert.equal(textOf(await session.callTool('echo', { message: 'merhaba' })), 'merhaba');
    const add = await session.callTool('add', { a: 2, b: 40 });
    assert.deepEqual(add.structuredContent, { sum: 42 });
    const complex = await session.callTool('complex_input', { name: 'x', count: 3, mode: 'safe', tags: ['a'], options: { depth: 2 } });
    assert.deepEqual(JSON.parse(textOf(complex)!), { name: 'x', count: 3, mode: 'safe', tags: ['a'], options: { depth: 2 } });
    const image = await session.callTool('tiny_image', {});
    assert.equal(image.content[1].type, 'image');
    const failed = await session.callTool('fail', {});
    assert.equal(failed.isError, true);
  });

  it('returns validation errors as tool errors', async () => {
    const result = await session.callTool('add', { a: 'not a number' });
    assert.equal(result.isError, true);
  });

  it('reports progress', async () => {
    const progress: number[] = [];
    const result = await session.callTool('slow', { steps: 3 }, { onprogress: (p) => progress.push(p.progress) });
    assert.equal(textOf(result), 'done after 3 steps');
    assert.deepEqual(progress, [1, 2, 3]);
  });

  it('cancels requests', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await assert.rejects(session.callTool('slow', { steps: 20 }, { signal: controller.signal }));
    assert.equal(session.status, 'connected');
  });

  it('gets prompts and reads resources', async () => {
    const prompt = await session.getPrompt('greeting', { name: 'Ada', style: 'formal' });
    assert.equal((prompt.messages[0].content as { text: string }).text, 'Say hello to Ada in a formal way.');
    const readme = await session.readResource('test://readme');
    assert.match(String((readme.contents[0] as { text?: string }).text), /Hello from a resource/);
    const logo = await session.readResource('test://logo');
    assert.ok((logo.contents[0] as { blob?: string }).blob);
    const user = await session.readResource(new UriTemplate('test://users/{id}').expand({ id: '7' }));
    assert.deepEqual(JSON.parse(String((user.contents[0] as { text?: string }).text)), { id: '7', name: 'User 7' });
  });

  it('disconnects and reconnects on demand', async () => {
    await session.disconnect();
    assert.equal(session.status, 'disconnected');
    // Any operation reconnects automatically.
    assert.equal(textOf(await session.callTool('echo', { message: 'again' })), 'again');
    assert.equal(session.status, 'connected');
  });

  it('notices when the server process exits', async () => {
    await session.callTool('crash', {});
    for (let i = 0; i < 50 && session.status === 'connected'; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(session.status, 'error');
    assert.match(session.error ?? '', /closed/i);
  });
});

describe('stdio failures', () => {
  it('reports a missing command', async () => {
    const session = new McpSession(stdio({ command: 'definitely-not-a-real-command-xyz', args: [] }), host);
    await assert.rejects(session.connect(), /ENOENT|not found|not recognized/i);
    assert.equal(session.status, 'error');
  });

  it('includes stderr when the server crashes on start', async () => {
    const session = new McpSession(stdio({ env: [{ key: 'CRASH_ON_START', value: '1', enabled: true }] }), host);
    await assert.rejects(session.connect(), /fatal: CRASH_ON_START is set/);
    assert.equal(session.status, 'error');
  });

  it('does not pass disabled environment variables', async () => {
    const session = new McpSession(stdio({ env: [{ key: 'CRASH_ON_START', value: '1', enabled: false }] }), host);
    await session.connect();
    assert.equal(session.status, 'connected');
    await session.disconnect();
  });
});

describe('HTTP transports', () => {
  let server: ChildProcess;

  before(async () => {
    server = spawn(process.execPath, [SERVER, 'http', String(PORT)], { env: { ...process.env, REQUIRE_TOKEN: TOKEN }, stdio: ['ignore', 'ignore', 'pipe'] });
    const [chunk] = await once(server.stderr!, 'data');
    assert.match(String(chunk), /inspector-test-server: http/);
  });
  after(() => server.kill());

  for (const transport of ['http', 'sse'] as const) {
    describe(transport === 'http' ? 'Streamable HTTP' : 'SSE', () => {
      it('fails without the Authorization header', async () => {
        const session = new McpSession(remote(transport, []), host);
        await assert.rejects(session.connect(), /401|unauthorized/i);
        assert.equal(session.status, 'error');
      });

      it('sends custom headers, resolves ${env:...} and skips disabled ones', async () => {
        process.env.INSPECTOR_TEST_TOKEN = TOKEN;
        const session = new McpSession(
          remote(transport, [
            { key: 'Authorization', value: 'Bearer ${env:INSPECTOR_TEST_TOKEN}', enabled: true },
            { key: 'X-Custom', value: 'hello', enabled: true },
            { key: 'X-Disabled', value: 'nope', enabled: false },
          ]),
          host,
        );
        try {
          await session.connect();
          assert.equal(session.status, 'connected');
          assert.equal(session.tools.length, 8);

          const headers = JSON.parse(textOf(await session.callTool('echo_headers', {}))!);
          assert.equal(headers['x-custom'], 'hello');
          assert.equal(headers.authorization, `Bearer ${TOKEN}`);
          assert.equal(headers['x-disabled'], undefined);

          const progress: number[] = [];
          const result = await session.callTool('slow', { steps: 3 }, { onprogress: (p) => progress.push(p.progress) });
          assert.equal(textOf(result), 'done after 3 steps');
          // The legacy SSE server may deliver the last progress notification after the result.
          assert.deepEqual(progress.slice(0, 2), [1, 2]);

          const readme = await session.readResource('test://readme');
          assert.equal(readme.contents.length, 1);
        } finally {
          await session.disconnect();
        }
        assert.equal(session.status, 'disconnected');
      });
    });
  }

  it('rejects an invalid URL', async () => {
    const session = new McpSession({ id: 'bad', name: 'bad', transport: 'http', url: 'not a url', headers: [] }, host);
    await assert.rejects(session.connect(), /Invalid URL/);
  });

  it('reports a refused connection', async () => {
    const session = new McpSession({ id: 'closed', name: 'closed', transport: 'http', url: 'http://127.0.0.1:1/mcp', headers: [] }, host);
    await assert.rejects(session.connect());
    assert.equal(session.status, 'error');
  });
});
