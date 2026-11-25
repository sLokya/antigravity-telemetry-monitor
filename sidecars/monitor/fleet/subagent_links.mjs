import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const transcriptLinkCache = new Map(); // convId -> { size: number, leftover: string, links: Array }

const CONV_ID_RE = /\\?"conversation_?[iI]d\\?"\s*:\s*\\?"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/g;
const NAME_RE = /\\?"name\\?"\s*:\s*\\?"([^"\\]+)/;
const CREATED_AT_RE = /"created_at"\s*:\s*"([^"]+)"/;

const SPAWN_CONTEXT_RE = /invoke_subagent|subagent|swarm|worker|spawned|send_message/i;

function extractLineLinks(line, parentId) {
  if (
    !line ||
    (!line.includes('onversation_id') && !line.includes('onversationId')) ||
    !SPAWN_CONTEXT_RE.test(line)
  ) {
    return [];
  }

  let spawnedAtMs = 0;
  let searchText = line;
  try {
    const obj = JSON.parse(line);
    if (obj?.created_at) {
      spawnedAtMs = Date.parse(obj.created_at) || 0;
    }
    if (typeof obj?.content === 'string') {
      searchText = obj.content;
    }
  } catch {
    const tsMatch = line.match(CREATED_AT_RE);
    if (tsMatch) {
      spawnedAtMs = Date.parse(tsMatch[1]) || 0;
    }
  }

  const foundIds = new Set();
  CONV_ID_RE.lastIndex = 0;
  let m;
  const parentLower = String(parentId).toLowerCase();
  while ((m = CONV_ID_RE.exec(searchText)) !== null) {
    const childId = m[1].toLowerCase();
    if (childId !== parentLower) {
      foundIds.add(childId);
    }
  }
  if (foundIds.size === 0 && searchText !== line) {
    CONV_ID_RE.lastIndex = 0;
    while ((m = CONV_ID_RE.exec(line)) !== null) {
      const childId = m[1].toLowerCase();
      if (childId !== parentLower) {
        foundIds.add(childId);
      }
    }
  }
  if (foundIds.size === 0) return [];

  let name = '';
  if (foundIds.size === 1) {
    const nameMatch = searchText.match(NAME_RE) || (searchText !== line ? line.match(NAME_RE) : null);
    if (nameMatch && nameMatch[1] !== 'swarm' && nameMatch[1] !== 'invoke_subagent') {
      name = nameMatch[1];
    }
  }

  const out = [];
  for (const childId of foundIds) {
    out.push({ childId, parentId, name, spawnedAtMs });
  }
  return out;
}

function readTranscriptLinksIncremental(convId, brainDir) {
  const transcriptPath = join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!existsSync(transcriptPath)) return [];

  let st;
  try {
    st = statSync(transcriptPath);
  } catch {
    return [];
  }

  let cache = transcriptLinkCache.get(convId);
  if (!cache || st.size < cache.size) {
    cache = { size: 0, leftover: '', links: [] };
  }

  if (st.size === cache.size) {
    return cache.links;
  }

  const deltaBytes = st.size - cache.size;
  let chunkStr = '';
  let fd = null;
  try {
    fd = openSync(transcriptPath, 'r');
    const buf = Buffer.allocUnsafe(deltaBytes);
    const bytesRead = readSync(fd, buf, 0, deltaBytes, cache.size);
    chunkStr = buf.toString('utf-8', 0, bytesRead);
  } catch {
    return cache.links;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }

  const combined = cache.leftover + chunkStr;
  const lines = combined.split('\n');
  const leftover = lines.pop() ?? '';

  for (const line of lines) {
    const extracted = extractLineLinks(line, convId);
    if (extracted.length > 0) {
      cache.links.push(...extracted);
    }
  }

  cache.size = st.size;
  cache.leftover = leftover;
  transcriptLinkCache.set(convId, cache);
  return cache.links;
}

export function scanSpawnLinks(convIds = [], brainDir) {
  const linkMap = new Map();
  if (!brainDir) return linkMap;

  for (const convId of convIds) {
    if (!convId) continue;
    const links = readTranscriptLinksIncremental(convId, brainDir);
    for (const item of links) {
      if (!linkMap.has(item.childId)) {
        linkMap.set(item.childId, {
          parentId: item.parentId,
          name: item.name,
          spawnedAtMs: item.spawnedAtMs,
        });
      }
    }
  }
  return linkMap;
}
