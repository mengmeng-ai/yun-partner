/**
 * Local semantic-ish recall (Phase 2, clean-room).
 *
 * TF-IDF over memory items + Wiki pages + recent chat, cosine similarity.
 * NO paid API, NO model download, NO true embeddings.
 *
 * What this is: lexical TF-IDF. It ranks by shared wording, weighted by how
 * rare each token is across the corpus. It does NOT understand meaning:
 * synonyms, paraphrases and differently-worded facts will NOT match unless
 * they share tokens. Chinese is tokenized as overlapping character bigrams
 * (e.g. "喜欢紫色" -> 喜欢 / 欢紫 / 紫色); latin text as lowercase words.
 *
 * Pure functions only — no Electron, no disk, no network — so they are
 * unit-testable in plain Node.
 */

export interface SearchItem {
  id: string;
  text: string;
}

export interface SearchResult {
  id: string;
  text: string;
  /** Cosine similarity, 0..1. 0 means no shared tokens at all. */
  score: number;
}

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const LATIN_WORD_RE = /[a-z0-9_]+/g;

/**
 * Tokenize text into Chinese character bigrams + lowercase latin words.
 * Punctuation and whitespace are dropped; bigrams span only consecutive
 * CJK characters (punctuation breaks the run).
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  for (const m of lower.matchAll(LATIN_WORD_RE)) {
    tokens.push(m[0]);
  }
  const cjk: string[] = [];
  for (const ch of lower) {
    if (CJK_RE.test(ch)) cjk.push(ch);
  }
  for (let i = 0; i + 1 < cjk.length; i++) {
    tokens.push(cjk[i] + cjk[i + 1]);
  }
  return tokens;
}

/** Function words that carry no tagging value, dropped by extractKeywords. */
const STOP_TOKENS = new Set([
  // chinese bigrams made of function words
  '的是', '了的', '是在', '和的', '有的', '没有', '这个', '那个',
  '我们', '你们', '他们', '她们', '它们', '什么', '怎么', '这样',
  '那样', '这里', '那里', '一个', '一下', '一点', '一些', '可以',
  '应该', '就是', '还是', '不是', '但是', '然后', '所以', '如果',
  // english stopwords
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has',
  'will', 'would', 'your', 'you', 'are', 'was', 'were', 'been', 'into',
  'about', 'when', 'what', 'which', 'there', 'their', 'they', 'them',
]);

/**
 * Auto-tagging: the most frequent non-stopword tokens in the text.
 * Frequency-only heuristic — no corpus, no IDF here. Returns at most
 * `topN` tokens, most frequent first.
 */
export function extractKeywords(text: string, topN = 8): string[] {
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  tokenize(text).forEach((t, i) => {
    if (STOP_TOKENS.has(t)) return;
    if (!counts.has(t)) firstSeen.set(t, i);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  });
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (firstSeen.get(a[0]) ?? 0) - (firstSeen.get(b[0]) ?? 0))
    .slice(0, Math.max(0, topN))
    .map(([t]) => t);
}

type Vector = Map<string, number>;

function toVector(tokens: string[], idf: (token: string) => number): Vector {
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  const total = tokens.length || 1;
  const v: Vector = new Map();
  for (const [t, c] of counts) v.set(t, (c / total) * idf(t));
  return v;
}

function norm(v: Vector): number {
  let s = 0;
  for (const x of v.values()) s += x * x;
  return Math.sqrt(s);
}

/**
 * Rank `items` by cosine similarity between the query and each item's
 * TF-IDF vector. Returns at most `topK` results with score > 0,
 * best first. Empty query or empty item list returns [].
 *
 * Limits: lexical only (see header). Very short items (1-2 tokens) can
 * score high on a single shared token; scores are comparable within one
 * call, not across different corpora.
 */
export function searchSemantic(
  query: string,
  items: SearchItem[],
  topK = 5,
): SearchResult[] {
  const qTokens = tokenize(query);
  if (qTokens.length === 0 || items.length === 0) return [];

  const docs = items.map((it) => tokenize(it.text));
  const df = new Map<string, number>();
  for (const d of docs) {
    for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = docs.length;
  const idf = (t: string) => Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1;

  const qv = toVector(qTokens, idf);
  const qNorm = norm(qv);
  if (qNorm === 0) return [];

  const results: SearchResult[] = [];
  docs.forEach((d, i) => {
    const dv = toVector(d, idf);
    let dot = 0;
    for (const [t, w] of qv) {
      const dw = dv.get(t);
      if (dw !== undefined) dot += w * dw;
    }
    const dNorm = norm(dv);
    const score = dNorm === 0 ? 0 : dot / (qNorm * dNorm);
    if (score > 0) results.push({ id: items[i].id, text: items[i].text, score });
  });

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, topK));
}
