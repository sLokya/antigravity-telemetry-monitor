function cloneBucket(b) {
  if (!b || typeof b !== 'object') return null;
  return {
    remainingFraction: typeof b.remainingFraction === 'number' ? b.remainingFraction : null,
    resetTime: b.resetTime || null,
    disabled: Boolean(b.disabled),
  };
}

export function cloneQuotaGroups(groups) {
  const out = {};
  if (!groups || typeof groups !== 'object') return out;
  for (const [key, grp] of Object.entries(groups)) {
    if (!grp || typeof grp !== 'object') continue;
    out[key] = {
      ...grp,
      fiveHour: cloneBucket(grp.fiveHour),
      weekly: cloneBucket(grp.weekly),
    };
  }
  return out;
}

// Fill ONLY missing/null pool buckets from GetCascadeModelConfigData.
// Never overwrite an already-present RetrieveUserQuotaSummary bucket,
// preventing 5h/weekly cross-endpoint desync and in-place cache mutation.
export function mergeCatalogQuotaFallback(modelCatalog, quotaGroups) {
  if (!modelCatalog || !quotaGroups) return quotaGroups;
  for (const entry of modelCatalog.values()) {
    if (typeof entry.remainingFraction !== 'number' || !entry.resetTime) continue;
    const is3p = /claude|sonnet|opus|gpt/i.test(String(entry.label || entry.modelId || ''));
    const poolKey = is3p ? '3p' : 'gemini';
    if (!quotaGroups[poolKey]) {
      quotaGroups[poolKey] = {
        displayName: is3p ? 'Claude & GPT' : 'Gemini Models',
        fiveHour: null,
        weekly: null,
      };
    }
    const grp = quotaGroups[poolKey];
    if (!grp.fiveHour || grp.fiveHour.remainingFraction === null || grp.fiveHour.remainingFraction === undefined) {
      grp.fiveHour = {
        remainingFraction: entry.remainingFraction,
        resetTime: entry.resetTime,
        disabled: false,
      };
    }
  }
  return quotaGroups;
}

export function buildCodexQuotaFromRateLimits(rl) {
  if (!rl || typeof rl !== 'object') return null;
  return {
    planType: rl.plan_type || 'plus',
    fiveHour: rl.primary
      ? {
          remainingFraction: Math.max(0, (100 - (rl.primary.used_percent || 0)) / 100),
          resetTime: rl.primary.resets_at
            ? new Date(rl.primary.resets_at * 1000).toISOString()
            : null,
        }
      : null,
    weekly: rl.secondary
      ? {
          remainingFraction: Math.max(0, (100 - (rl.secondary.used_percent || 0)) / 100),
          resetTime: rl.secondary.resets_at
            ? new Date(rl.secondary.resets_at * 1000).toISOString()
            : null,
        }
      : null,
  };
}

// Pick the Codex rate_limits snapshot with the strictly newest event timestamp,
// preventing stale thread snapshots from jumping into the global bar when an older
// SQLite thread row is touched.
export function pickLatestCodexQuota(candidates = []) {
  let best = null;
  let bestMs = -1;
  for (const c of candidates) {
    if (!c?.rateLimits) continue;
    const ts = Number(c.observedAtMs) || 0;
    if (!best || ts > bestMs) {
      best = c.rateLimits;
      bestMs = ts;
    }
  }
  return best ? buildCodexQuotaFromRateLimits(best) : null;
}
