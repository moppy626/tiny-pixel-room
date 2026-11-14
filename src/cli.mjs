// 手元で試すための入口。例: GITHUB_TOKEN=... node src/cli.mjs --user octocat --out out
// Action は、コントリビューションの数を別のトークン (contributions-token) で読む (github.mjs の fetchAccount)。
// 同じ読み方を試すときは、そのトークンを環境変数 CONTRIBUTIONS_TOKEN に入れる。なければ、すべて GITHUB_TOKEN で読む。
import { parseArgs } from 'node:util';
import { buildCards, findInputError, parseHide, writeCards } from './card.mjs';
import { fetchAccount } from './github.mjs';
import { DEFAULT_LANGUAGE } from './growth.mjs';
import { bilingual } from './messages.mjs';

// Action (src/index.mjs) と同じく、止まるときはスタックトレースではなく理由の文だけを出す。
function exitWith(message) {
  console.error(message);
  process.exit(1);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      user: { type: 'string' },
      character: { type: 'string', default: 'turnip' },
      pet: { type: 'string' },
      since: { type: 'string' },
      hide: { type: 'string', default: '' },
      language: { type: 'string', default: DEFAULT_LANGUAGE },
      out: { type: 'string', default: 'out' },
      'no-motion': { type: 'boolean', default: false },
    },
  }));
} catch (error) {
  // 知らないオプションや、値のないオプション。Node の文は英語だけなので、日本語の行を前に足す。
  exitWith(bilingual(`オプションの指定が正しくありません: ${error.message}`, `Invalid options: ${error.message}`));
}

// Action の入力と同じく、トークンの前後の空白や改行 ($(cat file) の末尾など) は外す。
// 残すと、空白だけの違いで別のトークンとして扱ったり、ヘッダーに改行が入って通信できなかったりする。
const env = (name) => (process.env[name] ?? '').trim();
const token = env('GITHUB_TOKEN');
const contributionsToken = env('CONTRIBUTIONS_TOKEN');

// 入力の誤り (findInputError) と同じく、日本語の行のあとに英語の行を続ける。
if (!values.user || !token) {
  exitWith(bilingual('--user と環境変数 GITHUB_TOKEN が必要です', '--user and the GITHUB_TOKEN environment variable are required'));
}
// Action と同じく、character、hide (parseHide)、language は大文字で書いても受け付ける。
const character = values.character.toLowerCase();
const { hide, warnings: hideWarnings } = parseHide(values.hide);
const language = values.language.toLowerCase();
const inputError = findInputError({ character, hide, language, since: values.since });
if (inputError) exitWith(inputError);

// GitHub API のエラー (github.mjs) は、日本語と英語の 2 行の文になっている。
try {
  // CONTRIBUTIONS_TOKEN が GITHUB_TOKEN と同じなら、渡さないのと同じ読み方になる。
  // 渡すと、401 のときに Action の 2 つの入力 (github-token と contributions-token) を直すよう伝えてしまうので、渡さない。
  const account = await fetchAccount(values.user, token, {
    contributionsToken: contributionsToken && contributionsToken !== token ? contributionsToken : undefined,
  });
  // 「隠しています」と伝える文なので、GitHub から読めて、カードを作ると決まってから出す。
  hideWarnings.forEach((message) => console.warn(message));
  const cards = buildCards(account, {
    character,
    since: values.since ?? account.today,
    petName: values.pet,
    hide,
    motion: !values['no-motion'],
    language,
    warn: console.warn,
  });

  await writeCards(values.out, cards);
  const count = Object.keys(cards).length;
  console.log(bilingual(`${values.out} に ${count} 枚のカードを書き出しました`, `Wrote ${count} cards to ${values.out}`));
} catch (error) {
  exitWith(error.message);
}
