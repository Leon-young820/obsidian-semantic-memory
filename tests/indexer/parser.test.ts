import { describe, it, expect } from 'vitest';
import { parseNote, stripIndexExcluded } from '../../src/indexer/parser';

describe('parseNote', () => {
  it('parses frontmatter', () => {
    const r = parseNote('/v/n.md', '---\ntitle: T\n---\n\n# Hello\n\nText.');
    expect(r.frontmatter.title).toBe('T');
  });

  it('extracts title from h1', () => {
    const r = parseNote('/v/scratch.md', '# Hello\n\nText.');
    expect(r.frontmatter).toEqual({});
    expect(r.title).toBe('Hello');
  });

  it('falls back to filename when no h1', () => {
    const r = parseNote('/v/my-note.md', 'Just text.');
    expect(r.title).toBe('my-note');
  });

  it('extracts wikilinks including aliased and heading variants', () => {
    const r = parseNote('/v/test.md', '# T\n\nSee [[People/John|JD]] and [[Projects/Alpha#Beta]].');
    expect(r.wikilinks).toContain('People/John');
    expect(r.wikilinks).toContain('Projects/Alpha');
  });

  // Regression: cross-reference blocks ("相关笔记") were a retrieval trap — they
  // repeat other notes' titles verbatim, so they matched any query about those
  // notes and outranked the notes themselves. They now carry an exclude marker.
  describe('index-excluded blocks', () => {
    it('keeps the block in body but removes it from indexBody', () => {
      const content = [
        '# Lesson',
        '',
        'Real content about chunking.',
        '',
        '<!-- memory-index:exclude -->',
        '## 相关笔记',
        '',
        '- [[Other Note]] — see also',
        '',
        '## After',
        '',
        'More real content.',
      ].join('\n');

      const r = parseNote('/v/lesson.md', content);

      // The file still contains the block...
      expect(r.body).toContain('相关笔记');
      expect(r.body).toContain('[[Other Note]]');
      // ...but the indexed text does not.
      expect(r.indexBody).not.toContain('相关笔记');
      expect(r.indexBody).not.toContain('[[Other Note]]');
      // Content before and after the block survives.
      expect(r.indexBody).toContain('Real content about chunking.');
      expect(r.indexBody).toContain('More real content.');
    });

    it('strips a trailing excluded block to the end of the note', () => {
      const text = ['Body.', '', '<!-- memory-index:exclude -->', '## Links', '', '- [[X]]'].join('\n');
      const out = stripIndexExcluded(text);
      expect(out).toContain('Body.');
      expect(out).not.toContain('[[X]]');
    });

    it('leaves unmarked notes untouched', () => {
      const text = '# T\n\nPlain body with [[A]].';
      const r = parseNote('/v/plain.md', text);
      expect(r.indexBody).toBe(r.body);
    });

    it('still collects wikilinks from excluded blocks', () => {
      // The backlink graph must not lose the cross-references.
      const content = ['# T', '', '<!-- memory-index:exclude -->', '## Links', '', '- [[Peer]]'].join('\n');
      const r = parseNote('/v/t.md', content);
      expect(r.wikilinks).toContain('Peer');
    });
  });
});
