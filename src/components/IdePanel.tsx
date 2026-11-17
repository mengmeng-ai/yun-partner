/**
 * IDE panel (Phase 2, clean-room).
 *
 * File tree + Monaco editor (language by extension) + local line-diff
 * view + confirm/discard save flow + undo timeline (max 200 shown).
 *
 * No fake functionality: every button calls a prop. File contents are
 * supplied by the parent via initialContent / onOpenFile; saving goes
 * through onSave; restores go through onRestore.
 */
import { useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';

export interface IdeUndoEntry {
  id: string;
  name: string;
  time: string;
  summary: string;
}

export interface IdePanelProps {
  files: string[];
  onOpenFile: (name: string) => void;
  onSave: (name: string, content: string) => void;
  initialContent: string;
  initialName: string;
  /** Undo timeline entries (newest first is fine, either order is shown as given). */
  entries?: IdeUndoEntry[];
  onRestore?: (id: string) => void;
}

export interface UndoTimelineProps {
  entries: IdeUndoEntry[];
  onRestore: (id: string) => void;
}

/** Map a file extension to a Monaco language id. Unknown -> plaintext. */
export function detectLanguage(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    css: 'css',
    scss: 'scss',
    less: 'less',
    html: 'html',
    htm: 'html',
    md: 'markdown',
    markdown: 'markdown',
    py: 'python',
    sh: 'shell',
    bash: 'shell',
    txt: 'plaintext',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml',
    sql: 'sql',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    h: 'cpp',
  };
  return map[ext] ?? 'plaintext';
}

export type DiffLineType = 'unchanged' | 'added' | 'removed';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/**
 * Line diff between old and new text, computed locally with LCS.
 * No dependency. O(n*m) — fine for files edited by hand here.
 */
export function computeLineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'unchanged', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'removed', text: a[i] });
      i++;
    } else {
      out.push({ type: 'added', text: b[j] });
      j++;
    }
  }
  while (i < n) {
    out.push({ type: 'removed', text: a[i] });
    i++;
  }
  while (j < m) {
    out.push({ type: 'added', text: b[j] });
    j++;
  }
  return out;
}

export function UndoTimeline({ entries, onRestore }: UndoTimelineProps) {
  const shown = entries.slice(0, 200);
  return (
    <div className="undo-timeline">
      <h3>撤销时间线（{shown.length}{entries.length > 200 ? ` / 共 ${entries.length} 条，只显示前 200 条` : ' 条'}）</h3>
      {shown.length === 0 && <p>还没有改动记录。</p>}
      <ul>
        {shown.map((e) => (
          <li key={e.id}>
            <strong>{e.name}</strong> · {e.time} — {e.summary}{' '}
            <button onClick={() => onRestore(e.id)}>恢复到这版</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function IdePanel({
  files,
  onOpenFile,
  onSave,
  initialContent,
  initialName,
  entries = [],
  onRestore,
}: IdePanelProps) {
  const [selected, setSelected] = useState(initialName);
  const [baseline, setBaseline] = useState(initialContent);
  const [content, setContent] = useState(initialContent);
  const [showDiff, setShowDiff] = useState(false);
  const [savedNote, setSavedNote] = useState('');

  // Parent opened a different file (or reloaded its content): adopt it.
  useEffect(() => {
    setSelected(initialName);
    setBaseline(initialContent);
    setContent(initialContent);
    setSavedNote('');
  }, [initialName, initialContent]);

  const dirty = content !== baseline;
  const diff = useMemo(
    () => (showDiff ? computeLineDiff(baseline, content) : []),
    [showDiff, baseline, content],
  );
  const added = diff.filter((d) => d.type === 'added').length;
  const removed = diff.filter((d) => d.type === 'removed').length;

  function open(name: string) {
    setSelected(name);
    onOpenFile(name);
  }

  function confirmSave() {
    onSave(selected, content);
    setBaseline(content);
    setSavedNote(`已保存 ${selected}`);
  }

  function discard() {
    setContent(baseline);
    setSavedNote('已放弃改动，回到上次保存的内容');
  }

  return (
    <div className="ide-panel" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div className="ide-tree" style={{ minWidth: 180 }}>
        <h3>文件</h3>
        {files.length === 0 && <p>（没有文件）</p>}
        <ul>
          {files.map((f) => (
            <li key={f}>
              <button
                onClick={() => open(f)}
                style={f === selected ? { fontWeight: 'bold' } : undefined}
              >
                {f}
              </button>
            </li>
          ))}
        </ul>
        {onRestore && entries.length > 0 && (
          <UndoTimeline entries={entries} onRestore={onRestore} />
        )}
      </div>

      <div className="ide-editor" style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>{selected || '未选择文件'}</strong>
          <span style={{ fontSize: 12, color: '#8fa1b5' }}>
            {detectLanguage(selected)}
            {dirty ? ' · 有未保存的改动' : ' · 已保存'}
          </span>
          <button onClick={() => setShowDiff((s) => !s)}>
            {showDiff ? '隐藏改动对比' : '查看改动对比'}
          </button>
          {dirty && (
            <>
              <button className="primary" onClick={confirmSave}>确认保存</button>
              <button onClick={discard}>放弃</button>
            </>
          )}
          {savedNote && !dirty && <span style={{ fontSize: 12 }}>{savedNote}</span>}
        </div>

        <div style={{ height: 420, border: '1px solid #2a3442', marginTop: 8 }}>
          <Editor
            height="100%"
            language={detectLanguage(selected)}
            value={content}
            onChange={(v) => setContent(v ?? '')}
            options={{ minimap: { enabled: false }, automaticLayout: true, fontSize: 13 }}
          />
        </div>

        {showDiff && (
          <div className="ide-diff" style={{ marginTop: 8 }}>
            <p style={{ fontSize: 12 }}>
              与上次保存的版本对比：新增 {added} 行，删除 {removed} 行
              {!dirty && '（无改动）'}
            </p>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                maxHeight: 300,
                overflow: 'auto',
                margin: 0,
              }}
            >
              {diff.map((d, i) => (
                <div
                  key={i}
                  style={{
                    background:
                      d.type === 'added'
                        ? 'rgba(46, 160, 67, 0.25)'
                        : d.type === 'removed'
                          ? 'rgba(248, 81, 73, 0.25)'
                          : 'transparent',
                  }}
                >
                  {d.type === 'added' ? '+ ' : d.type === 'removed' ? '- ' : '  '}
                  {d.text}
                </div>
              ))}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
