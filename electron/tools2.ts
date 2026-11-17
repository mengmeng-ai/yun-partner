// Phase 1 tool expansion: 25 additional tools (8 in llm.ts + 25 here = 33).
// Owns ONLY these new files; main.ts / llm.ts / preload.ts / App.tsx are wired
// later by the integrator — this module exposes TOOL2_DEFS, TOOL2_META and
// executeTool2(name, args, ctx) for that wiring.
// Safety: every file op is confined to the workspace via safeJoin (from
// tools.ts); destructive tools are flagged in TOOL2_META and must be gated
// by the UI approval flow before executeTool2 is called.
import { spawn} from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ToolDef} from './llm';
import { extractDocText} from './docs';
import { getSystemStatus} from './monitor';
import { safeJoin} from './tools';
import { UndoJournal} from './undo';

export interface Tool2Context {
workspace: string;
/** app.getPath('userData') — where the undo journal lives. */
userDataDir: string;
}

// ------------------------------------------------------------ arg helpers ----

function reqStr(args: Record<string, unknown>, key: string): string {
const v = args[key];
if (typeof v!== 'string' ||!v) throw new Error(`缺少参数：${key}`);
return v;
}
function optStr(args: Record<string, unknown>, key: string, fallback = ''): string {
const v = args[key];
return typeof v === 'string'? v: fallback;
}
function optNum(args: Record<string, unknown>, key: string, fallback: number): number {
const v = args[key];
return typeof v === 'number' && Number.isFinite(v)? v: fallback;
}
function optBool(args: Record<string, unknown>, key: string, fallback = false): boolean {
const v = args[key];
return typeof v === 'boolean'? v: fallback;
}

// ------------------------------------------------------------- process ----

interface ProcResult { stdout: string; stderr: string; code: number | null}

function runProcess(cmd: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<ProcResult> {
return new Promise((resolve) => {
const child = spawn(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true});
let stdout = '';
let stderr = '';
child.stdout?.on('data', (d: Buffer) => { stdout += d.toString();});
child.stderr?.on('data', (d: Buffer) => { stderr += d.toString();});
child.on('error', (e: Error) => resolve({ stdout, stderr: stderr + e.message, code: -1}));
child.on('close', (code) => resolve({ stdout: stdout.slice(0, 200_000), stderr: stderr.slice(0, 20_000), code}));
});
}

// --------------------------------------------------------------- walking ----

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', '.next', '__pycache__', '.venv', 'venv']);

/** Recursively list files under the workspace (relative posix paths). */
function walkWorkspace(workspace: string, maxDepth = 8, maxFiles = 20_000): string[] {
const out: string[] = [];
const walk = (dir: string, rel: string, depth: number): void => {
if (out.length >= maxFiles || depth > maxDepth) return;
let entries: fs.Dirent[];
try {
entries = fs.readdirSync(dir, { withFileTypes: true});
} catch {
return;
}
for (const e of entries) {
if (out.length >= maxFiles) return;
const childRel = rel? `${rel}/${e.name}`: e.name;
if (e.isDirectory()) {
if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
walk(path.join(dir, e.name), childRel, depth + 1);
} else if (e.isFile()) {
out.push(childRel);
}
}
};
walk(workspace, '', 0);
return out;
}

function isTextFile(absPath: string): boolean {
try {
const fd = fs.openSync(absPath, 'r');
try {
const buf = Buffer.alloc(8192);
const n = fs.readSync(fd, buf, 0, 8192, 0);
return!buf.subarray(0, n).includes(0);
} finally {
fs.closeSync(fd);
}
} catch {
return false;
}
}

/** Snapshot a file's old content into the undo journal before mutating it. */
function snapshotForUndo(ctx: Tool2Context, relPath: string, note?: string): void {
try {
const abs = safeJoin(ctx.workspace, relPath);
if (!fs.existsSync(abs) ||!fs.statSync(abs).isFile()) return;
const journal = new UndoJournal(ctx.userDataDir);
if (!isTextFile(abs)) {
journal.recordChange(relPath, null, '二进制文件，未保存旧内容快照');
return;
}
const stat = fs.statSync(abs);
if (stat.size > 2_000_000) {
journal.recordChange(relPath, null, '旧文件过大（>2MB），未保存快照');
return;
}
journal.recordChange(relPath, fs.readFileSync(abs, 'utf-8'), note);
} catch {
// Undo is best-effort: a journal failure must not block the operation.
}
}

