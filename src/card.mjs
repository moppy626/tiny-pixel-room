// アカウントのデータと設定から、昼と夜のカードを作る。
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHARACTERS, DEFAULT_LANGUAGE, LANGUAGES, describeGrowth } from './growth.mjs';
import { codeOf, isCombiningMark, isInvisibleChar, loadFont } from './fonts.mjs';
import { bilingual } from './messages.mjs';
import { cardRenderer } from './render.mjs';
import { computeStreaks, expSince, isDate, summarizeLanguages } from './stats.mjs';

export const HIDEABLE = ['contrib', 'current', 'longest', 'langs', 'stars', 'contrib1yr', 'prs', 'issues', 'repos'];
// hide に all と書くと、すべての項目を隠す。あとで項目が増えても、キャラクターだけの細いカードのままになる。
const HIDE_ALL = 'all';
// 名前を変えた項目の、前の名前。Contrib (1yr) は、v1.0.1 までは Commits (1yr) (過去 1 年のコミットの数) で、名前は commits だった。
// hide: commits と書いたワークフローが止まらないよう、同じ項目として受け付ける。
// ただし、隠れるのは前とは別の数 (コミットの数ではなく contributions の合計) なので、黙って読み替えず、名前が変わったと知らせる。
const RENAMED = { commits: 'contrib1yr' };
export const MAX_NAME_LENGTH = 10;

// 項目の名前は、大文字で書いても受け付ける。
const hideKeys = (value) => value.split(',').map((key) => key.trim().toLowerCase()).filter(Boolean);

// hide の入力を読む。隠す項目 (hide) と、前の名前を読み替えたことを知らせる文 (warnings) を一緒に返すので、
// 読み替えたのに知らせない、ということが起きない。
// warnings は、前の名前ごとに 1 つずつ。「隠しています」と伝える文なので、GitHub から読めて、カードを作ると決まってから出す。
export function parseHide(value) {
  const keys = hideKeys(value);
  const hide = keys
    .map((key) => (Object.hasOwn(RENAMED, key) ? RENAMED[key] : key))
    .flatMap((key) => (key === HIDE_ALL ? HIDEABLE : [key]));
  const olds = new Set(keys.filter((key) => Object.hasOwn(RENAMED, key)));
  const warnings = Array.from(olds, (old) => {
    const now = RENAMED[old];
    return bilingual(
      `hide の ${old} は ${now} に名前が変わりました。いまは ${now} として隠しています。${old} を ${now} に書き換えてください`,
      `The hide item ${old} was renamed to ${now}. It is hidden as ${now} for now. Replace ${old} with ${now}`,
    );
  });
  return { hide, warnings };
}

// Action と CLI で共通の入力チェック。問題があれば理由を返す。
export function findInputError({ character, hide, language, since }) {
  if (!Object.hasOwn(CHARACTERS, character)) {
    const kinds = Object.keys(CHARACTERS).join(' / ');
    return bilingual(`character は ${kinds} から選んでください`, `character must be one of ${kinds}`);
  }
  const unknown = hide.filter((key) => !HIDEABLE.includes(key)).join(', ');
  if (unknown) return bilingual(`hide に使えない項目があります: ${unknown}`, `Unknown items in hide: ${unknown}`);
  if (!LANGUAGES.includes(language)) {
    const languages = LANGUAGES.join(' / ');
    return bilingual(`language は ${languages} から選んでください`, `language must be one of ${languages}`);
  }
  if (since !== undefined && !isDate(since)) {
    return bilingual(`since は実在する YYYY-MM-DD の日付にしてください: ${since}`, `since must be a real date in YYYY-MM-DD: ${since}`);
  }
  return null;
}

const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
const graphemes = (text) => Array.from(segmenter.segment(text), ({ segment }) => segment);

