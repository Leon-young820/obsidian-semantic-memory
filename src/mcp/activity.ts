/**
 * Activity reporters for the two Obsidian visualisers this vault runs.
 *
 * WHY TWO TARGETS
 * ---------------
 * They answer different questions and neither one covers both:
 *
 *   neural-vault  lights nodes in Obsidian's NATIVE 2D graph view. That is the
 *                 view the user actually keeps open while working, so activity
 *                 has to show up there or it is invisible in practice.
 *   hivemynd      drives its own 3D "brain" view and keeps a structured access
 *                 log with per-agent colours, replay and audit. The graph view
 *                 does not have any of that.
 *
 * Both are optional. A vault with one, the other, or neither must behave
 * identically from the memory tools' point of view.
 *
 * WHAT IS AND IS NOT SENT
 * -----------------------
 * Note paths only. The search QUERY is deliberately never included, for either
 * target: the access log would otherwise become a transcript of everything the
 * user looked for. Hivemynd's own `storePurposes` setting is off for the same
 * reason.
 *
 * FAILURE POLICY
 * --------------
 * Best effort, never fatal. Obsidian may be closed, either plugin disabled, the
 * key file absent. None of that may fail or slow a memory tool: each request is
 * caught individually and capped at TIMEOUT_MS, and both are awaited together so
 * the requests are not abandoned when the MCP process winds down (a `void`ed
 * fetch dies before its bytes leave — that bug cost an hour once; see the
 * Hivemynd commit history).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TIMEOUT_MS = 1500;

/** Hivemynd's vocabulary. Neural Vault spells the same idea differently. */
type ActivityKind = 'read' | 'write' | 'search';

let cachedKey: string | null | undefined;

/**
 * Hivemynd's listener key, written by the plugin for local tools to read.
 *
 * Cached because it is consulted on every tool call, and `null` is cached too —
 * retrying a filesystem read on every search when the plugin simply is not
 * installed would be pure overhead.
 */
function hivemyndKey(): string | null {
  if (cachedKey !== undefined) return cachedKey;
  const override = process.env.HIVEMYND_KEY;
  if (override && override.trim()) {
    cachedKey = override.trim();
    return cachedKey;
  }
  try {
    cachedKey = readFileSync(join(homedir(), '.hivemynd', 'listener.key'), 'utf8').trim() || null;
  } catch {
    cachedKey = null;
  }
  return cachedKey;
}

function isEnabled(v: string | undefined): boolean {
  return v !== '0' && v !== 'false';
}

function port(name: string, fallback: number): number | null {
  const n = Number(process.env[name] ?? fallback);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Only absolute paths, and `_mcp_` is a synthetic source marker rather than a
 * real note — sending it would just produce a miss in both visualisers.
 */
function cleanPaths(paths: readonly (string | null | undefined)[]): string[] {
  return paths
    .map((p) => (p ?? '').trim())
    .filter((p) => p && p !== '_mcp_' && /^([/\\]|[A-Za-z]:[/\\])/.test(p));
}

async function pulseHivemynd(kind: ActivityKind, texts: string[]): Promise<void> {
  if (!isEnabled(process.env.HIVEMYND_ACTIVITY)) return;
  const p = port('HIVEMYND_PORT', 27183);
  const key = hivemyndKey();
  if (!p || !key) return;

  try {
    await fetch(`http://127.0.0.1:${p}/pulse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Hivemynd-Key': key },
      body: JSON.stringify({ agent: 'dsh', kind, texts }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    /* expected when the plugin is off */
  }
}

async function pulseNeuralVault(kind: ActivityKind, texts: string[]): Promise<void> {
  if (!isEnabled(process.env.NEURAL_VAULT_ACTIVITY)) return;
  const p = port('NEURAL_VAULT_PORT', 8765);
  if (!p) return;

  // Neural Vault takes one file per request and colours by tool name: it treats
  // Edit|Write|MultiEdit|NotebookEdit as a write and everything else as a read.
  // It has no separate "search" concept, so a search becomes a read.
  const toolName = kind === 'write' ? 'Write' : 'Read';

  await Promise.all(
    texts.map(async (filePath) => {
      try {
        await fetch(`http://127.0.0.1:${p}/read`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tool_name: toolName, tool_input: { file_path: filePath } }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        /* expected when the plugin is off */
      }
    }),
  );
}

/**
 * Report that an agent read, wrote, or searched these vault paths.
 *
 * Awaits both visualisers in parallel; neither can reject.
 */
export async function reportActivity(
  kind: ActivityKind,
  paths: readonly (string | null | undefined)[],
  _agent = 'dsh',
): Promise<void> {
  const texts = cleanPaths(paths);
  if (texts.length === 0) return;

  await Promise.all([pulseHivemynd(kind, texts), pulseNeuralVault(kind, texts)]);
}