// ----------------------------------------------------------------- glob ----

function globToRegExp(glob: string): RegExp {
let re = '^';
for (let i = 0; i < glob.length; i++) {
const c = glob[i];
if (c === '*') {
if (glob[i + 1] === '*') {
// **/ matches zero or more directories; ** matches anything.
if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2;}
else { re += '.*'; i += 1;}
} else {
re += '[^/]*';
}
} else if (c === '?') re += '[^/]';
else if (c === '[') {
const close = glob.indexOf(']', i + 1);
if (close > i) { re += glob.slice(i, close + 1); i = close;}
else re += '\\[';
} else {
re += c.replace(/[.+^${}()|\\]/g, '\\$&');
}
}
return new RegExp(re + '$');
}

// ----------------------------------------------------------------- diff ----

type DiffOp = { type: ' ' | '-' | '+'; text: string};

/** Line diff: LCS dynamic programming with a size guard; large inputs fall
* back to a common-prefix/common-suffix diff so we never blow up memory. */
function diffLines(a: string[], b: string[]): DiffOp[] {
const n = a.length;
const m = b.length;
if (n * m > 4_000_000) {
let prefix = 0;
while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
let suffix = 0;
while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;
const ops: DiffOp[] = [];
for (let i = 0; i < prefix; i++) ops.push({ type: ' ', text: a[i]});
for (let i = prefix; i < n - suffix; i++) ops.push({ type: '-', text: a[i]});
for (let i = prefix; i < m - suffix; i++) ops.push({ type: '+', text: b[i]});
for (let i = n - suffix; i < n; i++) ops.push({ type: ' ', text: a[i]});
return ops;
}
// LCS table: dp[i][j] = LCS length of a[i..] and b[j..].
const dp: number[][] = Array.from({ length: n + 1}, () => new Array<number>(m + 1).fill(0));
for (let i = n - 1; i >= 0; i--) {
for (let j = m - 1; j >= 0; j--) {
dp[i][j] = a[i] === b[j]? dp[i + 1][j + 1] + 1: Math.max(dp[i + 1][j], dp[i][j + 1]);
}
}
const ops: DiffOp[] = [];
let i = 0;
let j = 0;
while (i < n && j < m) {
if (a[i] === b[j]) { ops.push({ type: ' ', text: a[i]}); i++; j++;}
else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: '-', text: a[i]}); i++;}
else { ops.push({ type: '+', text: b[j]}); j++;}
}
while (i < n) { ops.push({ type: '-', text: a[i]}); i++;}
while (j < m) { ops.push({ type: '+', text: b[j]}); j++;}
return ops;
}

function toUnifiedDiff(oldLabel: string, newLabel: string, ops: DiffOp[]): string {
const CONTEXT = 3;
// Find change regions with context.
const changed = ops.map((o, idx) => (o.type === ' '? -1: idx)).filter((x) => x >= 0);
if (changed.length === 0) return '（两边内容完全相同，无差异）';
const hunks: { start: number; end: number}[] = [];
for (const idx of changed) {
const start = Math.max(0, idx - CONTEXT);
const end = Math.min(ops.length, idx + CONTEXT + 1);
const last = hunks[hunks.length - 1];
if (last && start <= last.end) last.end = end;
else hunks.push({ start, end});
}
const lines: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];
for (const h of hunks) {
let oldStart = 0;
let newStart = 0;
for (let k = 0; k < h.start; k++) {
if (ops[k].type!== '+') oldStart++;
if (ops[k].type!== '-') newStart++;
}
let oldCount = 0;
let newCount = 0;
for (let k = h.start; k < h.end; k++) {
if (ops[k].type!== '+') oldCount++;
if (ops[k].type!== '-') newCount++;
}
lines.push(`@@ -${oldStart + 1},${oldCount} +${newStart + 1},${newCount} @@`);
for (let k = h.start; k < h.end; k++) lines.push(`${ops[k].type}${ops[k].text}`);
}
return lines.join('\n');
}

// ------------------------------------------------------------------ web ----

function decodeEntities(s: string): string {
return s
.replace(/&amp;/g, '&')
.replace(/&lt;/g, '<')
.replace(/&gt;/g, '>')
.replace(/&quot;/g, '"')
.replace(/&#39;/g, "'")
.replace(/&nbsp;/g, ' ')
.replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)));
}

