import Database from 'better-sqlite3';
import fs from 'fs';

export interface GraphNode {
  /** Note path — stable id, also what the retrieval events report. */
  id: string;
  label: string;
  /** Top-level folder, used for colour grouping. */
  group: string;
  /** Relative weight (0.2–1), derived from how much text the note carries. */
  size: number;
}

export interface GraphEdge { source: string; target: string }

export interface GraphData { nodes: GraphNode[]; edges: GraphEdge[] }

const WIKILINK = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

function norm(p: string): string { return p.replace(/\\/g, '/'); }

function topFolder(notePath: string): string {
  const parts = norm(notePath).split('/');
  return parts.length > 1 ? parts[parts.length - 2] : 'root';
}

function label(notePath: string, title?: string | null): string {
  if (title && title.trim()) return title.trim();
  return norm(notePath).split('/').pop()!.replace(/\.md$/, '');
}

/**
 * Build the note graph the visualiser draws.
 *
 * WHY note files instead of indexed chunks: the indexer strips navigation
 * blocks from what it stores (they outrank real content — see the
 * `memory-index:exclude` markers), so the `[[...]]` links mostly live in text
 * the chunks never contain. Reading the files back gives 90+ edges where a
 * chunk-based graph had 26, and the visualiser needs the links far more than it
 * needs the prose. The files are small and this runs once per page load.
 *
 * WHY wikilinks and not the entities/relations tables: those are still nearly
 * empty (relations = 0 on this vault) while every note already links to its kin.
 *
 * Sized by character count rather than chunk count so a note split into eight
 * small chunks does not outweigh one dense note.
 */
export function buildGraph(db: Database.Database, vaultPath?: string): GraphData {
  const notes = db.prepare('SELECT path, title FROM notes').all() as { path: string; title: string | null }[];
  const byPath = new Map<string, { path: string; title: string | null }>();
  for (const n of notes) byPath.set(norm(n.path), n);

  const chars = new Map<string, number>();
  const chunks = db.prepare('SELECT note_path, text FROM chunks').all() as { note_path: string; text: string }[];
  for (const c of chunks) {
    const key = norm(c.note_path);
    chars.set(key, (chars.get(key) ?? 0) + (c.text?.length ?? 0));
  }

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const n of notes) {
    const key = norm(n.path);
    let body = '';
    if (vaultPath) {
      try { body = fs.readFileSync(n.path, 'utf8'); } catch { body = ''; }
    }
    if (!body) {
      // Fallback for a missing file: use whatever prose the index holds.
      body = chunks.filter(c => norm(c.note_path) === key).map(c => c.text).join('\n');
      chars.set(key, body.length);
    } else if (!chars.get(key)) {
      chars.set(key, Math.min(body.length, 20000));
    }

    for (const m of body.matchAll(WIKILINK)) {
      const wanted = norm(m[1].trim()).replace(/\.md$/, '');
      if (!wanted) continue;
      let target: string | undefined;
      const direct = byPath.get(wanted + '.md') ?? byPath.get(wanted);
      if (direct) target = norm(direct.path);
      else {
        for (const p of byPath.keys()) {
          if (p.endsWith('/' + wanted + '.md') || p === wanted + '.md') { target = p; break; }
        }
      }
      if (!target || target === key) continue;
      const edgeKey = key + '\u0000' + target;
      if (seen.has(edgeKey)) continue;
      seen.add(edgeKey);
      edges.push({ source: n.path, target: byPath.get(target)!.path });
    }
  }

  const maxChars = Math.max(1, ...chars.values());
  const nodes: GraphNode[] = notes.map(n => {
    const c = chars.get(norm(n.path)) ?? 0;
    return {
      id: n.path,
      label: label(n.path, n.title),
      group: topFolder(n.path),
      size: 0.2 + 0.8 * Math.sqrt(c / maxChars),
    };
  });

  return { nodes, edges };
}
