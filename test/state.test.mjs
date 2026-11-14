import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nextState, readState, recordExp, writeState } from '../src/state.mjs';

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

// 読むところではなく書くところで落とすので、state がどこから来ても state.json には戻らない。
test('v1.0.1 が残した非公開リポジトリのコミットの数は、書き出すときに落とし、ほかの項目は残す', async (t) => {
  const state = { version: 1, character: 'turnip', since: '2026-05-01', maxExp: 0, memo: 'kept' };
  const privateCommits = { count: 211, reading: 'all', userId: 'U_octocat' };
  const path = stateFile(t, JSON.stringify({ ...state, privateCommits }));
  await writeState(path, { ...state, privateCommits });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), state);
});

test('version のない state.json に、読むときに version を足さない', async (t) => {
  const state = { character: 'turnip', since: '2026-05-01', maxExp: 0, memo: 'kept' };
  assert.deepEqual(await readState(stateFile(t, JSON.stringify(state))), state);
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

test('contributions の数が減って EXP が下がっても、最高 EXP は下げない', () => {
  const state = { version: 1, character: 'turnip', since: '2026-05-01', maxExp: 600 };
  assert.equal(recordExp(state, 420).maxExp, 600);
});

test('初めて使う日の EXP も、最高 EXP として覚える', () => {
  assert.equal(recordExp(nextState(null, 'turnip', '2026-11-08'), 42).maxExp, 42);
});
