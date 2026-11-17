import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const SCRATCH_DIR = join(HOME, '.gemini', 'antigravity', 'scratch');
export const FINGERPRINT_LEDGER_FILE = join(SCRATCH_DIR, 'telemetry_fingerprints.json');

export function normalizeRouteFamily(modelId) {
  return String(modelId || '')
    .trim()
    .toLowerCase()
    .replace(/-(xhigh|high|medium|low|lite|d)$/i, '')
    .replace(/-worker-agy$/i, '');
}

export function isResponseModelMismatched(requestedModelId, responseModel) {
  const req = normalizeRouteFamily(requestedModelId);
  const resp = normalizeRouteFamily(responseModel);
  if (!req || !resp || req === 'unknown' || resp === 'unknown' || req.startsWith('model_placeholder_')) {
    return false;
  }
  if (req === resp || req.startsWith(resp) || resp.startsWith(req)) {
    return false;
  }
  if (req.includes('orchestrator') && resp.includes('orchestrator')) {
    return false;
  }
  return true;
}

export function decodeThinkingSignatureFingerprint(b64) {
  if (!b64 || typeof b64 !== 'string') return null;
  try {
    let buf = Buffer.from(b64, 'base64');
    if (buf.length < 8) return null;
    const rawByteLen = buf.length;

    // Anthropic Vertex double-encodes the thinking signature protobuf in Base64 ("CAQS...")
    if (buf[0] === 0x43 && buf[1] === 0x41 && buf[2] === 0x51) {
      try {
        const inner = Buffer.from(buf.toString('ascii'), 'base64');
        if (inner.length >= 16) buf = inner;
      } catch {
        // keep outer buf if inner decode fails
      }
    }

    let offset = 0;
    if (buf[offset] === 0x08) {
      offset++;
      while (offset < buf.length && (buf[offset] & 0x80)) offset++;
      offset++;
    }
    if (buf[offset] === 0x12) {
      offset++;
      while (offset < buf.length && (buf[offset] & 0x80)) offset++;
      offset++;
    }
    if (buf[offset] === 0x0a) {
      offset++;
      while (offset < buf.length && (buf[offset] & 0x80)) offset++;
      offset++;
    }
    const keyHex = buf.subarray(offset, Math.min(buf.length, offset + 5)).toString('hex');
    return {
      keyHex: keyHex || buf.subarray(0, 5).toString('hex'),
      byteLen: rawByteLen,
    };
  } catch {
    return null;
  }
}

let inMemoryFpLedger = null;
let fpLedgerDirty = false;
let lastFpFlushMs = 0;
const seenStepFpSet = new Set();

