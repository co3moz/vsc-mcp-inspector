// Runs inside a real VS Code instance (see test/run-integration.mjs).
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../src/extension';
import type { Node } from '../../src/tree';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER = path.join(ROOT, 'test', 'server.mjs');
const PORT = 3931;
const NODE = process.env.INSPECTOR_TEST_NODE ?? 'node';

type Test = [string, () => Promise<void>];

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<ExtensionApi>('co3moz.vsc-mcp-inspector');
  assert.ok(extension, 'extension is installed');
  const api = await extension.activate();
  const { manager, tree, store } = api;
  const readyWebviews: string[] = [];
  api.onDidWebviewReady((title) => readyWebviews.push(title));
  let httpServer: ChildProcess | undefined;

  const stdioId = 'it-stdio';
  const httpId = 'it-http';
  const labels = async (node?: Node) =>
    Promise.all((await tree.getChildren(node)).map((n) => String(tree.getTreeItem(n).label)));
  const webviewTabs = () =>
    vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview).map((t) => t.label);

  const tests: Test[] = [
    ['contributes the commands and the view', async () => {
      const commands = await vscode.commands.getCommands(true);
      for (const id of ['createConnection', 'editConnection', 'deleteConnection', 'connect', 'disconnect', 'reconnect', 'refresh', 'openItem', 'showLogs']) {
        assert.ok(commands.includes(`mcpInspector.${id}`), `mcpInspector.${id} registered`);
      }
      await vscode.commands.executeCommand('workbench.view.extension.mcpInspector');
      assert.deepEqual(await labels(), []);
    }],

    ['opens the create connection form', async () => {
      await vscode.commands.executeCommand('mcpInspector.createConnection');
      await waitFor(() => webviewTabs().includes('New MCP Connection'));
      // The page's scripts loaded under the webview CSP and requested their data.
      await waitFor(() => readyWebviews.includes('New MCP Connection'), 15000);
    }],

    ['adds a stdio connection and lists its tools in the tree', async () => {
      const session = await manager.add(
        { id: stdioId, name: 'Local test server', transport: 'stdio', command: NODE, args: [SERVER, 'stdio'], cwd: ROOT, env: [{ key: 'FOO', value: 'bar', enabled: true }] },
        true,
      );
      assert.equal(session.status, 'connected');
      assert.deepEqual(await labels(), ['Local test server']);

      const [connection] = await tree.getChildren();
      const item = tree.getTreeItem(connection);
      assert.equal(item.contextValue, 'connection-connected');
      assert.match(String(item.description), /STDIO · 8 tools/);

      assert.deepEqual(await labels(connection), ['Tools', 'Prompts', 'Resources', 'Resource Templates']);
      const [toolsGroup] = await tree.getChildren(connection);
      const tools = await tree.getChildren(toolsGroup);
      assert.equal(tools.length, 8);
      const echo = tools.find((n) => tree.getTreeItem(n).label === 'echo')!;
      const echoItem = tree.getTreeItem(echo);
      assert.equal(echoItem.description, 'Echo');
      assert.equal(echoItem.command?.command, 'mcpInspector.openItem');
      assert.deepEqual(echoItem.command?.arguments, [stdioId, 'tool', 'echo']);
    }],

    ['opens a tool detail panel from the tree command', async () => {
      const [connection] = await tree.getChildren();
      const [toolsGroup] = await tree.getChildren(connection);
      const echo = (await tree.getChildren(toolsGroup)).find((n) => tree.getTreeItem(n).label === 'echo')!;
      const command = tree.getTreeItem(echo).command!;
      await vscode.commands.executeCommand(command.command, ...(command.arguments ?? []));
      await waitFor(() => webviewTabs().includes('echo · Local test server'));
      await waitFor(() => readyWebviews.includes('echo · Local test server'), 15000);
    }],

    ['persists connections with secrets kept separately', async () => {
      const saved = await store.load();
      assert.equal(saved.length, 1);
      assert.equal(saved[0].name, 'Local test server');
      assert.deepEqual(saved[0].env, [{ key: 'FOO', value: 'bar', enabled: true }]);
    }],

    ['rejects connections that fail and does not save them', async () => {
      await assert.rejects(
        manager.add({ id: 'it-broken', name: 'Broken', transport: 'stdio', command: 'definitely-not-a-command-xyz', args: [], env: [] }, true),
      );
      assert.deepEqual(await labels(), ['Local test server']);
      assert.equal((await store.load()).length, 1);
    }],

    ['adds a Streamable HTTP connection with custom headers', async () => {
      httpServer = spawn(NODE, [SERVER, 'http', String(PORT)], { env: { ...process.env, REQUIRE_TOKEN: 'tok' }, stdio: ['ignore', 'ignore', 'pipe'] });
      await once(httpServer.stderr!, 'data');
      const session = await manager.add(
        {
          id: httpId,
          name: 'Remote test server',
          transport: 'http',
          url: `http://127.0.0.1:${PORT}/mcp`,
          headers: [
            { key: 'Authorization', value: 'Bearer tok', enabled: true },
            { key: 'X-Client', value: 'vscode', enabled: true },
          ],
        },
        true,
      );
      const result = await session.callTool('echo_headers', {});
      const headers = JSON.parse((result.content[0] as { text: string }).text);
      assert.equal(headers['x-client'], 'vscode');
      assert.deepEqual(await labels(), ['Local test server', 'Remote test server']);
      const saved = (await store.load()).find((c) => c.id === httpId);
      assert.equal(saved?.headers?.length, 2);
    }],

    ['disconnects and reconnects through commands', async () => {
      const nodeArg: Node = { type: 'connection', id: stdioId };
      await vscode.commands.executeCommand('mcpInspector.disconnect', nodeArg);
      assert.equal(manager.get(stdioId)?.status, 'disconnected');
      assert.deepEqual(await labels(nodeArg), ['Disconnected — click to connect']);
      await vscode.commands.executeCommand('mcpInspector.connect', nodeArg);
      assert.equal(manager.get(stdioId)?.status, 'connected');
      assert.equal((await labels(nodeArg))[0], 'Tools');
    }],

    ['edits a connection (rename) and keeps it connected', async () => {
      const config = { ...manager.get(stdioId)!.config, name: 'Renamed server' };
      await manager.update(config, true);
      assert.deepEqual(await labels(), ['Renamed server', 'Remote test server']);
      assert.equal(manager.get(stdioId)?.status, 'connected');
    }],

    ['deletes connections', async () => {
      await manager.remove(stdioId);
      await manager.remove(httpId);
      assert.deepEqual(await labels(), []);
      assert.deepEqual(await store.load(), []);
    }],
  ];

  let failed = 0;
  try {
    for (const [name, test] of tests) {
      try {
        await test();
        console.log(`  ✔ ${name}`);
      } catch (err) {
        failed++;
        console.log(`  ✖ ${name}\n    ${(err as Error).stack?.split('\n').slice(0, 4).join('\n    ')}`);
      }
    }
  } finally {
    httpServer?.kill();
    for (const session of manager.list()) {
      await manager.remove(session.config.id);
    }
  }
  console.log(`\n  ${tests.length - failed} passed, ${failed} failed`);
  if (failed) {
    throw new Error(`${failed} integration test(s) failed`);
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
