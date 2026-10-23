import { describe, expect, it } from 'vitest';
import { getMcpToolDefinitions } from '../src/mcp/server';

describe('MCP read-only mode', () => {
  it('hides memory-writing tools from the registered tool list', () => {
    const names = getMcpToolDefinitions(true).map(tool => tool.name);

    expect(names).toEqual(['vault_search']);
  });
});
