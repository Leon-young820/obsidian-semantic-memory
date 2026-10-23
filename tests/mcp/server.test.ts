import { describe, it, expect, afterEach, vi } from 'vitest';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import { VectorIndex } from '../../src/embeddings/vectorIndex';
import { createMcpTools, resultLimit } from '../../src/mcp/server';
import fs from 'fs';

const DB = '/tmp/test-mcp.db';
afterEach(() => { if (fs.existsSync(DB)) fs.unlinkSync(DB); });

function seedDb() {
  const db = openDb(DB);
  runMigrations(db);
  db.prepare("INSERT INTO notes VALUES ('/v/john.md','John','person','h1','2026-03-30T00:00:00.000Z','{}')").run();
  db.prepare("INSERT INTO chunks (note_path,heading_path,text,start_line,end_line,token_count,chunk_hash) VALUES (?,?,?,?,?,?,?)")
    .run('/v/john.md', '', 'John is an engineer at Acme.', 0, 2, 7, 'h1');
  db.prepare("INSERT INTO entities (type,canonical_name,aliases_json,source_note,confidence,updated_at) VALUES (?,?,?,?,?,?)")
    .run('person', 'John', '["JD"]', '/v/john.md', 1.0, '2026-03-30');
  const entityId = (db.prepare('SELECT id FROM entities LIMIT 1').get() as any).id;
  db.prepare("INSERT INTO facts (subject_entity_id,predicate,object_text,source_path,confidence,valid_from,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(entityId, 'works_at', 'Acme Corp', '/v/john.md', 0.9, '2026-03-30', '2026-03-30');
  return db;
}

describe('MCP tools', () => {
  it('caps result counts for context efficiency', () => {
    expect(resultLimit(undefined)).toBe(3);
    expect(resultLimit(5)).toBe(5);
    expect(resultLimit(100)).toBe(5);
    expect(resultLimit(0)).toBe(1);
  });

  it('vault_status returns counts', async () => {
    const db = seedDb();
    const idx = new VectorIndex(db, 4); idx.initTable();
    const tools = createMcpTools(db, idx, { embed: vi.fn(), dimensions: 4 } as any, { vaultPath: '/v', memoryDir: 'Memory/Daily', priorityPaths: [] });
    const result = await tools.vault_status({});
    expect(result.notes).toBe(1);
    expect(result.chunks).toBe(1);
    expect(result.entities).toBe(1);
    expect(result.facts).toBe(1);
    db.close();
  });

  it('vault_entity finds by name', async () => {
    const db = seedDb();
    const idx = new VectorIndex(db, 4); idx.initTable();
    const tools = createMcpTools(db, idx, { embed: vi.fn(), dimensions: 4 } as any, { vaultPath: '/v', memoryDir: 'Memory/Daily', priorityPaths: [] });
    const result = await tools.vault_entity({ name: 'John' });
    expect(result).not.toBeNull();
    expect(result!.canonicalName).toBe('John');
    db.close();
  });

  it('vault_entity finds by alias', async () => {
    const db = seedDb();
    const idx = new VectorIndex(db, 4); idx.initTable();
    const tools = createMcpTools(db, idx, { embed: vi.fn(), dimensions: 4 } as any, { vaultPath: '/v', memoryDir: 'Memory/Daily', priorityPaths: [] });
    const result = await tools.vault_entity({ name: 'JD' });
    expect(result).not.toBeNull();
    expect(result!.canonicalName).toBe('John');
    db.close();
  });

  it('vault_facts returns facts for entity', async () => {
    const db = seedDb();
    const idx = new VectorIndex(db, 4); idx.initTable();
    const tools = createMcpTools(db, idx, { embed: vi.fn(), dimensions: 4 } as any, { vaultPath: '/v', memoryDir: 'Memory/Daily', priorityPaths: [] });
    const result = await tools.vault_facts({ entityName: 'John' });
    expect(result).toHaveLength(1);
    expect(result[0].predicate).toBe('works_at');
    db.close();
  });

  it('vault_store_fact creates entity and fact', async () => {
    const db = seedDb();
    const idx = new VectorIndex(db, 4); idx.initTable();
    const tools = createMcpTools(db, idx, { embed: vi.fn(), dimensions: 4 } as any, { vaultPath: '/v', memoryDir: 'Memory/Daily', priorityPaths: [] });
    const result = await tools.vault_store_fact({ subject: 'Alice', predicate: 'works_at', object: 'Globex' });
    expect(result.ok).toBe(true);
    expect(result.factId).toBeGreaterThan(0);
    const facts = await tools.vault_facts({ entityName: 'Alice' });
    expect(facts).toHaveLength(1);
    expect(facts[0].object_text).toBe('Globex');
    db.close();
  });

  it('vault_search returns hits', async () => {
    const db = seedDb();
    const chunkId = (db.prepare('SELECT id FROM chunks LIMIT 1').get() as any).id;
    const idx = new VectorIndex(db, 4); idx.initTable();
    idx.upsert(chunkId, [1, 0, 0, 0]);
    const provider = { dimensions: 4, embed: vi.fn().mockResolvedValue([[0.9, 0, 0, 0]]) };
    const tools = createMcpTools(db, idx, provider as any, { vaultPath: '/v', memoryDir: 'Memory/Daily', priorityPaths: [] });
    const result = await tools.vault_search({ query: 'engineer', topK: 5 });
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].notePath).toBe('/v/john.md');
    db.close();
  });
});
