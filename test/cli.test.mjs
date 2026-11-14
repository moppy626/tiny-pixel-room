import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './fixtures/env.mjs';

const ENTRY = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const FAKE_GITHUB = fileURLToPath(new URL('./fixtures/fake-github.mjs', import.meta.url));

// env は、偽の GitHub API の応答を変えるときに渡す (FAKE_GITHUB など)。
function runCliWith(t, env, ...args) {
  const out = mkdtempSync(join(tmpdir(), 'tiny-pixel-room-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['--import', FAKE_GITHUB, ENTRY, '--user', 'octocat', '--out', out, ...args], {
    encoding: 'utf8',
    env: isolatedEnv({ GITHUB_TOKEN: 'dummy', ...env }),
  });
  return { out, result };
}

const runCli = (t, ...args) => runCliWith(t, {}, ...args);

// スタックトレースの行 (    at main (file:///...)) が出ていないか。
const STACK_LINE = /^\s+at /m;

test('--user がなければ、日本語の行と英語の行で理由を示して止まる', () => {
  const result = spawnSync(process.execPath, [ENTRY], { encoding: 'utf8', env: isolatedEnv({ GITHUB_TOKEN: 'dummy' }) });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '--user と環境変数 GITHUB_TOKEN が必要です\n--user and the GITHUB_TOKEN environment variable are required\n');
});

for (const since of ['2026/05/01', '2026-13-45', '2026-02-30']) {
  test(`--since ${since} は理由を示して止まる`, (t) => {
    const { result } = runCli(t, '--since', since);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /since は/);
  });
}

test('知らないオプションは、スタックトレースを出さずに、日本語の行と英語の行で理由を示して止まる', (t) => {
  const { result } = runCli(t, '--nope');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^オプションの指定が正しくありません: .*'--nope'/m);
  assert.match(result.stderr, /^Invalid options: .*'--nope'/m);
  assert.doesNotMatch(result.stderr, STACK_LINE);
});

test('GitHub API のエラーは、スタックトレースを出さずに、日本語の行と英語の行で理由を示して止まる', (t) => {
  const { out, result } = runCliWith(t, { FAKE_GITHUB: 'unauthorized' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^github-token のトークンが使えません \(401\)/m);
  assert.match(result.stderr, /^The github-token can't be used \(401\)/m);
  assert.doesNotMatch(result.stderr, STACK_LINE);
  assert.ok(!existsSync(join(out, 'card-light.svg')));
});

test('GitHub から読めずに止まるときは、--hide の前の名前 (commits) の警告を出さない', (t) => {
  const { result } = runCliWith(t, { FAKE_GITHUB: 'unauthorized' }, '--hide', 'commits');
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /名前が変わりました/);
});

// CLI には contributions-token という入力がないので、同じトークンなら、渡さないときと同じ文にする。
test('CONTRIBUTIONS_TOKEN が GITHUB_TOKEN と同じなら、401 のときに contributions-token を直すよう伝えない', (t) => {
  const { result } = runCliWith(t, { GITHUB_TOKEN: 'same', CONTRIBUTIONS_TOKEN: 'same', FAKE_GITHUB: 'unauthorized' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^github-token のトークンが使えません \(401\)/m);
  assert.doesNotMatch(result.stderr, /contributions-token/);
});

// 偽の GitHub は、違うトークンで読まれたら 401 を返す (fake-github.mjs の wrongToken)。
test('CONTRIBUTIONS_TOKEN があれば、Action と同じく、コントリビューションの数だけをそのトークンで読む', (t) => {
  const tokens = { FAKE_API_TOKEN: 'personal', FAKE_CONTRIBUTIONS_TOKEN: 'workflow' };
  const { out, result } = runCliWith(t, { GITHUB_TOKEN: 'personal', CONTRIBUTIONS_TOKEN: 'workflow', ...tokens });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(out, 'card-light.svg')));
});

// $(cat file) などで付いた末尾の改行を残すと、別のトークンとして扱ったり、ヘッダーに改行が入ったりする。
test('トークンの前後の空白や改行は外して読む', (t) => {
  const tokens = { FAKE_API_TOKEN: 'personal', FAKE_CONTRIBUTIONS_TOKEN: 'workflow' };
  const { result } = runCliWith(t, { GITHUB_TOKEN: ' personal\n', CONTRIBUTIONS_TOKEN: 'workflow\n', ...tokens });
  assert.equal(result.status, 0, result.stderr);
});

test('空白の違いしかない CONTRIBUTIONS_TOKEN は、GITHUB_TOKEN と同じトークンとして扱う', (t) => {
  const { result } = runCliWith(t, { GITHUB_TOKEN: 'same', CONTRIBUTIONS_TOKEN: 'same\n', FAKE_GITHUB: 'unauthorized' });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /contributions-token/);
});

test('CONTRIBUTIONS_TOKEN がなければ、すべて GITHUB_TOKEN で読む', (t) => {
  const tokens = { FAKE_API_TOKEN: 'personal', FAKE_CONTRIBUTIONS_TOKEN: 'personal' };
  const { result } = runCliWith(t, { GITHUB_TOKEN: 'personal', ...tokens });
  assert.equal(result.status, 0, result.stderr);
});

test('正しい --since と、大文字の --character、--hide、--language でカードを書き出す', (t) => {
  const { out, result } = runCli(t, '--since', '2026-05-01', '--character', 'Cactus', '--hide', 'Langs', '--language', 'JA');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(out, 'card-light.svg')));
});
