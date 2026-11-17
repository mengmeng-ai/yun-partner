// MCP on-demand client — Phase 3, clean-room implementation.
// Minimal JSON-RPC 2.0 WITHOUT the MCP SDK: stdio via child_process spawn,
// Streamable HTTP via fetch POST (Accept: application/json, text/event-stream,
// parsing SSE `data:` lines).
// On-demand semantics: NOTHING connects at import or at startup. Each call
// connects, does one operation (list / call), then closes. A long-lived
// session is only held while an McpClient instance is explicitly open.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

export const MCP_TIMEOUT_MS = 10_000;

export interface McpServerConfig {
  name: string;
  transport: 'stdio' | 'http';
  /** stdio: executable, e.g. 'npx' / 'python'. Required for stdio. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http: Streamable HTTP endpoint URL. Required for http. */
  url?: string;
  headers?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolResult {
  content: unknown;
  isError?: boolean;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id?: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

function timeoutError(what: string): Error {
  return new Error(`MCP 超时（${MCP_TIMEOUT_MS / 1000}s）：${what}`);
}

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError(what)), MCP_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ---------------------------------------------------------------------------
// stdio transport: one JSON-RPC message per line on stdin/stdout
// ---------------------------------------------------------------------------
class StdioTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buf = '';
  private pending = new Map<number, { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }>();

  constructor(private config: McpServerConfig) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.config.command) {
        reject(new Error('stdio 方式需要 command'));
        return;
      }
      const child = spawn(this.config.command, this.config.args ?? [], {
        env: { ...process.env, ...(this.config.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.child = child;
      let started = false;
      child.on('error', (err) => {
        if (!started) reject(err);
        this.failAll(err);
      });
      child.on('exit', (code) => {
        if (!started) reject(new Error(`MCP 服务进程退出，code=${code}`));
        this.failAll(new Error(`MCP 服务进程退出，code=${code}`));
      });
      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => this.onData(chunk));
      // stderr is the server's log channel; drain it so the pipe never blocks.
      child.stderr.on('data', () => undefined);
      started = true;
      resolve();
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(t) as JsonRpcResponse;
      } catch {
        continue; // not JSON-RPC — ignore stray server log lines on stdout
      }
      if (typeof msg.id === 'number') {
        const slot = this.pending.get(msg.id);
        if (slot) {
          this.pending.delete(msg.id);
          slot.resolve(msg);
        }
      }
      // Notifications / responses without id are ignored.
    }
  }

  private failAll(err: Error): void {
    for (const slot of this.pending.values()) slot.reject(err);
    this.pending.clear();
  }

  request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    if (!this.child) return Promise.reject(new Error('MCP stdio 未连接'));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });
    return withTimeout(
      new Promise<JsonRpcResponse>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.child?.stdin.write(payload + '\n', (err) => {
          if (err) {
            this.pending.delete(id);
            reject(err);
          }
        });
      }),
      `stdio ${method}`,
    );
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }) + '\n');
  }

  close(): void {
    if (this.child) {
      try {
        this.child.stdin.end();
        this.child.kill();
      } catch {
        // already gone
      }
      this.child = null;
    }
    this.failAll(new Error('MCP 连接已关闭'));
  }
}

// ---------------------------------------------------------------------------
// Streamable HTTP transport: POST JSON-RPC, parse SSE `data:` lines or a
// plain JSON body. Captures Mcp-Session-Id and replays it on later calls
// within the same client session.
// ---------------------------------------------------------------------------
class HttpTransport {
  private sessionId: string | null = null;

  constructor(private config: McpServerConfig) {}

  async request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const url = this.config.url;
    if (!url) throw new Error('http 方式需要 url');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.config.headers ?? {}),
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? {} }),
        signal: controller.signal,
      });
    } catch (e) {
      throw new Error(`连不上 MCP 服务 ${url}：${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    const session = res.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP 服务报错 HTTP ${res.status}：${text.slice(0, 300)}`);
    // SSE: one JSON object per `data:` line; take the last response-shaped one.
    const dataLines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter((l) => l && l !== '[DONE]');
    const candidates = dataLines.length > 0 ? dataLines : [text.trim()];
    for (let i = candidates.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(candidates[i]) as JsonRpcResponse;
        if (parsed && typeof parsed === 'object' && ('result' in parsed || 'error' in parsed)) return parsed;
      } catch {
        // not JSON — keep looking
      }
    }
    throw new Error('MCP 服务返回了无法解析的响应');
  }

  close(): void {
    this.sessionId = null;
  }
}

// ---------------------------------------------------------------------------
// Client — on-demand: connect(), list/call, disconnect(). No auto-connect.
// ---------------------------------------------------------------------------
export class McpClient {
  private stdio: StdioTransport | null = null;
  private http: HttpTransport | null = null;
  private connected = false;

  constructor(private config: McpServerConfig) {}

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.config.transport === 'stdio') {
      this.stdio = new StdioTransport(this.config);
      await this.stdio.start();
      const init = await this.stdio.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'yun-partner', version: '0.1.0' },
      });
      if (init.error) throw new Error(`MCP 初始化失败：${init.error.message}`);
      this.stdio.notify('notifications/initialized');
    } else {
      this.http = new HttpTransport(this.config);
      const init = await this.http.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'yun-partner', version: '0.1.0' },
      });
      if (init.error) throw new Error(`MCP 初始化失败：${init.error.message}`);
      // Streamable HTTP servers accept the initialized notification as a
      // plain POST; a failure here must not break the session.
      try {
        await this.http.request('notifications/initialized');
      } catch {
        // best-effort only
      }
    }
    this.connected = true;
  }

  private async rpc(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.connected) throw new Error('MCP 未连接：先调用 connect()');
    const res = this.stdio
      ? await this.stdio.request(method, params)
      : await this.http!.request(method, params);
    if (res.error) throw new Error(`MCP ${method} 失败：${res.error.message}`);
    return (res.result ?? {}) as Record<string, unknown>;
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.rpc('tools/list');
    const tools = (result.tools ?? []) as { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
    return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    const result = await this.rpc('tools/call', { name, arguments: args });
    return { content: result.content ?? result, isError: result.isError as boolean | undefined };
  }

  disconnect(): void {
    this.stdio?.close();
    this.stdio = null;
    this.http?.close();
    this.http = null;
    this.connected = false;
  }
}

/** On-demand: connect, list tools, close. No persistent connection. */
export async function listMcpTools(config: McpServerConfig): Promise<McpTool[]> {
  const client = new McpClient(config);
  try {
    await client.connect();
    return await client.listTools();
  } finally {
    client.disconnect();
  }
}

/** On-demand: connect, call one tool, close. No persistent connection. */
export async function callMcpTool(
  config: McpServerConfig,
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpToolResult> {
  const client = new McpClient(config);
  try {
    await client.connect();
    return await client.callTool(name, args);
  } finally {
    client.disconnect();
  }
}

/** Explicit on-demand session: connect, use, disconnect. */
export async function connectOnDemand(config: McpServerConfig): Promise<McpClient> {
  const client = new McpClient(config);
  await client.connect();
  return client;
}

export function disconnect(client: McpClient): void {
  client.disconnect();
}
