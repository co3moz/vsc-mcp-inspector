import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolResultSchema,
  LoggingMessageNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type CallToolResult,
  type GetPromptResult,
  type Implementation,
  type JSONRPCMessage,
  type MessageExtraInfo,
  type Progress,
  type Prompt,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  type ServerCapabilities,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { ConnectionConfig, ConnectionStatus, KeyValue, Logger } from './types';

export const CLIENT_INFO: Implementation = { name: 'vscode-mcp-inspector', version: '0.1.0' };

export type ListKind = 'tools' | 'prompts' | 'resources' | 'templates';

export interface SessionHost {
  log: Logger;
  /** Called whenever status, server info or any list changes. */
  onDidChange(): void;
  requestTimeoutMs(): number;
  logTraffic(): boolean;
  /** Expands ${env:X}, ${workspaceFolder}, ... in user supplied strings. */
  resolve(value: string): string;
}

export interface OperationOptions {
  signal?: AbortSignal;
  onprogress?: (progress: Progress) => void;
}

const STDERR_TAIL_LINES = 30;
const MAX_PAGES = 100;

export class McpSession {
  status: ConnectionStatus = 'idle';
  error?: string;

  serverInfo?: Implementation;
  capabilities?: ServerCapabilities;
  instructions?: string;
  protocolVersion?: string;

  tools: Tool[] = [];
  prompts: Prompt[] = [];
  resources: Resource[] = [];
  templates: ResourceTemplate[] = [];
  listErrors: Partial<Record<ListKind, string>> = {};

  private client?: Client;
  private transport?: Transport;
  private connectPromise?: Promise<void>;
  private closing = false;
  private stderrTail: string[] = [];

  constructor(public config: ConnectionConfig, private readonly host: SessionHost) {}

  get name(): string {
    return this.config.name;
  }

