// File-change journal ("改动" / undo timeline), mirroring the public Aivy OS
// behaviour: a 200-entry / 48h visible timeline with a 7-day restore window.
// The journal lives in userData (undo-log.json) and only ever restores files
// inside the workspace, via the same safeJoin rule as tools.ts (copied here
// on purpose — this module must not depend on edits to store.ts/tools.ts).
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface UndoEntry {
  id: string;
  relPath: string;
  /** Previous file content, or null when the file was binary / too large to keep. */
  oldContent: string | null;
  note?: string;
  createdAt: string; // ISO timestamp
}

export interface UndoListItem {
  id: string;
  relPath: string;
  createdAt: string;
  /** First ~120 chars of the old content, for display only. */
  preview: string;
  restorable: boolean;
}

const MAX_ENTRIES = 200;
const MAX_CONTENT_CHARS = 2_000_000;
/** Entries older than this are pruned from the journal entirely. */
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** The visible timeline only shows this window (Aivy: 48h). */
const LIST_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Same rule as tools.ts safeJoin: resolve inside the workspace or refuse. */
function safeJoin(workspace: string, relPath: string): string {
  const target = path.resolve(workspace, relPath || '.');
  const root = path.resolve(workspace);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('拒绝：路径超出工作区');
  }
  return target;
}

export class UndoJournal {
  private file: string;

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'undo-log.json');
  }

  private load(): UndoEntry[] {
    try {
      if (!fs.existsSync(this.file)) return [];
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as unknown;
      if (!Array.isArray(parsed)) return [];
      const cutoff = Date.now() - PRUNE_AFTER_MS;
      return (parsed as UndoEntry[]).filter(
        (e) => e && typeof e.id === 'string' && typeof e.relPath === 'string' && Date.parse(e.createdAt) >= cutoff,
      );
    } catch {
      return [];
    }
  }

  private save(entries: UndoEntry[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(entries, null, 2), 'utf-8');
  }

  /**
   * Record the previous content of a file before it is changed/deleted/moved.
   * Pass oldContent = null for binary files or files too large to snapshot —
   * the entry is still listed, but restore() will refuse with a clear error.
   */
  recordChange(relPath: string, oldContent: string | null, note?: string): UndoEntry {
    const entries = this.load();
    const entry: UndoEntry = {
      id: crypto.randomUUID(),
      relPath,
      oldContent: oldContent !== null && oldContent.length > MAX_CONTENT_CHARS ? null : oldContent,
      note: oldContent !== null && oldContent.length > MAX_CONTENT_CHARS
        ? '旧内容过大（>2MB），未保存快照，无法撤回'
        : note,
      createdAt: new Date().toISOString(),
    };
    entries.push(entry);
    // Keep newest 200 only.
    const trimmed = entries.slice(-MAX_ENTRIES);
    this.save(trimmed);
    return entry;
  }

  /** Visible timeline: newest first, last 48h, at most 200 entries. */
  listChanges(limit = 50): UndoListItem[] {
    const cutoff = Date.now() - LIST_WINDOW_MS;
    return this.load()
      .filter((e) => Date.parse(e.createdAt) >= cutoff)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, Math.min(limit, MAX_ENTRIES))
      .map((e) => ({
        id: e.id,
        relPath: e.relPath,
        createdAt: e.createdAt,
        preview: e.oldContent === null ? '(无旧内容快照)' : e.oldContent.slice(0, 120).replace(/\n/g, '⏎'),
        restorable: e.oldContent !== null,
      }));
  }

  /**
   * Write the recorded old content back into the workspace. Only entries
   * within the 7-day window can be restored; binary/unrecorded entries fail
   * with a clear error instead of writing garbage.
   */
  restore(workspace: string, entryId: string): string {
    const entries = this.load();
    const entry = entries.find((e) => e.id === entryId);
    if (!entry) throw new Error(`找不到这条改动记录：${entryId}`);
    if (Date.now() - Date.parse(entry.createdAt) > PRUNE_AFTER_MS) {
      throw new Error(`该改动已超过 7 天撤回期限（${entry.createdAt}），无法撤回`);
    }
    if (entry.oldContent === null) {
      throw new Error(`无法撤回 ${entry.relPath}：${entry.note ?? '没有保存旧内容快照（可能是二进制文件或过大）'}`);
    }
    const target = safeJoin(workspace, entry.relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.oldContent, 'utf-8');
    return entry.relPath;
  }
}
