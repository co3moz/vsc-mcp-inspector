import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { McpSession, type SessionHost } from './core/session';
import type { ConnectionConfig } from './core/types';
import type { ConnectionStore } from './store';

export interface ServerSummary {
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  capabilities: string[];
  counts: { tools: number; prompts: number; resources: number; templates: number };
  instructions?: string;
}

export class ConnectionManager implements vscode.Disposable {
  private readonly sessions = new Map<string, McpSession>();
  private readonly changeEmitter = new vscode.EventEmitter<string | undefined>();
  /** Fires with the id of the connection that changed, or undefined for structural changes. */
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly store: ConnectionStore,
    readonly log: vscode.LogOutputChannel,
  ) {}

  async init(): Promise<void> {
    for (const config of await this.store.load()) {
      this.sessions.set(config.id, this.createSession(config));
    }
    this.changeEmitter.fire(undefined);
  }

  list(): McpSession[] {
    return [...this.sessions.values()];
  }

  get(id: string): McpSession | undefined {
    return this.sessions.get(id);
  }

  isNameTaken(name: string, exceptId?: string): boolean {
    const normalized = name.trim().toLowerCase();
    return this.list().some((s) => s.config.id !== exceptId && s.name.trim().toLowerCase() === normalized);
  }

  /** Connects with a throwaway session and reports what the server offers. */
  async test(config: ConnectionConfig): Promise<ServerSummary> {
    const session = new McpSession(config, this.host(() => undefined));
    try {
      await session.connect();
      return summarize(session);
    } finally {
      await session.disconnect();
    }
  }

  /**
   * Adds a connection. When `connect` is true the connection is only saved if the server
   * accepts it, so a failed attempt never shows up in the tree.
   */
  async add(config: ConnectionConfig, connect: boolean): Promise<McpSession> {
    const session = this.createSession(config);
    if (connect) {
      try {
        await session.connect();
      } catch (err) {
        await session.disconnect();
        throw err;
      }
    }
    await this.store.upsert(config);
    this.sessions.set(config.id, session);
    this.changeEmitter.fire(undefined);
    return session;
  }

  async update(config: ConnectionConfig, connect: boolean): Promise<McpSession> {
    const previous = this.sessions.get(config.id);
    const session = this.createSession(config);
    if (connect) {
      try {
        await session.connect();
      } catch (err) {
        await session.disconnect();
        throw err;
      }
    }
    await previous?.disconnect();
    await this.store.upsert(config);
    this.sessions.set(config.id, session);
    this.changeEmitter.fire(undefined);
    return session;
  }

  async remove(id: string): Promise<void> {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    await session?.disconnect();
    await this.store.remove(id);
    this.changeEmitter.fire(undefined);
  }

  summary(id: string): ServerSummary | undefined {
    const session = this.sessions.get(id);
    return session ? summarize(session) : undefined;
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      void session.disconnect();
    }
    this.changeEmitter.dispose();
  }

  private createSession(config: ConnectionConfig): McpSession {
    return new McpSession(
      config,
      this.host(() => {
        // Only report changes for sessions that are (still) part of the tree.
        if (this.sessions.get(config.id)?.config === config) {
          this.changeEmitter.fire(config.id);
        }
      }),
    );
  }

  private host(onDidChange: () => void): SessionHost {
    const settings = () => vscode.workspace.getConfiguration('mcpInspector');
    return {
      log: this.log,
      onDidChange,
      requestTimeoutMs: () => Math.max(1, settings().get<number>('requestTimeout', 60)) * 1000,
      logTraffic: () => settings().get<boolean>('logTraffic', true),
      resolve: resolveVariables,
    };
  }
}

export function resolveVariables(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
    if (name.startsWith('env:')) {
      return process.env[name.slice(4)] ?? '';
    }
    switch (name) {
      case 'workspaceFolder':
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? match;
      case 'userHome':
        return os.homedir();
      case 'pathSeparator':
        return path.sep;
      default:
        return match;
    }
  });
}

function summarize(session: McpSession): ServerSummary {
  const caps = session.capabilities ?? {};
  return {
    serverName: session.serverInfo?.name,
    serverVersion: session.serverInfo?.version,
    protocolVersion: session.protocolVersion,
    capabilities: Object.keys(caps).filter((key) => caps[key as keyof typeof caps] !== undefined),
    counts: {
      tools: session.tools.length,
      prompts: session.prompts.length,
      resources: session.resources.length,
      templates: session.templates.length,
    },
    instructions: session.instructions,
  };
}
