import { encode } from 'gpt-tokenizer';
import { ParsedNote } from './parser';

export interface Chunk {
  notePath: string;
  headingPath: string;
  text: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
}

interface ChunkOptions {
  maxTokens?: number;
  overlapTokens?: number;
}

const tokens = (s: string) => encode(s).length;

export function chunkNote(note: ParsedNote, options: ChunkOptions = {}): Chunk[] {
  const max = options.maxTokens ?? 400;
  const overlap = options.overlapTokens ?? 0;
    // Chunk the INDEX body, not the raw body: blocks marked with the
  // index-exclude marker are navigation aids and must not enter the search space.
  const source = note.indexBody ?? note.body;
  const lines = source.split('\n');
  const sections = splitByHeadings(lines);
  const chunks: Chunk[] = [];

  for (const sec of sections) {
    const text = sec.lines.join('\n').trim();
    if (!text) continue;
    if (tokens(text) <= max) {
      chunks.push({
        notePath: note.path,
        headingPath: sec.headingPath,
        text,
        startLine: sec.startLine,
        endLine: sec.endLine,
        tokenCount: tokens(text),
      });
    } else {
      chunks.push(...splitByParagraphs(text, sec.headingPath, note.path, sec.startLine, max, overlap));
    }
  }

  // Drop heading-only fragments. A section whose entire body is `## Title` has
  // no content to retrieve; the title already lives in headingPath, so indexing it
  // again only adds noise. Real short prose is kept — a one-line fact is a fact.
  const usable = chunks.filter((c) => !isHeadingOnly(c.text));

  // The fallback only applies when the original split produced NOTHING (an empty
  // body). If sections existed but every one was heading-only, the correct answer
  // is zero chunks: the note genuinely has no retrievable content, and returning
  // the whole body would re-introduce exactly the fragments just filtered out.
  if (usable.length > 0) return usable;
  if (chunks.length > 0) return [];

  const body = source.trim();
  if (!body) return [];

  return [
    {
      notePath: note.path,
      headingPath: '',
      text: body,
      startLine: 0,
      endLine: lines.length,
      tokenCount: tokens(body),
    },
  ];
}

interface Section {
  headingPath: string;
  lines: string[];
  startLine: number;
  endLine: number;
}


