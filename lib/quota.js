/**
 * Antigravity quota summary: normalization and a short-lived cache shared by
 * the browser widget.
 *
 * The backend RPC is `POST /v1internal:retrieveUserQuotaSummary`; it groups
 * models and reports one bucket per window (`5h`, `weekly`) with the remaining
 * fraction, a reset time, and a human description.
 */

const WINDOW_5H = '5h';
const WINDOW_WEEKLY = 'weekly';

function normalizeWindow(value) {
  if (typeof value !== 'string') return 'other';
  const lower = value.trim().toLowerCase();
  if (lower === '5h' || lower === '5_hour' || lower === '5-hour' || lower === 'five_hour' || lower === 'five-hour') return WINDOW_5H;
  if (lower === 'weekly' || lower === 'week' || lower === '7d') return WINDOW_WEEKLY;
  return lower === '' ? 'other' : lower;
}

function fraction(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(1, Math.max(0, number));
}

/**
 * Turn the raw RPC body into the shape the widget reads.
 * @param {object} raw
 * @param {{email?: string, fetchedAt?: Date}} [meta]
 */
export function normalizeQuotaSummary(raw, meta = {}) {
  const fetchedAt = meta.fetchedAt ?? new Date();
  const groups = [];
  for (const group of Array.isArray(raw?.groups) ? raw.groups : []) {
    if (group === null || typeof group !== 'object') continue;
    const buckets = [];
    for (const bucket of Array.isArray(group.buckets) ? group.buckets : []) {
      if (bucket === null || typeof bucket !== 'object') continue;
      const remainingFraction = fraction(bucket.remainingFraction);
      buckets.push({
        id: typeof bucket.bucketId === 'string' ? bucket.bucketId : '',
        name: typeof bucket.displayName === 'string' ? bucket.displayName : '',
        window: normalizeWindow(bucket.window),
        description: typeof bucket.description === 'string' ? bucket.description : '',
        remainingFraction,
        usedFraction: remainingFraction === undefined ? undefined : Math.round((1 - remainingFraction) * 1e6) / 1e6,
        resetTime: typeof bucket.resetTime === 'string' ? bucket.resetTime : undefined,
      });
    }
    if (buckets.length === 0) continue;
    groups.push({
      name: typeof group.displayName === 'string' && group.displayName !== '' ? group.displayName : 'Antigravity',
      description: typeof group.description === 'string' ? group.description : '',
      buckets,
    });
  }
  return {
    fetchedAt: fetchedAt.toISOString(),
    ...(typeof meta.email === 'string' && meta.email !== '' ? { account: meta.email } : {}),
    groups,
  };
}

/** Whether a normalized summary carries at least one 5h/weekly bucket. */
export function hasUsableQuota(summary) {
  return Array.isArray(summary?.groups)
    && summary.groups.some((group) => group.buckets.some((bucket) => bucket.window === WINDOW_5H || bucket.window === WINDOW_WEEKLY));
}

/** One cached quota read; concurrent callers share the in-flight request. */
export class QuotaCache {
  /**
   * @param {{load: () => Promise<object>, ttlMs?: number, logger?: {warn?: Function}}} options
   */
  constructor(options) {
    this.load = options.load;
    this.ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 60_000;
    this.logger = options.logger;
    this.cached = undefined;
    this.cachedAt = 0;
    this.pending = undefined;
  }

  async get({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.cached !== undefined && now - this.cachedAt < this.ttlMs) return this.cached;
    if (this.pending !== undefined) return await this.pending;
    this.pending = (async () => {
      const data = await this.load();
      this.cached = data;
      this.cachedAt = Date.now();
      return data;
    })().finally(() => {
      this.pending = undefined;
    });
    return await this.pending;
  }
}

export { WINDOW_5H, WINDOW_WEEKLY };
