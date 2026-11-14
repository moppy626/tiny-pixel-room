// README に載せるサンプルのカードを作る。数字はすべて見本で、GitHub には問い合わせない。
// 使い方: npm run samples (カードの描き方を変えたら作り直してコミットする。CI で確かめている)
import { fileURLToPath } from 'node:url';
import { buildCards, parseHide, writeCards } from '../src/card.mjs';
import { addDays } from '../src/stats.mjs';

const OUT = fileURLToPath(new URL('../examples/samples/', import.meta.url));
const TODAY = '2026-11-08';

// end の日で終わる、length 日の連続記録。
const run = (end, length) => Array.from({ length }, (_, i) => ({ date: addDays(end, i - length + 1), count: 4 }));

const account = {
  login: 'your-name',
  today: TODAY,
  // Longest streak が 61 日、Current streak が 23 日になるカレンダー。
  days: [...run('2026-07-31', 61), ...run(TODAY, 23)],
  totalContributions: 2486,
  yearContributions: 1874,
  stars: 342,
  totalPullRequests: 126,
  totalIssues: 58,
  totalRepositories: 37,
  repositories: [
    {
      languages: [['TypeScript', 3800], ['Python', 2400], ['Go', 1700], ['Rust', 1200], ['Shell', 900]].map(([name, size]) => ({ name, size })),
    },
  ],
};

// 英語の README (README.en.md) の先頭のサンプル。4 枚を card-en-light.svg などの名前で出す。
const prefixed = (name) => (cards) =>
  Object.fromEntries(Object.entries(cards).map(([file, svg]) => [file.replace(/^card-/, `${name}-`), svg]));

// 一覧のサンプルは、動かない版を昼と夜の 2 枚だけ出す。
const stills = (name) => (cards) => ({
  [`${name}-light.svg`]: cards['card-light-still.svg'],
  [`${name}-dark.svg`]: cards['card-dark-still.svg'],
});

const SAMPLES = [
  // README.md (日本語) の先頭のサンプル。使い方の <picture> と同じく 4 枚を出す。
  { options: { character: 'turnip', exp: 386 }, files: (cards) => cards },
  { options: { character: 'turnip', exp: 386, language: 'en' }, files: prefixed('card-en') },
  // 既定は日本語のカードなので、英語のカードも 1 枚見せる。
  { options: { character: 'sunflower', exp: 640, petName: 'Himari', language: 'en' }, files: stills('sunflower-en') },
  { options: { character: 'cactus', exp: 120, hide: ['langs'] }, files: stills('cactus-hide-langs') },
  // README の説明と同じく、hide: all で作る。
  { options: { character: 'turnip', exp: 1240, hide: parseHide('all').hide }, files: stills('character-only') },
];

for (const { options, files } of SAMPLES) await writeCards(OUT, files(buildCards(account, options)));
console.log(`${OUT} にサンプルを書き出しました`);
