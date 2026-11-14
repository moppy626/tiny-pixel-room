import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nextState, readState, recordExp, recordPrivateCommits } from '../src/state.mjs';

function stateFile(t, text) {
  const dir = mkdtempSync(join(tmpdir(), 'tiny-pixel-room-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  if (text !== undefined) writeFileSync(path, text);
  return path;
}

test('ファイルがなければ null を返す', async (t) => {
  assert.equal(await readState(stateFile(t)), null);
});

test('正しいファイルはそのまま読む', async (t) => {
  const state = { version: 1, character: 'turnip', since: '2026-05-01', maxExp: 320 };
  assert.deepEqual(await readState(stateFile(t, JSON.stringify(state))), state);
});

test('うるう日の since も読む', async (t) => {
  const state = { version: 1, character: 'cactus', since: '2024-02-29', maxExp: 0 };
  assert.deepEqual(await readState(stateFile(t, JSON.stringify(state))), state);
});

for (const [label, text] of [
  ['JSON でない', '<<<<<<< HEAD'],
  ['日付の形が違う', '{"character":"turnip","since":"2026/05/01","maxExp":0}'],
  ['since がない', '{"character":"turnip","maxExp":0}'],
  ['実在しない月の', '{"character":"turnip","since":"2026-13-45","maxExp":0}'],
  ['実在しない日の', '{"character":"turnip","since":"2026-02-30","maxExp":0}'],
  ['character がない', '{"since":"2026-05-01","maxExp":0}'],
  ['character が種類の名前でない', '{"character":"Turnip","since":"2026-05-01","maxExp":0}'],
  ['null', 'null'],
  ['maxExp がない', '{"character":"turnip","since":"2026-05-01"}'],
  ['maxExp がマイナスの', '{"character":"turnip","since":"2026-05-01","maxExp":-1}'],
  ['maxExp が小数の', '{"character":"turnip","since":"2026-05-01","maxExp":1.5}'],
  ['maxExp が文字列の', '{"character":"turnip","since":"2026-05-01","maxExp":"10"}'],
]) {
  test(`${label} ファイルは場所を示して止まる`, async (t) => {
    const path = stateFile(t, text);
    await assert.rejects(readState(path), (error) => error.message.includes(path) && error.message.includes('壊れています'));
  });
}

test('初めて使う日は、今日から数える', () => {
  assert.deepEqual(nextState(null, 'turnip', '2026-11-08'), { version: 1, character: 'turnip', since: '2026-11-08', maxExp: 0 });
});

test('キャラクターが同じなら、開始日は変えない', () => {
  const state = { version: 1, character: 'turnip', since: '2026-05-01', maxExp: 0 };
  assert.equal(nextState(state, 'turnip', '2026-11-08'), state);
});

test('キャラクターを変えたら、次の日から数える', () => {
  const state = { version: 1, character: 'turnip', since: '2026-05-01', maxExp: 0 };
  assert.equal(nextState(state, 'cactus', '2026-11-08').since, '2026-11-09');
});

test('キャラクターを変えたら、最高 EXP は引き継がない', () => {
  const state = { version: 1, character: 'turnip', since: '2026-05-01', maxExp: 600 };
  assert.deepEqual(nextState(state, 'cactus', '2026-11-08'), { version: 1, character: 'cactus', since: '2026-11-09', maxExp: 0 });
});

test('キャラクターが同じなら、最高 EXP も残す', () => {
  const state = { version: 1, character: 'turnip', since: '2026-05-01', maxExp: 600 };
  assert.equal(nextState(state, 'turnip', '2026-11-08').maxExp, 600);
});

test('EXP が最高 EXP を超えたら、最高 EXP を更新する', () => {
  const state = { version: 1, character: 'turnip', since: '2026-05-01', maxExp: 100 };
  assert.deepEqual(recordExp(state, 130), { ...state, maxExp: 130 });
});

test('草の数が減って EXP が下がっても、最高 EXP は下げない', () => {
  const state = { version: 1, character: 'turnip', since: '2026-05-01', maxExp: 600 };
  assert.equal(recordExp(state, 420).maxExp, 600);
});

test('初めて使う日の EXP も、最高 EXP として覚える', () => {
  assert.equal(recordExp(nextState(null, 'turnip', '2026-11-08'), 42).maxExp, 42);
});

test('非公開リポジトリのコミットの数と読み方と数えた人と数えきれなくなった日を残し、なければ消す', () => {
  const state = { version: 1, character: 'turnip', since: '2026-05-01', maxExp: 0 };
  const privateCommits = { count: 5, reading: 'authored', userId: 'U_octocat', failedSince: '2026-05-08' };
  assert.deepEqual(recordPrivateCommits(state, privateCommits), { ...state, privateCommits });
  assert.deepEqual(recordPrivateCommits({ ...state, privateCommits }, undefined), state);
});

// 形の違う privateCommits は fetchAccount がないものとして扱い、次に残すときに直す。育ちには関係しないので止めない。
test('privateCommits の形が違っても、state.json は読む', async (t) => {
  const state = { version: 1, character: 'turnip', since: '2026-05-01', maxExp: 0, privateCommits: 'broken' };
  assert.deepEqual(await readState(stateFile(t, JSON.stringify(state))), state);
});
