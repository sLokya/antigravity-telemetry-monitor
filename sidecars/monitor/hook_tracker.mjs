import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const STATE_FILE = join(homedir(), '.gemini', 'antigravity', 'scratch', 'telemetry_live_state.json');
const eventType = process.argv[2] || 'UNKNOWN';

let raw = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const payload = raw.trim() ? JSON.parse(raw) : {};
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    const state = {
      eventType,
      timestampMs: Date.now(),
      conversationId: payload.conversationId || '',
      modelName: payload.modelName || '',
      invocationNum: payload.invocationNum ?? null,
      stepIdx: payload.stepIdx ?? null,
      toolName: payload.toolCall?.name || null,
      terminationReason: payload.terminationReason || null,
      fullyIdle: payload.fullyIdle ?? null
    };
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {
    // Ignore errors in passive telemetry hook
  }
  process.stdout.write('{}\n');
});
