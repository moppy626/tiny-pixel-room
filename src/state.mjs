// 育てはじめた日とキャラクターを覚えておく。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CHARACTERS } from './growth.mjs';
import { bilingual } from './messages.mjs';
import { addDays, isDate } from './stats.mjs';

// today は草の日付での今日。
export function nextState(previous, character, today) {
  if (previous?.character === character && previous.since) return previous;
  // 変えた日の活動を数えると、新しいキャラクターが 0 から始まらないので翌日から数える。
  // 最高 EXP は前のキャラクターのものなので引き継がない。
  return { version: 1, character, since: previous ? addDays(today, 1) : today, maxExp: 0 };
}

// 草の数は減ることがある (Private contributions をオフにした、リポジトリを消したなど)。
// 育った姿が戻らないよう、これまでの最高 EXP を覚えておき、それより下げない。
export function recordExp(state, exp) {
  return { ...state, maxExp: Math.max(state.maxExp, exp) };
}

// 非公開リポジトリのコミットの数と読み方 (github.mjs の fetchAccount が返す privateCommits) を残す。
// 次の実行で fetchAccount に渡し、数えきれなかった日に前の数を使うのと、読み方を実行ごとに揺らさないのに使う。
// 育ちには関係しないので、キャラクターを変えても引き継ぐ。undefined なら残さない。
export function recordPrivateCommits(state, privateCommits) {
  const { privateCommits: _, ...rest } = state;
  return privateCommits === undefined ? rest : { ...rest, privateCommits };
}

const isExp = (value) => Number.isSafeInteger(value) && value >= 0;

function parseState(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function readState(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  // 勝手に作り直すと育てた分が消えるので、壊れていたら止める。
  const state = parseState(text);
  if (!isDate(state?.since) || !Object.hasOwn(CHARACTERS, state.character) || !isExp(state.maxExp)) {
    const kinds = Object.keys(CHARACTERS).join(' / ');
    throw new Error(bilingual(
      `${path} が壊れています。since を実在する YYYY-MM-DD の日付に、character を ${kinds} のどれかに、maxExp を 0 以上の整数に直してください。` +
        'ファイルを消すと今日から育て直します',
      `${path} is broken. Set since to a real date in YYYY-MM-DD, character to one of ${kinds}, and maxExp to a whole number of 0 or more. ` +
        'Deleting the file starts the growth over from today',
    ));
  }
  return state;
}

export async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
}
