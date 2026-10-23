import { describe, it, expect } from 'vitest';
import { chunkNote } from '../../src/indexer/chunker';
import { parseNote, ParsedNote } from '../../src/indexer/parser';

const note = (body: string): ParsedNote => ({
  path: '/v/t.md',
  title: 'T',
  frontmatter: {},
  body,
  wikilinks: [],
});

const NL = String.fromCharCode(10);

describe('chunkNote', () => {
  it('returns at least one chunk', () => {
    expect(chunkNote(note('text')).length).toBeGreaterThanOrEqual(1);
  });

  it('splits by headings and tracks heading path', () => {
    const chunks = chunkNote(note('# S1\n\nA.\n\n## S1.1\n\nB.\n\n# S2\n\nC.'));
    expect(chunks.length).toBe(3);
    expect(chunks[0].headingPath).toBe('S1');
    expect(chunks[1].headingPath).toBe('S1 > S1.1');
    expect(chunks[2].headingPath).toBe('S2');
  });

  it('respects max token limit', () => {
    const long = ('word '.repeat(100) + '\n\n').repeat(6);
    const chunks = chunkNote(note(long), { maxTokens: 400 });
    expect(chunks.every(c => c.tokenCount <= 450)).toBe(true);
  });

  it('sets startLine and endLine', () => {
    const chunks = chunkNote(note('# A\n\nText A.\n\n# B\n\nText B.'));
    chunks.forEach(c => {
      expect(c.startLine).toBeGreaterThanOrEqual(0);
      expect(c.endLine).toBeGreaterThan(c.startLine);
    });
  });

  it('creates overlapping chunks when overlapTokens is set', () => {
    const long = ('word '.repeat(100) + '\n\n').repeat(6);
    const chunks = chunkNote(note(long), { maxTokens: 400, overlapTokens: 50 });
    if (chunks.length >= 2) {
      const lastPara1 = chunks[0].text.split('\n\n').pop()!;
      expect(chunks[1].text).toContain(lastPara1);
    }
  });

  // Regression: a single paragraph bigger than `max` used to bypass the size
  // guard entirely because the guard required a non-empty buffer.
  describe('over-budget single paragraph', () => {
    it('hard-splits a paragraph that cannot fit in one chunk', () => {
      const huge = '句子很短但数量很多。'.repeat(400);
      const chunks = chunkNote(note(huge), { maxTokens: 400 });
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every(c => c.tokenCount <= 400)).toBe(true);
    });

    it('hard-splits text with no sentence boundaries at all', () => {
      const wall = 'x'.repeat(20000);
      const chunks = chunkNote(note(wall), { maxTokens: 400 });
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every(c => c.tokenCount <= 400)).toBe(true);
    });

    it('keeps every chunk under budget for a mixed realistic note', () => {
      const mixed = [
        '# 标题',
        '',
        '短段落。',
        '',
        '句子很短但数量很多。'.repeat(300),
        '',
        'x'.repeat(8000),
      ].join('\n');
      const chunks = chunkNote(note(mixed), { maxTokens: 400, overlapTokens: 50 });
      expect(chunks.every(c => c.tokenCount <= 400)).toBe(true);
    });
  });

  describe('parseNote line-ending normalisation', () => {
    it('normalises CRLF so paragraphs actually split', () => {
      const crlf = 'para one\r\n\r\npara two\r\n\r\npara three';
      const parsed = parseNote('/v/crlf.md', crlf);
      expect(parsed.body.includes('\r')).toBe(false);
      expect(chunkNote(parsed, { maxTokens: 400 }).length).toBeGreaterThanOrEqual(1);
    });

    it('strips a leading BOM', () => {
      const parsed = parseNote('/v/bom.md', '\uFEFF# Title\n\nBody.');
      expect(parsed.body.startsWith('\uFEFF')).toBe(false);
      expect(parsed.title).toBe('Title');
    });
  });

  // Regression: `# comment` inside a fenced code block used to become a heading.
  // Real case: a bash block containing `# -> D:\qmd-global\...` produced
  // headingPath values equal to that path, polluting retrieval scoring.
  describe('code fence awareness', () => {
    it('does not treat a # comment inside a fence as a heading', () => {
      const lines = ['# Real', '', '```bash', '# not a heading', 'echo hi', '```', '', 'tail text.'];
      const chunks = chunkNote(note(lines.join(NL)));
      expect(chunks.every(c => !c.headingPath.includes('not a heading'))).toBe(true);
      expect(chunks.some(c => c.headingPath === 'Real')).toBe(true);
    });

    it('keeps the fenced block content inside its parent section', () => {
      const lines = ['# S', '', '```', '# inner', '```', '', 'after'];
      const chunks = chunkNote(note(lines.join(NL)));
      expect(chunks.length).toBe(1);
      expect(chunks[0].headingPath).toBe('S');
      expect(chunks[0].text).toContain('# inner');
    });

    it('only closes a fence with a marker of the same character', () => {
      // A ~~~ line inside a ``` block must NOT close it.
      const lines = ['# S', '', '```', '~~~', '# still code', '```', '', 'after'];
      const chunks = chunkNote(note(lines.join(NL)));
      expect(chunks[0].headingPath).toBe('S');
    });

    it('treats 4-space-indented ``` as an indented code block, not a fence', () => {
      // CommonMark: a fence may be indented at most 3 spaces. With 4 spaces the
      // line is indented code, so the following `# x` IS a heading.
      const lines = ['# S', '', '    ```', '', '# x', '', 'body'];
      const chunks = chunkNote(note(lines.join(NL)));
      expect(chunks.some(c => c.headingPath.includes('x'))).toBe(true);
    });
  });

  describe('heading-only fragments', () => {
    it('drops a chunk whose entire body is a heading', () => {
      const chunks = chunkNote(note('# Only\n\n## Sub'));
      expect(chunks.length).toBe(0);
    });

    it('keeps a short but real one-line fact', () => {
      const chunks = chunkNote(note(['# S', '', '路径是 D:\\\\x。'].join(NL)));
      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toContain('D:\\\\x');
    });
  });
});
