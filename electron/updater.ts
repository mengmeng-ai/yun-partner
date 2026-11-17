/**
 * Auto-update engine (clean-room, worker D).
 *
 * Uses electron-updater against GitHub Releases of mengmeng-ai/yun-partner.
 * The user asked 2026-11-17: "新版？我每次都要重新下载吗？" — so updates are
 * offered in-app, but the user always stays in control:
 *   check -> (update available) -> user clicks 下载 -> downloaded
 *   -> user clicks 重启安装 -> quitAndInstall.
 * If the user ignores the banner, nothing downloads and nothing installs.
 *
 * DATA SAFETY: an update only replaces the application files. It NEVER touches
 * Electron userData — settings.json / soul.md / memory.json / history.json /
 * wiki/ all live under app.getPath('userData') and survive an exe swap.
 * This module never reads, writes or deletes anything under userData.
 *
 * GRACEFUL DEGRADATION (mandatory): any of these -> status { state: 'manual' }
 * and the UI only shows a calm "去 GitHub Releases 手动下载" hint:
 *   - dev / not packaged (app.isPackaged === false)
 *   - electron-updater not installed yet (coordinator runs the install below)
 *   - no network / repo missing (404) / no releases published yet
 *   - any updater error at any point
 * NEVER show a native error dialog / error popup for update failures.
 * Every updater call is wrapped in try/catch and every listener is guarded.
 *
 * COORDINATOR — install + wiring (this file typechecks WITHOUT electron-updater
 * installed; it is loaded with a dynamic require and locally declared minimal
 * interfaces, so `npm install` must happen before the feature actually runs):
 *   1. npm install electron-updater
 *   2. electron-builder.json: add
 *        "publish": { "provider": "github", "owner": "mengmeng-ai", "repo": "yun-partner" }
 *   3. electron/main.ts (in app.whenReady, after createWindow()):
 *        import { setupAutoUpdater } from './updater';
 *        setupAutoUpdater(win);
 *      (setupAutoUpdater is idempotent — calling it twice is a no-op.)
 *   4. electron/preload.ts + src/api.d.ts: expose the IPC below via
 *      contextBridge (updater:check / updater:download / updater:install
 *      invoke handlers, updater:status event listener).
 *   5. Settings page: render <UpdateBanner /> and paste UPDATE_DATA_NOTE
 *      (exported from src/components/UpdateBanner.tsx) next to it.
 */

import { app, BrowserWindow, ipcMain } from 'electron';

export const UPDATER_REPO_OWNER = 'mengmeng-ai';
export const UPDATER_REPO_NAME = 'yun-partner';
export const GITHUB_RELEASES_URL =
  `https://github.com/${UPDATER_REPO_OWNER}/${UPDATER_REPO_NAME}/releases`;

/** First automatic check happens this long after the window is ready. */
export const STARTUP_CHECK_DELAY_MS = 10_000;

export type UpdaterState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'uptodate'
  | 'manual';

export interface UpdaterStatus {
  state: UpdaterState;
  /** New version, e.g. "0.2.0" (available / ready only). */
  version?: string;
  /** Release notes from the GitHub release (available / ready only). */
  notes?: string;
  /** Download progress 0-100 (downloading only). */
  progress?: number;
  /** Why automatic update is unavailable (manual only). Short, user-facing. */
  reason?: string;
}

export interface SetupAutoUpdaterOptions {
  /** Delay before the first automatic check. Default 10_000 ms. */
  startupDelayMs?: number;
}

/* ------------------------------------------------------------------ */
/* Minimal local interfaces for electron-updater.                      */
/* No static `import ... from 'electron-updater'` anywhere in this     */
/* file, so `tsc` passes even before `npm install electron-updater`.   */
/* ------------------------------------------------------------------ */

interface UpdateInfoLike {
  version: string;
  releaseNotes?: string | Array<{ note: string }> | null;
}

interface ProgressInfoLike {
  percent: number;
}

interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<{ updateInfo: UpdateInfoLike }>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

function loadAutoUpdater(): AutoUpdaterLike | null {
  try {
    // Dynamic require on purpose: electron-updater may not be installed yet
    // (another worker owns package.json right now). If the require fails,
    // we degrade to 'manual' instead of crashing startup.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('electron-updater') as { autoUpdater?: unknown };
    const au = mod?.autoUpdater as AutoUpdaterLike | undefined;
    if (!au || typeof au.checkForUpdates !== 'function') return null;
    return au;
  } catch {
    return null;
  }
}

function flattenNotes(
  raw: string | Array<{ note: string }> | null | undefined,
): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === 'string') return raw.trim() || undefined;
  const notes = raw
    .map((item) => (typeof item?.note === 'string' ? item.note.trim() : ''))
    .filter(Boolean);
  return notes.length > 0 ? notes.join('\n') : undefined;
}

function errorReason(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '未知错误');
  return msg.slice(0, 200);
}

/* ------------------------------------------------------------------ */
/* State                                                                */
/* ------------------------------------------------------------------ */

let winRef: BrowserWindow | null = null;
let wired = false;
let currentStatus: UpdaterStatus = { state: 'idle' };
let startupTimer: ReturnType<typeof setTimeout> | null = null;

function emit(status: UpdaterStatus): void {
  currentStatus = status;
  try {
    if (winRef && !winRef.isDestroyed()) {
      winRef.webContents.send('updater:status', status);
    }
  } catch {
    // Renderer gone — the status is kept in currentStatus for the next read.
  }
}

function emitManual(reason: string): UpdaterStatus {
  const status: UpdaterStatus = { state: 'manual', reason };
  emit(status);
  return status;
}

function autoUpdaterOrManual(): AutoUpdaterLike | null {
  if (!app.isPackaged) {
    emitManual('开发模式：自动更新只在打包后的正式版里可用。');
    return null;
  }
  const au = loadAutoUpdater();
  if (!au) {
    emitManual('自动更新组件还没装好，去 GitHub Releases 手动下载。');
    return null;
  }
  return au;
}

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */

/**
 * Manual check, for the settings-page [检查更新] button.
 * Never throws and never pops a dialog: every failure degrades to 'manual'.
 */
export async function checkForUpdatesManual(): Promise<UpdaterStatus> {
  const au = autoUpdaterOrManual();
  if (!au) return currentStatus;
  emit({ state: 'checking' });
  try {
    const result = await au.checkForUpdates();
    const latest = result?.updateInfo?.version;
    // electron-updater normally fires 'update-not-available' itself and the
    // listener below emits 'uptodate'; if it resolved without an event and
    // the version equals ours, report up-to-date directly.
    if (latest && latest === app.getVersion()) {
      const status: UpdaterStatus = { state: 'uptodate' };
      emit(status);
      return status;
    }
    // 'update-available' listener will emit 'available' (or 'uptodate').
    // If no event arrives, keep 'checking' only briefly: fall back to
    // 'uptodate' is wrong — leave the last emitted state; the listener
    // owns the outcome. Return the current status as-is.
    return currentStatus;
  } catch (err) {
    return emitManual(`检查更新失败（${errorReason(err)}），去 GitHub Releases 手动下载。`);
  }
}

async function downloadUpdateManual(): Promise<UpdaterStatus> {
  const au = autoUpdaterOrManual();
  if (!au) return currentStatus;
  try {
    await au.downloadUpdate();
    return currentStatus;
  } catch (err) {
    return emitManual(`下载失败（${errorReason(err)}），去 GitHub Releases 手动下载。`);
  }
}

function installUpdateManual(): UpdaterStatus {
  const au = autoUpdaterOrManual();
  if (!au) return currentStatus;
  try {
    // Data safety: quitAndInstall only swaps the app files; userData
    // (settings.json / soul.md / memory.json / history.json / wiki/) is
    // untouched, so nothing the user created is lost.
    au.quitAndInstall(false, true);
    return currentStatus;
  } catch (err) {
    return emitManual(`安装失败（${errorReason(err)}），去 GitHub Releases 手动下载。`);
  }
}