/** True when a chunk has no content beyond heading lines and blank lines. */
function isHeadingOnly(text: string): boolean {
  const rest = text
    .split('\n')
    .filter((l) => !/^\s{0,3}#{1,6}\s/.test(l))
    .join('')
    .trim();
  return rest.length === 0;
}

/**
 * Split a note body into heading-delimited sections.
 *
 * FENCE TRACKING — why this exists
 * --------------------------------
 * Without it, every `# comment` inside a fenced code block is treated as a
 * Markdown heading. Real damage observed in this vault on 2026-10-21: a bash block
 * containing `# -> D:\\qmd-global\\node_modules\\...` produced headingPath values
 * equal to that path, which then took part in retrieval scoring. bash, YAML,
 * Dockerfile, Python and TOML all use `#` for comments, so exposure grows with
 * every note that documents a command.
 *
 * Two CommonMark details matter and are easy to get wrong:
 *   1. A fence may be indented up to 3 spaces. Four or more spaces is an INDENTED
 *      code block, not a fence — hence `^ {0,3}`, which is required, not cosmetic.
 *   2. A fence opened with ``` can only be closed by ``` of at least the same
 *      length; a `~~~` line inside it is literal text. Tracking both the marker
 *      character and its length prevents a wrong-character line closing a block.
 */
function splitByHeadings(lines: string[]): Section[] {
  const sections: Section[] = [];
  let stack: string[] = [];
  let buf: string[] = [];
  let start = 0;
  let fenceChar = '';
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/);

    if (fence) {
      const marker = fence[1];
      if (!fenceChar) {
        fenceChar = marker[0];
        fenceLen = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLen) {
        fenceChar = '';
        fenceLen = 0;
      }
      buf.push(line);
      continue;
    }

    if (fenceChar) {
      buf.push(line); // inside a fence: no line may open a section
      continue;
    }

    const h1 = line.match(/^#\s+(.+)$/);
    const h2 = !h1 ? line.match(/^##\s+(.+)$/) : null;
    const h3 = !h1 && !h2 ? line.match(/^###\s+(.+)$/) : null;
    if (h1 || h2 || h3) {
      if (buf.length) sections.push({ headingPath: stack.join(' > '), lines: buf, startLine: start, endLine: i });
      if (h1) stack = [h1[1].trim()];
      else if (h2) stack = [stack[0] ?? '', h2[1].trim()].filter(Boolean);
      else if (h3) stack = [stack[0] ?? '', stack[1] ?? '', h3[1].trim()].filter(Boolean);
      buf = [line];
      start = i;
    } else {
      buf.push(line);
    }
  }
  if (buf.length) sections.push({ headingPath: stack.join(' > '), lines: buf, startLine: start, endLine: lines.length });
  return sections;
}

/**
 * Split one over-budget section into paragraph-aligned chunks.
 *
 * TWO BUGS LIVED HERE, both fixed on 2026-10-21:
 *
 * 1. A single paragraph larger than `max` never triggered the size guard,
 *    because the guard read `bt + pt > max && buf.length > 0`. With an empty
 *    buffer the oversized paragraph was appended whole and emitted at the end
 *    untouched — one 32 KB note became one 15,164-token chunk. Now a paragraph
 *    that cannot fit on its own is hard-split by sentence, then by character,
 *    so `max` is an invariant rather than a best effort.
 *
 * 2. Overlap was carried by re-reading `ct.split('\n\n')` and then rewinding
 *    `offset` by the overlap's line count. That made line numbers drift and
 *    could produce a chunk whose text did not start where `startLine` claimed.
 *    Overlap is now taken from the paragraph list we already hold, and offsets
 *    are tracked forward only.
 */
function splitByParagraphs(text: string, headingPath: string, notePath: string, base: number, max: number, overlapTokens: number = 0): Chunk[] {
  const paras = text.split(/\n\n+/);
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let bt = 0;
  let offset = base;

  const flush = () => {
    if (!buf.length) return;
    const ct = buf.join('\n\n');
    const lc = ct.split('\n').length;
    chunks.push({ notePath, headingPath, text: ct, startLine: offset, endLine: offset + lc, tokenCount: tokens(ct) });
    offset += lc;
  };

  for (const p of paras) {
    const pt = tokens(p);

    // A paragraph that cannot fit in an empty buffer must be split itself,
    // otherwise `max` is silently violated.
    if (pt > max) {
      flush();
      buf = [];
      bt = 0;
      for (const piece of hardSplit(p, max)) {
        const pct = tokens(piece);
        const plc = piece.split('\n').length;
        chunks.push({ notePath, headingPath, text: piece, startLine: offset, endLine: offset + plc, tokenCount: pct });
        offset += plc;
      }
      continue;
    }

    if (bt + pt > max && buf.length > 0) {
      const prev = buf;
      flush();
      // Overlap from paragraphs already in hand — no re-splitting, no rewind.
      buf = overlapTokens > 0 ? tailWithin(prev, overlapTokens) : [];
      bt = buf.reduce((sum, s) => sum + tokens(s), 0);
    }

    buf.push(p);
    bt += pt;
  }
  flush();
  return chunks;
}

/** Longest suffix of `paras` whose combined token count stays within `budget`. */
function tailWithin(paras: string[], budget: number): string[] {
  const out: string[] = [];
  let used = 0;
  for (let i = paras.length - 1; i >= 0; i--) {
    const t = tokens(paras[i]);
    if (used + t > budget) break;
    out.unshift(paras[i]);
    used += t;
  }
  return out;
}

/**
 * Split text that is itself over budget: sentences first (cheap, keeps meaning
 * together), then raw characters when even one sentence exceeds `max` (code
 * blocks, pasted logs, single-line JSON — no sentence boundary exists there).
 */
function hardSplit(text: string, max: number): string[] {
  const sentences = text.split(/(?<=[。！？.!?\n])/).filter(s => s.length > 0);
  const out: string[] = [];
  let buf = '';

  const push = () => {
    const t = buf.trim();
    if (t) out.push(t);
    buf = '';
  };

  for (const s of sentences) {
    if (tokens(s) > max) {
      push();
      out.push(...splitByChars(s, max));
      continue;
    }
    if (tokens(buf + s) > max) push();
    buf += s;
  }
  push();
  return out;
}

/** Last resort: fixed character windows, sized so tokens stay under `max`. */
function splitByChars(text: string, max: number): string[] {
  const out: string[] = [];
  let start = 0;
  // Token/char ratio varies by content; shrink the window until it fits rather
  // than assuming a constant ratio.
  let window = Math.max(200, max * 2);
  while (start < text.length) {
    let end = Math.min(text.length, start + window);
    let piece = text.slice(start, end);
    while (tokens(piece) > max && end - start > 50) {
      window = Math.max(50, Math.floor(window * 0.8));
      end = Math.min(text.length, start + window);
      piece = text.slice(start, end);
    }
    out.push(piece);
    start = end;
  }
  return out;
}
