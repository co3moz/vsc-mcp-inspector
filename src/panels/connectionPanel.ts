import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import type { ConnectionConfig, KeyValue, TransportType } from '../core/types';
import type { ConnectionManager } from '../manager';
import { errorMessage, renderHtml, webviewReady, webviewRoots } from './webview';

type InboundMessage =
  | { type: 'ready' }
  | { type: 'test'; config: ConnectionConfig }
  | { type: 'save'; config: ConnectionConfig; connect: boolean }
  | { type: 'pickCwd'; current?: string }
  | { type: 'cancel' };

/** Webview form for creating or editing a connection. */
export class ConnectionPanel {
  private static readonly panels = new Map<string, ConnectionPanel>();

  static show(extensionUri: vscode.Uri, manager: ConnectionManager, existing?: ConnectionConfig): void {
    const key = existing ? `edit:${existing.id}` : 'create';
    const open = ConnectionPanel.panels.get(key);
    if (open) {
      open.panel.reveal();
      return;
    }
    ConnectionPanel.panels.set(key, new ConnectionPanel(key, extensionUri, manager, existing));
  }

  static disposeFor(connectionId: string): void {
    ConnectionPanel.panels.get(`edit:${connectionId}`)?.panel.dispose();
  }

  private readonly panel: vscode.WebviewPanel;
  private busy = false;

  private constructor(
    private readonly key: string,
    extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    private readonly existing?: ConnectionConfig,
  ) {
    const title = existing ? `Edit: ${existing.name}` : 'New MCP Connection';
    this.panel = vscode.window.createWebviewPanel('mcpInspector.connection', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: webviewRoots(extensionUri),
    });
    this.panel.webview.html = renderHtml(this.panel.webview, extensionUri, title, ['media/connection.js']);
    this.panel.webview.onDidReceiveMessage((msg: InboundMessage) => this.onMessage(msg));
    this.panel.onDidDispose(() => ConnectionPanel.panels.delete(this.key));
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.post({ type: 'init', mode: this.existing ? 'edit' : 'create', config: this.existing });
        webviewReady.fire({ title: this.panel.title });
        return;
      case 'cancel':
        this.panel.dispose();
        return;
      case 'pickCwd': {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          defaultUri: msg.current ? vscode.Uri.file(msg.current) : vscode.workspace.workspaceFolders?.[0]?.uri,
          openLabel: 'Use as Working Directory',
        });
        if (picked?.[0]) {
          this.post({ type: 'cwd', path: picked[0].fsPath });
        }
        return;
      }
      case 'test':
        return this.runExclusive(async () => {
          const config = this.normalize(msg.config);
          const summary = await this.manager.test(config);
          this.post({ type: 'testResult', ok: true, summary });
        }, (error) => this.post({ type: 'testResult', ok: false, error }));
      case 'save':
        return this.runExclusive(async () => {
          const config = this.normalize(msg.config);
          const session = this.existing ? await this.manager.update(config, msg.connect) : await this.manager.add(config, msg.connect);
          if (msg.connect) {
            const info = session.serverInfo;
            void vscode.window.showInformationMessage(
              `Connected to "${config.name}"${info ? ` (${info.name} ${info.version})` : ''} — ${session.tools.length} tool(s) available.`,
            );
          }
          this.panel.dispose();
        }, (error) => this.post({ type: 'saveResult', ok: false, error }));
    }
  }

  private async runExclusive(work: () => Promise<void>, onError: (error: string) => void): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;
    try {
      await work();
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      this.busy = false;
    }
  }

  /** Validates the form payload and returns a clean config. Throws with a user facing message. */
  private normalize(raw: ConnectionConfig): ConnectionConfig {
    const name = (raw.name ?? '').trim();
    if (!name) {
      throw new Error('Please enter a connection name.');
    }
    if (this.manager.isNameTaken(name, this.existing?.id)) {
      throw new Error(`A connection named "${name}" already exists.`);
    }
    const transport: TransportType = raw.transport === 'sse' || raw.transport === 'http' ? raw.transport : 'stdio';
    const id = this.existing?.id ?? randomUUID();

    if (transport === 'stdio') {
      // A quoted executable path ("C:\Program Files\...\node.exe") is passed to spawn unquoted.
      const command = (raw.command ?? '').trim().replace(/^(["'])(.*)\1$/, '$2');
      if (!command) {
        throw new Error('Please enter the command that starts the server (e.g. npx, node, python, uvx).');
      }
      return {
        id,
        name,
        transport,
        command,
        args: (raw.args ?? []).filter((a) => typeof a === 'string'),
        cwd: raw.cwd?.trim() || undefined,
        env: cleanPairs(raw.env),
      };
    }

    const url = (raw.url ?? '').trim();
    if (!url) {
      throw new Error('Please enter the server URL.');
    }
    if (!url.includes('${')) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`"${url}" is not a valid URL.`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('The URL must start with http:// or https://');
      }
    }
    for (const header of cleanPairs(raw.headers)) {
      if (header.enabled && !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header.key)) {
        throw new Error(`"${header.key}" is not a valid HTTP header name.`);
      }
    }
    return { id, name, transport, url, headers: cleanPairs(raw.headers) };
  }
}

function cleanPairs(pairs: KeyValue[] | undefined): KeyValue[] {
  return (pairs ?? [])
    .map((p) => ({ key: String(p.key ?? '').trim(), value: String(p.value ?? ''), enabled: p.enabled !== false }))
    .filter((p) => p.key);
}
