/**
 * Preview panel (Phase 2, clean-room).
 *
 * Renders Markdown (tiny safe renderer, no new dependency), code with line
 * numbers, plain text, PDF (via <embed> when a fileUrl is given) and HTML
 * (sandboxed iframe — scripts are blocked).
 *
 * Markdown safety: all HTML in the source is escaped BEFORE any markdown
 * markup is applied, and link hrefs are restricted to http/https/mailto/
 * same-page anchors. Nothing from the document can inject markup or script.
 */
import { useMemo } from 'react';

export type PreviewKind = 'markdown' | 'code' | 'text' | 'pdf' | 'html';

export interface PreviewPanelProps {
  name: string;
  content: string;
  kind: PreviewKind;
  /** Required for kind === 'pdf' (and usable as a fallback source). */
  fileUrl?: string;
}

/** Guess the preview kind from a file name. Unknown extensions -> 'text'. */
export function detectKind(fileName: string): PreviewKind {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'html' || ext === 'htm') return 'html';
  const code = new Set([
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'css', 'scss', 'less',
    'py', 'sh', 'bash', 'yml', 'yaml', 'xml', 'sql', 'go', 'rs', 'java',
    'c', 'cpp', 'h', 'toml', 'ini', 'cfg',
  ]);
  if (code.has(ext)) return 'code';
  return 'text';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^(https?:\/\/|mailto:|#|\/)/i.test(href)) return escapeHtml(href);
  return null;
}

/** Inline markdown on already-escaped text: bold, code, links. */
function renderInline(escaped: string): string {
  return escaped
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_m, text: string, href: string) => {
      const safe = safeHref(href);
      return safe ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
    });
}

/**
 * Tiny safe markdown renderer: headings, bold, inline code, links,
 * fenced code blocks, unordered/ordered lists, paragraphs.
 * Returns an HTML string that is safe to inject via dangerouslySetInnerHTML
 * (input HTML is escaped first; only the markup above is generated).
 */
export function renderMarkdownToHtml(md: string): string {
  // Pull fenced code blocks out first so their contents are never parsed.
  const blocks: string[] = [];
  const withoutFences = md.replace(/```([^\n]*)\n([\s\S]*?)(?:```|$)/g, (_m, lang: string, code: string) => {
    const idx = blocks.length;
    blocks.push(
      `<pre><code${lang.trim() ? ` data-lang="${escapeHtml(lang.trim())}"` : ''}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`,
    );
    return `\n@@CODEBLOCK${idx}@@\n`;
  });

  const out: string[] = [];
  const lines = withoutFences.split('\n');
  let listTag: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (listTag) {
      out.push(`</${listTag}>`);
      listTag = null;
    }
  };

  for (const rawLine of lines) {
    const codeMatch = rawLine.match(/^@@CODEBLOCK(\d+)@@$/);
    if (codeMatch) {
      closeList();
      out.push(blocks[Number(codeMatch[1])]);
      continue;
    }
    const line = rawLine.trimEnd();
    if (line.trim() === '') {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const tag = ul ? 'ul' : 'ol';
      if (listTag !== tag) {
        closeList();
        out.push(`<${tag}>`);
        listTag = tag;
      }
      out.push(`<li>${renderInline(escapeHtml((ul ?? ol)![1]))}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${renderInline(escapeHtml(line))}</p>`);
  }
  closeList();
  return out.join('\n');
}

function CodeView({ content }: { content: string }) {
  const lines = content.split('\n');
  return (
    <pre style={{ margin: 0, overflow: 'auto', maxHeight: 600 }}>
      {lines.map((line, i) => (
        <div key={i} style={{ display: 'flex' }}>
          <span
            style={{
              minWidth: 40,
              textAlign: 'right',
              paddingRight: 12,
              color: '#8fa1b5',
              userSelect: 'none',
              flexShrink: 0,
            }}
          >
            {i + 1}
          </span>
          <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {line || ' '}
          </span>
        </div>
      ))}
    </pre>
  );
}

export default function PreviewPanel({ name, content, kind, fileUrl }: PreviewPanelProps) {
  const html = useMemo(
    () => (kind === 'markdown' ? renderMarkdownToHtml(content) : ''),
    [kind, content],
  );

  return (
    <div className="preview-panel">
      <header>
        <strong>预览 — {name || '未打开文件'}</strong>
        <span style={{ marginLeft: 8, fontSize: 12, color: '#8fa1b5' }}>{kind}</span>
      </header>

      {kind === 'markdown' && (
        <div
          className="preview-markdown"
          style={{ padding: 8, overflow: 'auto', maxHeight: 600 }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}

      {kind === 'code' && <CodeView content={content} />}

      {kind === 'text' && (
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, padding: 8 }}>
          {content}
        </pre>
      )}

      {kind === 'pdf' &&
        (fileUrl ? (
          <embed src={fileUrl} type="application/pdf" style={{ width: '100%', height: 600 }} />
        ) : (
          <p style={{ padding: 8 }}>没有可预览的 PDF 地址：预览 PDF 需要提供 fileUrl。</p>
        ))}

      {kind === 'html' && (
        <div>
          <p style={{ fontSize: 12, color: '#8fa1b5', padding: '0 8px' }}>
            HTML 以沙箱 iframe 显示，脚本已被禁用。
          </p>
          <iframe
            srcDoc={content}
            sandbox=""
            title={name || 'HTML 预览'}
            style={{ width: '100%', height: 600, border: '1px solid #2a3442' }}
          />
        </div>
      )}
    </div>
  );
}
