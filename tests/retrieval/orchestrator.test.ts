import { describe, it, expect, afterEach, vi } from 'vitest';
import { retrieveContext } from '../../src/retrieval/orchestrator';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import fs from 'fs';

// Unique database path per test.
//
// WHY: on Windows, unlinking an SQLite file while the connection is
// still open fails with EBUSY. With one shared path the previous test's
// rows survive and the next insert dies on "UNIQUE constraint failed" —
// which is why these tests failed on Windows but not on macOS/Linux.
let seq = 0;
const uniqueDbPath = () => `/tmp/test-orch-${process.pid}-${seq++}.db`;
afterEach(() => { /* best effort; unique paths make leftovers harmless */ });

describe('retrieveContext', () => {
  it('returns hits with reason field', async () => {
    const dbPath = uniqueDbPath(); const db = openDb(dbPath); runMigrations(db);
    db.prepare("INSERT INTO notes VALUES ('/v/john.md','John Doe','person','h','2026-03-30','{}')").run();
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/john.md','','John at Acme.',0,2,5,'h1');
    const id = (db.prepare('SELECT id FROM chunks LIMIT 1').get() as any).id;
    const idx = new VectorIndex(db, 4); idx.initTable(); idx.upsert(id, [1,0,0,0]);
    const provider = { dimensions:4, embed: vi.fn().mockResolvedValue([[0.9,0,0,0]]) };

    const result = await retrieveContext(db, idx, provider, 'John', 5, ['OpenClaw Memory/', 'Projects/', 'Infrastructure/']);
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits[0].reason).toBeTruthy();
    db.close();
  });

  it('boosts priority paths', async () => {
    const dbPath = uniqueDbPath(); const db = openDb(dbPath); runMigrations(db);
    // Two notes: one in OpenClaw Memory (priority), one generic
    db.prepare("INSERT INTO notes VALUES ('/v/OpenClaw Memory/User.md','User','preference','h1','2026-03-30','{}')").run();
    db.prepare("INSERT INTO notes VALUES ('/v/scratch.md','Scratch',null,'h2','2026-03-30','{}')").run();

    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/OpenClaw Memory/User.md','','Priority content.',0,2,5,'h1');
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/scratch.md','','Generic content.',0,2,5,'h2');

    const id1 = (db.prepare('SELECT id FROM chunks WHERE chunk_hash=?').get('h1') as any).id;
    const id2 = (db.prepare('SELECT id FROM chunks WHERE chunk_hash=?').get('h2') as any).id;

    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(id1, [1, 0, 0, 0]);
    idx.upsert(id2, [0.95, 0, 0, 0]); // slightly lower semantic score

    const provider = { dimensions:4, embed: vi.fn().mockResolvedValue([[1,0,0,0]]) };
    const result = await retrieveContext(db, idx, provider, 'content', 5, ['OpenClaw Memory/', 'Projects/', 'Infrastructure/']);

    // Priority note should rank first despite slightly lower base score
    expect(result.hits[0].notePath).toContain('OpenClaw Memory');
    db.close();
  });

  it('includes graph-related notes in results', async () => {
    const dbPath = uniqueDbPath(); const db = openDb(dbPath); runMigrations(db);

    // Create two notes with entities
    db.prepare("INSERT INTO notes VALUES ('/v/alpha.md','Alpha','project','h1','2026-03-30','{}')").run();
    db.prepare("INSERT INTO notes VALUES ('/v/john.md','John','person','h2','2026-03-30','{}')").run();

    // Chunks
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/alpha.md','','Alpha project uses Redis for caching.',0,2,10,'h1');
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/john.md','','John is a Redis expert at Acme.',0,2,8,'h2');

    // Entities
    db.prepare("INSERT INTO entities (type,canonical_name,aliases_json,source_note,confidence,updated_at) VALUES (?,?,?,?,?,?)")
      .run('project','Alpha','[]','/v/alpha.md',1.0,'2026-03-30');
    db.prepare("INSERT INTO entities (type,canonical_name,aliases_json,source_note,confidence,updated_at) VALUES (?,?,?,?,?,?)")
      .run('person','John','[]','/v/john.md',1.0,'2026-03-30');

    // Relation: Alpha links_to John
    const alphaId = (db.prepare("SELECT id FROM entities WHERE canonical_name='Alpha'").get() as any).id;
    const johnId = (db.prepare("SELECT id FROM entities WHERE canonical_name='John'").get() as any).id;
    db.prepare("INSERT INTO relations (source_entity_id,relation,target_entity_id,source_note,confidence) VALUES (?,?,?,?,?)")
      .run(alphaId, 'links_to', johnId, '/v/alpha.md', 1.0);

    // Only embed Alpha's chunk — John's chunk is intentionally not in the vector index
    // so John can only be reached via graph expansion
    const chunkId1 = (db.prepare("SELECT id FROM chunks WHERE chunk_hash='h1'").get() as any).id;
    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(chunkId1, [1,0,0,0]);

    const provider = { dimensions:4, embed: vi.fn().mockResolvedValue([[1,0,0,0]]) };
    const result = await retrieveContext(db, idx, provider, 'Redis caching', 5, []);

    // Alpha should be found semantically, John should appear via graph relation
    const paths = result.hits.map(h => h.notePath);
    expect(paths).toContain('/v/alpha.md');
    expect(paths).toContain('/v/john.md');

    // John's hit should have 'graph' in reason
    const johnHit = result.hits.find(h => h.notePath === '/v/john.md');
    expect(johnHit?.reason).toContain('graph');

    db.close();
  });

  it('boosts hits with matching facts', async () => {
    const dbPath = uniqueDbPath(); const db = openDb(dbPath); runMigrations(db);

    db.prepare("INSERT INTO notes VALUES ('/v/john.md','John','person','h1','2026-03-30','{}')").run();
    db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
      .run('/v/john.md','','John is an engineer.',0,2,5,'h1');

    const chunkId = (db.prepare("SELECT id FROM chunks LIMIT 1").get() as any).id;

    db.prepare("INSERT INTO entities (type,canonical_name,aliases_json,source_note,confidence,updated_at) VALUES (?,?,?,?,?,?)")
      .run('person','John','[]','/v/john.md',1.0,'2026-03-30');
    const entityId = (db.prepare("SELECT id FROM entities LIMIT 1").get() as any).id;

    // Add a fact: John works_at Acme
    db.prepare("INSERT INTO facts (subject_entity_id,predicate,object_text,source_path,confidence,valid_from,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(entityId, 'works_at', 'Acme Corp', '/v/john.md', 0.9, '2026-03-30', '2026-03-30');

    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(chunkId, [1,0,0,0]);

    const provider = { dimensions:4, embed: vi.fn().mockResolvedValue([[0.9,0,0,0]]) };

    // Search for "Acme" — should match via fact
    const result = await retrieveContext(db, idx, provider, 'Acme', 5, []);
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.hits[0].reason).toContain('fact');

    db.close();
  });

  // Regression for the 2026-10-21 finding: session handoffs are 55% of the
  // indexed text with file-listing prose, so their cosine score lands within
  // 0.01 of every query and outranked real lesson notes in 20 of 24 top-3 slots.
  // Deleting them from the index would lose "where were we", so the fix is a
  // per-directory multiplier instead.
  it('down-weights session handoff notes below lesson notes', async () => {
    // MIN_SCORE is captured when the module loads, and the default floor (0.75)
    // would simply drop the handoff hit — which is the desired end state but
    // hides whether the multiplier is what caused it. So re-import the module
    // with the floor disabled and compare scores directly.
    const prevMin = process.env.MEMORY_MIN_SCORE;
    process.env.MEMORY_MIN_SCORE = '0';
    vi.resetModules();
    const { retrieveContext: retrieve } = await import('../../src/retrieval/orchestrator');

    const dbPath = uniqueDbPath(); const db = openDb(dbPath); runMigrations(db);

    const handoff = '/v/04_会话交接/handoff.md';
    const lesson = '/v/03_通用技术与踩坑/lesson.md';
    for (const p of [handoff, lesson]) {
      db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?)').run(p, p, 'note', 'h', '2026-10-01', '{}');
      db.prepare('INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)')
        .run(p, '', 'identical text for both notes', 0, 2, 5, 'h' + p);
    }

    const idx = new VectorIndex(db, 4); idx.initTable();
    const rows = db.prepare('SELECT id, note_path FROM chunks ORDER BY id').all() as any[];
    // Identical vectors: only the directory multiplier can separate them.
    for (const r of rows) idx.upsert(r.id, [1, 0, 0, 0]);
    const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[1, 0, 0, 0]]) };

    const result = await retrieve(db, idx, provider, 'identical text', 5, []);
    const handoffHit = result.hits.find(h => h.notePath === handoff);
    const lessonHit = result.hits.find(h => h.notePath === lesson);
    expect(lessonHit).toBeTruthy();
    expect(handoffHit!.score).toBeLessThan(lessonHit!.score);
    expect(handoffHit!.reason).toContain('dirDown');

    db.close();
    if (prevMin === undefined) delete process.env.MEMORY_MIN_SCORE;
    else process.env.MEMORY_MIN_SCORE = prevMin;
    vi.resetModules();
  });

  // The vector scores of real candidates cluster in 0.92–0.99, so ordering is
  // nearly arbitrary. An exact hit on a rare query word is much stronger
  // evidence, which is why the lexical (trigram bm25) rank is fused in.
  it('ranks an exact lexical match above an equal-similarity neighbour', async () => {
    const dbPath = uniqueDbPath(); const db = openDb(dbPath); runMigrations(db);

    const plain = '/v/plain.md';
    const exact = '/v/exact.md';
    db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?)').run(plain, 'Plain', 'note', 'h', '2026-10-01', '{}');
    db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?)').run(exact, 'Exact', 'note', 'h', '2026-10-01', '{}');
    db.prepare('INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)')
      .run(plain, '', 'filler text with nothing in common', 0, 2, 5, 'hp');
    db.prepare('INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)')
      .run(exact, '', 'CADCraft 图纸批量导出说明', 0, 2, 5, 'he');

    const idx = new VectorIndex(db, 4); idx.initTable();
    for (const r of db.prepare('SELECT id FROM chunks ORDER BY id').all() as any[]) idx.upsert(r.id, [1, 0, 0, 0]);
    const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[1, 0, 0, 0]]) };

    const result = await retrieveContext(db, idx, provider, 'CADCraft 导出', 5, []);
    expect(result.hits.map(h => h.notePath)).toContain(exact);
    expect(result.hits[0].notePath).toBe(exact);
    expect(result.hits[0].reason).toContain('lex');

    db.close();
  });
});