/**
 * Wire the updater once, after the main window is ready.
 * Call from main.ts inside app.whenReady(), after createWindow().
 * Safe to call twice; the second call is a no-op. Safe in dev: in dev it
 * only registers the IPC handlers and reports 'manual' on any check.
 */
export function setupAutoUpdater(
  win: BrowserWindow,
  opts: SetupAutoUpdaterOptions = {},
): void {
  winRef = win;
  if (wired) return;
  wired = true;

  const au = app.isPackaged ? loadAutoUpdater() : null;

  if (au) {
    try {
      au.autoDownload = false;
      au.autoInstallOnAppQuit = false;
    } catch {
      // Ignore: defaults are safe enough; a failed check degrades to manual.
    }

    const onAvailable = (info: unknown) => {
      try {
        const updateInfo = info as UpdateInfoLike;
        emit({
          state: 'available',
          version: updateInfo?.version,
          notes: flattenNotes(updateInfo?.releaseNotes),
        });
      } catch {
        emitManual('发现新版，但读取版本信息失败，去 GitHub Releases 手动下载。');
      }
    };
    const onNotAvailable = () => emit({ state: 'uptodate' });
    const onProgress = (progress: unknown) => {
      try {
        const p = progress as ProgressInfoLike;
        const percent =
          typeof p?.percent === 'number' && Number.isFinite(p.percent)
            ? Math.max(0, Math.min(100, Math.round(p.percent)))
            : undefined;
        emit({ state: 'downloading', progress: percent });
      } catch {
        emit({ state: 'downloading' });
      }
    };
    const onDownloaded = (info: unknown) => {
      try {
        const updateInfo = info as UpdateInfoLike;
        emit({
          state: 'ready',
          version: updateInfo?.version,
          notes: flattenNotes(updateInfo?.releaseNotes),
        });
      } catch {
        emit({ state: 'ready' });
      }
    };
    const onError = (err: unknown) => {
      // Never a dialog: a failed update is not the user's problem to solve
      // with a popup — just point at the manual download.
      emitManual(`自动更新出错（${errorReason(err)}），去 GitHub Releases 手动下载。`);
    };

    try {
      au.on('update-available', onAvailable);
      au.on('update-not-available', onNotAvailable);
      au.on('download-progress', onProgress);
      au.on('update-downloaded', onDownloaded);
      au.on('error', onError);
    } catch {
      // Listener wiring failed — checks will degrade to 'manual' per call.
    }
  }

  // IPC for the renderer (preload must bridge these; see header comment).
  // Handlers never throw to the renderer: failures return a 'manual' status.
  try {
    ipcMain.handle('updater:check', async () => checkForUpdatesManual());
    ipcMain.handle('updater:download', async () => downloadUpdateManual());
    ipcMain.handle('updater:install', () => installUpdateManual());
    ipcMain.handle('updater:status', () => currentStatus);
  } catch {
    // IPC already registered (e.g. setup called again after a reload) —
    // the existing handlers serve the same contract.
  }

  // First automatic check, delayed so startup stays fast. Only in a
  // packaged build; in dev there is nothing to check against.
  if (app.isPackaged && au) {
    const delay = opts.startupDelayMs ?? STARTUP_CHECK_DELAY_MS;
    startupTimer = setTimeout(() => {
      startupTimer = null;
      void checkForUpdatesManual();
    }, delay);
    // Don't keep the app alive just for the update timer.
    if (typeof startupTimer === 'object' && startupTimer !== null) {
      (startupTimer as { unref?: () => void }).unref?.();
    }
  }
}

/** Current last-known updater status (for a late-attaching renderer). */
export function getUpdaterStatus(): UpdaterStatus {
  return currentStatus;
}
