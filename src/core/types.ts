export type TransportType = 'stdio' | 'sse' | 'http';

export const TRANSPORT_LABELS: Record<TransportType, string> = {
  stdio: 'STDIO',
  sse: 'SSE',
  http: 'Streamable HTTP',
};

export interface KeyValue {
  key: string;
  value: string;
  enabled: boolean;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  transport: TransportType;
  /** stdio */
  command?: string;
  args?: string[];
  cwd?: string;
  env?: KeyValue[];
  /** sse / http */
  url?: string;
  headers?: KeyValue[];
}

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

export type ItemKind = 'tool' | 'prompt' | 'resource' | 'template';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
