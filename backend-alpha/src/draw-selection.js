import { randomInt } from 'node:crypto';

// Alpha adaptation of MVP Raffle v2's CSPRNG_UNBIASED_INT_V1 selection.
// Only the backend calls this; the returned ranges are persisted with the result.
const MAX_EXCLUSIVE = 2 ** 48;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function selectDrawReward(segments, nextInt = randomInt) {
  if (!Array.isArray(segments) || segments.length === 0)
    throw new TypeError('Draw requires eligible rewards');
  const ordered = [...segments].sort((left, right) => left.segmentIndex - right.segmentIndex);
  const indexes = new Set();
  const ids = new Set();
  const ranges = [];
  let cursor = 0;
  for (const segment of ordered) {
    const id = typeof segment.rewardId === 'string' ? segment.rewardId.toLowerCase() : '';
    const end = cursor + segment.weight;
    if (!Number.isSafeInteger(segment.segmentIndex) || segment.segmentIndex < 0 ||
        indexes.has(segment.segmentIndex) || !UUID.test(id) || ids.has(id) ||
        !Number.isSafeInteger(segment.weight) || segment.weight <= 0 ||
        !Number.isSafeInteger(end) || end <= 0 || end >= MAX_EXCLUSIVE ||
        !segment.rewardSnapshot || typeof segment.rewardSnapshot !== 'object' ||
        Array.isArray(segment.rewardSnapshot))
      throw new TypeError('Invalid Draw reward configuration');
    const rewardSnapshot = structuredClone(segment.rewardSnapshot);
    ranges.push({ segmentIndex: segment.segmentIndex, rewardId: id,
      weight: segment.weight, startInclusive: cursor, endExclusive: end,
      rewardSnapshot });
    indexes.add(segment.segmentIndex);
    ids.add(id);
    cursor = end;
  }
  const ticket = nextInt(cursor);
  if (!Number.isSafeInteger(ticket) || ticket < 0 || ticket >= cursor)
    throw new Error('Invalid Draw random ticket');
  const selected = ranges.find(range => range.startInclusive <= ticket && ticket < range.endExclusive);
  if (!selected) throw new Error('Draw selection range mismatch');
  return { algorithm: 'CSPRNG_UNBIASED_INT_V1', ticket, totalWeight: cursor,
    selectedSegmentIndex: selected.segmentIndex, selectedRewardId: selected.rewardId,
    selectedRewardSnapshot: selected.rewardSnapshot, ranges };
}
