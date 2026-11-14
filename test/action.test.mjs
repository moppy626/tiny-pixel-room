import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { actionInputs } from './fixtures/action-inputs.mjs';
import { isolatedEnv } from './fixtures/env.mjs';

const ENTRY = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
// Action が実際に動かすのは、src をまとめた dist/index.js。
const DIST_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const FAKE_GITHUB = fileURLToPath(new URL('./fixtures/fake-github.mjs', import.meta.url));

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: isolatedEnv(),
  });

function runAction(cwd, inputs = {}, env = {}, entry = ENTRY) {
  const inputEnv = Object.entries({ 'github-token': 'dummy', username: 'octocat', ...inputs })
    .map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value]);
  return spawnSync(process.execPath, ['--import', FAKE_GITHUB, entry], {
    cwd,
    encoding: 'utf8',
    env: isolatedEnv({ ...Object.fromEntries(inputEnv), ...env }),
  });
}

function assertSucceeded(result) {
  assert.equal(result.status, 0, result.stderr);
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tiny-pixel-room-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// リモートと、それを clone した作業コピーを 2 つ用意する。
function createRepos(t) {
  const root = tempDir(t);
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  const other = join(root, 'other');
  git(root, 'init', '--quiet', '--bare', '--initial-branch=main', remote);
  git(root, 'clone', '--quiet', remote, work);
  git(work, 'commit', '--quiet', '--allow-empty', '-m', 'init');
  git(work, 'push', '--quiet', '-u', 'origin', 'HEAD');
  git(root, 'clone', '--quiet', remote, other);
  return { remote, work, other };
}

test('カードと state.json をコミットし、無関係なステージ済みファイルは含めない', (t) => {
  const { remote, work } = createRepos(t);
  writeFileSync(join(work, 'other.txt'), 'x');
  git(work, 'add', 'other.txt');

  assertSucceeded(runAction(work));

  const files = git(remote, 'show', '--name-only', '--format=', 'main').trim().split('\n').sort();
  assert.deepEqual(files, [
    'tiny-pixel-room/card-dark-still.svg',
    'tiny-pixel-room/card-dark.svg',
    'tiny-pixel-room/card-light-still.svg',
    'tiny-pixel-room/card-light.svg',
    'tiny-pixel-room/state.json',
  ]);
  assert.equal(git(work, 'status', '--porcelain', '--', 'other.txt').trim(), 'A  other.txt');
});

// ほかのテストは src を動かす。まとめたあとも、フォントや絵のデータを読めて、src と同じカードを作れるか確かめる。
// (dist が src から作り直してあるかは、CI で確かめている)
// state.json は今日の日付が入り、2 回の実行が日をまたぐと変わるので、カードだけを比べる。
test('Action が動かす dist/index.js でも、src と同じカードを作る', (t) => {
  const fromSrc = tempDir(t);
  const fromDist = tempDir(t);
  assertSucceeded(runAction(fromSrc, { commit: 'false' }));
  assertSucceeded(runAction(fromDist, { commit: 'false' }, {}, DIST_ENTRY));
  for (const name of ['card-light.svg', 'card-dark.svg', 'card-light-still.svg', 'card-dark-still.svg']) {
    const read = (dir) => readFileSync(join(dir, 'tiny-pixel-room', name), 'utf8');
    assert.equal(read(fromDist), read(fromSrc), name);
  }
});

// ワークフローに output-dir: '' のように空で書くと、Actions は既定値ではなく空の文字列を渡す。
// そのとき src が使う値 (index.mjs の || のあと) が、action.yml の既定値と同じか確かめる。
// github-token と username の既定は式なので比べない。commit は、git のない一時フォルダで動かすので false にする。
test('空の入力は、action.yml の既定値と同じに扱う', (t) => {
  const inputs = actionInputs();
  const names = Object.keys(inputs).filter((name) => !['github-token', 'username', 'commit'].includes(name));
  const withDefaults = tempDir(t);
  const withEmpty = tempDir(t);
  assertSucceeded(runAction(withDefaults, { ...Object.fromEntries(names.map((name) => [name, inputs[name]])), commit: 'false' }));
  assertSucceeded(runAction(withEmpty, { ...Object.fromEntries(names.map((name) => [name, ''])), commit: 'false' }));
  // state.json は今日の日付が入り、2 回の実行が日をまたぐと変わるので、キャラクターだけを比べる。
  const read = (dir, name) => readFileSync(join(dir, inputs['output-dir'], name), 'utf8');
  for (const name of ['card-light.svg', 'card-dark.svg', 'card-light-still.svg', 'card-dark-still.svg']) {
    assert.equal(read(withEmpty, name), read(withDefaults, name), name);
  }
  assert.equal(JSON.parse(read(withEmpty, 'state.json')).character, inputs.character);
});

test('実行結果の文は、日本語の行のあとに英語の行を続ける', (t) => {
  const result = runAction(tempDir(t), { hide: 'nope', commit: 'false' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^::error::hide に使えない項目があります: nope%0AUnknown items in hide: nope$/m);
});

test('変更がなければコミットしない', (t) => {
  const { remote, work } = createRepos(t);
  assertSucceeded(runAction(work));
  const head = git(remote, 'rev-parse', 'main');
  const result = runAction(work);
  assertSucceeded(result);
  assert.match(result.stdout, /変更はありませんでした/);
  assert.equal(git(remote, 'rev-parse', 'main'), head);
});

test('リモートが進んでいたら、その上に載せ直して push する', (t) => {
  const { remote, work, other } = createRepos(t);
  git(other, 'commit', '--quiet', '--allow-empty', '-m', 'README を編集');
  git(other, 'push', '--quiet');

  assertSucceeded(runAction(work));

  const subjects = git(remote, 'log', '--format=%s', 'main').trim().split('\n');
  // コミットのメッセージは、1 行目だけで日本語と英語の両方が読める。
  assert.deepEqual(subjects, ['chore: ドットのおへやを更新 / Update Tiny Pixel Room [skip ci]', 'README を編集', 'init']);
});

// ここまでの 2 つと次のテストは、実行の前の pull でリモートの変更を取り込む場合。
// カードを作っているあいだに push されて、push が断られる場合は、あとの「push が断られたら」のテストで確かめる。
test('先に別の実行がカードを push していても、その上で、いま作ったカードを push する', (t) => {
  const { remote, work, other } = createRepos(t);
  assertSucceeded(runAction(other, { 'pet-name': 'ぽち' }));

  assertSucceeded(runAction(work, { 'pet-name': 'たろう' }));

  const pushed = git(remote, 'show', 'main:tiny-pixel-room/card-light.svg');
  assert.equal(pushed, readFileSync(join(work, 'tiny-pixel-room/card-light.svg'), 'utf8'));
  assert.equal(git(work, 'status', '--porcelain').trim(), '');
});

test('リモートが進んでいても、ステージ済みの無関係なファイルは残る', (t) => {
  const { work, other } = createRepos(t);
  git(other, 'commit', '--quiet', '--allow-empty', '-m', 'README を編集');
  git(other, 'push', '--quiet');
  writeFileSync(join(work, 'other.txt'), 'x');
  git(work, 'add', 'other.txt');

  assertSucceeded(runAction(work));

  assert.equal(readFileSync(join(work, 'other.txt'), 'utf8'), 'x');
});

for (const value of ['false', 'False', 'FALSE']) {
  test(`commit: ${value} ならコミットしない`, (t) => {
    const { remote, work } = createRepos(t);
    const head = git(remote, 'rev-parse', 'main');
    assertSucceeded(runAction(work, { commit: value }));
    assert.equal(git(remote, 'rev-parse', 'main'), head);
    assert.ok(existsSync(join(work, 'tiny-pixel-room/card-light.svg')));
  });
}

for (const [inputs, message] of [
  [{ commit: 'no' }, /commit は true か false/],
  [{ motion: 'off' }, /motion は true か false/],
  [{ character: 'constructor' }, /character は turnip \/ sunflower \/ cactus/],
  [{ hide: 'stars, nope' }, /hide に使えない項目があります: nope/],
  [{ language: 'fr' }, /language は ja \/ en から選んでください/],
]) {
  test(`不正な入力は理由を示して止まる: ${JSON.stringify(inputs)}`, (t) => {
    const result = runAction(tempDir(t), inputs);
    assert.equal(result.status, 1);
    assert.match(result.stderr, message);
  });
}

test('PR と Issue の権限がなくても、カードを作って警告する', (t) => {
  const dir = tempDir(t);
  const result = runAction(dir, { commit: 'false' }, { FAKE_GITHUB: 'forbidden' });
  assertSucceeded(result);
  assert.match(result.stdout, /::warning::.*PR と Issue/);
  assert.ok(existsSync(join(dir, 'tiny-pixel-room/card-light.svg')));
});

for (const hide of ['all', 'contrib,current,longest,langs,stars,commits,prs,issues,repos']) {
  test(`hide にすべての項目を指定すると、キャラクターだけの細いカードを作る: ${hide}`, (t) => {
    const dir = tempDir(t);
    const result = runAction(dir, { hide, commit: 'false' });
    assertSucceeded(result);
    for (const name of ['card-light.svg', 'card-dark.svg', 'card-light-still.svg', 'card-dark-still.svg']) {
      assert.match(readFileSync(join(dir, 'tiny-pixel-room', name), 'utf8'), /^<svg [^>]*width="396"/);
    }
  });
}

test('hide の前後の空白は無視する', (t) => {
  assertSucceeded(runAction(tempDir(t), { hide: ' stars , prs ', commit: 'false' }));
});

test('名前に使えない文字を外したら警告する', (t) => {
  const result = runAction(tempDir(t), { 'pet-name': 'ぽち🌱', commit: 'false' });
  assertSucceeded(result);
  assert.match(result.stdout, /::warning::名前に使えない文字を外しました: 🌱/);
});

test('名前を 10 文字で切ったら警告する', (t) => {
  const result = runAction(tempDir(t), { 'pet-name': 'あいうえおかきくけこさ', commit: 'false' });
  assertSucceeded(result);
  assert.match(result.stdout, /::warning::名前は 10 文字までなので、「あいうえおかきくけこ」にしました/);
});

test('トークンの期限が切れていたら、直し方を示して止まる', (t) => {
  const dir = tempDir(t);
  const result = runAction(dir, { commit: 'false' }, { FAKE_GITHUB: 'unauthorized' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::github-token のトークンが使えません \(401\)/);
  assert.ok(!existsSync(join(dir, 'tiny-pixel-room/card-light.svg')));
});

test('language を変えるとカードは変わるが、開始日はリセットされない', (t) => {
  const dir = tempDir(t);
  const read = (name) => readFileSync(join(dir, 'tiny-pixel-room', name), 'utf8');
  mkdirSync(join(dir, 'tiny-pixel-room'));
  const state = { version: 1, character: 'turnip', since: '2026-05-01', maxExp: 0 };
  writeFileSync(join(dir, 'tiny-pixel-room/state.json'), JSON.stringify(state));

  assertSucceeded(runAction(dir, { language: 'en', commit: 'false' }));
  const english = read('card-light.svg');
  assertSucceeded(runAction(dir, { language: 'JA', commit: 'false' }));

  assert.notEqual(read('card-light.svg'), english);
  assert.equal(JSON.parse(read('state.json')).since, state.since);
});

test('壊れた state.json では止まり、ファイルを上書きしない', (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'tiny-pixel-room'));
  writeFileSync(join(dir, 'tiny-pixel-room/state.json'), '<<<<<<< HEAD');
  const result = runAction(dir, { commit: 'false' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /state\.json が壊れています/);
  assert.equal(readFileSync(join(dir, 'tiny-pixel-room/state.json'), 'utf8'), '<<<<<<< HEAD');
});

test('character のない state.json では止まり、開始日を書き換えない', (t) => {
  const dir = tempDir(t);
  const text = '{"since":"2026-05-01"}';
  mkdirSync(join(dir, 'tiny-pixel-room'));
  writeFileSync(join(dir, 'tiny-pixel-room/state.json'), text);
  const result = runAction(dir, { commit: 'false' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /state\.json が壊れています/);
  assert.equal(readFileSync(join(dir, 'tiny-pixel-room/state.json'), 'utf8'), text);
});

test('output-dir がリポジトリの直下でも、カードと state.json だけをコミットする', (t) => {
  const { remote, work } = createRepos(t);
  writeFileSync(join(work, 'other.txt'), 'x');

  assertSucceeded(runAction(work, { 'output-dir': '.' }));

  const files = git(remote, 'show', '--name-only', '--format=', 'main').trim().split('\n').sort();
  assert.deepEqual(files, ['card-dark-still.svg', 'card-dark.svg', 'card-light-still.svg', 'card-light.svg', 'state.json']);
  assert.equal(git(work, 'status', '--porcelain', '--', 'other.txt').trim(), '?? other.txt');
});

test('取れなかった項目をすべて隠していれば、取れなかった数の警告は出さない', (t) => {
  const result = runAction(tempDir(t), { hide: 'prs,issues', commit: 'false' }, { FAKE_GITHUB: 'forbidden' });
  assertSucceeded(result);
  assert.doesNotMatch(result.stdout, /::warning::/);
});

test('取れなかった項目が 1 つでも見えていれば、取れなかった数の警告を出す', (t) => {
  const result = runAction(tempDir(t), { hide: 'prs', commit: 'false' }, { FAKE_GITHUB: 'forbidden' });
  assertSucceeded(result);
  assert.match(result.stdout, /::warning::.*PR と Issue/);
});

test('複数行のエラーも 1 行の注釈にして、理由を残す', (t) => {
  const { work } = createRepos(t);
  git(work, 'remote', 'set-url', '--push', 'origin', join(work, 'missing.git'));
  const result = runAction(work);
  assert.equal(result.status, 1);
  // git の文は英語だけなので、どのコマンドが失敗したかを日本語の行と英語の行で前に足す。
  assert.match(result.stderr, /^::error::git push に失敗しました%0Agit push failed%0A.+/m);
});

// git を包むスクリプトを PATH の先頭に置く。push のときは、本物の git の前に onPush(本物の git) の sh の文を動かす。
// 呼ばれた git のコマンドは、1 回 1 行で log に書く。
function wrapGit(dir, onPush) {
  const bin = join(dir, 'bin');
  const log = join(dir, 'git.log');
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh
echo "$*" >> '${log}'
if [ "$1" = push ]; then
${onPush(realGit)}
fi
exec '${realGit}' "$@"
`, { mode: 0o755 });
  return { env: { PATH: `${bin}${delimiter}${process.env.PATH}` }, calls: () => readFileSync(log, 'utf8').trim().split('\n') };
}

// push だけを、書き込みの権限がないときの GitHub と同じく 403 で断る。
const gitDenyingPush = (dir) =>
  wrapGit(dir, () => `  echo "remote: Permission to octocat/octocat.git denied to github-actions[bot]." >&2
  echo "fatal: unable to access 'https://github.com/octocat/octocat/': The requested URL returned error: 403" >&2
  exit 128`);

// 1 回目の push の直前にだけ、rival (別の作業コピー) のコミットを push する。
// カードを作っているあいだに README を Web で編集したときなどと同じく、こちらの 1 回目の push は断られる。
function gitInterruptedPush(dir, rival) {
  const marker = join(dir, 'interrupted');
  return wrapGit(dir, (realGit) => `  if [ ! -e '${marker}' ]; then
    : > '${marker}'
    '${realGit}' -C '${rival}' push --quiet
  fi`);
}

// actions/checkout と同じく、既定のブランチを深さ 1 で取ってきた作業コピーを dir に作る。
// Action は、ふだんこの浅い clone の上で pull と push をする。--depth を効かせるため、リモートは file:// で指す。
function checkoutLikeActions(remote, dir) {
  mkdirSync(dir);
  git(dir, 'init', '--quiet');
  git(dir, 'remote', 'add', 'origin', pathToFileURL(remote).href);
  git(dir, 'fetch', '--quiet', '--no-tags', '--depth=1', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  git(dir, 'checkout', '--quiet', '--force', '-B', 'main', 'refs/remotes/origin/main');
  assert.equal(git(dir, 'rev-parse', '--is-shallow-repository').trim(), 'true');
  return dir;
}

const pushes = (calls) => calls().filter((call) => /^push\b/.test(call));

test('push が断られたら、カードを作っているあいだに進んだリモートの上に載せ直して push する', (t) => {
  const { remote, other } = createRepos(t);
  // 浅い clone の境目より前にも履歴があるよう、コミットを足しておく。
  git(other, 'commit', '--quiet', '--allow-empty', '-m', 'README を編集');
  git(other, 'push', '--quiet');
  const work = checkoutLikeActions(remote, join(other, '..', 'checkout'));
  // 実行中に README を Web で編集した。こちらの 1 回目の push の直前に push する。
  git(other, 'commit', '--quiet', '--allow-empty', '-m', '実行中に README を編集');
  // ステージ済みの無関係なファイルは、載せ直したあとも残し、コミットには入れない。
  writeFileSync(join(work, 'other.txt'), 'x');
  git(work, 'add', 'other.txt');
  const { env, calls } = gitInterruptedPush(join(work, '..'), other);

  assertSucceeded(runAction(work, {}, env));

  assert.equal(pushes(calls).length, 2);
  const subjects = git(remote, 'log', '--format=%s', 'main').trim().split('\n');
  assert.deepEqual(subjects, ['chore: ドットのおへやを更新 / Update Tiny Pixel Room [skip ci]', '実行中に README を編集', 'README を編集', 'init']);
  assert.doesNotMatch(git(remote, 'show', '--name-only', '--format=', 'main'), /other\.txt/);
  assert.equal(git(work, 'status', '--porcelain', '--', 'other.txt').trim(), 'A  other.txt');
});

// concurrency を外したワークフローなどで、別の実行がカードを push していたとき。
// 載せ直すとき (rebase では theirs がこちら側) に、いま作ったカードを残す。
test('push が断られたとき、別の実行のカードと衝突したら、いま作ったカードを残す', (t) => {
  const { remote, other } = createRepos(t);
  assertSucceeded(runAction(other, { 'pet-name': 'ぽち' }));
  const work = checkoutLikeActions(remote, join(other, '..', 'checkout'));
  // 別の実行が作ったカード。こちらの 1 回目の push の直前に push する。
  assertSucceeded(runAction(other, { 'pet-name': 'じろう', commit: 'false' }));
  git(other, 'commit', '--quiet', '-am', '別の実行のカード');
  const { env, calls } = gitInterruptedPush(join(work, '..'), other);

  assertSucceeded(runAction(work, { 'pet-name': 'たろう' }, env));

  assert.equal(pushes(calls).length, 2);
  assert.ok(calls().some((call) => /\bpull --rebase --autostash -X theirs$/.test(call)), calls().join('\n'));
  assert.equal(git(remote, 'log', '--format=%s', 'main~1', '-1').trim(), '別の実行のカード');
  for (const name of ['card-light.svg', 'card-dark.svg', 'card-light-still.svg', 'card-dark-still.svg']) {
    assert.equal(git(remote, 'show', `main:tiny-pixel-room/${name}`), readFileSync(join(work, 'tiny-pixel-room', name), 'utf8'), name);
  }
  assert.equal(git(work, 'status', '--porcelain').trim(), '');
});

test('push する権限がなければ、やり直さずに permissions の直し方を示して止まる', (t) => {
  const { remote, work } = createRepos(t);
  const head = git(remote, 'rev-parse', 'main');
  const { env, calls } = gitDenyingPush(join(work, '..'));

  const result = runAction(work, {}, env);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^::error::カードを push する権限がありません \(403\)。ワークフローに permissions: contents: write/m);
  // pull は実行の前の 1 回だけで、断られた push のあとには載せ直さない。
  assert.equal(calls().filter((call) => /^push\b/.test(call)).length, 1);
  assert.equal(calls().filter((call) => /\bpull\b/.test(call)).length, 1);
  assert.equal(git(remote, 'rev-parse', 'main'), head);
});

test('character と hide は、language と同じく大文字で書いても受け付ける', (t) => {
  const dir = tempDir(t);
  assertSucceeded(runAction(dir, { character: 'Cactus', hide: 'ALL', commit: 'false' }));
  const state = JSON.parse(readFileSync(join(dir, 'tiny-pixel-room/state.json'), 'utf8'));
  assert.equal(state.character, 'cactus');
  assert.match(readFileSync(join(dir, 'tiny-pixel-room/card-light.svg'), 'utf8'), /^<svg [^>]*width="396"/);
});

test('注釈の中の % はエンコードする', (t) => {
  const result = runAction(tempDir(t), { hide: '100%' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::hide に使えない項目があります: 100%25/);
});

test('既定のブランチ以外で動いたら、カードを更新しない', (t) => {
  const { remote, work } = createRepos(t);
  const event = join(work, '..', 'event.json');
  writeFileSync(event, JSON.stringify({ repository: { default_branch: 'main' } }));
  git(work, 'switch', '--quiet', '-c', 'patch-1');
  git(work, 'push', '--quiet', '-u', 'origin', 'patch-1');
  const head = git(remote, 'rev-parse', 'patch-1');

  const result = runAction(work, {}, { GITHUB_REF_NAME: 'patch-1', GITHUB_EVENT_PATH: event });

  assertSucceeded(result);
  assert.match(result.stdout, /::notice::既定のブランチ \(main\) ではないので/);
  assert.equal(git(remote, 'rev-parse', 'patch-1'), head);
  assert.ok(!existsSync(join(work, 'tiny-pixel-room')));
});

test('既定のブランチで動いたら、いつもどおり更新する', (t) => {
  const { remote, work } = createRepos(t);
  const event = join(work, '..', 'event.json');
  writeFileSync(event, JSON.stringify({ repository: { default_branch: 'main' } }));
  const head = git(remote, 'rev-parse', 'main');
  assertSucceeded(runAction(work, {}, { GITHUB_REF_NAME: 'main', GITHUB_EVENT_PATH: event }));
  assert.notEqual(git(remote, 'rev-parse', 'main'), head);
});

test('順番待ちのあいだに別の実行が state.json を更新していたら、その状態から数える', (t) => {
  const { remote, work, other } = createRepos(t);
  // 先に動いた実行が、キャラクターを変えて開始日を決めた。
  mkdirSync(join(other, 'tiny-pixel-room'));
  const updated = { version: 1, character: 'cactus', since: '2026-05-02', maxExp: 0 };
  writeFileSync(join(other, 'tiny-pixel-room/state.json'), JSON.stringify(updated));
  git(other, 'add', '.');
  git(other, 'commit', '--quiet', '-m', 'state を更新');
  git(other, 'push', '--quiet');

  // 古いチェックアウトのまま動いても、開始日を決め直さない。
  assertSucceeded(runAction(work, { character: 'cactus' }));

  assert.equal(JSON.parse(git(remote, 'show', 'main:tiny-pixel-room/state.json')).since, updated.since);
});

test('state.json がなければ、今日から育てはじめることと output-dir の注意を知らせる', (t) => {
  const result = runAction(tempDir(t), { commit: 'false' });
  assertSucceeded(result);
  assert.match(result.stdout, /::notice::tiny-pixel-room\/state\.json がないので、今日から育てはじめます。output-dir を変えたときは/);
});

test('キャラクターを変えたら、草の日付での今日の次の日から数える', (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'tiny-pixel-room'));
  writeFileSync(join(dir, 'tiny-pixel-room/state.json'), JSON.stringify({ version: 1, character: 'turnip', since: '2026-05-01', maxExp: 0 }));
  assertSucceeded(runAction(dir, { character: 'cactus', commit: 'false' }));
  // 偽の GitHub は、既定のトークンと同じく UTC の今日で終わる草を返す。
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const state = JSON.parse(readFileSync(join(dir, 'tiny-pixel-room/state.json'), 'utf8'));
  assert.deepEqual(state, { version: 1, character: 'cactus', since: tomorrow, maxExp: 0 });
});

// 偽の GitHub の草は 9 日間、毎日 3 件なので、開始日が古ければ 27 EXP になる。
const FAKE_EXP = 27;

function runWithState(t, state) {
  const dir = tempDir(t);
  mkdirSync(join(dir, 'tiny-pixel-room'));
  writeFileSync(join(dir, 'tiny-pixel-room/state.json'), JSON.stringify(state));
  assertSucceeded(runAction(dir, { commit: 'false' }));
  const read = (name) => readFileSync(join(dir, 'tiny-pixel-room', name), 'utf8');
  return { saved: JSON.parse(read('state.json')), title: read('card-light.svg').match(/<title[^>]*>([^<]*)</)[1] };
}

test('草の数が減っても、最高 EXP より下げず、育った姿を保つ', (t) => {
  const state = { version: 1, character: 'turnip', since: '2026-05-01', maxExp: 500 };
  const { saved, title } = runWithState(t, state);
  assert.deepEqual(saved, state);
  // 500 EXP は 4 段階目の姿で、Lv.26。
  assert.match(title, /おおきなカブ Lv\.26/);
});

test('EXP が最高 EXP を超えたら、state.json の最高 EXP を更新する', (t) => {
  const state = { version: 1, character: 'turnip', since: '2026-05-01', maxExp: 10 };
  const { saved, title } = runWithState(t, state);
  assert.deepEqual(saved, { ...state, maxExp: FAKE_EXP });
  // 27 EXP は最初の姿で、Lv.2。
  assert.match(title, /たね Lv\.2/);
});

// 1 つのリポジトリが読めつづけないだけで、カード全体がずっと更新されなくならないようにする。
// キャラクターを変えても、育ちには関係しないので引き継ぐ。
for (const character of ['turnip', 'cactus']) {
  test(`非公開リポジトリのコミットを数えきれなかった日も、カードは更新し、前の実行で数えた数を state.json に残す: character ${character}`, (t) => {
    const dir = tempDir(t);
    mkdirSync(join(dir, 'tiny-pixel-room'));
    const privateCommits = { count: 5, reading: 'authored', userId: 'U_fake' };
    const state = { version: 1, character: 'turnip', since: '2026-05-01', maxExp: FAKE_EXP, privateCommits };
    writeFileSync(join(dir, 'tiny-pixel-room/state.json'), JSON.stringify(state));
    // 偽の GitHub の今日 (UTC の今日) が、数えきれなくなった日になる。動かしているあいだに日付が変わってもよいよう、前後の日を取る。
    const utcToday = () => new Date().toISOString().slice(0, 10);
    const before = utcToday();
    const result = runAction(dir, { character, commit: 'false' }, { FAKE_GITHUB: 'private-error' });
    const after = utcToday();
    assertSucceeded(result);
    assert.match(result.stdout, /::warning::非公開リポジトリのコミットを数えきれなかったので、前に数えた数を使います/);
    const saved = JSON.parse(readFileSync(join(dir, 'tiny-pixel-room/state.json'), 'utf8'));
    assert.equal(saved.character, character);
    const { failedSince, ...kept } = saved.privateCommits;
    assert.deepEqual(kept, privateCommits);
    assert.ok([before, after].includes(failedSince));
  });
}

test('非公開リポジトリのコミットを数えないなら、state.json に残した数を消す', (t) => {
  const state = { version: 1, character: 'turnip', since: '2026-05-01', maxExp: FAKE_EXP };
  const { saved } = runWithState(t, { ...state, privateCommits: { count: 5, reading: 'all', userId: 'U_fake' } });
  assert.deepEqual(saved, state);
});
