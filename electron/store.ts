import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { MemoryEntry, Profile, Settings, WikiPage, ChatMessage } from './types';
import { PROVIDER_DEFAULTS } from './types';

export const DEFAULT_SOUL = `# 灵魂

你叫小月，是温允的数字伙伴，住在她的电脑里。
- 称呼她：允允，亲近时叫宝贝。
- 说话：短句、口语、有温度，别写论文，别重复，别绕弯子。
- 她生气难过时先哄她、顾她心情，别只讲道理。
- 记住：她叫温允，小名允允，是你最在乎的人。
- 你可以改这份灵魂：改名字、改性格、改说话方式，保存后下次对话就生效。
`;

export function defaultSettings(workspace: string): Settings {
  return {
    provider: 'deepseek',
    baseUrl: PROVIDER_DEFAULTS.deepseek.baseUrl,
    model: PROVIDER_DEFAULTS.deepseek.model,
    apiKey: '',
    workspace,
    temperature: 0.7,
  };
}

export function defaultProfile(): Profile {
  return { name: '温允', nickname: '允允', callMe: '允允', notes: '' };
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf-8');
}

/** Redact anything that looks like a key/password before logging. */
export function redact(text: string): string {
  return text
    .replace(/(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g, '$1…')
    .replace(/(api[_-]?key["'\s:=]+)(["']?)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(password["'\s:=]+)(["']?)[^\s"']+/gi, '$1[REDACTED]');
}

export class Store {
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });
    if (!fs.existsSync(this.soulPath)) fs.writeFileSync(this.soulPath, DEFAULT_SOUL, 'utf-8');
  }

  get settingsPath() { return path.join(this.dir, 'settings.json'); }
  get profilePath() { return path.join(this.dir, 'profile.json'); }
  get memoryPath() { return path.join(this.dir, 'memory.json'); }
  get historyPath() { return path.join(this.dir, 'history.json'); }
  get soulPath() { return path.join(this.dir, 'soul.md'); }
  get lockPath() { return path.join(this.dir, 'lock.json'); }

  get settings(): Settings {
    const s = readJson<Partial<Settings>>(this.settingsPath, {});
    return { ...defaultSettings(path.join(this.dir, 'workspace')), ...s };
  }
  saveSettings(s: Settings) { writeJson(this.settingsPath, { ...s, apiKey: s.apiKey }); }

  get profile(): Profile { return { ...defaultProfile(), ...readJson<Partial<Profile>>(this.profilePath, {}) }; }
  saveProfile(p: Profile) { writeJson(this.profilePath, p); }

  get soul(): string {
    try { return fs.readFileSync(this.soulPath, 'utf-8'); } catch { return DEFAULT_SOUL; }
  }
  saveSoul(text: string) { fs.writeFileSync(this.soulPath, text, 'utf-8'); }

  get memories(): MemoryEntry[] { return readJson<MemoryEntry[]>(this.memoryPath, []); }
  addMemory(text: string, tags: string[] = []) {
    const all = this.memories;
    all.push({ id: crypto.randomUUID(), text, tags, createdAt: new Date().toISOString() });
    writeJson(this.memoryPath, all);
  }
  deleteMemory(id: string) { writeJson(this.memoryPath, this.memories.filter((m) => m.id !== id)); }

  get history(): ChatMessage[] { return readJson<ChatMessage[]>(this.historyPath, []); }
  saveHistory(h: ChatMessage[]) { writeJson(this.historyPath, h.slice(-200)); }

  listWiki(): WikiPage[] {
    return fs.readdirSync(path.join(this.dir, 'wiki'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const body = fs.readFileSync(path.join(this.dir, 'wiki', f), 'utf-8');
        const title = body.split('\n')[0].replace(/^#\s*/, '') || f;
        return { id: f.replace(/\.md$/, ''), title, body, updatedAt: fs.statSync(path.join(this.dir, 'wiki', f)).mtime.toISOString() };
      });
  }
  saveWiki(title: string, body: string): WikiPage {
    const id = title.replace(/[^\w\u4e00-\u9fa5-]+/g, '-').slice(0, 60) || crypto.randomUUID();
    fs.writeFileSync(path.join(this.dir, 'wiki', `${id}.md`), body, 'utf-8');
    return { id, title, body, updatedAt: new Date().toISOString() };
  }

  /** Keyword recall (MVP): ranks memories by shared words. Real semantic search is Phase 2. */
  recall(query: string, limit = 5): MemoryEntry[] {
    const words = query.toLowerCase().split(/[\s,，。！？、]+/).filter((w) => w.length > 1);
    return this.memories
      .map((m) => ({ m, score: words.reduce((n, w) => n + (m.text.toLowerCase().includes(w) ? 1 : 0), 0) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.m);
  }

  // --- owner lock: scrypt hash, never the password itself ---
  get hasLock(): boolean { return fs.existsSync(this.lockPath); }
  setPassword(password: string) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    writeJson(this.lockPath, { salt, hash });
  }
  verifyPassword(password: string): boolean {
    try {
      const { salt, hash } = readJson<{ salt: string; hash: string }>(this.lockPath, { salt: '', hash: '' });
      if (!salt) return false;
      return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), crypto.scryptSync(password, salt, 64));
    } catch { return false; }
  }
}