  connect(): Promise<void> {
    if (this.status === 'connected' && this.client) {
      return Promise.resolve();
    }
    this.connectPromise ??= this.doConnect().finally(() => (this.connectPromise = undefined));
    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.closing = true;
    if (client) {
      if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
        await transport.terminateSession().catch(() => undefined);
      }
      await client.close().catch(() => undefined);
    }
    this.client = undefined;
    this.transport = undefined;
    if (this.status !== 'idle') {
      this.setStatus('disconnected');
    }
  }

  async refresh(): Promise<void> {
    if (!this.client) {
      return this.connect();
    }
    await this.loadLists(this.client);
    this.host.onDidChange();
  }

  async callTool(name: string, args: Record<string, unknown>, opts: OperationOptions = {}): Promise<CallToolResult> {
    const client = await this.ensureClient();
    // Use the raw request instead of client.callTool() so the inspector shows exactly what the
    // server returned, even when it does not match the tool's declared output schema.
    return client.request({ method: 'tools/call', params: { name, arguments: args } }, CallToolResultSchema, this.requestOptions(opts));
  }

  async getPrompt(name: string, args: Record<string, string>, opts: OperationOptions = {}): Promise<GetPromptResult> {
    const client = await this.ensureClient();
    return client.getPrompt({ name, arguments: args }, this.requestOptions(opts));
  }

  async readResource(uri: string, opts: OperationOptions = {}): Promise<ReadResourceResult> {
    const client = await this.ensureClient();
    return client.readResource({ uri }, this.requestOptions(opts));
  }

  private async ensureClient(): Promise<Client> {
    await this.connect();
    if (!this.client) {
      throw new Error(`"${this.name}" is not connected.`);
    }
    return this.client;
  }

  private requestOptions(opts: OperationOptions) {
    return {
      signal: opts.signal,
      onprogress: opts.onprogress,
      timeout: this.host.requestTimeoutMs(),
      resetTimeoutOnProgress: true,
    };
  }

  private async doConnect(): Promise<void> {
    this.closing = false;
    this.error = undefined;
    this.stderrTail = [];
    this.setStatus('connecting');
    this.host.log.info(`[${this.name}] Connecting via ${this.config.transport}...`);

    let client: Client | undefined;
    try {
      const transport = this.createTransport();
      client = new Client(CLIENT_INFO, { capabilities: {} });
      this.client = client;
      this.transport = transport;
      client.onerror = (err) => this.host.log.warn(`[${this.name}] ${err.message}`);
      client.onclose = () => this.handleClose(client!);
      this.registerNotificationHandlers(client);

      await client.connect(new ObservedTransport(transport, this), { timeout: this.host.requestTimeoutMs() });

      this.serverInfo = client.getServerVersion();
      this.capabilities = client.getServerCapabilities();
      this.instructions = client.getInstructions();
      await this.loadLists(client);

      this.host.log.info(
        `[${this.name}] Connected to ${this.serverInfo?.name ?? 'server'} ${this.serverInfo?.version ?? ''} (protocol ${this.protocolVersion ?? 'unknown'})`,
      );
      this.setStatus('connected');
    } catch (err) {
      const cancelled = this.closing;
      this.client = undefined;
      this.transport = undefined;
      this.closing = true;
      await client?.close().catch(() => undefined);
      if (cancelled) {
        this.setStatus('disconnected');
        throw new Error('Connection cancelled.');
      }
      this.error = this.describeError(err);
      this.host.log.error(`[${this.name}] Connection failed: ${this.error}`);
      this.setStatus('error');
      throw new Error(this.error);
    }
  }

  private handleClose(client: Client): void {
    if (client !== this.client) {
      return;
    }
    this.client = undefined;
    this.transport = undefined;
    if (this.closing) {
      this.setStatus('disconnected');
      return;
    }
    this.error = this.describeError(new Error('Connection closed by server.'));
    this.host.log.warn(`[${this.name}] ${this.error}`);
    this.setStatus('error');
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.host.onDidChange();
  }

  private createTransport(): Transport {
    const { config, host } = this;
    if (config.transport === 'stdio') {
      const command = host.resolve(config.command?.trim() ?? '');
      if (!command) {
        throw new Error('A command is required for stdio connections.');
      }
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          env[key] = value;
        }
      }
      Object.assign(env, toRecord(config.env, host.resolve));
      const transport = new StdioClientTransport({
        command,
        args: (config.args ?? []).map(host.resolve),
        cwd: config.cwd?.trim() ? host.resolve(config.cwd.trim()) : undefined,
        env,
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk: Buffer) => this.onStderr(chunk.toString()));
      return transport;
    }

    const rawUrl = host.resolve(config.url?.trim() ?? '');
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error(`Invalid URL: "${rawUrl}"`);
    }
    const requestInit: RequestInit = { headers: toRecord(config.headers, host.resolve) };
    return config.transport === 'sse'
      ? new SSEClientTransport(url, { requestInit })
      : new StreamableHTTPClientTransport(url, { requestInit });
  }

  private onStderr(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      this.host.log.info(`[${this.name}] stderr: ${line}`);
      this.stderrTail.push(line);
    }
    if (this.stderrTail.length > STDERR_TAIL_LINES) {
      this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LINES);
    }
  }

  private describeError(err: unknown): string {
    let message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: unknown })?.code;
    if (typeof code === 'number' && !message.includes(String(code))) {
      message = `${message} (code ${code})`;
    }
    // fetch() reports most network failures as a bare "fetch failed" / "terminated" and keeps
    // the actual reason (ECONNREFUSED, HTTP parser errors, ...) in `cause`.
    let cause = (err as { cause?: unknown })?.cause;
    for (let depth = 0; cause instanceof Error && depth < 3; depth++) {
      if (cause.message && !message.includes(cause.message)) {
        message += `: ${cause.message}`;
      }
      cause = (cause as { cause?: unknown }).cause;
    }
    if (/does not match the HTTP\/1\.1 protocol/i.test(message)) {
      message +=
        '\n\nThe server sent a malformed HTTP response. A common cause is a "Transfer-Encoding: chunked" header on a body that is not actually chunked.';
    }
    if (this.config.transport === 'stdio' && this.stderrTail.length) {
      message += `\n\nServer stderr:\n${this.stderrTail.join('\n')}`;
    }
    return message;
  }

  private registerNotificationHandlers(client: Client): void {
    const reload = (kinds: ListKind[]) => async () => {
      try {
        await Promise.all(kinds.map((kind) => this.loadList(client, kind)));
        this.host.onDidChange();
      } catch (err) {
        this.host.log.warn(`[${this.name}] Failed to reload ${kinds.join(', ')}: ${(err as Error).message}`);
      }
    };
    client.setNotificationHandler(ToolListChangedNotificationSchema, reload(['tools']));
    client.setNotificationHandler(PromptListChangedNotificationSchema, reload(['prompts']));
    client.setNotificationHandler(ResourceListChangedNotificationSchema, reload(['resources', 'templates']));
    client.setNotificationHandler(LoggingMessageNotificationSchema, async (notification) => {
      const { level, logger, data } = notification.params;
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      this.host.log.info(`[${this.name}] server log (${level}${logger ? `, ${logger}` : ''}): ${text}`);
    });
  }

  private async loadLists(client: Client): Promise<void> {
    await Promise.all((['tools', 'prompts', 'resources', 'templates'] as ListKind[]).map((kind) => this.loadList(client, kind)));
  }

  private async loadList(client: Client, kind: ListKind): Promise<void> {
    const caps = client.getServerCapabilities() ?? {};
    const supported = kind === 'tools' ? caps.tools : kind === 'prompts' ? caps.prompts : caps.resources;
    delete this.listErrors[kind];
    if (!supported) {
      this[kind] = [];
      return;
    }
    const opts = { timeout: this.host.requestTimeoutMs() };
    try {
      switch (kind) {
        case 'tools':
          this.tools = await paginate(async (cursor) => {
            const r = await client.listTools({ cursor }, opts);
            return [r.tools, r.nextCursor];
          });
          break;
        case 'prompts':
          this.prompts = await paginate(async (cursor) => {
            const r = await client.listPrompts({ cursor }, opts);
            return [r.prompts, r.nextCursor];
          });
          break;
        case 'resources':
          this.resources = await paginate(async (cursor) => {
            const r = await client.listResources({ cursor }, opts);
            return [r.resources, r.nextCursor];
          });
          break;
        case 'templates':
          this.templates = await paginate(async (cursor) => {
            const r = await client.listResourceTemplates({ cursor }, opts);
            return [r.resourceTemplates, r.nextCursor];
          });
          break;
      }
    } catch (err) {
      this[kind] = [];
      this.listErrors[kind] = (err as Error).message;
      this.host.log.warn(`[${this.name}] Failed to list ${kind}: ${(err as Error).message}`);
    }
  }

  /** Called by ObservedTransport. */
  traffic(direction: '→' | '←', message: JSONRPCMessage): void {
    if (!this.host.logTraffic()) {
      return;
    }
    let text = JSON.stringify(message);
    if (text.length > 4000) {
      text = `${text.slice(0, 4000)}… (${text.length} chars)`;
    }
    this.host.log.info(`[${this.name}] ${direction} ${text}`);
  }
}

