import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Resolve a workspace-relative path, refusing anything that escapes the workspace. */
export function safeJoin(workspace: string, relPath: string): string {
  const target = path.resolve(workspace, relPath || '.');
  const root = path.resolve(workspace);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('拒绝：路径超出工作区');
  }
  return target;
}

export function listFiles(workspace: string, relPath = '.'): string[] {
  const dir = safeJoin(workspace, relPath);
  return fs.readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
}

export function readFile(workspace: string, relPath: string): string {
  const file = safeJoin(workspace, relPath);
  const stat = fs.statSync(file);
  if (stat.size > 2_000_000) throw new Error('文件太大（>2MB），先分段读');
  return fs.readFileSync(file, 'utf-8');
}

export function writeFile(workspace: string, relPath: string, content: string): void {
  const file = safeJoin(workspace, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf-8');
}

export function editFile(workspace: string, relPath: string, oldText: string, newText: string): void {
  const file = safeJoin(workspace, relPath);
  const cur = fs.readFileSync(file, 'utf-8');
  if (!cur.includes(oldText)) throw new Error('没找到要替换的那段原文');
  fs.writeFileSync(file, cur.replace(oldText, newText), 'utf-8');
}

function runProcess(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (e: Error) => resolve({ stdout, stderr: stderr + e.message, code: -1 }));
    child.on('close', (code) => resolve({ stdout: stdout.slice(0, 200_000), stderr: stderr.slice(0, 20_000), code }));
  });
}

export async function runCommand(workspace: string, command: string) {
  // Windows: PowerShell; macOS/Linux: bash. The command always runs inside the workspace.
  if (process.platform === 'win32') {
    return runProcess('powershell.exe', ['-NoProfile', '-Command', command], workspace);
  }
  return runProcess('bash', ['-lc', command], workspace);
}

export async function runPython(workspace: string, code: string) {
  // MVP: run the snippet as a temp script inside the workspace. No persistent
  // interpreter state yet (Phase 2: long-lived Python process).
  const tmp = path.join(os.tmpdir(), `yun-partner-${Date.now()}.py`);
  fs.writeFileSync(tmp, code, 'utf-8');
  try {
    const exe = process.platform === 'win32' ? 'python' : 'python3';
    return await runProcess(exe, [tmp], workspace);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}
