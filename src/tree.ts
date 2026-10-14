import * as vscode from 'vscode';
import type { ListKind, McpSession } from './core/session';
import { TRANSPORT_LABELS, type ItemKind } from './core/types';
import type { ConnectionManager } from './manager';

export type Node =
  | { type: 'connection'; id: string }
  | { type: 'group'; id: string; list: ListKind }
  | { type: 'item'; id: string; kind: ItemKind; key: string }
  | { type: 'message'; id: string; slot: string; label: string; tooltip?: string; icon: string; command?: vscode.Command };

/** Value of the `mcpInspector.sortOrder` setting: the server's order, or by label. */
export type SortOrder = 'none' | 'ascending' | 'descending';

const GROUPS: Record<ListKind, { label: string; icon: string; item: ItemKind; empty: string }> = {
  tools: { label: 'Tools', icon: 'tools', item: 'tool', empty: 'No tools' },
  prompts: { label: 'Prompts', icon: 'comment-discussion', item: 'prompt', empty: 'No prompts' },
  resources: { label: 'Resources', icon: 'files', item: 'resource', empty: 'No resources' },
  templates: { label: 'Resource Templates', icon: 'file-symlink-file', item: 'template', empty: 'No resource templates' },
};
const LISTS = Object.keys(GROUPS) as ListKind[];

/** An item of a list: its key, the label shown in the tree (used for sorting) and other text a search matches. */
interface Entry {
  key: string;
  label: string;
  also: (string | undefined)[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortOrder(): SortOrder {
  return vscode.workspace.getConfiguration('mcpInspector').get<SortOrder>('sortOrder', 'none');
}

export class ConnectionsTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly subscriptions: vscode.Disposable[];
  private query = '';

  constructor(private readonly manager: ConnectionManager) {
    this.subscriptions = [
      manager.onDidChange(() => this.changeEmitter.fire(undefined)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('mcpInspector.sortOrder')) {
          this.changeEmitter.fire(undefined);
        }
      }),
    ];
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
    this.changeEmitter.dispose();
  }

  /** Text that items must contain (case-insensitive) to be shown; empty shows everything. */
  get filter(): string {
    return this.query;
  }

  setFilter(text: string): void {
    const query = text.trim();
    if (query !== this.query) {
      this.query = query;
      this.changeEmitter.fire(undefined);
    }
  }

  /** Number of items matching the filter on all connected servers. */
  matchCount(): number {
    return this.manager
      .list()
      .filter((s) => s.status === 'connected')
      .reduce((count, session) => count + LISTS.reduce((n, list) => n + this.matches(session, list).length, 0), 0);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      return this.manager.list().map((s) => ({ type: 'connection', id: s.config.id }));
    }
    const session = this.manager.get(node.id);
    if (!session) {
      return [];
    }
    if (node.type === 'connection') {
      return this.connectionChildren(session);
    }
    if (node.type === 'group') {
      const items = this.visibleKeys(session, node.list).map((key): Node => ({ type: 'item', id: node.id, kind: GROUPS[node.list].item, key }));
      return items.length ? items : [message(node.id, `${node.list}-empty`, this.query ? 'No matches' : GROUPS[node.list].empty, 'info')];
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const session = this.manager.get(node.id);
    switch (node.type) {
      case 'connection':
        return session ? connectionItem(session, !!this.query) : new vscode.TreeItem('?');
      case 'group':
        return session ? groupItem(session, node.list, this.query ? this.matches(session, node.list).length : undefined) : new vscode.TreeItem('?');
      case 'item':
        return session ? itemTreeItem(session, node.kind, node.key) : new vscode.TreeItem(node.key);
      case 'message': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = `${node.id}/msg/${node.slot}`;
        item.iconPath = new vscode.ThemeIcon(node.icon);
        item.tooltip = node.tooltip ?? node.label;
        item.command = node.command;
        return item;
      }
    }
  }

  private async connectionChildren(session: McpSession): Promise<Node[]> {
    const id = session.config.id;
    // Expanding a connection that has not been used yet in this window connects it.
    if (session.status === 'idle' || session.status === 'connecting') {
      await session.connect().catch(() => undefined);
    }
    if (session.status === 'error') {
      const firstLine = session.error?.split('\n')[0] ?? 'Connection failed';
      return [
        message(id, 'error', firstLine, 'error', session.error),
        message(id, 'retry', 'Retry connection', 'debug-restart', undefined, {
          title: 'Reconnect',
          command: 'mcpInspector.reconnect',
          arguments: [{ type: 'connection', id }],
        }),
      ];
    }
    if (session.status !== 'connected') {
      return [
        message(id, 'disconnected', 'Disconnected — click to connect', 'plug', undefined, {
          title: 'Connect',
          command: 'mcpInspector.connect',
          arguments: [{ type: 'connection', id }],
        }),
      ];
    }
    const caps = session.capabilities ?? {};
    const groups: Node[] = [];
    if (caps.tools) {
      groups.push({ type: 'group', id, list: 'tools' });
    }
    if (caps.prompts) {
      groups.push({ type: 'group', id, list: 'prompts' });
    }
    if (caps.resources) {
      groups.push({ type: 'group', id, list: 'resources' });
      if (session.templates.length || session.listErrors.templates) {
        groups.push({ type: 'group', id, list: 'templates' });
      }
    }
    if (!groups.length) {
      return [message(id, 'nothing', 'Server exposes no tools, prompts or resources', 'info')];
    }
    if (!this.query) {
      return groups;
    }
    const matching = groups.filter((g) => g.type === 'group' && this.matches(session, g.list).length);
    return matching.length ? matching : [message(id, 'no-matches', `No matches for “${this.query}”`, 'search')];
  }

  /** Keys of the items to show: those matching the filter, in the configured order. */
  private visibleKeys(session: McpSession, list: ListKind): string[] {
    const entries = this.matches(session, list);
    const order = sortOrder();
    if (order !== 'none') {
      const sign = order === 'descending' ? -1 : 1;
      entries.sort((a, b) => sign * collator.compare(a.label, b.label));
    }
    return entries.map((e) => e.key);
  }

  private matches(session: McpSession, list: ListKind): Entry[] {
    const query = this.query.toLowerCase();
    const all = entries(session, list);
    return query ? all.filter((e) => [e.label, ...e.also].some((text) => text?.toLowerCase().includes(query))) : all;
  }
}