/** Wraps a transport to log the JSON-RPC traffic and capture the negotiated protocol version. */
class ObservedTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

  constructor(private readonly inner: Transport, private readonly session: McpSession) {
    inner.onclose = () => this.onclose?.();
    inner.onerror = (error) => this.onerror?.(error);
    inner.onmessage = (message, extra) => {
      session.traffic('←', message);
      this.onmessage?.(message, extra);
    };
  }

  get sessionId(): string | undefined {
    return this.inner.sessionId;
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    this.session.traffic('→', message);
    return this.inner.send(message, options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  setProtocolVersion = (version: string): void => {
    this.session.protocolVersion = version;
    this.inner.setProtocolVersion?.(version);
  };
}

async function paginate<T>(fetchPage: (cursor?: string) => Promise<[T[], string | undefined]>): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const [pageItems, next] = await fetchPage(cursor);
    items.push(...pageItems);
    if (!next) {
      break;
    }
    cursor = next;
  }
  return items;
}

function toRecord(entries: KeyValue[] | undefined, resolve: (value: string) => string): Record<string, string> {
  const record: Record<string, string> = {};
  for (const entry of entries ?? []) {
    const key = entry.key.trim();
    if (entry.enabled && key) {
      record[key] = resolve(entry.value);
    }
  }
  return record;
}
