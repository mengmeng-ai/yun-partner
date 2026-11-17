import type { ChatMessage, Settings } from './types';
import { redact } from './store';
import { TOOL2_DEFS, TOOL2_META } from './tools2';

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export const TOOL_DEFS: ToolDef[] = [
  { type: 'function', function: { name: 'file_list', description: '列出工作区内某文件夹的文件（仅工作区内）', parameters: { type: 'object', properties: { relPath: { type: 'string' } } } } },
  { type: 'function', function: { name: 'file_read', description: '按相对路径读工作区内的文本文件', parameters: { type: 'object', properties: { relPath: { type: 'string' } }, required: ['relPath'] } } },
  { type: 'function', function: { name: 'file_write', description: '在工作区内新建或覆盖写一个文本文件（需用户确认）', parameters: { type: 'object', properties: { relPath: { type: 'string' }, content: { type: 'string' } }, required: ['relPath', 'content'] } } },
  { type: 'function', function: { name: 'file_edit', description: '把文件里的 oldText 精确替换成 newText（需用户确认）', parameters: { type: 'object', properties: { relPath: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['relPath', 'oldText', 'newText'] } } },
  { type: 'function', function: { name: 'run_command', description: '在工作区目录执行一条命令（需用户确认；Windows 用 PowerShell）', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'run_python', description: '在工作区执行一段 Python 代码（需用户确认）', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } } },
  { type: 'function', function: { name: 'save_memory', description: '把用户说的重要事实存进长期记忆', parameters: { type: 'object', properties: { text: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['text'] } } },
  { type: 'function', function: { name: 'save_wiki', description: '把一件事整理成 Wiki 笔记页', parameters: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } }, required: ['title', 'body'] } } },
];

/** Tools that mutate state and always need an explicit user confirmation in the UI. */
export const DESTRUCTIVE_TOOLS = new Set([
  'file_write', 'file_edit', 'run_command', 'run_python',
  ...Object.entries(TOOL2_META).filter(([, m]) => m.needsApproval).map(([n]) => n),
]);

/** All 33 tools (8 core + 25 Phase-1) offered to the model. */
export const ALL_TOOL_DEFS: ToolDef[] = [...TOOL_DEFS, ...TOOL2_DEFS];

export interface StreamEvent {
  type: 'delta' | 'tool_calls' | 'done' | 'error';
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  error?: string;
}

const base = (s: Settings) => s.baseUrl.replace(/\/$/, '');

export async function listModels(s: Settings): Promise<string[]> {
  if (!s.apiKey && s.provider !== 'ollama') throw new Error('先在设置里填 API Key');
  const url = s.provider === 'ollama' ? `${base(s)}/api/tags` : `${base(s)}/models`;
  const headers: Record<string, string> = {};
  if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`获取模型列表失败：HTTP ${res.status}`);
  const data = await res.json() as { data?: { id: string }[]; models?: { name: string }[] };
  if (data.models) return data.models.map((m) => m.name);
  return (data.data ?? []).map((m) => m.id);
}

/** Streaming chat-completion call. Calls onEvent for each chunk; returns the full text + tool calls. */
export async function chatStream(
  s: Settings,
  messages: ChatMessage[],
  opts: { signal: AbortSignal; onEvent: (e: StreamEvent) => void; useTools: boolean; toolNames?: string[] },
): Promise<{ text: string; toolCalls: { name: string; args: Record<string, unknown> }[] }> {
  const url = s.provider === 'ollama' ? `${base(s)}/api/chat` : `${base(s)}/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
  const offeredTools = opts.toolNames
    ? ALL_TOOL_DEFS.filter((t) => opts.toolNames!.includes(t.function.name))
    : ALL_TOOL_DEFS;

  const body: Record<string, unknown> = s.provider === 'ollama'
    ? { model: s.model, messages: messages.map((m) => ({ role: m.role, content: m.content })), stream: true, options: { temperature: s.temperature } }
    : {
        model: s.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: s.temperature,
        stream: true,
        ...(opts.useTools ? { tools: offeredTools, tool_choice: 'auto' } : {}),
      };

  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal });
  } catch (e) {
    throw new Error(`连不上模型服务（${redact(s.baseUrl)}）：${(e as Error).message}`);
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`模型服务报错 HTTP ${res.status}：${redact(text.slice(0, 300))}`);
  }

  let full = '';
  const toolCallParts: Record<number, { name: string; args: string }> = {};
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json: Record<string, unknown>;
        try { json = JSON.parse(payload) as Record<string, unknown>; } catch { continue; }
        if (s.provider === 'ollama') {
          const msg = (json.message ?? {}) as { content?: string };
          if (msg.content) { full += msg.content; opts.onEvent({ type: 'delta', text: msg.content }); }
          continue;
        }
        const choice = ((json.choices ?? []) as Record<string, unknown>[])[0];
        const delta = (choice?.delta ?? {}) as { content?: string; tool_calls?: { index: number; function?: { name?: string; arguments?: string } }[] };
        if (delta.content) { full += delta.content; opts.onEvent({ type: 'delta', text: delta.content }); }
        for (const tc of delta.tool_calls ?? []) {
          const slot = (toolCallParts[tc.index] ??= { name: '', args: '' });
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  const toolCalls = Object.values(toolCallParts)
    .filter((t) => t.name)
    .map((t) => ({ name: t.name, args: (() => { try { return JSON.parse(t.args || '{}') as Record<string, unknown>; } catch { return {}; } })() }));
  opts.onEvent({ type: 'tool_calls', toolCalls });
  return { text: full, toolCalls };
}
