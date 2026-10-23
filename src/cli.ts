import { Command } from "commander";
import OpenAI from "openai";
import { loadConfig } from "./config";
import { openDb } from "./db/client";
import { runMigrations } from "./db/schema";
import { indexVault } from "./indexer/pipeline";
import { startWatcher } from "./watcher/watcher";
import { retrieveContext } from "./retrieval/orchestrator";
import { VectorIndex } from "./embeddings/vectorIndex";
import { OpenAIEmbeddingProvider } from "./embeddings/openai";
import { LocalEmbeddingProvider } from "./embeddings/local";
import { createServer } from "./api/server";
import { extractFacts } from "./extraction/factExtractor";
import { startMcpServer } from "./mcp/server";
import type { EmbeddingProvider } from "./embeddings/types";
import { parseConversation, resolveJSONLPath } from "./conversation/parser";
import { writeConversation } from "./conversation/writer";

function setup() {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  runMigrations(db);
  let provider: EmbeddingProvider;
  if (config.embeddingProvider === "local") {
    provider = new LocalEmbeddingProvider(config.embeddingModel);
  } else {
    provider = new OpenAIEmbeddingProvider(config.openaiApiKey!);
  }
  const vectorIndex = new VectorIndex(db, provider.dimensions);
  vectorIndex.initTable();
  const factExtractor = config.llmExtraction
    ? (title: string, body: string) =>
        extractFacts(new OpenAI({ apiKey: config.openaiApiKey! }), title, body)
    : undefined;
  return { config, db, provider, vectorIndex, factExtractor };
}

const program = new Command().name("osm").version("1.0.0");

program
  .command("index")
  .description("Index full vault")
  .action(async () => {
    const { config, db, provider, vectorIndex, factExtractor } = setup();
    console.log(`Indexing: ${config.vaultPath}`);
    const stats = await indexVault(
      db,
      config.vaultPath,
      {
        embeddingProvider: provider,
        vectorIndex,
        chunkOptions: {
          maxTokens: config.chunkMaxTokens,
          overlapTokens: config.chunkOverlapTokens,
        },
        factExtractor,
      },
      config.indexConcurrency,
    );
    console.log(
      `Done. ${stats.indexed}/${stats.total} indexed, ${stats.errors} errors.`,
    );
    db.close();
  });

program
  .command("search <query>")
  .description("Semantic search")
  .option("-k, --top-k <n>", "results", "5")
  .action(async (query: string, opts: any) => {
    const { config, db, provider, vectorIndex } = setup();
    const result = await retrieveContext(
      db,
      vectorIndex,
      provider,
      query,
      Number(opts.topK),
      config.priorityPaths,
    );
    result.hits.forEach((h) => {
      console.log(`\n[${h.score.toFixed(3)}] ${h.notePath} (${h.reason})`);
      console.log(h.text.substring(0, 200));
    });
    db.close();
  });

program
  .command("watch")
  .description("Watch vault for changes")
  .action(async () => {
    const { config, db, provider, vectorIndex, factExtractor } = setup();
    console.log(`Watching: ${config.vaultPath}`);
    startWatcher(config.vaultPath, db, {
      embeddingProvider: provider,
      vectorIndex,
      factExtractor,
    });
  });

program
  .command("serve")
  .description("Start HTTP API")
  .option("-p, --port <n>", "port", "3456")
  .action(async (opts: any) => {
    const { config, db, provider, vectorIndex } = setup();
    const app = createServer(
      db,
      vectorIndex,
      provider,
      config.vaultPath,
      config.priorityPaths,
    );
    app.listen(Number(opts.port), "127.0.0.1", () =>
      console.log(`Listening on http://127.0.0.1:${opts.port}`),
    );
  });

program
  .command("rebuild")
  .description("Clear derived data and reindex from scratch")
  .action(async () => {
    const { config, db, provider, vectorIndex, factExtractor } = setup();
    // Clear vector index — drop and recreate
    db.prepare("DROP TABLE IF EXISTS chunk_embeddings").run();
    vectorIndex.initTable(); // recreates it
    // Clear SQL derived tables atomically
    db.transaction(() => {
      ["facts", "relations", "entities", "chunks", "notes"].forEach((t) =>
        db.prepare(`DELETE FROM ${t}`).run(),
      );
    })();
    console.log("Cleared. Reindexing...");
    const rebuildStats = await indexVault(
      db,
      config.vaultPath,
      {
        embeddingProvider: provider,
        vectorIndex,
        chunkOptions: {
          maxTokens: config.chunkMaxTokens,
          overlapTokens: config.chunkOverlapTokens,
        },
        factExtractor,
      },
      config.indexConcurrency,
    );
    console.log(
      `Rebuild complete. ${rebuildStats.indexed}/${rebuildStats.total} indexed, ${rebuildStats.errors} errors.`,
    );
    db.close();
  });

program
  .command("mcp")
  .description("Start MCP server (stdio transport) for agent connectivity")
  .action(async () => {
    const { config, db, provider, vectorIndex } = setup();

    // Warm the embedding model in the background.
    //
    // WHY: the first real query otherwise pays the full model load (~10-14s on
    // this machine for a 300MB transformer). The MCP client's own tool timeout is
    // shorter than that, so the first search after every restart reported
    // "tool execution may have occurred; outcome unknown" instead of an answer.
    // Warm-up cannot be awaited — the MCP handshake must respond immediately or
    // the client treats the server as failed to start — so it is fire-and-forget
    // with errors swallowed (a failed warm-up must not affect serving).
    void provider
      .embed(['warm-up'])
      .then(() => process.stderr.write('[mcp] embedding model warmed' + String.fromCharCode(10)))
      .catch(() => {});

    await startMcpServer(db, vectorIndex, provider, config);
  });

program
  .command("log-conversation")
  .description(
    "Log a Claude Code session to Obsidian vault (invoked by Stop hook)",
  )
  .action(async () => {
    const vaultPath = process.env.VAULT_PATH;
    const conversationsDir =
      process.env.CONVERSATIONS_DIR ?? "Claude Code/Conversations";

    if (!vaultPath) {
      process.stderr.write("log-conversation: VAULT_PATH not set\n");
      process.exit(0);
    }

    // Читаем JSON-пейлоад Stop hook из stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8").trim();

    let sessionId: string | undefined;
    let cwd: string | undefined;
    try {
      const payload = JSON.parse(raw);
      sessionId = payload.session_id;
      cwd = payload.cwd;
    } catch {
      process.stderr.write("log-conversation: invalid JSON on stdin\n");
      process.exit(0);
    }

    if (!sessionId || !cwd) {
      process.stderr.write(
        "log-conversation: missing session_id or cwd in payload\n",
      );
      process.exit(0);
    }

    const jsonlPath = resolveJSONLPath(sessionId, cwd);
    try {
      const conv = await parseConversation(jsonlPath, sessionId, cwd);
      const filePath = await writeConversation(
        vaultPath,
        conversationsDir,
        conv,
      );
      process.stdout.write(`Conversation saved: ${filePath}\n`);
    } catch (err) {
      process.stderr.write(`log-conversation: ${err}\n`);
      process.exit(0);
    }
  });

program.parse();
