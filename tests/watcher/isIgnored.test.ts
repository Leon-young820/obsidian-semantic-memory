import { describe, it, expect } from 'vitest';
import path from 'path';
import { isIgnored } from '../../src/watcher/watcher';

const vault = path.join('D:', 'AI全局记忆库');
const patterns = ['模板/', 'Access Log/', '04_会话交接/归档/', '99_归档.md'];

describe('isIgnored', () => {
  // Regression for the 2026-10-21 bug: path.relative() yields backslashes on
  // Windows while .semanticignore patterns use slashes, so nothing inside an
  // ignored directory matched and the watcher indexed `模板/` notes that a
  // rebuild would have excluded.
  it('matches a Windows-style path inside an ignored directory', () => {
    const p = path.join(vault, '模板', '项目记忆写入约定.md');
    expect(isIgnored(p, vault, patterns)).toBe(true);
  });

  it('matches a forward-slash path inside an ignored directory', () => {
    expect(isIgnored(vault + '/Access Log/2026-10-21.md', vault, patterns)).toBe(true);
  });

  it('matches a nested ignored subdirectory', () => {
    expect(isIgnored(path.join(vault, '04_会话交接', '归档', 'x.md'), vault, patterns)).toBe(true);
  });

  it('matches a bare file pattern', () => {
    expect(isIgnored(path.join(vault, '99_归档.md'), vault, patterns)).toBe(true);
  });

  it('does not match ordinary notes', () => {
    expect(isIgnored(path.join(vault, '03_通用技术与踩坑', 'a.md'), vault, patterns)).toBe(false);
    expect(isIgnored(path.join(vault, '02_项目树', '模板说明.md'), vault, patterns)).toBe(false);
  });
});
