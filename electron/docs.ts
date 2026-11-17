// Document text extraction (Phase 1): PDF / Word / Excel / PowerPoint / plain text.
// Clean-room: uses only public npm libraries (pdf-parse, mammoth, xlsx) plus a
// hand-written minimal ZIP reader for.pptx. Never invents content: if a format
// cannot be read, it throws a clear error instead of returning fake text.
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

export interface DocTextResult {
text: string;
pages?: number;
sheets?: string[];
}

/** Cap extracted text so one huge document cannot blow up the chat context. */
const MAX_TEXT_CHARS = 500_000;

function cap(text: string): string {
if (text.length <= MAX_TEXT_CHARS) return text;
return `${text.slice(0, MAX_TEXT_CHARS)}\n\n…（内容过长，已截断前 ${MAX_TEXT_CHARS} 字）`;
}

// ---------------------------------------------------------------- PDF ----

interface PdfParseResult {
text: string;
total: number;
pages: { text: string; num: number}[];
}

async function extractPdf(absPath: string): Promise<DocTextResult> {
const data = fs.readFileSync(absPath);
try {
// pdf-parse v2 API: class constructor + getText(). Imported dynamically so a
// broken install degrades to the minimal fallback below instead of crashing
// the whole tools module at load time.
const { PDFParse} = await import('pdf-parse');
const parser = new PDFParse({ data});
const result = (await parser.getText()) as unknown as PdfParseResult;
const text = (result.text?? '').trim();
if (!text) throw new Error('pdf-parse 返回了空文本');
return { text: cap(text), pages: result.total};
} catch (err) {
// Minimal fallback: pull literal strings out of UNCOMPRESSED content streams.
// Compressed/encoded streams cannot be read this way — report that honestly.
const text = extractPdfUncompressed(data);
if (text.trim()) return { text: cap(text.trim())};
throw new Error(
`PDF 文本提取失败：${(err as Error).message}。该 PDF 的文本流是压缩或编码的，无法用内置方式提取，请用可复制文本的 PDF 或另存为.docx/.txt 后再读。`,
);
}
}

/** Last-resort reader for PDFs whose content streams are stored uncompressed. */
function extractPdfUncompressed(data: Buffer): string {
const raw = data.toString('latin1');
const chunks: string[] = [];
const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
let m: RegExpExecArray | null;
while ((m = streamRe.exec(raw))!== null) {
const stream = m[1];
// Literal strings shown with Tj, and arrays shown with TJ.
const tjRe = /\(((?:\\.|[^\\()])*)\)\s*Tj/g;
let t: RegExpExecArray | null;
while ((t = tjRe.exec(stream))!== null) chunks.push(unescapePdfString(t[1]));
const tjArrRe = /\[((?:[^\]\\]|\\.)*)\]\s*TJ/g;
let a: RegExpExecArray | null;
while ((a = tjArrRe.exec(stream))!== null) {
const parts: string[] = [];
const strRe = /\(((?:\\.|[^\\()])*)\)/g;
let s: RegExpExecArray | null;
while ((s = strRe.exec(a[1]))!== null) parts.push(unescapePdfString(s[1]));
chunks.push(parts.join(''));
}
}
return chunks.join('\n');
}

function unescapePdfString(inner: string): string {
// inner is the raw content of a PDF literal string (parens already stripped).
return inner
.replace(/\\([0-7]{1,3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)))
.replace(/\\n/g, '\n')
.replace(/\\r/g, '\r')
.replace(/\\t/g, '\t')
.replace(/\\\(/g, '(')
.replace(/\\\)/g, ')')
.replace(/\\\\/g, '\\');
}

// --------------------------------------------------------------- DOCX ----

async function extractDocx(absPath: string): Promise<DocTextResult> {
const mammoth = await import('mammoth');
const result = await mammoth.extractRawText({ path: absPath});
const text = (result.value?? '').trim();
if (!text) throw new Error('该.docx 文档中没有可提取的文本');
return { text: cap(text)};
}

// --------------------------------------------------------------- XLSX ----

async function extractXlsx(absPath: string): Promise<DocTextResult> {
const XLSX = await import('xlsx');
const wb = XLSX.readFile(absPath, { type: 'file'});
const sheets = wb.SheetNames;
const parts: string[] = [];
for (const name of sheets) {
const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
parts.push(`\n${csv.trim()}`);
}
const text = parts.join('\n\n').trim();
if (!text) throw new Error('该表格文件中没有可提取的内容');
return { text: cap(text), sheets};
}

