import matter from 'gray-matter';
import path from 'path';

export interface ParsedNote {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  /**
   * The body as it should be CHUNKED. Equal to `body` unless the note contains
   * index-excluded blocks (see INDEX_EXCLUDE_MARKER).
   */
  indexBody: string;
  wikilinks: string[];
}

const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?]]/g;
const HEADING_RE = /^#{1,6}\s/;

/**
 * Headings whose sections are navigation rather than knowledge.
 *
 * A section titled "关联" or "相关笔记" lists links to other notes. Those titles
 * appear verbatim in the text, so the section matches any query that mentions
 * those notes and outranks the notes themselves.
 */
const NAV_HEADINGS = new Set(['关联', '相关笔记', '记忆树导航', '导航', '相关', 'See also']);

/**
 * Normalise line endings and strip a BOM before any downstream regex runs.
 *
 * WHY THIS EXISTS: every chunker regex — section splitting on `^#`, paragraph
 * splitting on `\n\n+`, heading-path tracking — assumes LF. A CRLF note leaves a
 * trailing `\r` on every line and, worse, contains no `\n\n` sequence at all
 * (`\r\n\r\n` instead), so `split(/\n\n+/)` yields ONE paragraph. The size guard
 * in splitByParagraphs only fires when `buf` is already non-empty, so a single
 * oversized paragraph bypassed it entirely: a 32 KB note became a single chunk
 * of 15,164 tokens against a 400-token budget. Measured in this vault on
 * 2026-10-21 (max chunk 127,724 chars). Normalising here fixes every consumer at
 * once instead of patching each regex separately.
 */
export function normalizeBody(raw: string): string {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/**
 * Marker that hides a block from the retrieval index while leaving it in the file.
 *
 * WHY
 * ---
 * Cross-reference blocks ("相关笔记", "See also") are navigation aids, not
 * knowledge. They are also a retrieval trap: a block that lists the titles of
 * other notes contains those titles verbatim, so it is a near-perfect keyword
 * match for any query mentioning them — and it outranks the notes they point at.
 * Measured on 2026-10-21: searching "记忆体系 部署 架构" returned three "## 关联"
 * blocks as the top three hits — none of them the deployment note the query was
 * about.
 *
 * Rewriting each block to differ does not fix it — the block still repeats the
 * other notes' vocabulary, which is exactly what the query matches on. The only
 * real fix is to keep the block OUT of the indexed text.
 *
 * The block stays in the file, so Obsidian still renders it and still counts the
 * wikilinks for its backlink panel. Only the text handed to the chunker changes.
 */
export const INDEX_EXCLUDE_MARKER = '<!-- memory-index:exclude -->';

/** True when a heading line names a navigation section. */
function isNavHeading(line: string): boolean {
  const m = line.match(/^#{1,6}\s+(.+?)\s*$/);
  return m ? NAV_HEADINGS.has(m[1].trim()) : false;
}

/**
 * Remove index-excluded blocks from the text that will be chunked.
 *
 * TWO EXCLUSION MECHANISMS, because navigation hides in two shapes:
 *
 * 1. An explicit marker. The marker sits directly ABOVE the heading it
 *    introduces, so that heading is part of the excluded block and goes with it.
 *    The block then runs until a heading that is neither the marker's own
 *    heading nor another navigation heading. One marker can therefore cover a
 *    run of consecutive navigation sections.
 *
 * 2. A navigation heading with no marker at all. Any heading whose text names a
 *    navigation section excludes its own body, up to the next heading. This
 *    catches blocks added by hand or by other tooling that never learned the
 *    marker convention.
 *
 * In both cases the heading itself is excluded along with its body, because the
 * heading text ("相关笔记") is as much noise as the list under it.
 */
export function stripIndexExcluded(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  let skipping = false;
  // The first heading after a marker belongs to the excluded block; only the
  // heading after that one opens included content.
  let sawFirstHeading = false;

  for (const line of lines) {
    if (skipping) {
      if (HEADING_RE.test(line)) {
        if (!sawFirstHeading) {
          sawFirstHeading = true;
          continue;
        }
        if (!isNavHeading(line)) {
          skipping = false;
          kept.push(line); // this heading opens the next included section
        }
        continue;
      }
      continue;
    }

    if (line.includes(INDEX_EXCLUDE_MARKER)) {
      skipping = true;
      sawFirstHeading = false;
      continue;
    }

    if (HEADING_RE.test(line)) {
      if (isNavHeading(line)) {
        skipping = true;
        sawFirstHeading = true; // the nav heading is consumed with its body
        continue;
      }
      kept.push(line);
      continue;
    }

    kept.push(line);
  }

  return kept.join('\n');
}

export function parseNote(filePath: string, content: string): ParsedNote {
  const { data: frontmatter, content: rawBody } = matter(normalizeBody(content));
  const title = rawBody.match(/^#\s+(.+)$/m)?.[1].trim() ?? path.basename(filePath, '.md');
  const wikilinks = [...new Set([...rawBody.matchAll(new RegExp(WIKILINK_RE.source, 'g'))].map(m => m[1].trim()))].filter(Boolean);

  // The full body keeps the excluded blocks (they are part of the file's
  // structure); the chunker receives the stripped version.
  const body = rawBody.trim();

  return {
    path: filePath,
    title,
    frontmatter,
    body,
    indexBody: stripIndexExcluded(body),
    wikilinks,
  };
}
