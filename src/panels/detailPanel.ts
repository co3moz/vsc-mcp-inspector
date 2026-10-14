import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import * as vscode from 'vscode';
import type { McpSession } from '../core/session';
import { TRANSPORT_LABELS, type ItemKind } from '../core/types';
import type { ConnectionManager } from '../manager';
import { validateJson } from '../schemaValidation';
import { errorMessage, renderHtml, webviewReady, webviewRoots } from './webview';

type InboundMessage =
  | { type: 'ready'; editorLoaded?: boolean }
  | { type: 'run'; runId: string; args: Record<string, unknown> }
  | { type: 'cancel'; runId: string }
  | { type: 'copy'; text: string }
  | { type: 'openInEditor'; content: string; language: string }
  | { type: 'validate'; requestId: string; schema: Record<string, unknown>; text: string };

const RUN_LABELS: Record<ItemKind, string> = {
  tool: 'Run Tool',
  prompt: 'Get Prompt',
  resource: 'Read Resource',
  template: 'Read Resource',
};

/** Shows an item's details and lets the user invoke it. One panel per connection item. */
export class DetailPanel {
  private static readonly panels = new Map<string, DetailPanel>();
  /** Last arguments used per item, so reopening a panel restores the form. */
  private static readonly lastArgs = new Map<string, Record<string, unknown>>();

  /**
   * Opens (or reveals) the panel for an item. `args` pre-fills the form; `run` invokes the item
   * right away with those arguments, or with the ones used last time.
   */
  static show(
    extensionUri: vscode.Uri,
    manager: ConnectionManager,
    connectionId: string,
    kind: ItemKind,
    key: string,
    options: { args?: Record<string, unknown>; run?: boolean } = {},
  ): void {
    const panelKey = `${connectionId}|${kind}|${key}`;
    if (options.args) {
      DetailPanel.lastArgs.set(panelKey, options.args);
    }
    const open = DetailPanel.panels.get(panelKey);
    if (open) {
      open.panel.reveal();
      if (options.run || options.args) {
        open.post({ type: 'invoke', args: options.args, run: !!options.run });
      }
      return;
    }
    const panel = new DetailPanel(panelKey, extensionUri, manager, connectionId, kind, key);
    panel.runOnInit = !!options.run;
    DetailPanel.panels.set(panelKey, panel);
  }