function stripTags(s: string): string {
return decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

const WEB_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'};

async function webSearch(query: string): Promise<string> {
const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
const res = await fetch(url, { headers: WEB_UA, signal: AbortSignal.timeout(20_000)});
if (!res.ok) throw new Error(`联网搜索失败：HTTP ${res.status}`);
const html = await res.text();
if (res.status === 202) throw new Error('DuckDuckGo 拒绝了这次搜索请求（HTTP 202，疑似触发机器人验证），请稍后再试或换个网络');
const titleRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
const titles: { href: string; title: string}[] = [];
let t: RegExpExecArray | null;
while ((t = titleRe.exec(html))!== null && titles.length < 8) {
let href = t[1];
// DuckDuckGo wraps outbound links: //duckduckgo.com/l/?uddg=<urlencoded>
const uddg = href.match(/[?&]uddg=([^&]+)/);
if (uddg) {
try { href = decodeURIComponent(uddg[1]);} catch { /* keep raw */}
}
titles.push({ href, title: stripTags(t[2])});
}
const snippets: string[] = [];
let s: RegExpExecArray | null;
while ((s = snipRe.exec(html))!== null && snippets.length < 8) snippets.push(stripTags(s[1]));
if (titles.length === 0) { if (!html.includes('results')) throw new Error('DuckDuckGo 没有返回可解析的搜索结果（可能触发了机器人验证），请稍后再试或换个网络'); return '（网页搜索）没有找到相关结果。'; }
const lines = titles.map((r, i) => `${i + 1}. ${r.title}\n ${r.href}${snippets[i]? `\n ${snippets[i]}`: ''}`);
return `（以下为网页搜索结果，来自 DuckDuckGo）\n${lines.join('\n')}`;
}

async function webFetch(url: string): Promise<string> {
let parsed: URL;
try {
parsed = new URL(url);
} catch {
throw new Error(`不是有效的网址：${url}`);
}
if (parsed.protocol!== 'http:' && parsed.protocol!== 'https:') {
throw new Error(`只支持 http/https 网址：${url}`);
}
const res = await fetch(url, { headers: WEB_UA, signal: AbortSignal.timeout(20_000)});
if (!res.ok) throw new Error(`抓取网页失败：HTTP ${res.status}`);
const html = await res.text();
const noScript = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
const text = stripTags(noScript).replace(/\s{2,}/g, ' ');
return text.slice(0, 20_000) || '（该网页没有可提取的正文）';
}

// -------------------------------------------------------------- handlers ----

async function hFileCopy(ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
const src = reqStr(args, 'relPath');
const dest = reqStr(args, 'destPath');
const absSrc = safeJoin(ctx.workspace, src);
const absDest = safeJoin(ctx.workspace, dest);
const stat = fs.statSync(absSrc);
if (!stat.isFile()) throw new Error('file_copy 目前只支持复制单个文件，不支持文件夹');
snapshotForUndo(ctx, dest);
fs.mkdirSync(path.dirname(absDest), { recursive: true});
fs.copyFileSync(absSrc, absDest);
return `已复制 ${src} → ${dest}`;
}

async function hFileMove(ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
const src = reqStr(args, 'relPath');
const dest = reqStr(args, 'destPath');
const absSrc = safeJoin(ctx.workspace, src);
const absDest = safeJoin(ctx.workspace, dest);
snapshotForUndo(ctx, src);
snapshotForUndo(ctx, dest);
fs.mkdirSync(path.dirname(absDest), { recursive: true});
try {
fs.renameSync(absSrc, absDest);
} catch {
// Cross-device move: copy then delete.
fs.copyFileSync(absSrc, absDest);
fs.rmSync(absSrc, { recursive: true, force: true});
}
return `已移动 ${src} → ${dest}`;
}

async function hFileDelete(ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
const rel = reqStr(args, 'relPath');
const recursive = optBool(args, 'recursive', false);
const abs = safeJoin(ctx.workspace, rel);
const stat = fs.statSync(abs);
if (stat.isDirectory()) {
if (!recursive) throw new Error('是文件夹：删除文件夹需要传 recursive=true');
fs.rmSync(abs, { recursive: true, force: false});
return `已删除文件夹 ${rel}（递归）`;
}
snapshotForUndo(ctx, rel);
fs.rmSync(abs, { force: false});
return `已删除 ${rel}`;
}

async function hFileReadPaged(ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
const rel = reqStr(args, 'relPath');
const offset = Math.max(0, optNum(args, 'offset', 0));
const lines = Math.min(Math.max(1, optNum(args, 'lines', 100)), 500);
const abs = safeJoin(ctx.workspace, rel);
const stat = fs.statSync(abs);
if (stat.size > 10_000_000) throw new Error('文件太大（>10MB），请先用 global_search 定位再读');
const text = fs.readFileSync(abs, 'utf-8');
const all = text.split('\n');
const page = all.slice(offset, offset + lines);
return JSON.stringify({
relPath: rel,
totalLines: all.length,
offset,
lines: page,
hasMore: offset + lines < all.length,
});
}

async function hFileDiff(ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
let oldText: string;
let newText: string;
let oldLabel = '旧内容';
let newLabel = '新内容';
const relA = optStr(args, 'relPathA');
const relB = optStr(args, 'relPathB');
if (relA && relB) {
oldText = fs.readFileSync(safeJoin(ctx.workspace, relA), 'utf-8');
newText = fs.readFileSync(safeJoin(ctx.workspace, relB), 'utf-8');
oldLabel = relA;
newLabel = relB;
} else {
oldText = reqStr(args, 'oldText');
newText = reqStr(args, 'newText');
}
const oldLines = oldText.split('\n');
const newLines = newText.split('\n');
if (oldLines.length > 5000 || newLines.length > 5000) {
throw new Error('内容过长（>5000 行），请缩小比较范围');
}
return toUnifiedDiff(oldLabel, newLabel, diffLines(oldLines, newLines));
}

async function hFileInfo(ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
const rel = reqStr(args, 'relPath');
const abs = safeJoin(ctx.workspace, rel);
const stat = fs.statSync(abs);
return JSON.stringify({
relPath: rel,
isDirectory: stat.isDirectory(),
size: stat.size,
mtime: stat.mtime.toISOString(),
createdAt: stat.birthtime.toISOString(),
ext: path.extname(rel),
});
}

async function hFileMkdir(ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
const rel = reqStr(args, 'relPath');
fs.mkdirSync(safeJoin(ctx.workspace, rel), { recursive: true});
return `已创建文件夹 ${rel}`;
}

async function hFileAppend(ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
const rel = reqStr(args, 'relPath');
const content = reqStr(args, 'content');
snapshotForUndo(ctx, rel);
const abs = safeJoin(ctx.workspace, rel);
fs.mkdirSync(path.dirname(abs), { recursive: true});
fs.appendFileSync(abs, content, 'utf-8');
return `已追加 ${content.length} 字到 ${rel}`;
}

async function hFileHash(ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
const rel = reqStr(args, 'relPath');
const abs = safeJoin(ctx.workspace, rel);
const stat = fs.statSync(abs);
if (!stat.isFile()) throw new Error('只能对文件算哈希');
const hash = crypto.createHash('sha256');
hash.update(fs.readFileSync(abs));
return JSON.stringify({ relPath: rel, sha256: hash.digest('hex'), size: stat.size});
}

async function hFileGlob(ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
const pattern = reqStr(args, 'pattern');
const re = globToRegExp(pattern);
const files = walkWorkspace(ctx.workspace);
const hits = files.filter((f) => re.test(f)).slice(0, 500);
return JSON.stringify({ pattern, count: hits.length, files: hits});
}

async function hDirTree(ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
const rel = optStr(args, 'relPath', '.');
const depth = Math.min(Math.max(1, optNum(args, 'depth', 3)), 6);
const root = safeJoin(ctx.workspace, rel);
const lines: string[] = [];
const walk = (dir: string, prefix: string, d: number): void => {
if (lines.length > 500 || d > depth) return;
let entries: fs.Dirent[];
try {
entries = fs.readdirSync(dir, { withFileTypes: true});
} catch {
return;
}
const visible = entries.filter((e) =>!(e.isDirectory() && (IGNORE_DIRS.has(e.name) || e.name.startsWith('.'))));
visible.forEach((e, i) => {
if (lines.length > 500) return;
const last = i === visible.length - 1;
lines.push(`${prefix}${last? '└─ ': '├─ '}${e.name}${e.isDirectory()? '/': ''}`);
if (e.isDirectory() && d < depth) walk(path.join(dir, e.name), `${prefix}${last? ' ': '│ '}`, d + 1);
});
};
lines.push(rel === '.'? '(工作区)': rel);
walk(root, '', 1);
return lines.join('\n');
}

async function hFileRecent(ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
const limit = Math.min(Math.max(1, optNum(args, 'limit', 20)), 50);
const files = walkWorkspace(ctx.workspace);
const withTime = files
.map((f) => {
try {
return { rel: f, mtime: fs.statSync(safeJoin(ctx.workspace, f)).mtimeMs};
} catch {
return null;
}
})
.filter((x): x is { rel: string; mtime: number} => x!== null)
.sort((a, b) => b.mtime - a.mtime)
.slice(0, limit)
.map((x) => ({ relPath: x.rel, mtime: new Date(x.mtime).toISOString()}));
return JSON.stringify(withTime);
}

async function hDocRead(ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
const rel = reqStr(args, 'relPath');
const abs = safeJoin(ctx.workspace, rel);
const result = await extractDocText(abs);
const meta = [``, result.pages!== undefined? `页数/幻灯片数：${result.pages}`: '', result.sheets? `工作表：${result.sheets.join('、')}`: '']
.filter(Boolean)
.join('\n');
return `${meta}\n\n${result.text}`;
}

async function hDocWrite(ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
const rel = reqStr(args, 'relPath');
const ext = path.extname(rel).toLowerCase();
const abs = safeJoin(ctx.workspace, rel);
fs.mkdirSync(path.dirname(abs), { recursive: true});
if (ext === '.md' || ext === '.txt' || ext === '.csv') {
snapshotForUndo(ctx, rel);
fs.writeFileSync(abs, reqStr(args, 'content'), 'utf-8');
return `已写入 ${rel}`;
}
if (ext === '.xlsx') {
const rows = args.rows;
let data: unknown[][];
if (Array.isArray(rows)) {
data = rows as unknown[][];
} else {
// Fallback: treat content as CSV text (comma-separated lines).
const content = reqStr(args, 'content');
data = content.split('\n').map((line) => line.split(',').map((c) => c.trim()));
}
const XLSX = await import('xlsx');
const ws = XLSX.utils.aoa_to_sheet(data);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
const journal = new UndoJournal(ctx.userDataDir);
journal.recordChange(rel, null, '二进制表格文件，未保存旧内容快照');
XLSX.writeFile(wb, abs);
return `已写入表格 ${rel}（${data.length} 行）`;
}
if (ext === '.docx') {
throw new Error('不支持写入.docx：只支持读取.docx（没有安装可用的 docx 写入库）；可写入.md /.txt /.csv /.xlsx');
}
throw new Error(`doc_write 不支持 ${ext || '（无扩展名）'}，支持.md /.txt /.csv /.xlsx（.docx 仅可读）`);
}

async function hWebSearch(_ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
return webSearch(reqStr(args, 'query'));
}

async function hWebFetch(_ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
return webFetch(reqStr(args, 'url'));
}

async function hGlobalSearch(ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
const pattern = reqStr(args, 'pattern');
const caseSensitive = optBool(args, 'caseSensitive', false);
const glob = optStr(args, 'glob', '');
let re: RegExp;
try {
re = new RegExp(pattern, caseSensitive? '': 'i');
} catch {
throw new Error(`不是有效的正则表达式：${pattern}`);
}
const globRe = glob? globToRegExp(glob): null;
const files = walkWorkspace(ctx.workspace);
const matches: string[] = [];
let searched = 0;
for (const rel of files) {
if (matches.length >= 200) break;
if (globRe &&!globRe.test(rel)) continue;
const abs = safeJoin(ctx.workspace, rel);
let stat: fs.Stats;
try {
stat = fs.statSync(abs);
} catch {
continue;
}
if (!stat.isFile() || stat.size > 1_000_000) continue;
if (!isTextFile(abs)) continue;
searched++;
const text = fs.readFileSync(abs, 'utf-8');
const lines = text.split('\n');
for (let i = 0; i < lines.length; i++) {
if (matches.length >= 200) break;
if (re.test(lines[i])) matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
}
}
if (matches.length === 0) return `在 ${searched} 个文件中没有找到匹配 /${pattern}/ 的内容。`;
return `在 ${searched} 个文件中找到 ${matches.length} 处匹配（最多显示 200 条）：\n${matches.join('\n')}`;
}

async function hSystemMonitor(_ctx: Tool2Context, _args: Record<string, unknown>): Promise<string> {
const s = await getSystemStatus();
return JSON.stringify(s, null, 2);
}

async function hSystemInfo(_ctx: Tool2Context, _args: Record<string, unknown>): Promise<string> {
return JSON.stringify({
platform: process.platform,
arch: process.arch,
osRelease: os.release(),
hostname: os.hostname(),
uptimeSec: Math.round(os.uptime()),
cpus: os.cpus().length,
cpuModel: os.cpus()[0]?.model?? '',
totalMem: os.totalmem(),
freeMem: os.freemem(),
nodeVersion: process.version,
}, null, 2);
}

async function hProcessKill(_ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
const pid = optNum(args, 'pid', 0);
if (!pid || pid <= 0) throw new Error('缺少有效的 pid 参数');
if (pid === process.pid) throw new Error('拒绝：不能结束数字伙伴自己的进程');
const force = optBool(args, 'force', false);
if (process.platform === 'win32') {
const r = await runProcess('taskkill', force? ['/PID', String(pid), '/F']: ['/PID', String(pid)], process.cwd(), 15_000);
if (r.code!== 0) throw new Error(`结束进程失败：${r.stderr || r.stdout}`);
return `已结束进程 ${pid}`;
}
try {
process.kill(pid, force? 'SIGKILL': 'SIGTERM');
return `已向进程 ${pid} 发送 ${force? 'SIGKILL': 'SIGTERM'}`;
} catch (e) {
throw new Error(`结束进程失败：${(e as Error).message}`);
}
}

async function hUndoLog(ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
const journal = new UndoJournal(ctx.userDataDir);
const items = journal.listChanges(Math.min(Math.max(1, optNum(args, 'limit', 50)), 200));
if (items.length === 0) return '最近 48 小时内没有文件改动记录。';
const lines = items.map((it) => `- [${it.id}] ${it.relPath}（${it.createdAt}）${it.restorable? '': '（不可撤回）'}\n 旧内容预览：${it.preview}`);
return `改动时间线（最近 48 小时，撤回期限 7 天）：\n${lines.join('\n')}`;
}

async function hUndoChange(ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
const journal = new UndoJournal(ctx.userDataDir);
const rel = journal.restore(ctx.workspace, reqStr(args, 'entryId'));
return `已撤回，恢复了 ${rel} 的旧内容`;
}

async function hWingetInstall(_ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
if (process.platform!== 'win32') {
throw new Error('winget 只在 Windows 上可用；当前系统是 ' + process.platform + '，请用系统自带的包管理器安装');
}
const packageId = reqStr(args, 'packageId');
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(packageId)) throw new Error(`不是有效的 winget 包 ID：${packageId}`);
const r = await runProcess('winget', ['install', '--id', packageId, '-e', '--accept-source-agreements', '--accept-package-agreements'], process.cwd(), 600_000);
if (r.code!== 0) throw new Error(`winget 安装失败（退出码 ${r.code}）：${(r.stderr || r.stdout).slice(0, 1000)}`);
return `已通过 winget 安装 ${packageId}\n${r.stdout.slice(0, 2000)}`;
}

