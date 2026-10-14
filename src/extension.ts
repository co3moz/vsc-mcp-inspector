import * as vscode from 'vscode';
import type { McpSession } from './core/session';
import { TRANSPORT_LABELS, type ItemKind } from './core/types';
import { ConnectionManager } from './manager';
import { ConnectionPanel } from './panels/connectionPanel';
import { DetailPanel } from './panels/detailPanel';
import { errorMessage, webviewReady, type WebviewReadyEvent } from './panels/webview';
import { ConnectionStore } from './store';
import { ConnectionsTreeProvider, sortOrder, type Node, type SortOrder } from './tree';

const SORT_ORDERS: { order: SortOrder; label: string }[] = [
  { order: 'none', label: 'Server Order' },
  { order: 'ascending', label: 'Name (A → Z)' },
  { order: 'descending', label: 'Name (Z → A)' },
];

/** Returned from activate() so integration tests can drive the extension. */
export interface ExtensionApi {
  manager: ConnectionManager;
  tree: ConnectionsTreeProvider;
  store: ConnectionStore;
  onDidWebviewReady: vscode.Event<WebviewReadyEvent>;
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  const log = vscode.window.createOutputChannel('MCP Inspector', { log: true });
  const store = new ConnectionStore(context);
  const manager = new ConnectionManager(store, log);
  const tree = new ConnectionsTreeProvider(manager);
  const view = vscode.window.createTreeView('mcpInspector.connections', { treeDataProvider: tree, showCollapseAll: true });
  context.subscriptions.push(log, manager, tree, view, webviewReady);
  context.subscriptions.push(
    tree.onDidChangeTreeData(() => {
      const query = tree.filter;
      void vscode.commands.executeCommand('setContext', 'mcpInspector.searching', !!query);
      const count = query ? tree.matchCount() : 0;
      view.message = !query ? undefined : count ? `${count} match${count === 1 ? '' : 'es'} for “${query}”` : `No matches for “${query}”`;
    }),
  );
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

  /** Filters the tree as the user types; the filter stays after the input closes until it is cleared. */
  register('mcpInspector.search', (query?: string) => {
    if (typeof query === 'string') {
      tree.setFilter(query);
      return;
    }
    const input = vscode.window.createInputBox();
    input.placeholder = 'Search tools, prompts and resources';
    input.value = tree.filter;
    input.buttons = [{ iconPath: new vscode.ThemeIcon('clear-all'), tooltip: 'Clear Search' }];
    input.onDidChangeValue((value) => tree.setFilter(value));
    input.onDidTriggerButton(() => {
      tree.setFilter('');
      input.hide();
    });
    input.onDidAccept(() => input.hide());
    input.onDidHide(() => input.dispose());
    input.show();
  });

  register('mcpInspector.clearSearch', () => tree.setFilter(''));

  register('mcpInspector.sort', async (order?: SortOrder) => {
    const current = sortOrder();
    if (typeof order !== 'string') {
      const picked = await vscode.window.showQuickPick(
        SORT_ORDERS.map((o) => ({ label: `$(${o.order === current ? 'check' : 'blank'}) ${o.label}`, order: o.order })),
        { placeHolder: 'Sort tools, prompts and resources by' },
      );
      order = picked?.order;
    }
    if (order && order !== current) {
      const config = vscode.workspace.getConfiguration('mcpInspector');
      // Write where the current value comes from, so a workspace setting does not hide the change.
      const target = config.inspect('sortOrder')?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await config.update('sortOrder', order, target);
    }
  });

  /** Accepts a tree node (context menu) or explicit (connectionId, kind, key, args?) arguments. */
  const openItem = (run: boolean) => (target?: Node | string, kind?: ItemKind, key?: string, args?: Record<string, unknown>) => {
    const item = typeof target === 'string' && kind && key ? { id: target, kind, key } : typeof target === 'object' && target.type === 'item' ? target : undefined;
    if (item) {
      DetailPanel.show(context.extensionUri, manager, item.id, item.kind, item.key, { args, run });
    }
  };
  register('mcpInspector.openItem', openItem(false));
  register('mcpInspector.runItem', openItem(true));

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
