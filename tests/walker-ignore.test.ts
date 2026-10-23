import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { walkVault } from '../src/indexer/walker';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe('walkVault ignore paths', () => {
  it('honors a nested .semanticignore rule on Windows-style paths', async () => {
    const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'osm-ignore-'));
    temporaryDirectories.push(vault);
    await fs.mkdir(path.join(vault, '02_Project-Trees', 'Example'), { recursive: true });
    await fs.writeFile(path.join(vault, '.semanticignore'), '99_Archive.md\n');
    await fs.writeFile(path.join(vault, '02_Project-Trees', 'Example', '99_Archive.md'), '# archive');
    await fs.writeFile(path.join(vault, '02_Project-Trees', 'Example', '01_Effective-Facts.md'), '# facts');

    const files = await walkVault(vault);
    const names = files.map(file => path.basename(file));

    expect(names).toContain('01_Effective-Facts.md');
    expect(names).not.toContain('99_Archive.md');
  });
});
