import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyDate } from '../src/daily';
test('daily routing crosses months, accepts a stale month folder, and rejects invalid dates', () => {
  assert.equal(dailyDate('Daily/(10) October 2026/October 11, 2026.md', 'Daily'), '2026-10-11');
  assert.equal(dailyDate('Daily/(11) November 2026/November 1, 2026.md', 'Daily'), '2026-11-01');
  assert.equal(dailyDate('Daily/(2) February 2026/February 30, 2026.md', 'Daily'), null);
  assert.equal(dailyDate('Daily/(9) September 2026/October 11, 2026.md', 'Daily'), '2026-10-11');
  assert.equal(dailyDate('Other/(10) October 2026/October 11, 2026.md', 'Daily'), null);
  assert.equal(dailyDate('Daily/(10) October 2026/October 11th, 2026.md', 'Daily'), null);
});
