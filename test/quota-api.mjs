/**
 * Quota summary test: normalization of a recorded RPC body, then one live read.
 *
 *   node test/quota-api.mjs
 */
import { normalizeQuotaSummary, hasUsableQuota } from '../lib/quota.js';
import { Transport } from '../lib/transport.js';
import { AuthStore } from '../lib/auth.js';
import { AntigravityApi } from '../lib/api.js';

const sample = {
  groups: [
    {
      displayName: 'Gemini Models',
      description: 'Models within this group: Gemini 3.8 Flash',
      buckets: [
        { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.9921473, resetTime: '2026-11-22T15:55:35Z', description: 'weekly' },
        { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.9869573, resetTime: '2026-11-16T14:51:19Z', description: 'five hour' },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      buckets: [
        { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.9815732 },
        { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.9638808 },
      ],
    },
  ],
};

const normalized = normalizeQuotaSummary(sample, { email: 'user@example.com', fetchedAt: new Date('2026-11-16T04:00:00Z') });
console.assert(normalized.groups.length === 2, 'two groups');
console.assert(normalized.account === 'user@example.com', 'account kept');
const gemini = normalized.groups[0];
const five = gemini.buckets.find((bucket) => bucket.window === '5h');
const week = gemini.buckets.find((bucket) => bucket.window === 'weekly');
console.assert(five !== undefined && Math.abs(five.usedFraction - 0.0130427) < 1e-6, '5h used fraction');
console.assert(week !== undefined && Math.abs(week.usedFraction - 0.0078527) < 1e-6, 'weekly used fraction');
console.assert(hasUsableQuota(normalized), 'usable quota');
console.log('normalization OK:', JSON.stringify({ groups: normalized.groups.map((group) => ({ name: group.name, five: findUsed(group, '5h'), weekly: findUsed(group, 'weekly') })) }));

function findUsed(group, window) {
  const bucket = group.buckets.find((entry) => entry.window === window);
  return bucket === undefined ? undefined : Math.round((bucket.usedFraction ?? 0) * 10000) / 100;
}

const transport = new Transport({ proxy: process.env.AGY_PROXY ?? '' });
console.log(`route: ${await transport.describe()}`);
const auth = new AuthStore({ transport });
const api = new AntigravityApi({ transport, auth, logger: { warn: console.warn, info: () => {} } });
const live = normalizeQuotaSummary(await api.quotaSummary(), { email: auth.email });
if (!hasUsableQuota(live)) throw new Error('live quota summary has no 5h/weekly buckets');
for (const group of live.groups) {
  const fiveBucket = group.buckets.find((bucket) => bucket.window === '5h');
  const weekBucket = group.buckets.find((bucket) => bucket.window === 'weekly');
  console.log(`${group.name}: 5h used=${findUsed(group, '5h')}% reset=${fiveBucket?.resetTime ?? '-'}; weekly used=${findUsed(group, 'weekly')}% reset=${weekBucket?.resetTime ?? '-'}`);
}
transport.close();
console.log('\nQUOTA API OK');