  static disposeFor(connectionId: string): void {
    for (const panel of [...DetailPanel.panels.values()]) {
      if (panel.connectionId === connectionId) {
        panel.panel.dispose();
      }
    }
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly runs = new Map<string, AbortController>();
  private readonly disposables: vscode.Disposable[] = [];
  private lastDefinition = '';
  private runOnInit = false;

  private constructor(
    private readonly panelKey: string,
    extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    private readonly connectionId: string,
    private readonly kind: ItemKind,
    private readonly key: string,
  ) {
    const session = manager.get(connectionId);
    const title = `${this.displayName(session)} · ${session?.name ?? ''}`;
    this.panel = vscode.window.createWebviewPanel('mcpInspector.detail', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: webviewRoots(extensionUri),
    });
    this.panel.webview.html = renderHtml(this.panel.webview, extensionUri, title, ['dist/webview/jsonEditor.js', 'media/schemaForm.js', 'media/detail.js']);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: InboundMessage) => this.onMessage(msg)),
      manager.onDidChange((id) => {
        if (id === undefined || id === this.connectionId) {
          this.sync();
        }
      }),
    );
    this.panel.onDidDispose(() => {
      DetailPanel.panels.delete(this.panelKey);
      for (const controller of this.runs.values()) {
        controller.abort();
      }
      this.disposables.forEach((d) => d.dispose());
    });
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  private displayName(session: McpSession | undefined): string {
    if (this.kind === 'resource') {
      const resource = session?.resources.find((r) => r.uri === this.key);
      return resource?.name ?? this.key;
    }
    if (this.kind === 'template') {
      return session?.templates.find((t) => t.uriTemplate === this.key)?.name ?? this.key;
    }
    return this.key;
  }

  private definition(session: McpSession | undefined): unknown {
    switch (this.kind) {
      case 'tool':
        return session?.tools.find((t) => t.name === this.key);
      case 'prompt':
        return session?.prompts.find((p) => p.name === this.key);
      case 'resource':
        return session?.resources.find((r) => r.uri === this.key);
      case 'template':
        return session?.templates.find((t) => t.uriTemplate === this.key);
    }
  }

  private connectionState(session: McpSession | undefined) {
    return {
      name: session?.name ?? '(deleted connection)',
      transport: session ? TRANSPORT_LABELS[session.config.transport] : '',
      status: session?.status ?? 'disconnected',
      server: session?.serverInfo ? `${session.serverInfo.name} ${session.serverInfo.version}` : undefined,
    };
  }

  private sendInit(): void {
    const session = this.manager.get(this.connectionId);
    const definition = this.definition(session);
    this.lastDefinition = JSON.stringify(definition ?? null);
    this.post({
      type: 'init',
      kind: this.kind,
      key: this.key,
      runLabel: RUN_LABELS[this.kind],
      definition,
      connection: this.connectionState(session),
      lastArgs: DetailPanel.lastArgs.get(this.panelKey),
      autoRun: this.runOnInit,
    });
    this.runOnInit = false;
  }

  /** Pushes connection status, and the definition when the server changed it. */
  private sync(): void {
    const session = this.manager.get(this.connectionId);
    if (!session) {
      this.post({ type: 'connection', connection: this.connectionState(undefined) });
      return;
    }
    const definition = this.definition(session);
    // While reconnecting the lists are briefly empty; keep showing the last known definition.
    if (definition && JSON.stringify(definition) !== this.lastDefinition) {
      this.lastDefinition = JSON.stringify(definition);
      this.post({ type: 'definition', definition });
    }
    this.post({ type: 'connection', connection: this.connectionState(session) });
  }

  private async onMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.sendInit();
        if (!msg.editorLoaded) {
          this.manager.log.error('The JSON editor failed to load in the detail panel (dist/webview/jsonEditor.js).');
        }
        webviewReady.fire({ title: this.panel.title, editorLoaded: msg.editorLoaded });
        return;
      case 'cancel':
        this.runs.get(msg.runId)?.abort();
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(msg.text);
        void vscode.window.setStatusBarMessage('$(check) Copied to clipboard', 2000);
        return;
      case 'openInEditor': {
        const doc = await vscode.workspace.openTextDocument({ content: msg.content, language: msg.language || 'plaintext' });
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
        return;
      }
      case 'run':
        return this.run(msg.runId, msg.args ?? {});
      case 'validate':
        this.post({ type: 'validation', requestId: msg.requestId, issues: validateJson(msg.schema, msg.text) });
        return;
    }
  }

  private async run(runId: string, args: Record<string, unknown>): Promise<void> {
    DetailPanel.lastArgs.set(this.panelKey, args);
    const controller = new AbortController();
    this.runs.set(runId, controller);
    const started = Date.now();
    const options = {
      signal: controller.signal,
      onprogress: (progress: { progress: number; total?: number; message?: string }) =>
        this.post({ type: 'progress', runId, ...progress }),
    };
    let uri: string | undefined;
    try {
      const session = this.manager.get(this.connectionId);
      if (!session) {
        throw new Error('This connection no longer exists.');
      }
      let result: unknown;
      switch (this.kind) {
        case 'tool':
          result = await session.callTool(this.key, args, options);
          break;
        case 'prompt':
          result = await session.getPrompt(this.key, stringValues(args), options);
          break;
        case 'resource':
          uri = this.key;
          result = await session.readResource(uri, options);
          break;
        case 'template':
          uri = new UriTemplate(this.key).expand(stringValues(args));
          result = await session.readResource(uri, options);
          break;
      }
      this.post({ type: 'result', runId, ok: true, durationMs: Date.now() - started, result, uri });
    } catch (err) {
      this.post({
        type: 'result',
        runId,
        ok: false,
        durationMs: Date.now() - started,
        error: controller.signal.aborted ? 'Request cancelled.' : errorMessage(err),
        uri,
      });
    } finally {
      this.runs.delete(runId);
    }
  }
}

function stringValues(args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && value !== null) {
      out[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
  }
  return out;
}
