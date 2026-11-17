/**
 * UpdateBanner — in-app auto-update banner (worker D).
 *
 * Pure presentational component: it holds no update logic and never talks to
 * the main process directly. Every button calls a prop; the parent (settings
 * page, wired by the coordinator) calls window.api.checkUpdate /
 * downloadUpdate / installUpdate, which invoke the updater:* IPC channels,
 * and feeds updater:status events back in as `status`.
 *
 * States (mirror electron/updater.ts UpdaterStatus):
 *   idle        — quiet, just a [检查更新] button
 *   checking    — spinner text
 *   available   — version + notes + [下载更新]
 *   downloading — progress %
 *   ready       — [重启安装]
 *   uptodate    — "已是最新版"
 *   manual      — calm hint + GitHub Releases address + [检查更新]
 *
 * No fake states: if the parent never wires a prop, the button simply does
 * nothing the component invented — every action is the parent's callback.
 */

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'uptodate'
  | 'manual';

export interface UpdateStatus {
  state: UpdateState;
  version?: string;
  notes?: string;
  progress?: number;
  reason?: string;
}

export interface UpdateBannerProps {
  status: UpdateStatus;
  onCheck: () => void;
  onDownload: () => void;
  onInstall: () => void;
}

export const GITHUB_RELEASES_URL =
  'https://github.com/mengmeng-ai/yun-partner/releases';

/**
 * Data-safety note for the settings page (paste next to <UpdateBanner />).
 * Updates only replace the app files; user data is never touched.
 */
export const UPDATE_DATA_NOTE =
  '更新只替换程序文件，你的数据不会丢：设置（settings.json）、灵魂（soul.md）、长期记忆（memory.json）、聊天记录（history.json）和 Wiki 都存在本机，不会因为更新被删掉。';

/**
 * Short manual-download hint, for the coordinator's README / settings copy.
 */
export const MANUAL_DOWNLOAD_HINT =
  `自动更新暂不可用（仓库还没建好 / 没联网），去 GitHub Releases 手动下载：${GITHUB_RELEASES_URL}`;

export function UpdateBanner({ status, onCheck, onDownload, onInstall }: UpdateBannerProps) {
  const wrap: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 12,
    border: '1px solid #2b3648',
    borderRadius: 8,
    background: '#131a26',
    fontSize: 13,
  };
  const row: React.CSSProperties = {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    flexWrap: 'wrap',
  };
  const muted: React.CSSProperties = { color: '#8fa1b5', fontSize: 12 };
  const barOuter: React.CSSProperties = {
    height: 8,
    borderRadius: 4,
    background: '#2b3648',
    overflow: 'hidden',
  };
  const barInner = (pct: number): React.CSSProperties => ({
    height: '100%',
    width: `${pct}%`,
    background: '#2f6fed',
    transition: 'width 0.3s',
  });

  const pct =
    typeof status.progress === 'number' && Number.isFinite(status.progress)
      ? Math.max(0, Math.min(100, Math.round(status.progress)))
      : undefined;

  return (
    <div style={wrap} role="status" aria-live="polite">
      <div style={{ fontWeight: 600 }}>软件更新</div>

      {status.state === 'idle' && (
        <div style={row}>
          <span style={muted}>点一下看看有没有新版。</span>
          <button className="primary" onClick={onCheck}>
            检查更新
          </button>
        </div>
      )}

      {status.state === 'checking' && (
        <div style={row}>
          <span aria-hidden="true">⟳</span>
          <span>正在检查更新…</span>
        </div>
      )}

      {status.state === 'available' && (
        <>
          <div>
            发现新版{status.version ? ` v${status.version}` : ''}，下载后重启就装好，不用你自己重新下载。
          </div>
          {status.notes && (
            <div style={{ ...muted, whiteSpace: 'pre-wrap' }}>{status.notes}</div>
          )}
          <div style={row}>
            <button className="primary" onClick={onDownload}>
              下载更新
            </button>
            <button onClick={onCheck}>稍后再说</button>
          </div>
        </>
      )}

      {status.state === 'downloading' && (
        <>
          <div>正在下载新版…{pct !== undefined ? ` ${pct}%` : ''}</div>
          {pct !== undefined && (
            <div style={barOuter}>
              <div style={barInner(pct)} />
            </div>
          )}
          <div style={muted}>下载完会告诉你，什么时候重启由你定。</div>
        </>
      )}

      {status.state === 'ready' && (
        <>
          <div>
            新版{status.version ? ` v${status.version}` : ''}已下载好，重启一下就装好。
          </div>
          <div style={row}>
            <button className="primary" onClick={onInstall}>
              重启安装
            </button>
            <span style={muted}>现在不想重启也没关系，下次打开再装。</span>
          </div>
        </>
      )}

      {status.state === 'uptodate' && (
        <div style={row}>
          <span>已是最新版 ✓</span>
          <button onClick={onCheck}>再检查一次</button>
        </div>
      )}

      {status.state === 'manual' && (
        <>
          <div>
            自动更新暂不可用
            {status.reason ? `（${status.reason}）` : '（仓库还没建好/没联网）'}，
            去 GitHub Releases 手动下载。
          </div>
          <code style={{ ...muted, wordBreak: 'break-all' }}>{GITHUB_RELEASES_URL}</code>
          <div style={row}>
            <button className="primary" onClick={onCheck}>
              检查更新
            </button>
          </div>
        </>
      )}

      <div style={muted}>{UPDATE_DATA_NOTE}</div>
    </div>
  );
}

export default UpdateBanner;
