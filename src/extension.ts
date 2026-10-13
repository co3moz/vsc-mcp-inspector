import * as vscode from 'vscode';
import type { McpSession } from './core/session';
import { TRANSPORT_LABELS, type ItemKind } from './core/types';
import { ConnectionManager } from './manager';
import { ConnectionPanel } from './panels/connectionPanel';
import { DetailPanel } from './panels/detailPanel';
import { errorMessage, webviewReady } from './panels/webview';
import { ConnectionStore } from './store';
import { ConnectionsTreeProvider, type Node } from './tree';

/** Returned from activate() so integration tests can drive the extension. */
export interface ExtensionApi {
  manager: ConnectionManager;
  tree: ConnectionsTreeProvider;
  store: ConnectionStore;
  onDidWebviewReady: vscode.Event<string>;
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  const log = vscode.window.createOutputChannel('MCP Inspector', { log: true });
  const store = new ConnectionStore(context);
  const manager = new ConnectionManager(store, log);
  const tree = new ConnectionsTreeProvider(manager);
  const view = vscode.window.createTreeView('mcpInspector.connections', { treeDataProvider: tree, showCollapseAll: true });
  context.subscriptions.push(log, manager, tree, view, webviewReady);
  await manager.init();

  /** Resolves the session a command targets: the clicked tree node, or a quick pick from the palette. */
  const target = async (node?: Node, filter?: (s: McpSession) => boolean): Promise<McpSession | undefined> => {
    if (node?.id) {
      return manager.get(node.id);
    }
    const candidates = manager.list().filter(filter ?? (() => true));
    if (!candidates.length) {
      void vscode.window.showInformationMessage('No matching MCP connections.');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      candidates.map((s) => ({ label: s.name, description: `${TRANSPORT_LABELS[s.config.transport]} · ${s.status}`, session: s })),
      { placeHolder: 'Select an MCP connection' },
    );
    return picked?.session;
  };

  const connect = async (session: McpSession) => {
    try {
      await vscode.window.withProgress(
        { location: { viewId: 'mcpInspector.connections' }, title: `Connecting to ${session.name}` },
        () => session.connect(),
      );
    } catch (err) {
      const choice = await vscode.window.showErrorMessage(
        `Could not connect to "${session.name}": ${errorMessage(err).split('\n')[0]}`,
        'Edit Connection',
        'Show Logs',
      );
      if (choice === 'Edit Connection') {
        ConnectionPanel.show(context.extensionUri, manager, session.config);
      } else if (choice === 'Show Logs') {
        log.show();
      }
    }
  };

  const register = (command: string, handler: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));

  register('mcpInspector.createConnection', () => ConnectionPanel.show(context.extensionUri, manager));

  register('mcpInspector.editConnection', async (node?: Node) => {
    const session = await target(node);
    if (session) {
      ConnectionPanel.show(context.extensionUri, manager, session.config);
    }
  });

  register('mcpInspector.deleteConnection', async (node?: Node) => {
    const session = await target(node);
    if (!session) {
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      `Delete the MCP connection "${session.name}"?`,
      { modal: true, detail: 'Its saved headers and environment variables are removed as well.' },
      'Delete',
    );
    if (confirmed === 'Delete') {
      DetailPanel.disposeFor(session.config.id);
      ConnectionPanel.disposeFor(session.config.id);
      await manager.remove(session.config.id);
    }
  });

  register('mcpInspector.connect', async (node?: Node) => {
    const session = await target(node, (s) => s.status !== 'connected');
    if (session) {
      await connect(session);
    }
  });

  register('mcpInspector.disconnect', async (node?: Node) => {
    const session = await target(node, (s) => s.status === 'connected' || s.status === 'connecting');
    await session?.disconnect();
  });

  register('mcpInspector.reconnect', async (node?: Node) => {
    const session = await target(node);
    if (session) {
      await session.disconnect();
      await connect(session);
    }
  });

  register('mcpInspector.refresh', async (node?: Node) => {
    const sessions = node?.id ? [manager.get(node.id)] : manager.list().filter((s) => s.status === 'connected');
    await Promise.all(
      sessions.map(async (session) => {
        if (!session) {
          return;
        }
        try {
          await session.refresh();
        } catch (err) {
          void vscode.window.showErrorMessage(`Refreshing "${session.name}" failed: ${errorMessage(err).split('\n')[0]}`);
        }
      }),
    );
  });

  register('mcpInspector.showServerInfo', async (node?: Node) => {
    const session = await target(node, (s) => s.status === 'connected');
    if (!session) {
      return;
    }
    const info = {
      connection: { name: session.name, ...redact(session) },
      serverInfo: session.serverInfo,
      protocolVersion: session.protocolVersion,
      capabilities: session.capabilities,
      instructions: session.instructions,
      counts: manager.summary(session.config.id)?.counts,
    };
    const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(info, null, 2) });
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  register('mcpInspector.showLogs', () => log.show());

  register('mcpInspector.openItem', (connectionId: string, kind: ItemKind, key: string) =>
    DetailPanel.show(context.extensionUri, manager, connectionId, kind, key),
  );

  return { manager, tree, store, onDidWebviewReady: webviewReady.event };
}

export function deactivate(): void {
  // Sessions are disposed through context.subscriptions (ConnectionManager.dispose).
}

/** Connection settings without header/env values, which may contain secrets. */
function redact(session: McpSession) {
  const { config } = session;
  return config.transport === 'stdio'
    ? { transport: config.transport, command: config.command, args: config.args, cwd: config.cwd, env: config.env?.map((e) => e.key) }
    : { transport: config.transport, url: config.url, headers: config.headers?.filter((h) => h.enabled).map((h) => h.key) };
}