async function hNpmInstall(ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
const pkg = optStr(args, 'package', '');
const cmdArgs = pkg? ['install', pkg]: ['install'];
const r = await runProcess(process.platform === 'win32'? 'npm.cmd': 'npm', cmdArgs, ctx.workspace, 600_000);
if (r.code!== 0) throw new Error(`npm install 失败（退出码 ${r.code}）：${(r.stderr || r.stdout).slice(0, 1000)}`);
return `npm install ${pkg || '(全部依赖)'} 完成\n${r.stdout.slice(-2000)}`;
}

async function hPipInstall(ctx: Tool2Context, args: Record<string, unknown>): Promise<string> {
const pkg = reqStr(args, 'package');
const exe = process.platform === 'win32'? 'python': 'python3';
const r = await runProcess(exe, ['-m', 'pip', 'install', pkg], ctx.workspace, 600_000);
if (r.code!== 0) throw new Error(`pip install 失败（退出码 ${r.code}）：${(r.stderr || r.stdout).slice(0, 1000)}`);
return `pip install ${pkg} 完成\n${r.stdout.slice(-2000)}`;
}

// ------------------------------------------------------------- tool defs ----

export const TOOL2_DEFS: ToolDef[] = [
{ type: 'function', function: { name: 'file_copy', description: '复制工作区内的单个文件（目标已存在会被覆盖，需用户确认）', parameters: { type: 'object', properties: { relPath: { type: 'string'}, destPath: { type: 'string'}}, required: ['relPath', 'destPath']}}},
{ type: 'function', function: { name: 'file_move', description: '移动/重命名工作区内的文件或文件夹（需用户确认）', parameters: { type: 'object', properties: { relPath: { type: 'string'}, destPath: { type: 'string'}}, required: ['relPath', 'destPath']}}},
{ type: 'function', function: { name: 'file_delete', description: '删除工作区内的文件；删文件夹需 recursive=true（需用户确认，可撤回）', parameters: { type: 'object', properties: { relPath: { type: 'string'}, recursive: { type: 'boolean'}}, required: ['relPath']}}},
{ type: 'function', function: { name: 'file_read_paged', description: '分页读大文件：按行号 offset 取 lines 行（最多 500 行/次）', parameters: { type: 'object', properties: { relPath: { type: 'string'}, offset: { type: 'number'}, lines: { type: 'number'}}, required: ['relPath']}}},
{ type: 'function', function: { name: 'file_diff', description: '比较两段文本（oldText/newText）或两个文件（relPathA/relPathB），返回 unified diff', parameters: { type: 'object', properties: { oldText: { type: 'string'}, newText: { type: 'string'}, relPathA: { type: 'string'}, relPathB: { type: 'string'}}}}},
{ type: 'function', function: { name: 'file_info', description: '查看文件/文件夹信息：大小、修改时间、类型', parameters: { type: 'object', properties: { relPath: { type: 'string'}}, required: ['relPath']}}},
{ type: 'function', function: { name: 'file_mkdir', description: '在工作区内创建文件夹（自动建父目录）', parameters: { type: 'object', properties: { relPath: { type: 'string'}}, required: ['relPath']}}},
{ type: 'function', function: { name: 'file_append', description: '向文件末尾追加文本（需用户确认，可撤回）', parameters: { type: 'object', properties: { relPath: { type: 'string'}, content: { type: 'string'}}, required: ['relPath', 'content']}}},
{ type: 'function', function: { name: 'file_hash', description: '算文件的 SHA-256 哈希（核对文件是否被改过）', parameters: { type: 'object', properties: { relPath: { type: 'string'}}, required: ['relPath']}}},
{ type: 'function', function: { name: 'file_glob', description: '按 glob 模式在工作区找文件，如 **/*.md、src/*.ts', parameters: { type: 'object', properties: { pattern: { type: 'string'}}, required: ['pattern']}}},
{ type: 'function', function: { name: 'dir_tree', description: '以树形列出某文件夹结构（默认深度 3）', parameters: { type: 'object', properties: { relPath: { type: 'string'}, depth: { type: 'number'}}}}},
{ type: 'function', function: { name: 'file_recent', description: '列出工作区最近修改过的文件（默认 20 个）', parameters: { type: 'object', properties: { limit: { type: 'number'}}}}},
{ type: 'function', function: { name: 'doc_read', description: '读文档为纯文本：PDF / Word(.docx) / Excel(.xlsx/.xls) / PPT(.pptx) / md/txt/csv', parameters: { type: 'object', properties: { relPath: { type: 'string'}}, required: ['relPath']}}},
{ type: 'function', function: { name: 'doc_write', description: '写文档：.md/.txt/.csv 写文本；.xlsx 写表格（rows 为二维数组，或 content 按 CSV 解析）；.docx 只读不可写（需用户确认）', parameters: { type: 'object', properties: { relPath: { type: 'string'}, content: { type: 'string'}, rows: { type: 'array', items: { type: 'array', items: {}}}}, required: ['relPath']}}},
{ type: 'function', function: { name: 'web_search', description: '联网搜索（DuckDuckGo），返回标题、链接和摘要', parameters: { type: 'object', properties: { query: { type: 'string'}}, required: ['query']}}},
{ type: 'function', function: { name: 'web_fetch', description: '抓取一个 http/https 网页的正文文本', parameters: { type: 'object', properties: { url: { type: 'string'}}, required: ['url']}}},
{ type: 'function', function: { name: 'global_search', description: '在工作区全文搜索（支持正则），返回 文件:行号:内容，可用 glob 限定文件', parameters: { type: 'object', properties: { pattern: { type: 'string'}, caseSensitive: { type: 'boolean'}, glob: { type: 'string'}}, required: ['pattern']}}},
{ type: 'function', function: { name: 'system_monitor', description: '查看系统状态：CPU 负载、内存、磁盘、占用内存最多的进程', parameters: { type: 'object', properties: {}}}},
{ type: 'function', function: { name: 'system_info', description: '查看系统信息：平台、CPU 型号、运行时间、Node 版本', parameters: { type: 'object', properties: {}}}},
{ type: 'function', function: { name: 'process_kill', description: '结束一个进程（按 pid；force=true 强制结束，需用户确认）', parameters: { type: 'object', properties: { pid: { type: 'number'}, force: { type: 'boolean'}}, required: ['pid']}}},
{ type: 'function', function: { name: 'undo_log', description: '查看文件改动时间线（最近 48 小时，撤回期限 7 天）', parameters: { type: 'object', properties: { limit: { type: 'number'}}}}},
{ type: 'function', function: { name: 'undo_change', description: '撤回一条改动，把文件恢复成旧内容（需用户确认）', parameters: { type: 'object', properties: { entryId: { type: 'string'}}, required: ['entryId']}}},
{ type: 'function', function: { name: 'winget_install', description: '用 winget 安装 Windows 软件（仅 Windows，需用户确认）', parameters: { type: 'object', properties: { packageId: { type: 'string'}}, required: ['packageId']}}},
{ type: 'function', function: { name: 'npm_install', description: '在工作区执行 npm install（可带包名，需用户确认）', parameters: { type: 'object', properties: { package: { type: 'string'}}}}},
{ type: 'function', function: { name: 'pip_install', description: '用 pip 安装 Python 包（需用户确认）', parameters: { type: 'object', properties: { package: { type: 'string'}}, required: ['package']}}},
];

