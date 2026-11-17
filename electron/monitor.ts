// System monitoring: CPU load, memory, disks, top processes.
// Best-effort everywhere — a failed probe yields an empty/zero value, never a
// throw, so the tool works on Linux (dev) and Windows (target) alike.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

export interface DiskInfo {
  path: string;
  total: number; // bytes
  free: number; // bytes
}

export interface ProcessInfo {
  pid: number;
  name: string;
  mem: number; // bytes (RSS / working set)
}

export interface SystemStatus {
  /** 1-minute load average on Linux/macOS; current CPU % / 100 on Windows. */
  cpuLoad: number;
  totalMem: number; // bytes
  freeMem: number; // bytes
  disks: DiskInfo[];
  /** Top processes by memory, most first (max 15). */
  processes: ProcessInfo[];
}

const EXEC_TIMEOUT_MS = 10_000;

function execCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) resolve('');
      else resolve(stdout.toString());
    });
  });
}

function parseLinuxPs(out: string): ProcessInfo[] {
  const rows: ProcessInfo[] = [];
  for (const line of out.split('\n').slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(\d+)$/);
    if (m) rows.push({ pid: Number(m[1]), name: m[2], mem: Number(m[3]) * 1024 });
  }
  return rows.slice(0, 15);
}

function parseWindowsPs(out: string): ProcessInfo[] {
  // PowerShell output: "pid|name|workingset" lines, or plain table fallback.
  const rows: ProcessInfo[] = [];
  for (const line of out.split('\n')) {
    const parts = line.trim().split('|');
    if (parts.length === 3) {
      const pid = Number(parts[0]);
      const mem = Number(parts[2]);
      if (Number.isFinite(pid) && parts[1] && Number.isFinite(mem)) {
        rows.push({ pid, name: parts[1], mem });
      }
    }
  }
  return rows.slice(0, 15);
}

async function linuxStatus(): Promise<SystemStatus> {
  let cpuLoad = 0;
  try {
    const loadavg = fs.readFileSync('/proc/loadavg', 'utf-8').trim().split(/\s+/)[0];
    cpuLoad = Number(loadavg) || 0;
  } catch {
    cpuLoad = os.loadavg()[0] || 0;
  }
  const disks: DiskInfo[] = [];
  try {
    const s = fs.statfsSync('/');
    disks.push({ path: '/', total: s.blocks * s.bsize, free: s.bfree * s.bsize });
  } catch { /* no disk info */ }
  const ps = await execCapture('ps', ['-eo', 'pid,comm,rss', '--sort=-rss']);
  return {
    cpuLoad,
    totalMem: os.totalmem(),
    freeMem: os.freemem(),
    disks,
    processes: parseLinuxPs(ps),
  };
}

async function windowsStatus(): Promise<SystemStatus> {
  let cpuLoad = 0;
  let disks: DiskInfo[] = [];
  let processes: ProcessInfo[] = [];
  try {
    const cpuOut = await execCapture('powershell.exe', [
      '-NoProfile', '-Command',
      "(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average",
    ]);
    const pct = Number(cpuOut.trim());
    if (Number.isFinite(pct)) cpuLoad = pct / 100;
  } catch { /* keep 0 */ }
  try {
    const diskOut = await execCapture('powershell.exe', [
      '-NoProfile', '-Command',
      "Get-PSDrive -PSProvider FileSystem | ForEach-Object { \"$($_.Root)|$($_.Used)|$($_.Free)\" }",
    ]);
    for (const line of diskOut.split('\n')) {
      const parts = line.trim().split('|');
      if (parts.length === 3) {
        const used = Number(parts[1]);
        const free = Number(parts[2]);
        if (Number.isFinite(used) && Number.isFinite(free)) {
          disks.push({ path: parts[0], total: used + free, free });
        }
      }
    }
  } catch { /* keep empty */ }
  try {
    const psOut = await execCapture('powershell.exe', [
      '-NoProfile', '-Command',
      "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 | ForEach-Object { \"$($_.Id)|$($_.ProcessName)|$($_.WorkingSet64)\" }",
    ]);
    processes = parseWindowsPs(psOut);
  } catch { /* keep empty */ }
  if (disks.length === 0) {
    try {
      const s = fs.statfsSync('C:\\');
      disks.push({ path: 'C:\\', total: s.blocks * s.bsize, free: s.bfree * s.bsize });
    } catch { /* no disk info */ }
  }
  return { cpuLoad, totalMem: os.totalmem(), freeMem: os.freemem(), disks, processes };
}

/** Never throws: every probe degrades to a zero/empty value on failure. */
export async function getSystemStatus(): Promise<SystemStatus> {
  try {
    if (process.platform === 'win32') return await windowsStatus();
    return await linuxStatus();
  } catch {
    return { cpuLoad: 0, totalMem: os.totalmem(), freeMem: os.freemem(), disks: [], processes: [] };
  }
}
