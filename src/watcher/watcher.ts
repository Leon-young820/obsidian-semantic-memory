import chokidar from 'chokidar';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { indexFile, IndexOptions } from '../indexer/pipeline';

function loadIgnorePatterns(vaultPath: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(vaultPath, '.semanticignore'), 'utf8');
    return raw.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

// Separators normalised here because path.relative() uses backslashes on
// Windows while .semanticignore patterns use slashes — without this the watcher
// indexed files inside ignored directories that `rebuild` correctly skipped.
export function isIgnored(filePath: string, vaultPath: string, patterns: string[]): boolean {
  const rel = path.relative(vaultPath, filePath).split(path.sep).join('/');
  return patterns.some(p => {
    const clean = p.replace(/\/$/, '');
    return rel === clean || rel.startsWith(clean + '/') || rel.includes('/' + clean + '/') || rel.endsWith('/' + clean);
  });
}

export function startWatcher(
  vaultPath: string,
  db: Database.Database,
  options: IndexOptions = {}
): chokidar.FSWatcher {
  const ignorePatterns = loadIgnorePatterns(vaultPath);

  const watcher = chokidar.watch(path.join(vaultPath, '**/*.md'), {
    ignored: [/\.obsidian/, /\.semantic-memory/],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  const pending = new Map<string, NodeJS.Timeout>();

  const handle = (filePath: string) => {
    if (isIgnored(filePath, vaultPath, ignorePatterns)) return;
    if (pending.has(filePath)) clearTimeout(pending.get(filePath)!);
    pending.set(filePath, setTimeout(async () => {
      pending.delete(filePath);
      try {
        await indexFile(db, filePath, options);
        console.log(`[watcher] indexed: ${filePath}`);
      } catch (err) {
        console.error(`[watcher] error:`, err);
      }
    }, 500));
  };

  watcher
    .on('add', handle)
    .on('change', handle)
    .on('unlink', (filePath: string) => {
      if (isIgnored(filePath, vaultPath, ignorePatterns)) return;
      db.transaction(() => {
        db.prepare('DELETE FROM relations WHERE source_note = ?').run(filePath);
        db.prepare('DELETE FROM notes WHERE path = ?').run(filePath);
      })();
      console.log(`[watcher] removed: ${filePath}`);
    });

  return watcher;
}
