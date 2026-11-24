export {
  QUOTA_RATES_OVERRIDE_FILE,
  FAMILY_QUOTA_STATE_FILE,
  CALIBRATION_STATE_FILE,
  DEFAULT_TOKEN_WEIGHTS,
  DEFAULT_POOL_RATES,
  DEFAULT_FAMILY_DETECTION,
  DEFAULT_CALIBRATION_RULES,
  loadQuotaRatesConfig,
  resolveModelQuotaRate,
  invalidateQuotaRatesCache,
  readRawQuotaRatesOverride,
  saveQuotaPoolRateOverride,
  resetQuotaRatesOverride,
} from './contract.mjs';

export {
  computeWeightedTokens,
  estimateQuotaFromByModel,
  estimateTurnQuotaUsage,
  estimateTotalsQuotaUsage,
} from './estimator.mjs';

export {
  cloneQuotaGroups,
  mergeCatalogQuotaFallback,
  buildCodexQuotaFromRateLimits,
  pickLatestCodexQuota,
} from './pool_snapshot.mjs';

import {
  updateFamilyQuotaTracker,
  resetFamilyQuotaTracker,
  clearFamilyQuotaCacheForTest,
} from './family_detector.mjs';

import {
  updateQuotaCalibrationTracker,
  startSoloCalibrationWindow,
  applyPoolCalibration,
  resetCalibratedPoolRates,
  clearCalibrationCacheForTest,
} from './calibrator.mjs';

export {
  updateFamilyQuotaTracker,
  resetFamilyQuotaTracker,
  clearFamilyQuotaCacheForTest,
  updateQuotaCalibrationTracker,
  startSoloCalibrationWindow,
  applyPoolCalibration,
  resetCalibratedPoolRates,
  clearCalibrationCacheForTest,
};

export function handleQuotaAction(data, nowMs = Date.now()) {
  const action = data?.action;
  const poolKey = typeof data?.poolKey === 'string' ? data.poolKey : '';

  if (action === 'reset_family_quota') {
    resetFamilyQuotaTracker({ poolKey, nowMs });
    return { ok: true, message: '已重置预期家庭成员使用额度基线' };
  }
  if (action === 'start_calibration_window') {
    const res = startSoloCalibrationWindow({ poolKey, nowMs });
    return {
      ...res,
      message: poolKey
        ? `已重置 ${poolKey} 单人校准起点，请独享运行 1-2 轮重任务（实降 ≥2%）后点击校准`
        : '已重置全部配额池单人校准起点，请独享运行重任务（实降 ≥2%）后点击校准',
    };
  }
  if (action === 'calibrate_quota' || action === 'apply_overestimate_fix') {
    const res = applyPoolCalibration({
      poolKey,
      mode: action === 'apply_overestimate_fix' ? 'overestimate_fix' : 'solo',
      nowMs,
    });
    if (res.ok) {
      resetFamilyQuotaTracker({ poolKey, nowMs });
    }
    return res;
  }
  if (action === 'reset_quota_rates') {
    const res = resetCalibratedPoolRates({ poolKey, nowMs });
    if (res.ok) {
      resetFamilyQuotaTracker({ poolKey, nowMs });
    }
    return res;
  }
  return null;
}
