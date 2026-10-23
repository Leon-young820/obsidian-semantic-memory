import express from 'express';
import path from 'path';
import Database from 'better-sqlite3';
import { retrieveContext } from '../retrieval/orchestrator';
import { lookupEntity } from '../retrieval/entityLookup';
import { appendDailyMemory } from '../memory/writer';
import { VectorIndex } from '../embeddings/vectorIndex';
import { buildGraph } from './graph';
import { GRAPH_UI_HTML } from './ui';

interface ProviderLike { embed(texts: string[]): Promise<number[][]>; dimensions: number }

export function createServer(
  db: Database.Database,
  vectorIndex: VectorIndex,
  provider: ProviderLike,
  vaultPath: string,
  priorityPaths?: string[],
  memoryDir?: string
) {
  const app = express();
  app.use(express.json());

  // Vendored browser dependency (force-graph), served locally on purpose: a CDN
  // URL would make the visualiser fail exactly when the network is the thing
  // being debugged.
  app.use('/vendor', express.static(path.join(__dirname, '..', '..', 'vendor')));

  // Read-only CORS for the two endpoints a browser page (the DSH skin's ripple
  // background) polls. Scoped to GET on /events and POST on /activity: the
  // retrieval endpoints stay same-origin only.
  app.use((req: any, res: any, next: any) => {
    if (req.path === '/events' || req.path === '/activity') {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      if (req.method === 'OPTIONS') return void res.status(204).end();
    }
    next();
  });

  // Ring buffer of recent retrieval hits.
  //
  // WHY in-process and not persisted: this feeds a live view of "what did the
  // last few prompts pull in". A restart empties it, which is correct — the
  // visualiser must not replay yesterday's activity as if it were happening
  // now. Only note paths are stored, never the query text.
  type Hit = { seq: number; ts: number; kind: string; notePath: string };
  const events: Hit[] = [];
  let eventSeq = 0;
  const MAX_EVENTS = 200;
  const recordHits = (kind: string, hits: Array<{ notePath: string }>) => {
    for (const h of hits) {
      events.push({ seq: ++eventSeq, ts: Date.now(), kind, notePath: h.notePath });
    }
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  };

  app.post('/retrieve-context', async (req: any, res: any) => {
    const { query, topK: rawTopK = 5 } = req.body;
    if (!query) return void res.status(400).json({ error: 'query required' });
    const topK = Math.min(100, Math.max(1, Math.floor(Number(rawTopK) || 5)));
    try {
      const result = await retrieveContext(db, vectorIndex, provider, query, topK, priorityPaths);
      recordHits('retrieve', result.hits);
      res.json(result);
    }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.get('/entity/:name', (req: any, res: any) => {
    const entity = lookupEntity(db, req.params.name);
    if (!entity) return void res.status(404).json({ error: 'not found' });
    res.json(entity);
  });

  app.get('/facts/:entityId', (req: any, res: any) => {
    const rows = db.prepare(
      'SELECT * FROM facts WHERE subject_entity_id = ? ORDER BY updated_at DESC'
    ).all(Number(req.params.entityId));
    res.json(rows);
  });

  app.get('/search', async (req: any, res: any) => {
    const q = req.query.q as string;
    if (!q) return void res.status(400).json({ error: 'q required' });
    try {
      const result = await retrieveContext(db, vectorIndex, provider, q, 5, priorityPaths);
      recordHits('search', result.hits);
      res.json(result);
    }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  /** Node/edge data for the visualiser (nodes = notes, edges = wikilinks). */
  app.get('/graph', (_req: any, res: any) => {
    try { res.json(buildGraph(db, vaultPath)); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  /** Hits recorded since `seq`, in the order retrieval produced them. */
  app.get('/events', (req: any, res: any) => {
    const since = Number(req.query.since ?? 0) || 0;
    res.json({ seq: eventSeq, events: events.filter(e => e.seq > since) });
  });

  /**
   * Record a non-retrieval activity beat (tool call, turn finished, ...).
   *
   * WHY a POST instead of inferring it: hooks know when a tool ran or a turn
   * ended; the browser does not. One event stream for both means the skin can
   * pulse its background without knowing anything about the harness internals.
   * Only the label is stored — never prompt text or tool arguments.
   */
  app.post('/activity', (req: any, res: any) => {
    const kind = String(req.body?.kind ?? 'activity').slice(0, 32);
    const label = String(req.body?.label ?? '').slice(0, 120);
    events.push({ seq: ++eventSeq, ts: Date.now(), kind, notePath: label });
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    res.json({ ok: true, seq: eventSeq });
  });

  /** The visualiser itself, served from this origin so there is no CORS setup. */
  app.get('/ui', (_req: any, res: any) => {
    res.type('html').send(GRAPH_UI_HTML);
  });

  app.post('/memory/daily', async (req: any, res: any) => {
    const { date, text, source = 'api' } = req.body;
    if (!date || !text) return void res.status(400).json({ error: 'date and text required' });
    try { await appendDailyMemory(vaultPath, date, { text, source }, memoryDir); res.json({ ok: true }); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  return app;
}
