import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { VectorIndex } from '../embeddings/vectorIndex';
import { retrieveContext } from '../retrieval/orchestrator';
import { lookupEntity } from '../retrieval/entityLookup';
import { appendDailyMemory } from '../memory/writer';
import type { Config } from '../config';
import type { EmbeddingProvider } from '../embeddings/types';
import { reportActivity } from './activity';

const DEFAULT_RESULT_LIMIT = 3;
const MAX_RESULT_LIMIT = 5;

export function resultLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_RESULT_LIMIT;
  return Math.min(MAX_RESULT_LIMIT, Math.max(1, Math.trunc(parsed)));
}

export function createMcpTools(
  db: Database.Database,
  vectorIndex: VectorIndex,
  provider: EmbeddingProvider,
  config: Pick<Config, 'vaultPath' | 'memoryDir' | 'priorityPaths'>
) {
  return {
    async vault_search(args: { query: string; topK?: number; project?: string }) {
      const topK = resultLimit(args.topK);
      const result = await retrieveContext(db, vectorIndex, provider, args.query, topK, config.priorityPaths ?? [], args.project);
      // Light every hit on the vault graph. Only paths leave this process —
      // never the query text (see activity.ts).
      await reportActivity('search', result.hits.map(h => h.notePath));
      return result.hits;
    },

    async vault_fts(args: { query: string; topK?: number }) {
      const topK = resultLimit(args.topK);
      const rows = db.prepare(
        `SELECT c.id as chunkId, c.note_path as notePath, c.heading_path as headingPath, c.text,
                bm25(chunks_fts) as score
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY score
         LIMIT ?`
      ).all(args.query, topK) as any[];
      await reportActivity('search', rows.map(r => r.notePath));
      return rows.map(r => ({ ...r, score: Math.abs(r.score), reason: 'fts' }));
    },

    async vault_entity(args: { name: string }) {
      return lookupEntity(db, args.name);
    },

    async vault_facts(args: { entityName: string }) {
      const entity = lookupEntity(db, args.entityName);
      if (!entity) return [];
      return db.prepare('SELECT * FROM facts WHERE subject_entity_id = ? ORDER BY updated_at DESC').all(entity.id) as any[];
    },

    async vault_status(_args: {}) {
      const counts = {
        notes: (db.prepare('SELECT COUNT(*) as c FROM notes').get() as any).c,
        chunks: (db.prepare('SELECT COUNT(*) as c FROM chunks').get() as any).c,
        entities: (db.prepare('SELECT COUNT(*) as c FROM entities').get() as any).c,
        facts: (db.prepare('SELECT COUNT(*) as c FROM facts').get() as any).c,
        relations: (db.prepare('SELECT COUNT(*) as c FROM relations').get() as any).c,
      };
      return counts;
    },

    /**
     * Self-check: is the index telling the truth about the vault?
     *
     * WHY: the index is derived data, so it CAN drift from the files — a crashed
     * index run, a manual file deletion, a vector insert that failed silently.
     * Until now nothing reported that drift, which means a search can quietly
     * return stale results forever. Basic Memory ships the same idea as `bm doctor`.
     *
     * Deliberately does NOT repair anything: a diagnostic that mutates is a
     * diagnostic you cannot run twice to confirm the diagnosis.
     */
    async vault_doctor(_args: {}) {
      const issues: string[] = [];

      // 1. Index rows pointing at files that no longer exist.
      const indexed = db.prepare('SELECT path FROM notes').all() as { path: string }[];
      const ghost = indexed.filter((r) => {
        try {
          return !statSync(r.path).isFile();
        } catch {
          return true;
        }
      });
      if (ghost.length) {
        issues.push(`${ghost.length} 条索引指向已不存在的文件（幽灵条目）`);
      }

      // 2. Chunks with no vector. Those rows are unreachable by semantic search —
      //    they can still be hit by FTS, which hides the problem.
      const noVec = db.prepare(
        `SELECT COUNT(*) as c FROM chunks WHERE id NOT IN (SELECT rowid FROM chunk_embeddings)`
      ).get() as { c: number };
      if (noVec.c) issues.push(`${noVec.c} 个 chunk 缺少向量（语义检索查不到）`);

      // 3. Heading-only fragments, which add noise without content.
      const fragments = db.prepare(
        // The threshold is 25 characters, not 40: a section with a title
        // and one real bullet is legitimate short content, and flagging those
        // produces false positives that train the reader to ignore the report.
        // The chunker already drops chunks whose body is ONLY a heading, so
        // what survives here is mostly genuine one-liners.
        `SELECT COUNT(*) as c FROM chunks WHERE length(trim(text)) < 25`
      ).get() as { c: number };
      `${fragments.c} 个 chunk 过短（< 25 字符，多为纯标题碎片）`;

      // 4. Notes with no chunks at all — indexed but unsearchable.
      const emptyNotes = db.prepare(
        `SELECT COUNT(*) as c FROM notes n
         WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.note_path = n.path)
           AND length(trim(n.frontmatter_json)) > 2`
      ).get() as { c: number };
      if (emptyNotes.c) issues.push(`${emptyNotes.c} 篇笔记没有任何可检索内容`);

      const stats = {
        notes: (db.prepare('SELECT COUNT(*) as c FROM notes').get() as any).c,
        chunks: (db.prepare('SELECT COUNT(*) as c FROM chunks').get() as any).c,
        vectors: (db.prepare('SELECT COUNT(*) as c FROM chunk_embeddings').get() as any).c,
      };

      return { ok: issues.length === 0, issues, stats };
    },

    async vault_remember(args: { text: string; date?: string; source?: string }) {
      const date = args.date ?? new Date().toISOString().substring(0, 10);
      const source = args.source ?? 'mcp';
      const filePath = await appendDailyMemory(config.vaultPath, date, { text: args.text, source }, config.memoryDir);
      await reportActivity('write', [filePath]);
      return { ok: true, path: filePath };
    },

    async vault_store_fact(args: { subject: string; predicate: string; object: string; confidence?: number }) {
      const now = new Date().toISOString();
      const confidence = args.confidence ?? 0.8;

      let entity = lookupEntity(db, args.subject);
      let entityId: number;
      if (entity) {
        entityId = entity.id;
      } else {
        db.prepare(
          `INSERT OR IGNORE INTO notes (path, title, kind, note_hash, modified_at, frontmatter_json) VALUES ('_mcp_', 'MCP', 'system', '_mcp_', ?, '{}')`
        ).run(now);
        const row = db.prepare(
          `INSERT INTO entities (type, canonical_name, aliases_json, source_note, confidence, updated_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
        ).get('concept', args.subject, '[]', '_mcp_', 1.0, now) as { id: number };
        entityId = row.id;
      }

      const row = db.prepare(
        `INSERT INTO facts (subject_entity_id, predicate, object_text, source_path, confidence, valid_from, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`
      ).get(entityId, args.predicate, args.object, '_mcp_', confidence, now, now) as { id: number };

      return { ok: true, factId: row.id };
    },
  };
}

const TOOLS = [
  {
    name: 'vault_search',
    // Behaviour hints let a client decide whether to auto-approve, ask,
    // or refuse — without these it cannot tell a lookup from a write.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Search prior work only when history or user-specific context matters. Returns ranked vault chunks; default 3, maximum 5.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        topK: { type: 'number', description: 'Results (default 3, maximum 5)' },
        project: { type: 'string', description: 'Restrict results to one project (matches frontmatter project). Omit to search the whole vault.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'vault_fts',
    // Behaviour hints let a client decide whether to auto-approve, ask,
    // or refuse — without these it cannot tell a lookup from a write.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Exact keyword search for known terms. Use only when prior work or user-specific context matters.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Keyword or phrase to search (SQLite FTS5 syntax supported)' },
        topK: { type: 'number', description: 'Results (default 3, maximum 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'vault_entity',
    // Behaviour hints let a client decide whether to auto-approve, ask,
    // or refuse — without these it cannot tell a lookup from a write.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Look up an entity (person, project, concept) by name or alias. Returns entity details or null.',
    inputSchema: {
      type: 'object' as const,
      properties: { name: { type: 'string', description: 'Entity name or alias to look up' } },
      required: ['name'],
    },
  },
  {
    name: 'vault_facts',
    // Behaviour hints let a client decide whether to auto-approve, ask,
    // or refuse — without these it cannot tell a lookup from a write.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Get all known facts about an entity. Returns structured subject-predicate-object triples.',
    inputSchema: {
      type: 'object' as const,
      properties: { entityName: { type: 'string', description: 'Entity name to look up facts for' } },
      required: ['entityName'],
    },
  },
  {
    name: 'vault_status',
    // Behaviour hints let a client decide whether to auto-approve, ask,
    // or refuse — without these it cannot tell a lookup from a write.
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Get vault index statistics: count of notes, chunks, entities, facts, and relations.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'vault_doctor',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Check whether the index matches the vault: ghost entries, chunks without vectors, fragments, empty notes. Read-only; never repairs.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'vault_remember',
    // Behaviour hints let a client decide whether to auto-approve, ask,
    // or refuse — without these it cannot tell a lookup from a write.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Store a memory entry in the daily notes. Appends text to the daily note for the given date.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text to remember' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format (defaults to today)' },
        source: { type: 'string', description: 'Source identifier (defaults to "mcp")' },
      },
      required: ['text'],
    },
  },
  {
    name: 'vault_store_fact',
    // Behaviour hints let a client decide whether to auto-approve, ask,
    // or refuse — without these it cannot tell a lookup from a write.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Store a structured fact. Creates entity if it does not exist. Format: subject-predicate-object (e.g. "Alice works_at Globex").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        subject: { type: 'string', description: 'Subject entity name' },
        predicate: { type: 'string', description: 'Predicate (e.g. works_at, is_a, uses, located_in)' },
        object: { type: 'string', description: 'Object value' },
        confidence: { type: 'number', description: 'Confidence score 0-1 (default 0.8)' },
      },
      required: ['subject', 'predicate', 'object'],
    },
  },
];

const READ_ONLY_TOOLS = new Set(['vault_search']);

export function getMcpToolDefinitions(readOnly = false) {
  return readOnly ? TOOLS.filter(tool => READ_ONLY_TOOLS.has(tool.name)) : TOOLS;
}
export async function startMcpServer(
  db: Database.Database,
  vectorIndex: VectorIndex,
  provider: EmbeddingProvider,
  config: Config
) {
  const server = new Server({ name: 'osm-memory', version: '1.0.0' }, { capabilities: { tools: {} } });
  const tools = createMcpTools(db, vectorIndex, provider, config);
  const readOnly = process.env.MCP_READ_ONLY === 'true';
  const toolDefinitions = getMcpToolDefinitions(readOnly);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = (tools as any)[name];
    if (!toolDefinitions.some(tool => tool.name === name) || !handler) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    try {
      const result = await handler(args ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
