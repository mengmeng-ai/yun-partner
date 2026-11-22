// Shared IPC types between main and renderer. No secrets in log lines.
import type { McpServerConfig } from './mcp';

export type ProviderId = 'deepseek' | 'openai' | 'custom' | 'ollama';

export interface Settings {
  provider: ProviderId;
  baseUrl: string;
  model: string;
  apiKey: string; // stored only in local userData settings.json; never logged
  workspace: string; // the ONLY folder tools may touch by default
  temperature: number;
  /** Optional ElevenLabs API key for voice synthesis (voice panel, default off). */
  elevenLabsKey?: string;
  /** Optional ElevenLabs voice ID for full-duplex TTS. Defaults to her approved voice when empty. */
  elevenLabsVoiceId?: string;
  /** Optional Whisper key for full-duplex STT (OpenAI-compatible /audio/transcriptions). */
  whisperKey?: string;
  /** Whisper-compatible base URL. Defaults to https://api.openai.com/v1 when empty. */
  whisperBaseUrl?: string;
  /** Registered MCP servers (on-demand connect only, never auto-connected). */
  mcpServers?: McpServerConfig[];
}

export interface Profile {
  name: string;
  nickname: string;
  callMe: string; // e.g. 允允 / 宝贝
  notes: string;
}

export interface MemoryEntry {
  id: string;
  text: string;
  tags: string[];
  createdAt: string;
}

export interface WikiPage {
  id: string;
  title: string;
  body: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: string;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export const PROVIDER_DEFAULTS: Record<ProviderId, { baseUrl: string; model: string; label: string }> = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', label: 'DeepSeek' },
  openai: { baseUrl: 'https://api.openai.com', model: 'gpt-4o-mini', label: 'OpenAI' },
  custom: { baseUrl: '', model: '', label: '自定义 (OpenAI 兼容)' },
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b', label: 'Ollama 本地' },
};