// 異体字セレクタ (VS1〜16、IVS) は字形を選ぶだけなので、外しても字は残る。
const VARIATION_SELECTORS = /[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;
const TEXT_STYLE = '\u{FE0E}';
const ZWJ = '\u{200D}';
const KEYCAP = '\u{20E3}';

// 絵文字として表示される字か。白黒のドットの字にすると別のものに見えるので、名前からは丸ごと外す。
// - ふだん色つきで表示される絵文字 (✨ や ☕ など)。VS15 (U+FE0E) で字として描くよう指定されていれば、字として描く。
//   ❤ や ★ のように、ふだん字として表示される記号は、VS16 (U+FE0F) が付いていても (❤️) 字として描く。
//   国旗 (🇯🇵) やタグの付いた旗も、先頭の字が色つきで表示される絵文字なので、ここで外れる。
// - 絵文字のつながり (❤️‍🔥、☝🏽、1️⃣ など)。先頭の ❤ や ☝ だけを残すと、別の意味の記号になる。
//   1︎⃣ のように VS15 の付いたキーキャップは、⭐︎ と同じく字として描く。
//   ★‍✨ のように、絵文字ではない記号のあとでも ZWJ でつないだものは 1 字として扱う (clusters)。先頭の字が絵文字かどうかは問わない。
function isEmoji(grapheme) {
  const [base, ...rest] = Array.from(grapheme);
  if (/\p{Emoji_Presentation}/u.test(base) && rest[0] !== TEXT_STYLE) return true;
  // ZWJ のあとに絵文字が続く (★‍✨ も含む)。ZWJ だけが付いた字 (1 と ZWJ など) は、つながりではない。
  if (rest.some((c, i) => c === ZWJ && /\p{Extended_Pictographic}/u.test(rest[i + 1] ?? ''))) return true;
  // 肌の色は、肌の色を付けられる字 (☝ など) に付いたときだけつながる。
  if (/\p{Emoji_Modifier_Base}/u.test(base) && rest.some((c) => /\p{Emoji_Modifier}/u.test(c))) return true;
  // キーキャップは、数字と # と * を囲む。VS15 で字として描くよう指定されていれば、数字は残し、描けない囲みだけを外す。
  return /[0-9#*]/u.test(base) && rest[0] !== TEXT_STYLE && rest.includes(KEYCAP);
}

// 字に分けて、ZWJ で終わる字と後ろの絵文字は 1 字にまとめる。
// Unicode 17 (Node 24.22 など) で ★ や ♡ が Extended_Pictographic から外れ、★‍✨ が ★‍ と ✨ に分かれるようになった。
// Node の版でカードが変わらないよう、ここでつなぎ直す。
function clusters(text) {
  const result = [];
  for (const segment of graphemes(text)) {
    const last = result.at(-1);
    if (last?.endsWith(ZWJ) && /^\p{Extended_Pictographic}/u.test(segment)) result[result.length - 1] = last + segment;
    else result.push(segment);
  }
  return result;
}

// 前に付く字 (U+0600 など) か。前に付く字は、後ろの字とつながって 1 字に数えられる。
const isPrepend = (char) => graphemes(`${char}a`).length === 1;

// 警告で、外した字が見えるようにする。
// - 見えない字は U+200B のように番号で示し、ほかの字とは空白で区切る。
// - 重ねる字が前にない結合文字は、◌ に付けて示す。
function shown(text) {
  const parts = [];
  let canAttach = false;
  for (const c of text) {
    if (isInvisibleChar(c)) {
      parts.push(codeOf(c));
      canAttach = false;
    } else if (canAttach) {
      parts[parts.length - 1] += c;
    } else {
      parts.push(isCombiningMark(c) ? `◌${c}` : c);
      canAttach = true;
    }
  }
  return parts.join(' ');
}

// 見た目の 1 文字を 1 文字として数え、フォントで描けない文字は外す。
function fitPetName(value, font) {
  const text = (value ?? '').normalize('NFC').trim();
  // フォントには、カードで描く字 (isDrawnChar) だけが入っている (scripts/subset-unifont.mjs)。
  // 結合文字や見えない字はフォントにないので、ここで外れる。
  const drawable = (c) => font.hasChar(c);
  const kept = [];
  const dropped = [];
  for (const cluster of clusters(text)) {
    // 描けない前に付く字は外し、後ろの字は 1 字として別に扱う。
    const chars = Array.from(cluster);
    while (chars.length > 1 && !drawable(chars[0]) && isPrepend(chars[0])) dropped.push(shown(chars.shift()));
    const grapheme = chars.join('');
    // 絵文字は、異体字セレクタや ZWJ も含めて、表示されるとおりに知らせる。
    if (isEmoji(grapheme)) {
      dropped.push(grapheme);
      continue;
    }
    const [base, ...rest] = Array.from(grapheme.replace(VARIATION_SELECTORS, ''));
    // 異体字セレクタだけの字 (名前の先頭の U+FE0F など) は、形を選ぶ字がないので外して知らせる。
    if (base === undefined) {
      dropped.push(shown(grapheme));
      continue;
    }
    if (!drawable(base)) {
      dropped.push(shown([base, ...rest].join('')));
      continue;
    }
    // 元の字が描ければ字は残し、描けない結合文字などだけを外す。
    kept.push([base, ...rest.filter(drawable)].join(''));
    for (const c of rest.filter((c) => !drawable(c))) dropped.push(shown(c));
  }
  // 文字を外すと端に空白が残ることがあるので、切り詰める前と後で取り除く。
  const name = graphemes(kept.join('').trim());
  return {
    name: name.slice(0, MAX_NAME_LENGTH).join('').trimEnd(),
    dropped,
    truncated: name.length > MAX_NAME_LENGTH,
  };
}

// 取れなかった数を知らせる。隠している項目はカードに - と出ないので、知らせない。
// 「権限の強いトークンを作って渡せばよい」と受け取られないよう、文ではトークンや権限に触れない。
// 自分で作ったトークンを渡す使い方はサポートしていない (README の「知っておいてほしいこと」)。
function warnMissing(account, hide, warn) {
  const missing = (key, value) => value === null && !hide.includes(key);
  if (missing('prs', account.totalPullRequests) || missing('issues', account.totalIssues)) {
    warn(bilingual(
      'GitHub から PR と Issue の一部の数を取れませんでした。カードには - と表示します',
      "Couldn't get some of the PR and issue counts from GitHub, so the card shows - for them",
    ));
  }
}

// exp を渡せばそれで育ち具合を決める (Action は state.json の最高 EXP を渡す)。なければ since から数える。
export function buildView(account, { character, since, exp, petName, hide = [], motion = true, language = DEFAULT_LANGUAGE, warn = () => {} }, font = loadFont()) {
  warnMissing(account, hide, warn);
  const { current, longest } = computeStreaks(account.days, account.today);
  const { name, dropped, truncated } = fitPetName(petName, font);
  // 英語の文は、設定サイトの英語の警告 (site/i18n.mjs) と同じにしている。
  if (dropped.length) {
    const chars = dropped.join(' ');
    warn(bilingual(`名前に使えない文字を外しました: ${chars}`, `Removed characters that can't be used in the name: ${chars}`));
  }
  if (truncated) {
    warn(bilingual(
      `名前は ${MAX_NAME_LENGTH} 文字までなので、「${name}」にしました`,
      `Names can be up to ${MAX_NAME_LENGTH} characters, so it was shortened to "${name}"`,
    ));
  }
  return {
    login: account.login,
    petName: name || CHARACTERS[character][language].label,
    motion,
    language,
    hide: new Set(hide),
    stats: {
      totalContributions: account.totalContributions,
      currentStreak: current,
      longestStreak: longest,
      stars: account.stars,
      yearContributions: account.yearContributions,
      pullRequests: account.totalPullRequests,
      issues: account.totalIssues,
      repositories: account.totalRepositories,
      languages: summarizeLanguages(account.repositories),
    },
    growth: describeGrowth(character, exp ?? expSince(account.days, since), language),
    // 名前から外した字と、切り詰めたかどうか。warn の文は Action の実行結果に出す日本語と英語の 2 行なので、
    // 設定サイトはこれを見て、サイトの言葉で知らせる。
    nameIssues: { dropped, truncated },
  };
}

export function buildCards(account, options) {
  const font = loadFont();
  const view = buildView(account, options, font);
  // 4 枚のカードは色が違うだけで文字の形は同じなので、作った形を 4 枚で使い回す。
  const draw = cardRenderer(font);
  const render = (mode, motion) => draw({ ...view, mode, motion });
  return {
    'card-light.svg': render('light', view.motion),
    'card-dark.svg': render('dark', view.motion),
    // 動きを減らす設定の人には、README の <picture> でこちらを見せる。
    'card-light-still.svg': render('light', false),
    'card-dark-still.svg': render('dark', false),
  };
}

export async function writeCards(outputDir, cards) {
  await mkdir(outputDir, { recursive: true });
  for (const [name, svg] of Object.entries(cards)) await writeFile(join(outputDir, name), svg);
}
