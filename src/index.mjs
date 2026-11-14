// GitHub Action の入口。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCards, findInputError, parseHide, writeCards } from './card.mjs';
import { fetchAccount } from './github.mjs';
import { DEFAULT_LANGUAGE } from './growth.mjs';
import { NAME, bilingual, encodeCommand } from './messages.mjs';
import { nextState, readState, recordExp, recordPrivateCommits, writeState } from './state.mjs';
import { expSince } from './stats.mjs';

const PUSH_ATTEMPTS = 3;
const BOT_IDENTITY = ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];
// 書き込みの権限がないときの push の失敗。やり直しても通らないので、直し方を示して止まる。
const PUSH_DENIED = /The requested URL returned error: 403|Permission to .+ denied/;
const PUSH_DENIED_MESSAGE = bilingual(
  'カードを push する権限がありません (403)。ワークフローに permissions: contents: write が書いてあるか確かめてください',
  'No permission to push the cards (403). Make sure the workflow has permissions: contents: write',
);

// プロフィール用リポジトリに残るコミットのメッセージ。実行結果の文と同じく、language にかかわらず日本語と英語の両方を書く。
// git log --oneline や GitHub のファイル一覧には 1 行目しか出ないので、bilingual のように 2 行に分けず、
// action.yml の description と同じく「 / 」で区切って 1 行に並べる。
const COMMIT_MESSAGE = `chore: ${NAME.ja}を更新 / Update ${NAME.en} [skip ci]`;

const input = (name) => (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim();

// git の文は英語だけなので、どの git のコマンドが失敗したかを日本語と英語の行で前に足し、git の文はそのあとに続ける。
// push が断られた理由の見分け (PUSH_DENIED) に使うので、stderr は残す。
function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' });
  } catch (error) {
    // -c の設定 (BOT_IDENTITY) を飛ばした、最初の語がコマンドの名前 (pull、push など)。
    const command = `git ${args.find((arg, i) => arg !== '-c' && args[i - 1] !== '-c')}`;
    const detail = error.stderr?.trim() || error.message;
    throw Object.assign(new Error(`${bilingual(`${command} に失敗しました`, `${command} failed`)}\n${detail}`), { stderr: error.stderr });
  }
}

const warn = (message) => console.log(`::warning::${encodeCommand(message)}`);
const notice = (message) => console.log(`::notice::${encodeCommand(message)}`);

function fail(message) {
  console.error(`::error::${encodeCommand(message)}`);
  process.exit(1);
}

function flag(name) {
  const value = input(name).toLowerCase();
  if (value === '' || value === 'true') return true;
  if (value === 'false') return false;
  return fail(bilingual(`${name} は true か false で指定してください`, `${name} must be true or false`));
}

// 既定のブランチ以外で動いているときは、その既定のブランチの名前を返す。
// Web エディタで作ったブランチなどにカードを書くと、マージのときに衝突したり古い state.json が戻ったりする。
function otherDefaultBranch() {
  const branch = process.env.GITHUB_REF_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!branch || !eventPath) return null;
  let event;
  try {
    event = JSON.parse(readFileSync(eventPath, 'utf8'));
  } catch {
    return null;
  }
  const defaultBranch = event.repository?.default_branch;
  return defaultBranch && defaultBranch !== branch ? defaultBranch : null;
}

// state.json は実行の前に最新にしてあるので、ここで衝突するのは実行中に push されたときだけ。
// そのときは、いま作ったほうを残す (rebase では theirs がこちら側)。
function pushCards() {
  for (let attempt = 1; ; attempt += 1) {
    try {
      git('push');
      return;
    } catch (error) {
      if (PUSH_DENIED.test(error.stderr ?? '')) throw new Error(PUSH_DENIED_MESSAGE);
      if (attempt === PUSH_ATTEMPTS) throw error;
      git(...BOT_IDENTITY, 'pull', '--rebase', '--autostash', '-X', 'theirs');
    }
  }
}

async function main() {
  const token = input('github-token');
  const login = input('username');
  // character、hide (parseHide)、language は、大文字で書いても受け付ける。
  const character = input('character').toLowerCase() || 'turnip';
  const outputDir = input('output-dir') || 'tiny-pixel-room';
  const hide = parseHide(input('hide'));
  const language = input('language').toLowerCase() || DEFAULT_LANGUAGE;
  const motion = flag('motion');
  const commit = flag('commit');

  if (!token) fail(bilingual('github-token が空です', 'github-token is empty'));
  if (!login) fail(bilingual('username が空です', 'username is empty'));
  const inputError = findInputError({ character, hide, language });
  if (inputError) fail(inputError);

  if (commit) {
    const defaultBranch = otherDefaultBranch();
    if (defaultBranch) {
      notice(bilingual(
        `既定のブランチ (${defaultBranch}) ではないので、カードを更新しませんでした`,
        `Skipped updating the cards because this isn't the default branch (${defaultBranch})`,
      ));
      return;
    }
    // 順番待ちのあいだに別の実行が state.json を更新していることがあるので、最新の状態から数える。
    // autostash はコミットを作るので、名前とメールを渡す。
    git(...BOT_IDENTITY, 'pull', '--rebase', '--autostash');
  }

  const statePath = join(outputDir, 'state.json');
  const previous = await readState(statePath);
  if (!previous) {
    notice(bilingual(
      `${statePath} がないので、今日から育てはじめます。output-dir を変えたときは、前のフォルダの state.json を移すと成長を引き継げます`,
      `${statePath} wasn't found, so the growth starts today. If you changed output-dir, move state.json from the old folder to keep the growth`,
    ));
  }

  const account = await fetchAccount(login, token, { privateCommits: previous?.privateCommits, warn });
  const started = nextState(previous, character, account.today);
  const state = recordPrivateCommits(recordExp(started, expSince(account.days, started.since)), account.privateCommits);
  const cards = buildCards(account, { character, exp: state.maxExp, petName: input('pet-name'), hide, motion, language, warn });

  await writeCards(outputDir, cards);
  await writeState(statePath, state);

  if (!commit) return;
  // output-dir がリポジトリの直下でも巻き込まないよう、書いたファイルだけを指定する。
  const files = [...Object.keys(cards).map((name) => join(outputDir, name)), statePath];
  git('add', '--', ...files);
  if (git('status', '--porcelain', '--', ...files).trim() === '') {
    console.log(bilingual('カードに変更はありませんでした', "The cards haven't changed"));
    return;
  }
  git(...BOT_IDENTITY, 'commit', '-m', COMMIT_MESSAGE, '--', ...files);
  pushCards();
}

main().catch((error) => fail(error.message));