// --------------------------------------------------------------- PPTX ----
// Minimal ZIP reader (stored + deflate entries only) — no extra dependency.
// PPTX is a ZIP of XML parts; slide text lives in <a:t> runs in
// ppt/slides/slideN.xml.

interface ZipEntry {
name: string;
method: number;
compressedSize: number;
localHeaderOffset: number;
}

function readZipEntries(buf: Buffer): ZipEntry[] {
// Find End Of Central Directory record (search last 64KB).
const tailStart = Math.max(0, buf.length - 65557);
let eocd = -1;
for (let i = buf.length - 22; i >= tailStart; i--) {
if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break;}
}
if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到中央目录）');
const count = buf.readUInt16LE(eocd + 10);
let offset = buf.readUInt32LE(eocd + 16);
const entries: ZipEntry[] = [];
for (let n = 0; n < count; n++) {
if (buf.readUInt32LE(offset)!== 0x02014b50) break;
const method = buf.readUInt16LE(offset + 10);
const compressedSize = buf.readUInt32LE(offset + 20);
const nameLen = buf.readUInt16LE(offset + 28);
const extraLen = buf.readUInt16LE(offset + 30);
const commentLen = buf.readUInt16LE(offset + 32);
const localHeaderOffset = buf.readUInt32LE(offset + 42);
const name = buf.toString('utf-8', offset + 46, offset + 46 + nameLen);
entries.push({ name, method, compressedSize, localHeaderOffset});
offset += 46 + nameLen + extraLen + commentLen;
}
return entries;
}

function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
const lh = entry.localHeaderOffset;
if (buf.readUInt32LE(lh)!== 0x04034b50) throw new Error('ZIP 本地文件头损坏');
const nameLen = buf.readUInt16LE(lh + 26);
const extraLen = buf.readUInt16LE(lh + 28);
const dataStart = lh + 30 + nameLen + extraLen;
const data = buf.subarray(dataStart, dataStart + entry.compressedSize);
if (entry.method === 0) return Buffer.from(data);
if (entry.method === 8) return zlib.inflateRawSync(data);
throw new Error(`ZIP 压缩方式 ${entry.method} 不支持`);
}

function extractPptx(absPath: string): DocTextResult {
const buf = fs.readFileSync(absPath);
const entries = readZipEntries(buf);
const slides = entries
.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
.sort((a, b) => {
const na = parseInt(a.name.match(/slide(\d+)\.xml$/)?.[1]?? '0', 10);
const nb = parseInt(b.name.match(/slide(\d+)\.xml$/)?.[1]?? '0', 10);
return na - nb;
});
if (slides.length === 0) throw new Error('该.pptx 中没有找到幻灯片');
const parts: string[] = [];
slides.forEach((entry, i) => {
const xml = readZipEntry(buf, entry).toString('utf-8');
const runs: string[] = [];
const runRe = /<a:t>([\s\S]*?)<\/a:t>/g;
let r: RegExpExecArray | null;
while ((r = runRe.exec(xml))!== null) {
runs.push(r[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
}
parts.push(`\n${runs.join('\n')}`);
});
const text = parts.join('\n\n').trim();
if (!parts.some((part) => part.replace(/【幻灯片 \d+】/g, '').trim())) throw new Error('该.pptx 的幻灯片中没有可提取的文本');
return { text: cap(text), pages: slides.length};
}

// ------------------------------------------------------------------ main ----

/**
* Extract plain text from a document file. Supports.pdf,.docx,.xlsx/.xls,
*.pptx, and plain-text formats (.md/.txt/.csv). Throws a clear, honest error
* for unsupported or unreadable files — never returns invented content.
*/
export async function extractDocText(absPath: string): Promise<DocTextResult> {
const ext = path.extname(absPath).toLowerCase();
switch (ext) {
case '.pdf':
return extractPdf(absPath);
case '.docx':
return extractDocx(absPath);
case '.xlsx':
case '.xls':
return extractXlsx(absPath);
case '.pptx':
return extractPptx(absPath);
case '.md':
case '.txt':
case '.csv':
return { text: cap(fs.readFileSync(absPath, 'utf-8'))};
case '.doc':
throw new Error('不支持.doc（旧版 Word 二进制格式），请在 Word/WPS 里另存为.docx 后再读');
case '.ppt':
throw new Error('不支持.ppt（旧版 PowerPoint 二进制格式），请另存为.pptx 后再读');
default:
throw new Error(`不支持的文档格式：${ext || '（无扩展名）'}，支持.pdf /.docx /.xlsx /.xls /.pptx /.md /.txt /.csv`);
}
}
