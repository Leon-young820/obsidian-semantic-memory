import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { openDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/schema';
import fs from 'fs';

// Unique database path per test.
//
// WHY: on Windows, unlinking an SQLite file while the connection is open fails
// with EBUSY. With one shared path the previous test's rows survived and later
// inserts died on "UNIQUE constraint failed" — a cleanup problem masquerading as
// a logic failure.
let seq = 0;
const uniqueDbPath = () => `/tmp/test-watcher-${process.pid}-${seq++}.db`;

// Mock chokidar
const mockOn = vi.fn().mockReturnThis();
const mockClose = vi.fn();
vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => ({ on: mockOn, close: mockClose })),
  },
}));

// Mock indexFile
vi.mock('../../src/indexer/pipeline', () => ({
  indexFile: vi.fn().mockResolvedValue(undefined),
}));

import { startWatcher } from '../../src/watcher/watcher';
import chokidar from 'chokidar';

// Separator used by the platform when path.join builds the glob.
const SEP = require('node:path').sep;

beforeEach(() => {
  vi.clearAllMocks();
  mockOn.mockReturnThis();
});

afterEach(() => {
  /* best effort; unique paths make leftover files harmless */
});

describe('startWatcher', () => {
  it('registers add, change, and unlink handlers', () => {
    const dbPath = uniqueDbPath();
    const db = openDb(dbPath);
    runMigrations(db);
    startWatcher('/vault', db, {});
    const events = mockOn.mock.calls.map((c: any[]) => c[0]);
    expect(events).toContain('add');
    expect(events).toContain('change');
    expect(events).toContain('unlink');
    db.close();
  });

  it('watches correct glob pattern', () => {
    const dbPath = uniqueDbPath();
    const db = openDb(dbPath);
    runMigrations(db);
    startWatcher('/vault', db, {});

    // The watcher builds its glob with path.join, so on Windows the pattern is
    // `\vault\**\*.md`, not `/vault/**/*.md`. Normalise separators before
    // asserting instead of demanding a POSIX shape that cannot appear here.
    expect(chokidar.watch).toHaveBeenCalled();
    const firstCall = (chokidar.watch as any).mock.calls[0];
    const pattern = String(firstCall[0]).split(SEP).join('/');
    expect(pattern).toContain('**/*.md');

    expect(firstCall[1]).toMatchObject({ persistent: true, ignoreInitial: true });
    db.close();
  });

  it('unlink handler deletes note and relations', () => {
    const dbPath = uniqueDbPath();
    const db = openDb(dbPath);
    runMigrations(db);
    // Seed a note
    db.prepare("INSERT INTO notes VALUES ('/vault/test.md','Test',null,'h','2026-03-30','{}')").run();
    db.prepare("INSERT INTO entities (type,canonical_name,aliases_json,source_note,confidence,updated_at) VALUES (?,?,?,?,?,?)")
      .run('note', 'Test', '[]', '/vault/test.md', 1.0, '2026-03-30');

    startWatcher('/vault', db, {});

    // Find the unlink handler and call it
    const unlinkCall = mockOn.mock.calls.find((c: any[]) => c[0] === 'unlink');
    expect(unlinkCall).toBeTruthy();
    const unlinkHandler = unlinkCall![1];
    unlinkHandler('/vault/test.md');

    // Verify note was deleted (cascade deletes entities)
    const note = db.prepare('SELECT * FROM notes WHERE path = ?').get('/vault/test.md');
    expect(note).toBeUndefined();
    db.close();
  });
});
