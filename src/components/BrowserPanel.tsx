// BrowserPanel — built-in multi-tab browser UI (Phase 3).
// Pure presentational component: tabs + address bar call the props; the
// active tab renders in an Electron <webview> with partition="persist:browser"
// so logins/cookies persist per profile. A <webview> only works inside
// Electron — in a plain browser preview it renders nothing, and the note
// below says so honestly.

import { useState } from 'react';
import type { DetailedHTMLProps, HTMLAttributes } from 'react';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        partition?: string;
      };
    }
  }
}

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
}

export interface BrowserPanelProps {
  tabs: BrowserTab[];
  activeId: string;
  onNavigate: (id: string, url: string) => void;
  onNewTab: () => void;
  onCloseTab: (id: string) => void;
}

function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  if (/^https?:\/\//i.test(t)) return t;
  return `https://${t}`;
}

export default function BrowserPanel({ tabs, activeId, onNavigate, onNewTab, onCloseTab }: BrowserPanelProps) {
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const [draft, setDraft] = useState(active?.url ?? '');

  // Keep the address bar in sync when the active tab changes.
  const [lastActiveId, setLastActiveId] = useState(active?.id);
  if (active && active.id !== lastActiveId) {
    setLastActiveId(active.id);
    setDraft(active.url);
  }

  function go() {
    if (!active) return;
    const url = normalizeUrl(draft);
    if (url) onNavigate(active.id, url);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
        {tabs.map((t) => (
          <span
            key={t.id}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 8px',
              borderRadius: 6,
              background: t.id === active?.id ? '#2f6fed' : '#1c2635',
              cursor: 'pointer',
              maxWidth: 180,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
            onClick={() => {
              setDraft(t.url);
              setLastActiveId(t.id);
              onNavigate(t.id, t.url);
            }}
          >
            {t.title || t.url}
            <button
              aria-label="关闭标签页"
              style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(t.id);
              }}
            >
              ×
            </button>
          </span>
        ))}
        <button onClick={onNewTab}>＋ 新标签页</button>
      </div>

      {active && (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go()}
            placeholder="输入网址，回车打开"
            style={{ flex: 1 }}
          />
          <button className="primary" onClick={go}>打开</button>
        </div>
      )}

      {active ? (
        <webview
          src={active.url}
          partition="persist:browser"
          style={{ flex: 1, width: '100%', minHeight: 400, border: '1px solid #2a3648', borderRadius: 8, background: '#fff' }}
        />
      ) : (
        <p>没有打开的标签页，点“＋ 新标签页”。</p>
      )}
      <p style={{ fontSize: 12, color: '#8fa1b5', margin: 0 }}>
        内置浏览器用 Electron 的 webview 实现（partition="persist:browser"，登录状态会保存）。
        在普通浏览器里预览时 webview 不显示内容，需在 Electron 里运行。
      </p>
    </div>
  );
}
