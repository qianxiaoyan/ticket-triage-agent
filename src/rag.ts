import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KbChunk, ScoredChunk } from './types.ts';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'our', 'with', 'this', 'that', 'from',
  'have', 'has', 'had', 'was', 'were', 'will', 'would', 'can', 'could', 'should', 'about', 'into',
  'when', 'what', 'which', 'who', 'how', 'why', 'all', 'any', 'been', 'being', 'they', 'them',
  'their', 'there', 'than', 'then', 'also', 'just', 'get', 'got', 'may', 'might', 'must',
]);

const MAX_SECTION_CHARS = 900;
const EMBED_DIMS = 256;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function splitLongSection(text: string): string[] {
  if (text.length <= MAX_SECTION_CHARS) return [text];
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: string[] = [];
  let buffer = '';
  for (const paragraph of paragraphs) {
    if (buffer.length + paragraph.length + 2 > MAX_SECTION_CHARS && buffer) {
      out.push(buffer.trim());
      buffer = '';
    }
    buffer += paragraph + '\n\n';
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

export function chunkMarkdown(docId: string, docTitle: string, raw: string): KbChunk[] {
  const sections: Array<{ heading: string; body: string }> = [];
  let currentHeading = docTitle;
  let currentBody: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const headingMatch = /^##\s+(.*)$/.exec(line);
    if (headingMatch) {
      if (currentBody.join('\n').trim()) {
        sections.push({ heading: currentHeading, body: currentBody.join('\n').trim() });
      }
      currentHeading = headingMatch[1].trim();
      currentBody = [];
    } else if (!/^#\s+/.test(line)) {
      currentBody.push(line);
    }
  }
  if (currentBody.join('\n').trim()) {
    sections.push({ heading: currentHeading, body: currentBody.join('\n').trim() });
  }

  const chunks: KbChunk[] = [];
  for (const section of sections) {
    const parts = splitLongSection(section.body);
    parts.forEach((part, index) => {
      chunks.push({
        id: `${docId}#${slug(section.heading)}${parts.length > 1 ? `-${index + 1}` : ''}`,
        docId,
        docTitle,
        heading: section.heading,
        text: part,
      });
    });
  }
  return chunks;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let i = 0; i < token.length; i += 1) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % EMBED_DIMS;
}

/**
 * Deterministic feature-hashing embedding.
 * Keeps the demo runnable with zero network calls and zero cost, while still
 * behaving like a real vector index (cosine similarity over normalized vectors).
 * Swap this for a hosted embedding model by implementing the same interface.
 */
export function embed(text: string): Float64Array {
  const vector = new Float64Array(EMBED_DIMS);
  const tokens = tokenize(text);
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const [token, count] of counts) {
    vector[hashToken(token)] += 1 + Math.log(count);
    vector[hashToken(`b:${token}`)] += 0.35;
  }
  let norm = 0;
  for (let i = 0; i < EMBED_DIMS; i += 1) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIMS; i += 1) vector[i] /= norm;
  return vector;
}

function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

interface IndexedChunk {
  chunk: KbChunk;
  vector: Float64Array;
  terms: Map<string, number>;
  length: number;
}

export class Retriever {
  private readonly indexed: IndexedChunk[] = [];
  private readonly df = new Map<string, number>();
  private readonly avgLength: number;

  private constructor(chunks: KbChunk[]) {
    let totalLength = 0;
    for (const chunk of chunks) {
      const tokens = tokenize(`${chunk.docTitle} ${chunk.heading} ${chunk.text}`);
      const terms = new Map<string, number>();
      for (const token of tokens) terms.set(token, (terms.get(token) ?? 0) + 1);
      for (const token of new Set(tokens)) this.df.set(token, (this.df.get(token) ?? 0) + 1);
      totalLength += tokens.length;
      this.indexed.push({
        chunk,
        vector: embed(`${chunk.docTitle} ${chunk.heading} ${chunk.text}`),
        terms,
        length: tokens.length,
      });
    }
    this.avgLength = this.indexed.length ? totalLength / this.indexed.length : 1;
  }

  static fromChunks(chunks: KbChunk[]): Retriever {
    return new Retriever(chunks);
  }

  static async load(directory: string): Promise<Retriever> {
    const files = (await readdir(directory)).filter((file) => file.endsWith('.md')).sort();
    const chunks: KbChunk[] = [];
    for (const file of files) {
      const raw = await readFile(join(directory, file), 'utf8');
      const docId = file.replace(/\.md$/, '');
      const titleMatch = /^#\s+(.*)$/m.exec(raw);
      const docTitle = titleMatch ? titleMatch[1].trim() : docId;
      chunks.push(...chunkMarkdown(docId, docTitle, raw));
    }
    return new Retriever(chunks);
  }

  private bm25(queryTerms: string[], chunk: IndexedChunk): number {
    const k1 = 1.2;
    const b = 0.75;
    const total = this.indexed.length;
    let score = 0;
    for (const term of queryTerms) {
      const tf = chunk.terms.get(term);
      if (!tf) continue;
      const df = this.df.get(term) ?? 0;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
      const denominator = tf + k1 * (1 - b + (b * chunk.length) / this.avgLength);
      score += idf * ((tf * (k1 + 1)) / denominator);
    }
    return score;
  }

  search(query: string, k = 4): ScoredChunk[] {
    const queryTerms = tokenize(query);
    if (!queryTerms.length) return [];
    const queryVector = embed(query);
    const scored = this.indexed.map((entry) => ({
      chunk: entry.chunk,
      semantic: cosine(queryVector, entry.vector),
      lexical: this.bm25(queryTerms, entry),
    }));

    const maxLexical = Math.max(...scored.map((item) => item.lexical), 0.0001);
    return scored
      .map((item) => ({
        ...item.chunk,
        semantic: item.semantic,
        lexical: item.lexical,
        score: 0.55 * item.semantic + 0.45 * (item.lexical / maxLexical),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  byId(id: string): KbChunk | undefined {
    return this.indexed.find((entry) => entry.chunk.id === id)?.chunk;
  }

  get size(): number {
    return this.indexed.length;
  }
}
