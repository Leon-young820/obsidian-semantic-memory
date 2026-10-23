import fs from 'fs/promises';
import path from 'path';

export interface DailyEntry { text: string; source: string }

/**
 * Append one entry to the day's memory note.
 *
 * CONCURRENCY — why this opens with 'a' instead of stat-then-write
 * ----------------------------------------------------------------
 * The previous implementation did `fs.stat` to test for existence and then
 * either appended or WROTE the file with frontmatter. That is a TOCTOU race: two
 * agents both see ENOENT, both take the create branch, and the second write
 * replaces the first. The loser's entry vanishes with no error — the worst
 * possible failure mode for a memory service, because the user believes the
 * memory was saved.
 *
 * This vault is shared by several agents (DSH, Codex, WorkBuddy), so the race is
 * reachable, not theoretical.
 *
 * Opening with 'a' gives O_APPEND semantics: the kernel positions every write at
 * the current end of file atomically, so concurrent appends interleave instead of
 * overwriting. The file is created if absent, which removes the need for the
 * separate existence check entirely.
 */
export async function appendDailyMemory(vaultPath: string, date: string, entry: DailyEntry, memoryDir = 'Memory/Daily'): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('date must be YYYY-MM-DD format');
  }

  const dir = path.join(vaultPath, memoryDir);
  const filePath = path.join(dir, `${date}.md`);

  const resolvedPath = path.resolve(filePath);
  const resolvedBase = path.resolve(dir);
  if (!resolvedPath.startsWith(resolvedBase)) {
    throw new Error('Invalid date: path traversal detected');
  }

  await fs.mkdir(dir, { recursive: true });

  // Sanitize text: trim, remove frontmatter delimiters, limit length
  let sanitizedText = entry.text.trim();
  sanitizedText = sanitizedText.replace(/---/g, '');
  if (sanitizedText.length > 2000) {
    sanitizedText = sanitizedText.substring(0, 2000);
  }

  // Sanitize source: alphanumeric and hyphens only
  const sanitizedSource = entry.source.replace(/[^\p{L}\p{N}-]/gu, '');

  const time = new Date().toISOString().substring(11, 19);
  const line = `\n- [${time}] (${sanitizedSource}) ${sanitizedText}`;

  // 'a' = create if absent, then position every write at EOF (atomic append).
  const handle = await fs.open(filePath, 'a');
  try {
    const stat = await handle.stat();
    // A brand-new file has size 0 here only if we are its first writer; if two
    // writers race, exactly one observes 0 and adds the header. The other sees a
    // non-zero size (or a size that grows between the stat and the write) and
    // appends cleanly. Worst case the header is written twice, which Obsidian
    // tolerates; content is never lost, which is what matters.
    if (stat.size === 0) {
      await handle.write(`---\nkind: note\nupdated: ${date}\n---\n# ${date}\n`);
    }
    await handle.write(line);
  } finally {
    await handle.close();
  }

  return filePath;
}
