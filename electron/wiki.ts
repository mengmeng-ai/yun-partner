/**
* Wiki cross-links + lint (Phase 2, clean-room).
*
* Operates on passed-in WikiPage arrays only. Stores nothing new on disk
* beyond what store.ts already does.
*
* - links: resolved [[wikilink]] / [text](target.md) edges, {from, to}
* where `to` is a page id. Links to pages that do not exist are ignored
* (they are not edges); use `extractLinkTargets` to inspect raw targets.
* - orphans: pages with no incoming links from any other page.
* - contradictions: HEURISTIC only. Detects (a) duplicate titles,
* (b) the same subject stated both "是 X" and "不是 X" in one page,
* (c) a subject restated with "改为/改成" while the old "是 X" line is
* still present. This is string matching, not understanding — it will
* miss real contradictions phrased differently and can flag phrasing
* that is not actually contradictory. Treat every hit as "check this",
* never as proof.
* - stale: pages whose updatedAt is older than 90 days (or unparseable).
*/

import type { WikiPage} from './types';

export interface WikiLink {
from: string; // page id
to: string; // page id
}

export interface WikiGraph {
links: WikiLink[];
/** Page ids with no incoming links from any other page. */
orphans: string[];
/** Heuristic contradiction flags (see header). Human-readable strings. */
contradictions: string[];
/** Page ids not updated in 90 days (or with an unparseable date). */
stale: string[];
}

const STALE_DAYS = 90;

/** Raw link targets found in a page body: [[目标]] and [文本](目标.md). */
export function extractLinkTargets(body: string): string[] {
const targets: string[] = [];
for (const m of body.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
targets.push(m[1].trim());
}
for (const m of body.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
targets.push(m[1].trim().replace(/\.md$/i, ''));
}
return targets;
}

function normalizeKey(s: string): string {
return s.trim().toLowerCase().replace(/[。；;，,\s]+$/g, '');
}

export function buildWikiGraph(pages: WikiPage[], now: Date = new Date()): WikiGraph {
const byKey = new Map<string, WikiPage>();
for (const p of pages) {
byKey.set(normalizeKey(p.id), p);
byKey.set(normalizeKey(p.title), p);
}

// --- links ---
const links: WikiLink[] = [];
const incoming = new Map<string, number>();
for (const p of pages) incoming.set(p.id, 0);
for (const p of pages) {
const seen = new Set<string>();
for (const target of extractLinkTargets(p.body)) {
const hit = byKey.get(normalizeKey(target));
if (!hit || hit.id === p.id || seen.has(hit.id)) continue;
seen.add(hit.id);
links.push({ from: p.id, to: hit.id});
incoming.set(hit.id, (incoming.get(hit.id)?? 0) + 1);
}
}

const orphans = pages
.filter((p) => (incoming.get(p.id)?? 0) === 0)
.map((p) => p.id);

// --- stale ---
const staleCutoff = now.getTime() - STALE_DAYS * 24 * 60 * 60 * 1000;
const stale = pages
.filter((p) => {
const t = Date.parse(p.updatedAt);
return Number.isNaN(t) || t < staleCutoff;
})
.map((p) => p.id);

// --- contradictions (heuristic) ---
const contradictions: string[] = [];

// (a) duplicate titles
const byTitle = new Map<string, WikiPage[]>();
for (const p of pages) {
const key = normalizeKey(p.title);
const arr = byTitle.get(key)?? [];
arr.push(p);
byTitle.set(key, arr);
}
for (const [title, group] of byTitle) {
if (group.length > 1) {
contradictions.push(
`标题重复：「${title}」（${group.map((g) => g.id).join('、')}）——可能是同一主题被记了两次`,
);
}
}

// (b) + (c) per-page statement scan
const isStmt = /^\s*(.{1,30}?)\s*(不是|是)\s*(.+?)\s*$/;
const changeStmt = /^\s*(.{1,30}?)\s*(?:被)?\s*(改为|改成)\s*(.+?)\s*$/;
for (const p of pages) {
const positive = new Map<string, Set<string>>();
const negative = new Map<string, Set<string>>();
const changedTo = new Map<string, Set<string>>();
for (const line of p.body.split('\n')) {
const ch = line.match(changeStmt);
if (ch) {
const s = normalizeKey(ch[1]);
const v = normalizeKey(ch[3]);
const set = changedTo.get(s)?? new Set<string>();
set.add(v);
changedTo.set(s, set);
continue;
}
const st = line.match(isStmt);
if (st) {
const s = normalizeKey(st[1]);
const v = normalizeKey(st[3]);
const map = st[2] === '不是'? negative: positive;
const set = map.get(s)?? new Set<string>();
set.add(v);
map.set(s, set);
}
}
for (const [subject, pos] of positive) {
const neg = negative.get(subject);
if (neg) {
for (const v of pos) {
if (neg.has(v)) {
contradictions.push(
`「${p.title}」：关于「${subject}」的说法冲突——既说「是 ${v}」，又说「不是 ${v}」`,
);
}
}
}
const changed = changedTo.get(subject);
if (changed) {
for (const v of pos) {
for (const nv of changed) {
if (v!== nv) {
contradictions.push(
`「${p.title}」：「${subject}」已改为「${nv}」，但旧说法「是 ${v}」还在——可能没清理干净`,
);
}
}
}
}
}
}

return { links, orphans, contradictions, stale};
}
