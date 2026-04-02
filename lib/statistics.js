/**
 * Statistical significance calculations for A/B tests.
 * Uses two-proportion Z-test.
 */

// Approximation of the standard normal CDF (Abramowitz & Stegun)
function normCdf(z) {
  const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
  const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/**
 * Two-proportion Z-test between control (A) and variant (B).
 * Returns p-value (two-tailed), Z-score, uplift %, and confidence level.
 */
function zTest(viewsA, convsA, viewsB, convsB) {
  if (viewsA < 1 || viewsB < 1) return null;

  const pA = convsA / viewsA;
  const pB = convsB / viewsB;
  const pooled = (convsA + convsB) / (viewsA + viewsB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / viewsA + 1 / viewsB));

  if (se === 0) return null;

  const z = (pB - pA) / se;
  const pValue = 2 * (1 - normCdf(Math.abs(z)));
  const confidence = (1 - pValue) * 100;
  const uplift = pA > 0 ? ((pB - pA) / pA) * 100 : null;

  return {
    z: +z.toFixed(4),
    pValue: +pValue.toFixed(4),
    confidence: +confidence.toFixed(1),
    uplift: uplift !== null ? +uplift.toFixed(2) : null,
    significant: pValue < 0.05,
    confident95: pValue < 0.05,
    confident99: pValue < 0.01,
  };
}

/**
 * Minimum sample size per variation for a given MDE (minimum detectable effect).
 * Uses simplified formula for 95% confidence, 80% power.
 */
function minSampleSize(baseRate, mde = 0.05, alpha = 0.05, power = 0.8) {
  if (baseRate <= 0 || baseRate >= 1) return null;
  const pB = baseRate * (1 + mde);
  const zAlpha = 1.96; // two-tailed 95%
  const zBeta  = 0.842; // 80% power
  const pooled = (baseRate + pB) / 2;
  const n = Math.ceil(
    (zAlpha + zBeta) ** 2 * pooled * (1 - pooled) / (baseRate - pB) ** 2
  );
  return n;
}

/**
 * Runs significance analysis across all variation pairs vs the first (control).
 * Returns enriched variation objects.
 */
function analyzeVariations(variations) {
  if (!variations || variations.length < 2) return variations;

  const control = variations[0];
  return variations.map((v, i) => {
    if (i === 0) return { ...v, isControl: true, significance: null };
    const sig = zTest(control.views, control.conversions, v.views, v.conversions);
    return { ...v, isControl: false, significance: sig };
  });
}

module.exports = { zTest, minSampleSize, analyzeVariations };
