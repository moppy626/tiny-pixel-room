import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, computeStreaks, expSince, summarizeLanguages } from '../src/stats.mjs';

const days = (entries) => entries.map(([date, count]) => ({ date, count }));

test('addDays は月と年をまたいで計算する', () => {
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2025-12-31', 1), '2026-01-01');
});

test('今日が 0 件でも昨日まで続いていれば current は切れない', () => {
  const result = computeStreaks(days([['2026-11-05', 1], ['2026-11-06', 2], ['2026-11-07', 3], ['2026-11-08', 0]]), '2026-11-08');
  assert.deepEqual(result, { current: 3, longest: 3 });
});

test('昨日も 0 件なら current は 0 になる', () => {
  const result = computeStreaks(days([['2026-11-05', 4], ['2026-11-06', 0], ['2026-11-07', 0], ['2026-11-08', 0]]), '2026-11-08');
  assert.deepEqual(result, { current: 0, longest: 1 });
});

test('年をまたぐ連続と、年の境界で重複した日を正しく数える', () => {
  const result = computeStreaks(
    days([['2025-12-30', 1], ['2025-12-31', 1], ['2025-12-31', 1], ['2026-01-01', 1], ['2026-01-02', 1]]),
    '2026-01-02',
  );
  assert.deepEqual(result, { current: 4, longest: 4 });
});

test('longest は過去の記録を保つ', () => {
  const result = computeStreaks(
    days([['2026-01-01', 1], ['2026-01-02', 1], ['2026-01-03', 1], ['2026-01-05', 1], ['2026-01-06', 1]]),
    '2026-01-06',
  );
  assert.deepEqual(result, { current: 2, longest: 3 });
});

test('expSince は開始日を含めて数える', () => {
  assert.equal(expSince(days([['2026-05-01', 3], ['2026-05-02', 4], ['2026-04-30', 100]]), '2026-05-01'), 7);
});

test('年の境界で重複した日は EXP でも 1 日として数える', () => {
  assert.equal(expSince(days([['2025-12-31', 5], ['2025-12-31', 5], ['2026-01-01', 1]]), '2025-12-31'), 6);
  assert.equal(expSince(days([['2025-12-31', 5], ['2025-12-31', 0]]), '2025-12-31'), 5);
});

test('重複した日の片方が 0 件でも、連続記録は切らない', () => {
  const result = computeStreaks(days([['2025-12-31', 5], ['2025-12-31', 0], ['2026-01-01', 1]]), '2026-01-01');
  assert.deepEqual(result, { current: 2, longest: 2 });
});

test('今日の分は、コントリビューションのグラフに今日の日付で入っていれば数える', () => {
  const result = computeStreaks(days([['2026-11-06', 1], ['2026-11-07', 1], ['2026-11-08', 2]]), '2026-11-08');
  assert.deepEqual(result, { current: 3, longest: 3 });
});

test('コントリビューションのグラフの今日の前日が 0 件なら、その日のうちに連続記録は切れる', () => {
  // 日本時間のコントリビューションのグラフで、日本の 00:17 (今日はまだ 0 件) に実行したとき。前日の 11-08 に活動がなかった。
  const result = computeStreaks(days([['2026-11-06', 1], ['2026-11-07', 1], ['2026-11-08', 0], ['2026-11-09', 0]]), '2026-11-09');
  assert.deepEqual(result, { current: 0, longest: 2 });
});

test('言語はリポジトリをまたいでバイト数を足し、多い順に上位 5 つを出す', () => {
  const rows = summarizeLanguages([
    { languages: [{ name: 'A', size: 300 }, { name: 'B', size: 100 }, { name: 'C', size: 50 }] },
    { languages: [{ name: 'B', size: 250 }, { name: 'D', size: 40 }, { name: 'E', size: 30 }, { name: 'F', size: 5 }] },
  ]);
  assert.deepEqual(rows.map((row) => row.name), ['B', 'A', 'C', 'D', 'E']);
});

test('割合は、出す 5 つの言語の合計に対する値で、Other は出さない', () => {
  const rows = summarizeLanguages([
    { languages: [{ name: 'A', size: 40 }, { name: 'B', size: 30 }, { name: 'C', size: 20 }, { name: 'D', size: 5 }, { name: 'E', size: 5 }] },
    { languages: [{ name: 'F', size: 100 }] },
  ]);
  // 6 番目の F は分母に入らない。F を除いた 5 つで 100 になる。
  assert.deepEqual(rows.map((row) => row.name), ['F', 'A', 'B', 'C', 'D']);
  const percents = Object.fromEntries(rows.map((row) => [row.name, row.percent.toFixed(2)]));
  assert.deepEqual(percents, { F: '51.28', A: '20.51', B: '15.38', C: '10.26', D: '2.56' });
});

test('言語がないリポジトリだけなら空を返す', () => {
  assert.deepEqual(summarizeLanguages([{ languages: [] }]), []);
});
