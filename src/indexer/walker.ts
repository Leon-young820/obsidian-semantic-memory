import fs from 'fs/promises';
import path from 'path';

const DEFAULT_IGNORE = ['.obsidian/', '.trash/', '.semantic-memory/', 'node_modules/'];

interface WalkOptions {
  ignorePatterns?: string[];
}

export async function walkVault(vaultPath: string, options: WalkOptions = {}): Promise<string[]> {
  let patterns = [...DEFAULT_IGNORE, ...(options.ignorePatterns ?? [])];

  try {
    const raw = await fs.readFile(path.join(vaultPath, '.semanticignore'), 'utf8');
    const fromFile = raw
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
    patterns = [...patterns, ...fromFile];
  } catch {
    /* no .semanticignore */
  }

  const results: string[] = [];

  async function walk(dir: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(vaultPath, full).split(path.sep).join('/');
      if (patterns.some(p => {
        const clean = p.replace(/\/$/, '');
        return rel === clean || rel.startsWith(clean + '/') || rel.includes('/' + clean + '/') || rel.endsWith('/' + clean);
      }))
        continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) results.push(full);
    }
  }

  await walk(vaultPath);
  return results;
}
