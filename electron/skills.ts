// Skills — Phase 3, clean-room implementation.
// A skill is a local folder: SKILL.md (the prompt) + optional tools.json
// (list of tool names the skill may use). Skills live under a directory
// chosen by the owner (default: <userData>/skills).
// Trust rule: a skill installed from a Git URL gets an origin.json recording
// where it came from. Any skill folder WITHOUT origin.json is listed with
// untrusted: true — the owner must review it before use. No skill is ever
// auto-trusted, and installing never runs any code from the skill.

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

export interface SkillInfo {
  name: string;
  dir: string;
  hasPrompt: boolean;
  tools: string[];
  /** True when the folder has no origin.json (unknown provenance). */
  untrusted: boolean;
  originUrl?: string;
}

export interface LoadedSkill {
  name: string;
  prompt: string;
  tools: string[];
}

export interface InstallResult {
  ok: boolean;
  detail: string;
  name?: string;
}

function skillDirs(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

function readToolsJson(folder: string): string[] {
  try {
    const file = path.join(folder, 'tools.json');
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string');
    if (raw && typeof raw === 'object' && Array.isArray((raw as { tools?: unknown }).tools)) {
      return ((raw as { tools: unknown[] }).tools).filter((t): t is string => typeof t === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

function readOrigin(folder: string): string | undefined {
  try {
    const file = path.join(folder, 'origin.json');
    if (!fs.existsSync(file)) return undefined;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { url?: unknown };
    return typeof raw.url === 'string' ? raw.url : undefined;
  } catch {
    return undefined;
  }
}

/** List every skill folder under `dir`. Unknown-origin skills are flagged. */
export function listSkills(dir: string): SkillInfo[] {
  return skillDirs(dir).map((folder) => {
    const name = path.basename(folder);
    const originUrl = readOrigin(folder);
    return {
      name,
      dir: folder,
      hasPrompt: fs.existsSync(path.join(folder, 'SKILL.md')),
      tools: readToolsJson(folder),
      untrusted: originUrl === undefined,
      originUrl,
    };
  });
}

/**
 * Load one skill: returns its SKILL.md prompt + tool list.
 * Throws if the folder or SKILL.md is missing — the caller reports it.
 */
export function loadSkill(dir: string, name: string): LoadedSkill {
  const safe = path.basename(name);
  if (safe !== name || !name) throw new Error('技能名不合法');
  const folder = path.join(dir, safe);
  const promptFile = path.join(folder, 'SKILL.md');
  if (!fs.existsSync(promptFile)) throw new Error(`技能不存在或缺少 SKILL.md：${name}`);
  return {
    name: safe,
    prompt: fs.readFileSync(promptFile, 'utf-8'),
    tools: readToolsJson(folder),
  };
}

/** Validate a Git URL for install: only https:// URLs ending in .git. */
export function validateGitUrl(gitUrl: string): { ok: boolean; detail: string; name?: string } {
  const url = gitUrl.trim();
  if (!url.startsWith('https://')) return { ok: false, detail: '只接受 https:// 开头的 Git 地址' };
  if (!url.endsWith('.git')) return { ok: false, detail: 'Git 地址必须以 .git 结尾' };
  if (/\s/.test(url)) return { ok: false, detail: 'Git 地址里不能有空格' };
  let name = '';
  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return { ok: false, detail: 'Git 地址没有主机名' };
    name = path.basename(parsed.pathname).replace(/\.git$/, '');
  } catch {
    return { ok: false, detail: 'Git 地址解析失败' };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '' || name === '.' || name === '..') {
    return { ok: false, detail: '无法从地址推断出合法的技能名' };
  }
  return { ok: true, detail: '地址合法', name };
}

/**
 * Install a skill with `git clone --depth 1`. Rejects anything that is not
 * an https:// URL ending in .git. Never runs code from the repo — it only
 * clones files and records the origin. The skill stays untrusted until the
 * owner reviews it (origin.json is written, but review is a human step).
 */
export function installSkillFromGit(gitUrl: string, dir: string): Promise<InstallResult> {
  const checked = validateGitUrl(gitUrl);
  if (!checked.ok || !checked.name) return Promise.resolve({ ok: false, detail: checked.detail });
  const name = checked.name;
  const target = path.join(dir, name);
  if (fs.existsSync(target)) {
    return Promise.resolve({ ok: false, detail: `技能已存在：${name}（先删除旧的再装）`, name });
  }
  fs.mkdirSync(dir, { recursive: true });
  return new Promise((resolve) => {
    execFile(
      'git',
      ['clone', '--depth', '1', gitUrl.trim(), target],
      { timeout: 60_000, windowsHide: true },
      (err) => {
        if (err) {
          try {
            fs.rmSync(target, { recursive: true, force: true });
          } catch {
            // best-effort cleanup
          }
          resolve({ ok: false, detail: `git clone 失败：${err.message}` });
          return;
        }
        const promptFile = path.join(target, 'SKILL.md');
        if (!fs.existsSync(promptFile)) {
          resolve({
            ok: true,
            detail: `已克隆 ${name}，但里面没有 SKILL.md——先读懂再补用法，暂不启用`,
            name,
          });
          return;
        }
        try {
          fs.writeFileSync(
            path.join(target, 'origin.json'),
            JSON.stringify({ url: gitUrl.trim(), installedAt: new Date().toISOString() }, null, 2),
            'utf-8',
          );
        } catch {
          // origin record is nice-to-have; the skill still works
        }
        resolve({ ok: true, detail: `已安装技能：${name}`, name });
      },
    );
  });
}

/** Delete a skill folder. Returns false when it does not exist. */
export function removeSkill(dir: string, name: string): boolean {
  const safe = path.basename(name);
  if (safe !== name || !name) return false;
  const folder = path.join(dir, safe);
  if (!fs.existsSync(folder)) return false;
  fs.rmSync(folder, { recursive: true, force: true });
  return true;
}
