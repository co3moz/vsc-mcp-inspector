import * as vscode from 'vscode';
import type { ConnectionConfig, KeyValue } from './core/types';

const LIST_KEY = 'mcpInspector.connections';
const secretKey = (id: string) => `mcpInspector.connection.${id}`;

/** Header and environment values often hold tokens, so they live in SecretStorage. */
interface SecretPart {
  env?: KeyValue[];
  headers?: KeyValue[];
}

type StoredConnection = Omit<ConnectionConfig, keyof SecretPart>;

export class ConnectionStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async load(): Promise<ConnectionConfig[]> {
    const stored = this.context.globalState.get<StoredConnection[]>(LIST_KEY, []);
    return Promise.all(
      stored.map(async (connection) => {
        let secrets: SecretPart = {};
        try {
          const raw = await this.context.secrets.get(secretKey(connection.id));
          secrets = raw ? (JSON.parse(raw) as SecretPart) : {};
        } catch {
          // Corrupt or inaccessible secret: fall back to an empty header/env list.
        }
        return { ...connection, ...secrets };
      }),
    );
  }

  async upsert(config: ConnectionConfig): Promise<void> {
    const { env, headers, ...rest } = config;
    const stored = this.context.globalState.get<StoredConnection[]>(LIST_KEY, []);
    const index = stored.findIndex((c) => c.id === config.id);
    if (index >= 0) {
      stored[index] = rest;
    } else {
      stored.push(rest);
    }
    await this.context.secrets.store(secretKey(config.id), JSON.stringify({ env, headers } satisfies SecretPart));
    await this.context.globalState.update(LIST_KEY, stored);
  }

  async remove(id: string): Promise<void> {
    const stored = this.context.globalState.get<StoredConnection[]>(LIST_KEY, []);
    await this.context.globalState.update(
      LIST_KEY,
      stored.filter((c) => c.id !== id),
    );
    await this.context.secrets.delete(secretKey(id));
  }
}
