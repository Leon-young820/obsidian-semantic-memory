import Database from 'better-sqlite3';
import { VectorIndex } from '../embeddings/vectorIndex';
import { semanticSearch } from './semantic';
import { lookupEntity } from './entityLookup';

export interface RetrievalHit { notePath: string; chunkId: number; headingPath: string; text: string; score: number; reason: string }
export interface RetrievalResult { query: string; hits: RetrievalHit[] }

interface ProviderLike { embed(texts: string[]): Promise<number[][]> }

function getEntityIdsForNotes(db: Database.Database, notePaths: string[]): Array<{ id: number; notePath: string }> {
  if (notePaths.length === 0) return [];
  const placeholders = notePaths.map(() => '?').join(',');
  return (db.prepare(
    `SELECT id, source_note as notePath FROM entities WHERE source_note IN (${placeholders})`
  ).all(...notePaths) as any[]).map(r => ({ id: r.id, notePath: r.notePath }));
}

function getRelatedEntityIds(db: Database.Database, entityIds: Array<{ id: number }>): number[] {
  if (entityIds.length === 0) return [];
  const ids = entityIds.map(e => e.id);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT DISTINCT target_entity_id as id FROM relations WHERE source_entity_id IN (${placeholders})
     UNION
     SELECT DISTINCT source_entity_id as id FROM relations WHERE target_entity_id IN (${placeholders})`
  ).all(...ids, ...ids) as any[];
  const existing = new Set(ids);
  return rows.map(r => r.id).filter(id => !existing.has(id));
}

function getNotesForEntities(db: Database.Database, entityIds: number[]): string[] {
  if (entityIds.length === 0) return [];
  const placeholders = entityIds.map(() => '?').join(',');
  return (db.prepare(
    `SELECT DISTINCT source_note FROM entities WHERE id IN (${placeholders})`
  ).all(...entityIds) as any[]).map(r => r.source_note);
}

function getBestChunksForNotes(db: Database.Database, notePaths: string[], limit: number): Array<{
  notePath: string; chunkId: number; headingPath: string; text: string; startLine: number; endLine: number
}> {
  if (notePaths.length === 0) return [];
  const placeholders = notePaths.map(() => '?').join(',');
  return (db.prepare(
    `SELECT chunkId, notePath, headingPath, text, startLine, endLine FROM (
       SELECT id as chunkId, note_path as notePath, heading_path as headingPath, text, start_line as startLine, end_line as endLine,
         ROW_NUMBER() OVER (PARTITION BY note_path ORDER BY token_count DESC) as rn
       FROM chunks WHERE note_path IN (${placeholders})
     ) WHERE rn = 1
     LIMIT ?`
  ).all(...notePaths, limit) as any[]);
}

/**
 * Scoring weights, gathered in one place.
 *
 * These numbers used to be scattered literals inside the scoring loop, which made
 * retrieval tuning a code change plus a rebuild plus a service restart. They are
 * now env-overridable so behaviour can be adjusted without touching TypeScript —
 * the values should be treated as tunable parameters, not as facts about the
 * domain.
 *
 * Each weight answers "how much extra confidence does this signal buy?":
 *   priority  a note in a configured priority directory
 *   entity    the note that owns the entity matched by the query
 *   recency   linearly decaying boost, full for today, zero at RECENCY_DAYS
 *   graph     a note reached by graph expansion rather than direct similarity
 *   fact      a stored fact whose predicate/object matches a query word
 */
const SCORE_WEIGHTS = {
  priority: Number(process.env.MEMORY_W_PRIORITY ?? 0.1),
  entity: Number(process.env.MEMORY_W_ENTITY ?? 0.2),
  recency: Number(process.env.MEMORY_W_RECENCY ?? 0.1),
  graph: Number(process.env.MEMORY_W_GRAPH ?? 0.3),
  fact: Number(process.env.MEMORY_W_FACT ?? 0.15),
  /**
   * Lexical (BM25) agreement, rank-shaped.
   *
   * WHY: a query word that appears VERBATIM in a chunk ("CADCraft", "3456") is
   * much stronger evidence than an embedding that merely lands 0.01 higher
   * than its neighbours — which is the whole problem with e5 similarity, where
   * every candidate sits in 0.92–0.99 and ordering is near-arbitrary. Mixing a
   * lexical channel into a vector ranking is standard hybrid retrieval; RRF
   * (Cormack et al.) is the usual fusion because the two raw scores are not
   * comparable, so this adds a bonus derived from the BM25 RANK rather than
   * from the BM25 score. Same idea, expressed in this additive-boost scheme.
   * Set MEMORY_W_LEXICAL=0 to disable.
   */
  lexical: Number(process.env.MEMORY_W_LEXICAL ?? 0.25),
};

/** Recency boost decays linearly to zero over this many days. */
const RECENCY_DAYS = Number(process.env.MEMORY_RECENCY_DAYS ?? 30);

/**
 * Minimum score a hit must reach to be returned.
 *
 * Without a floor, a query always returns `topK` results no matter how weak the
 * match — so a question with no good answer still injects three mediocre chunks
 * into the model's context. Measured example: "Hivemynd 点亮" returned a daily
 * log file rather than the relevant note.
 *
 * 0.75 is deliberately conservative: it cuts obvious noise while still returning
 * borderline-but-useful hits. Override to 0 to restore the old behaviour.
 */
const MIN_SCORE = Number(process.env.MEMORY_MIN_SCORE ?? 0.75);

/**
 * Per-directory multipliers applied to the semantic score before any boost.
 *
 * WHY THIS EXISTS (measured 2026-10-21): across eight real queries, 20 of 24
 * top-3 hits came from `04_会话交接` — session handoffs that are 55% of the
 * indexed text and read like file listings, so their cosine score lands within
 * 0.01 of every query. Ranking cannot fix that: the signal genuinely is that
 * similar. The fix is to state that a handoff transcript is worth less than a
 * lesson note, rather than to drop it from the index — "where were we last
 * time" still needs it to be retrievable.
 *
 * Format: "dir=factor,dir=factor", matched when the path contains "/dir/".
 * Set MEMORY_DIR_WEIGHTS to an empty string to disable all down-weighting.
 */
const DIR_WEIGHTS = parseDirWeights(
  process.env.MEMORY_DIR_WEIGHTS ?? '04_会话交接=0.45,04_会话交接/归档=0.2'
);

function parseDirWeights(spec: string): { dir: string; factor: number }[] {
  return spec
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .flatMap(item => {
      const i = item.lastIndexOf('=');
      if (i <= 0) return [];
      const dir = item.slice(0, i).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      const factor = Number(item.slice(i + 1));
      return dir && Number.isFinite(factor) ? [{ dir, factor }] : [];
    });
}

/** Multiplier for the directory a note lives in; 1 when the path is not listed. */
function dirFactor(notePath: string): number {
  const p = notePath.replace(/\\/g, '/');
  const hit = DIR_WEIGHTS.find(d => p.includes('/' + d.dir + '/'));
  return hit ? hit.factor : 1;
}

/**
 * Query terms that the trigram index can actually match (>= 3 characters).
 *
 * Latin/digit runs are taken as-is. CJK runs are taken whole: the trigram
 * tokenizer turns a quoted phrase into overlapping 3-grams and requires all of
 * them, so a 6-character run behaves like a phrase search rather than a bag of
 * words — intentionally strict, since a loose lexical match would just add more
 * noise to a ranking that already has too much of it.
 */
function lexicalTerms(query: string): string[] {
  const latin = query.match(/[A-Za-z0-9][A-Za-z0-9_.-]{2,}/g) ?? [];
  const cjk = query.match(/[\u3400-\u4dbf\u4e00-\u9fff]{3,}/g) ?? [];
  return [...new Set([...latin, ...cjk])].slice(0, 8);
}

/**
 * BM25 rank of each candidate chunk against the trigram index, 1-based.
 *
 * Returns an empty map whenever the lexical channel is unavailable (old DB
 * without migration 5, FTS5 built without trigram support, unparseable MATCH
 * expression). Retrieval must never fail because an OPTIONAL signal is missing,
 * so every path here degrades to vector-only.
 */
function lexicalRanks(db: Database.Database, query: string, limit: number): Map<number, number> {
  const ranks = new Map<number, number>();
  if (!(SCORE_WEIGHTS.lexical > 0)) return ranks;
  const terms = lexicalTerms(query);
  if (terms.length === 0) return ranks;
  const expr = terms.map(t => '"' + t.replace(/"/g, '') + '"').join(' OR ');
  try {
    const rows = db.prepare(
      `SELECT rowid as id FROM chunks_trigram WHERE chunks_trigram MATCH ? ORDER BY bm25(chunks_trigram) LIMIT ?`
    ).all(expr, limit) as { id: number }[];
    rows.forEach((r, i) => ranks.set(r.id, i + 1));
  } catch {
    return new Map();
  }
  return ranks;
}

export async function retrieveContext(
  db: Database.Database, vectorIndex: VectorIndex, provider: ProviderLike,
  query: string, topK = 5, priorityPaths: string[] = [], project?: string
): Promise<RetrievalResult> {
  let semanticHits = await semanticSearch(db, vectorIndex, provider, query, topK * 2);

  // Project scoping. Notes carry `project` in their frontmatter, so the filter is
  // a JSON lookup on the already-stored frontmatter_json — no schema change and no
  // second index. Without this, a question about project A competes with every
  // other project's notes in one shared vector space.
  if (project && project.trim()) {
    const wanted = project.trim();
    const allowed = new Set(
      (db.prepare(
        `SELECT path FROM notes WHERE json_extract(frontmatter_json, '$.project') = ?`
      ).all(wanted) as { path: string }[]).map(r => r.path)
    );
    // An empty allow-set means no note declares this project. Returning unfiltered
    // results would silently answer a different question than the one asked, so
    // fall through to no hits instead.
    semanticHits = semanticHits.filter(h => allowed.has(h.notePath));
  }
  const entityHit = lookupEntity(db, query.trim());
  const lexLimit = topK * 3;
  const lexRanks = lexicalRanks(db, query, lexLimit);

  const scored = semanticHits.map(h => {
    const dFactor = dirFactor(h.notePath);
    let score = h.score * dFactor; let reason = dFactor === 1 ? 'semantic' : 'semantic+dirDown';
    if (priorityPaths.some(p => h.notePath.includes('/' + p) || h.notePath.startsWith(p))) { score += SCORE_WEIGHTS.priority; reason = 'semantic+priority'; }
    if (entityHit?.sourceNote === h.notePath) { score += SCORE_WEIGHTS.entity; reason = 'semantic+entity'; }
    // Lexical agreement, shaped by rank: full weight for the best BM25 hit,
    // decaying to zero at lexLimit. Rank-based rather than score-based because
    // BM25 magnitudes are not comparable with cosine.
    const lexRank = lexRanks.get(h.chunkId);
    if (lexRank) {
      const lexBonus = SCORE_WEIGHTS.lexical * (1 - (lexRank - 1) / lexLimit);
      if (lexBonus > 0.001) { score += lexBonus; reason += '+lex'; }
    }
    // Time-decay recency: +0.1 for today, linearly decaying to 0 over 30 days
    const noteRow = db.prepare('SELECT modified_at FROM notes WHERE path = ?').get(h.notePath) as { modified_at: string } | undefined;
    if (noteRow) {
      const daysSince = (Date.now() - new Date(noteRow.modified_at).getTime()) / 86400000;
      const recencyBoost = Math.max(0, SCORE_WEIGHTS.recency * (1 - daysSince / RECENCY_DAYS));
      if (recencyBoost > 0.001) { score += recencyBoost; reason += '+recency'; }
    }
    return { ...h, score, reason };
  });

  // Graph expansion
  const hitNotePaths = [...new Set(semanticHits.map(h => h.notePath))];
  const hitEntityIds = getEntityIdsForNotes(db, hitNotePaths);

  const relatedEntityIds = getRelatedEntityIds(db, hitEntityIds);

  const relatedNotePaths = getNotesForEntities(db, relatedEntityIds);
  const newPaths = relatedNotePaths.filter(p => !hitNotePaths.includes(p));

  if (newPaths.length > 0) {
    const relatedChunks = getBestChunksForNotes(db, newPaths, topK);
    for (const chunk of relatedChunks) {
      scored.push({
        ...chunk,
        score: SCORE_WEIGHTS.graph,
        reason: 'graph'
      });
    }
  }

  // Fact-aware boost
  const queryWords = query.toLowerCase().split(/\s+/);
  for (const hit of scored) {
    const entityForNote = hitEntityIds.find(e => e.notePath === hit.notePath);
    if (entityForNote) {
      const facts = db.prepare(
        'SELECT predicate, object_text FROM facts WHERE subject_entity_id = ?'
      ).all(entityForNote.id) as any[];

      const factMatch = facts.some(f =>
        queryWords.some(w =>
          (f.object_text ?? '').toLowerCase().includes(w) ||
          (f.predicate ?? '').toLowerCase().includes(w)
        )
      );
      if (factMatch) {
        hit.score += SCORE_WEIGHTS.fact;
        hit.reason += '+fact';
      }
    }
  }

  return {
    query,
    hits: scored
      // Graph-expanded hits are exempt from the score floor.
      //
      // WHY: they carry a fixed weight (SCORE_WEIGHTS.graph, default 0.3) rather
      // than a similarity score, so comparing them against MIN_SCORE would always
      // drop them — silently disabling graph expansion whenever a floor is set.
      // Their relevance was already established by the entity graph, not by vector
      // distance, so the floor does not apply.
      .filter(h => h.reason.startsWith('graph') || h.score >= MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(h => ({ notePath: h.notePath, chunkId: h.chunkId, headingPath: h.headingPath, text: h.text, score: h.score, reason: h.reason }))
  };
}
