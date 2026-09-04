/**
 * Spread from a set of ensemble members.
 *
 * p90 minus p10 — the width of the range eight members in ten fall inside.
 * Type 7 quantiles, the NumPy and R default, so the numbers can be checked.
 */

export function quantileSorted(sorted, p) {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const h = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return lo === hi ? sorted[lo] : sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** p90 - p10 across members at one timestep, or null if too few reported. */
export function spreadOf(values) {
  const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length < 5) return null;
  return quantileSorted(clean, 0.9) - quantileSorted(clean, 0.1);
}