/** Destructive tools must be gated by the UI approval flow before running. */
export const TOOL2_META: Record<string, { needsApproval: boolean}> = {
file_copy: { needsApproval: true},
file_move: { needsApproval: true},
file_delete: { needsApproval: true},
file_read_paged: { needsApproval: false},
file_diff: { needsApproval: false},
file_info: { needsApproval: false},
file_mkdir: { needsApproval: false},
file_append: { needsApproval: true},
file_hash: { needsApproval: false},
file_glob: { needsApproval: false},
dir_tree: { needsApproval: false},
file_recent: { needsApproval: false},
doc_read: { needsApproval: false},
doc_write: { needsApproval: true},
web_search: { needsApproval: false},
web_fetch: { needsApproval: false},
global_search: { needsApproval: false},
system_monitor: { needsApproval: false},
system_info: { needsApproval: false},
process_kill: { needsApproval: true},
undo_log: { needsApproval: false},
undo_change: { needsApproval: true},
winget_install: { needsApproval: true},
npm_install: { needsApproval: true},
pip_install: { needsApproval: true},
};

/** Dispatch a Phase-1 tool by name. Throws on unknown tools. Callers must
* check TOOL2_META[name].needsApproval and get user confirmation first. */
export async function executeTool2(
name: string,
args: Record<string, unknown>,
ctx: Tool2Context,
): Promise<string> {
switch (name) {
case 'file_copy': return hFileCopy(ctx, args);
case 'file_move': return hFileMove(ctx, args);
case 'file_delete': return hFileDelete(ctx, args);
case 'file_read_paged': return hFileReadPaged(ctx, args);
case 'file_diff': return hFileDiff(ctx, args);
case 'file_info': return hFileInfo(ctx, args);
case 'file_mkdir': return hFileMkdir(ctx, args);
case 'file_append': return hFileAppend(ctx, args);
case 'file_hash': return hFileHash(ctx, args);
case 'file_glob': return hFileGlob(ctx, args);
case 'dir_tree': return hDirTree(ctx, args);
case 'file_recent': return hFileRecent(ctx, args);
case 'doc_read': return hDocRead(ctx, args);
case 'doc_write': return hDocWrite(ctx, args);
case 'web_search': return hWebSearch(ctx, args);
case 'web_fetch': return hWebFetch(ctx, args);
case 'global_search': return hGlobalSearch(ctx, args);
case 'system_monitor': return hSystemMonitor(ctx, args);
case 'system_info': return hSystemInfo(ctx, args);
case 'process_kill': return hProcessKill(ctx, args);
case 'undo_log': return hUndoLog(ctx, args);
case 'undo_change': return hUndoChange(ctx, args);
case 'winget_install': return hWingetInstall(ctx, args);
case 'npm_install': return hNpmInstall(ctx, args);
case 'pip_install': return hPipInstall(ctx, args);
default: throw new Error(`未知工具：${name}`);
}
}