export function loadFingerprintLedger() {
  if (inMemoryFpLedger) return inMemoryFpLedger;
  try {
    if (existsSync(FINGERPRINT_LEDGER_FILE)) {
      const parsed = JSON.parse(readFileSync(FINGERPRINT_LEDGER_FILE, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        const rawBaselines = parsed.baselines || {};
        const cleanBaselines = {};
        let cleanedBogus = false;
        for (const [k, v] of Object.entries(rawBaselines)) {
          if (v?.apiProvider === 'OPENAI_CODEX' || k.startsWith('gpt-')) {
            cleanedBogus = true;
            continue;
          }
          const known = new Set(Array.isArray(v.knownKeys) ? v.knownKeys : []);
          if (v.baselineKeyHex) known.add(v.baselineKeyHex);
          if (v.status === 'MATCH' && v.latestKeyHex) known.add(v.latestKeyHex);
          cleanBaselines[k] = {
            ...v,
            knownKeys: Array.from(known),
          };
        }
        const rawEvents = Array.isArray(parsed.events) ? parsed.events : [];
        const cleanEvents = rawEvents.filter(
          (e) => e?.apiProvider !== 'OPENAI_CODEX' && !String(e?.modelFamily || '').startsWith('gpt-')
        );
        if (cleanEvents.length !== rawEvents.length) cleanedBogus = true;

        inMemoryFpLedger = {
          updatedAtMs: parsed.updatedAtMs || Date.now(),
          baselines: cleanBaselines,
          events: cleanEvents,
        };
        if (cleanedBogus) {
          fpLedgerDirty = true;
          flushFingerprintLedger(true);
        }
        return inMemoryFpLedger;
      }
    }
  } catch {
    // fallback to clean ledger
  }
  inMemoryFpLedger = {
    updatedAtMs: Date.now(),
    baselines: {},
    events: [],
  };
  return inMemoryFpLedger;
}

export function flushFingerprintLedger(force = false) {
  if (!inMemoryFpLedger) return;
  const now = Date.now();
  if (!force && (!fpLedgerDirty || now - lastFpFlushMs < 5000)) return;
  try {
    if (!existsSync(SCRATCH_DIR)) {
      mkdirSync(SCRATCH_DIR, { recursive: true });
    }
    inMemoryFpLedger.updatedAtMs = now;
    writeFileSync(FINGERPRINT_LEDGER_FILE, JSON.stringify(inMemoryFpLedger, null, 2), 'utf-8');
    fpLedgerDirty = false;
    lastFpFlushMs = now;
  } catch {
    // ignore write errors
  }
}

function normalizeModelFamily(responseModel, exactModelId) {
  const raw = String(responseModel || exactModelId || '')
    .trim()
    .toLowerCase();
  if (!raw || raw === '--' || raw === 'n/a' || raw === 'unknown') return '';
  return raw.replace(/-(low|medium|high|lite)$/i, '');
}

export function recordModelFingerprint({
  convId,
  convTitle,
  responseModel,
  exactModelId,
  sigKeyHex,
  sigBytes,
  apiProvider,
  stepCount,
}) {
  const family = normalizeModelFamily(responseModel, exactModelId);
  if (!family || !sigKeyHex || apiProvider === 'OPENAI_CODEX' || family.startsWith('gpt-')) {
    return {
      modelFamily: family || '--',
      status: 'NONE',
      baselineKeyHex: '',
      latestKeyHex: '',
    };
  }

  const ledger = loadFingerprintLedger();
  const now = Date.now();
  const dedupKey = `${convId}:${stepCount}:${sigKeyHex}`;
  const isNewObservation = !seenStepFpSet.has(dedupKey);
  if (isNewObservation) {
    seenStepFpSet.add(dedupKey);
  }

  let base = ledger.baselines[family];
  if (!base) {
    base = {
      modelFamily: family,
      exactModelId: exactModelId || family,
      baselineKeyHex: sigKeyHex,
      latestKeyHex: sigKeyHex,
      knownKeys: [sigKeyHex],
      sigBytes: sigBytes || 0,
      apiProvider: apiProvider || 'UNKNOWN',
      firstSeenMs: now,
      lastSeenMs: now,
      verifiedCount: 1,
      status: 'MATCH',
      prevKeyHex: '',
      changedAtMs: 0,
    };
    ledger.baselines[family] = base;
    ledger.events.unshift({
      id: `fp-${now}-${Math.random().toString(36).slice(2, 6)}`,
      timestampMs: now,
      type: 'BASELINE_INIT',
      modelFamily: family,
      exactModelId: exactModelId || family,
      prevKeyHex: '',
      newKeyHex: sigKeyHex,
      apiProvider: apiProvider || 'UNKNOWN',
      conversationId: convId,
      conversationTitle: convTitle || convId.slice(0, 8),
      acknowledged: true,
    });
    ledger.events = ledger.events.slice(0, 50);
    fpLedgerDirty = true;
    flushFingerprintLedger(true);
    return {
      modelFamily: family,
      status: 'MATCH',
      baselineKeyHex: base.baselineKeyHex,
      latestKeyHex: sigKeyHex,
    };
  }

  if (!Array.isArray(base.knownKeys)) {
    base.knownKeys = base.baselineKeyHex ? [base.baselineKeyHex] : [];
  }

  const isKnownOrAckedKey =
    sigKeyHex === base.baselineKeyHex || base.knownKeys.includes(sigKeyHex);

  if (isNewObservation) {
    base.lastSeenMs = now;
    base.verifiedCount = (base.verifiedCount || 0) + 1;
    if (!isKnownOrAckedKey || sigKeyHex === base.baselineKeyHex) {
      base.latestKeyHex = sigKeyHex;
    }
    if (sigBytes) base.sigBytes = sigBytes;
    if (exactModelId) base.exactModelId = exactModelId;
    fpLedgerDirty = true;
  }

  if (!isKnownOrAckedKey) {
    base.latestKeyHex = sigKeyHex;
    base.status = 'CHANGED';
    base.prevKeyHex = base.baselineKeyHex;
    if (!base.changedAtMs) base.changedAtMs = now;
    const hasUnackedSameEvent = ledger.events.some(
      (e) =>
        !e.acknowledged &&
        e.type === 'KEY_CHANGED' &&
        e.modelFamily === family &&
        e.newKeyHex === sigKeyHex
    );
    if (!hasUnackedSameEvent) {
      ledger.events.unshift({
        id: `fp-${now}-${Math.random().toString(36).slice(2, 6)}`,
        timestampMs: now,
        type: 'KEY_CHANGED',
        modelFamily: family,
        exactModelId: exactModelId || family,
        prevKeyHex: base.baselineKeyHex,
        newKeyHex: sigKeyHex,
        apiProvider: apiProvider || base.apiProvider || 'UNKNOWN',
        conversationId: convId,
        conversationTitle: convTitle || convId.slice(0, 8),
        acknowledged: false,
      });
      ledger.events = ledger.events.slice(0, 50);
      fpLedgerDirty = true;
      flushFingerprintLedger(true);
    }
    return {
      modelFamily: family,
      status: 'CHANGED',
      baselineKeyHex: base.baselineKeyHex,
      latestKeyHex: sigKeyHex,
      prevKeyHex: base.baselineKeyHex,
    };
  }

  return {
    modelFamily: family,
    status: base.status === 'CHANGED' ? 'CHANGED' : 'MATCH',
    baselineKeyHex: base.baselineKeyHex,
    latestKeyHex: base.latestKeyHex || sigKeyHex,
  };
}

export function acknowledgeFingerprintChanges(targetFamily = '') {
  const ledger = loadFingerprintLedger();
  const now = Date.now();
  for (const [fam, base] of Object.entries(ledger.baselines)) {
    if (!targetFamily || targetFamily === fam) {
      const known = new Set(Array.isArray(base.knownKeys) ? base.knownKeys : []);
      if (base.baselineKeyHex) known.add(base.baselineKeyHex);
      if (base.prevKeyHex) known.add(base.prevKeyHex);
      if (base.latestKeyHex) {
        known.add(base.latestKeyHex);
        base.baselineKeyHex = base.latestKeyHex;
      }
      base.knownKeys = Array.from(known);
      base.status = 'MATCH';
      base.changedAtMs = 0;
      base.ackedAtMs = now;
    }
  }
  for (const evt of ledger.events) {
    if (!targetFamily || evt.modelFamily === targetFamily) {
      evt.acknowledged = true;
      evt.ackedAtMs = now;
      const base = ledger.baselines[evt.modelFamily];
      if (base) {
        const known = new Set(Array.isArray(base.knownKeys) ? base.knownKeys : []);
        if (evt.newKeyHex) known.add(evt.newKeyHex);
        if (evt.prevKeyHex) known.add(evt.prevKeyHex);
        base.knownKeys = Array.from(known);
      }
    }
  }
  fpLedgerDirty = true;
  flushFingerprintLedger(true);
  return ledger;
}