function entries(session: McpSession, list: ListKind): Entry[] {
  switch (list) {
    case 'tools':
      return session.tools.map((t) => ({ key: t.name, label: t.name, also: [t.title, t.annotations?.title] }));
    case 'prompts':
      return session.prompts.map((p) => ({ key: p.name, label: p.name, also: [p.title] }));
    case 'resources':
      return session.resources.map((r) => ({ key: r.uri, label: r.title ?? r.name, also: [r.name, r.uri] }));
    case 'templates':
      return session.templates.map((t) => ({ key: t.uriTemplate, label: t.title ?? t.name, also: [t.name, t.uriTemplate] }));
  }
}

function message(id: string, slot: string, label: string, icon: string, tooltip?: string, command?: vscode.Command): Node {
  return { type: 'message', id, slot, label, icon, tooltip, command };
}

function connectionItem(session: McpSession, searching: boolean): vscode.TreeItem {
  const { config, status } = session;
  const item = new vscode.TreeItem(
    config.name,
    status === 'connected' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
  );
  // VS Code keeps the expanded state per id; a separate id while searching shows the matches even if the user collapsed it.
  item.id = searching && status === 'connected' ? `${config.id}/search` : config.id;
  item.contextValue = `connection-${status}`;

  const transport = TRANSPORT_LABELS[config.transport];
  const statusText: Record<typeof status, string> = {
    idle: transport,
    disconnected: `${transport} · disconnected`,
    connecting: `${transport} · connecting…`,
    connected: `${transport} · ${session.tools.length} tool${session.tools.length === 1 ? '' : 's'}`,
    error: `${transport} · error`,
  };
  item.description = statusText[status];

  item.iconPath =
    status === 'connected'
      ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'))
      : status === 'connecting'
        ? new vscode.ThemeIcon('loading~spin')
        : status === 'error'
          ? new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'))
          : new vscode.ThemeIcon('circle-large-outline');

  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${escapeMd(config.name)}** — ${transport}\n\n`);
  const target = config.transport === 'stdio' ? [config.command, ...(config.args ?? [])].join(' ') : config.url ?? '';
  md.appendCodeblock(target, 'text');
  if (session.serverInfo) {
    md.appendMarkdown(`\nServer: ${code(`${session.serverInfo.name} ${session.serverInfo.version}`)}`);
    if (session.protocolVersion) {
      md.appendMarkdown(` · protocol ${code(session.protocolVersion)}`);
    }
    md.appendMarkdown('\n');
  }
  if (status === 'error' && session.error) {
    md.appendMarkdown('\n**Error**\n');
    md.appendCodeblock(session.error, 'text');
  }
  item.tooltip = md;
  return item;
}

/** `matches` is the number of items matching the search, undefined when not searching. */
function groupItem(session: McpSession, list: ListKind, matches?: number): vscode.TreeItem {
  const group = GROUPS[list];
  const searching = matches !== undefined;
  const item = new vscode.TreeItem(
    group.label,
    list === 'tools' || searching ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.id = `${session.config.id}/${list}${searching ? '/search' : ''}`;
  item.contextValue = `group-${list}`;
  const error = session.listErrors[list];
  if (error) {
    item.description = 'failed to load';
    item.tooltip = error;
    item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
  } else {
    item.description = searching ? `${matches} of ${session[list].length}` : String(session[list].length);
    item.iconPath = new vscode.ThemeIcon(group.icon);
  }
  return item;
}

function itemTreeItem(session: McpSession, kind: ItemKind, key: string): vscode.TreeItem {
  const item = new vscode.TreeItem(key, vscode.TreeItemCollapsibleState.None);
  item.id = `${session.config.id}/${kind}/${key}`;
  item.contextValue = kind;
  item.command = {
    title: 'Open',
    command: 'mcpInspector.openItem',
    arguments: [session.config.id, kind, key],
  };
  const md = new vscode.MarkdownString();

  switch (kind) {
    case 'tool': {
      const tool = session.tools.find((t) => t.name === key);
      item.iconPath = new vscode.ThemeIcon('symbol-method');
      const title = tool?.title ?? tool?.annotations?.title;
      if (title && title !== key) {
        item.description = title;
      }
      md.appendMarkdown(`**${escapeMd(key)}**\n\n`);
      if (tool?.description) {
        md.appendMarkdown(`${tool.description}\n\n`);
      }
      const props = Object.entries((tool?.inputSchema?.properties ?? {}) as Record<string, { type?: unknown; description?: string }>);
      const required = new Set(tool?.inputSchema?.required ?? []);
      if (props.length) {
        md.appendMarkdown('**Parameters**\n\n');
        for (const [name, schema] of props) {
          const type = Array.isArray(schema?.type) ? schema.type.join(' | ') : (schema?.type as string | undefined) ?? 'any';
          md.appendMarkdown(`- ${code(name)}${required.has(name) ? ' (required)' : ''} _${escapeMd(type)}_`);
          md.appendMarkdown(schema?.description ? ` — ${escapeMd(schema.description)}\n` : '\n');
        }
      }
      break;
    }
    case 'prompt': {
      const prompt = session.prompts.find((p) => p.name === key);
      item.iconPath = new vscode.ThemeIcon('comment');
      if (prompt?.title && prompt.title !== key) {
        item.description = prompt.title;
      }
      md.appendMarkdown(`**${escapeMd(key)}**\n\n`);
      if (prompt?.description) {
        md.appendMarkdown(`${prompt.description}\n\n`);
      }
      for (const arg of prompt?.arguments ?? []) {
        md.appendMarkdown(`- ${code(arg.name)}${arg.required ? ' (required)' : ''}${arg.description ? ` — ${escapeMd(arg.description)}` : ''}\n`);
      }
      break;
    }
    case 'resource': {
      const resource = session.resources.find((r) => r.uri === key);
      item.iconPath = new vscode.ThemeIcon('file');
      item.label = resource?.title ?? resource?.name ?? key;
      item.description = resource?.mimeType;
      md.appendMarkdown(`**${escapeMd(String(item.label))}**\n\n`);
      md.appendCodeblock(key, 'text');
      if (resource?.description) {
        md.appendMarkdown(`\n${resource.description}`);
      }
      break;
    }
    case 'template': {
      const template = session.templates.find((t) => t.uriTemplate === key);
      item.iconPath = new vscode.ThemeIcon('file-symlink-file');
      item.label = template?.title ?? template?.name ?? key;
      item.description = key;
      md.appendMarkdown(`**${escapeMd(String(item.label))}**\n\n`);
      md.appendCodeblock(key, 'text');
      if (template?.description) {
        md.appendMarkdown(`\n${template.description}`);
      }
      break;
    }
  }
  item.tooltip = md;
  return item;
}

function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
