import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HIDEABLE, buildCards, buildView, parseHide } from '../src/card.mjs';
import { DOTS_PER_EM, FONT_UNICODE_VERSION, isDrawnChar, loadFont, parseFont } from '../src/fonts.mjs';
import { CHARACTERS, LANGUAGES, THRESHOLDS } from '../src/growth.mjs';
import { renderCard, textPathData, wrapWords } from '../src/render.mjs';
import { PALETTE, allForms, framesOf, stepsOf } from '../src/sprites.mjs';
import { addDays } from '../src/stats.mjs';
import { TEXT } from '../site/i18n.mjs';

const account = {
  login: 'octocat',
  today: '2026-11-08',
  days: [{ date: '2026-11-07', count: 5 }, { date: '2026-11-08', count: 3 }],
  repositories: [{ stars: 2, languages: [{ name: 'Go', size: 10 }] }],
  totalContributions: 2486,
  yearContributions: 1874,
  totalPullRequests: 126,
  totalIssues: 58,
  totalRepositories: 37,
  stars: 2,
};
// 文を比べるテストが多いので、英語のカードで確かめる。既定 (日本語) は「language を書かなければ」のテストで確かめる。
const options = { character: 'turnip', since: '2026-11-07', language: 'en' };
// 警告は日本語の行のあとに英語の行が続く (src/messages.mjs)。ここでは日本語の行だけを比べる。
const japanese = (message) => message.split('\n')[0];

test('すべての絵は同じ幅で、使う色が定義され、部屋に収まる', () => {
  for (const { character, stage, form } of allForms()) {
    const width = form.rows[0].length;
    assert.ok(width <= 20 && form.rows.length <= 19, `${character}:${stage} size`);
    for (const rows of Object.values(framesOf(form))) {
      assert.equal(rows.length, form.rows.length, `${character}:${stage} frame height`);
      for (const row of rows) {
        assert.equal(row.length, width, `${character}:${stage} width`);
        for (const ch of row) assert.ok(ch === '.' || PALETTE[ch], `${character}:${stage} color ${ch}`);
      }
    }
    assert.equal(stepsOf(form).length, 45);
  }
});

test('README の画像で動かない要素を含まない', () => {
  const cards = buildCards(account, options);
  assert.deepEqual(Object.keys(cards).sort(), ['card-dark-still.svg', 'card-dark.svg', 'card-light-still.svg', 'card-light.svg']);
  for (const svg of Object.values(cards)) {
    assert.doesNotMatch(svg, /<script|<text|<foreignObject|<image|@import|https?:\/\/(?!www\.w3\.org)/);
  }
  assert.match(cards['card-light.svg'], /@keyframes/);
  assert.match(cards['card-dark.svg'], /@keyframes/);
  assert.doesNotMatch(cards['card-light-still.svg'], /@keyframes|<style/);
  assert.doesNotMatch(cards['card-dark-still.svg'], /@keyframes|<style/);
  assert.notEqual(cards['card-light.svg'], cards['card-dark.svg']);
});

test('motion を切るとアニメーションが消える', () => {
  const cards = buildCards(account, { ...options, motion: false });
  assert.doesNotMatch(cards['card-light.svg'], /@keyframes|<style/);
});

test('ユーザー入力はタイトルでエスケープされ、本文は文字として残らない', () => {
  const hostile = { ...account, login: 'a"><script>alert(1)</script>' };
  const svg = buildCards(hostile, { ...options, petName: '<b>ペット</b>' })['card-light.svg'];
  assert.doesNotMatch(svg, /<script|<b>/);
  assert.match(svg, /&lt;script&gt;/);
});

test('名前は 10 文字までで、未入力なら種類名になる', () => {
  assert.equal(buildView(account, { ...options, petName: 'あいうえおかきくけこさ' }).petName, 'あいうえおかきくけこ');
  assert.equal(buildView(account, { ...options, petName: '   ', character: 'cactus' }).petName, 'Cactus');
});

test('10 文字を超える名前は切って知らせ、10 文字ちょうどなら知らせない', () => {
  const warnings = [];
  const warn = (message) => warnings.push(japanese(message));
  assert.equal(buildView(account, { ...options, petName: 'あいうえおかきくけこさ', warn }).petName, 'あいうえおかきくけこ');
  assert.deepEqual(warnings, ['名前は 10 文字までなので、「あいうえおかきくけこ」にしました']);
  warnings.length = 0;
  buildView(account, { ...options, petName: 'あいうえおかきくけこ', warn });
  // 描けない文字を外したあとで 10 文字なら、切ってはいない。
  buildView(account, { ...options, petName: '🌱 あいうえおかきくけこ', warn });
  assert.deepEqual(warnings, ['名前に使えない文字を外しました: 🌱']);
});

// 英語の行は、設定サイトの英語の警告と同じ文にしている。
test('名前の警告は、日本語の行のあとに、設定サイトと同じ英語の行を続ける', () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);
  buildView(account, { ...options, petName: '🌱あいうえおかきくけこさ', warn });
  assert.deepEqual(warnings, [
    `名前に使えない文字を外しました: 🌱\n${TEXT.en.dropped('🌱')}`,
    `名前は 10 文字までなので、「あいうえおかきくけこ」にしました\n${TEXT.en.truncated('あいうえおかきくけこ', 10)}`,
  ]);
});

test('絵文字の組み合わせや濁点を分けた文字も、見た目の 1 文字として数える', () => {
  const decomposed = 'か\u3099'.repeat(11);
  assert.equal(buildView(account, { ...options, petName: decomposed }).petName, 'が'.repeat(10));
});

test('フォントで描けない文字は名前から外して知らせる', () => {
  const warnings = [];
  const warn = (message) => warnings.push(japanese(message));
  assert.equal(buildView(account, { ...options, petName: 'ぽ🌱ち👨‍👩‍👧', warn }).petName, 'ぽち');
  assert.deepEqual(warnings, ['名前に使えない文字を外しました: 🌱 👨‍👩‍👧']);
});

test('異体字セレクタの付いた字は、セレクタだけを外して字は残す', () => {
  const warnings = [];
  const warn = (message) => warnings.push(japanese(message));
  assert.equal(buildView(account, { ...options, petName: '葛\u{E0100}ちゃん', warn }).petName, '葛ちゃん');
  assert.deepEqual(warnings, []);
});

test('日本語と英語のほか、ハングルや中国語、アクセント付きのラテン文字、キリル文字なども名前に使える', () => {
  const warnings = [];
  const warn = (message) => warnings.push(japanese(message));
  for (const name of ['ぽち', 'Turnip', '葛西', '𩸽', '포치', '小龙', 'Çağrı', 'Мурка', 'Ελλάδα', 'Ɛfua', 'ɔkɔ', 'Ольʼга']) {
    assert.equal(buildView(account, { ...options, petName: name, warn }).petName, name);
  }
  assert.deepEqual(warnings, []);
});

test('アラビア文字のように 1 字ずつでは正しく描けない文字は、名前から外す', () => {
  const warnings = [];
  assert.equal(buildView(account, { ...options, petName: 'ぽちمرحبا', warn: (message) => warnings.push(japanese(message)) }).petName, 'ぽち');
  assert.equal(warnings.length, 1);
});

test('改行やハングルの埋め字のような見えない字は、Unifont にあっても名前から外す', () => {
  const warnings = [];
  const warn = (message) => warnings.push(japanese(message));
  assert.equal(buildView(account, { ...options, petName: 'ぽち\u2028たま\u2029', warn }).petName, 'ぽちたま');
  assert.equal(buildView(account, { ...options, petName: '\u3164', warn }).petName, 'Turnip');
  assert.equal(buildView(account, { ...options, petName: '\uFFA0', warn }).petName, 'Turnip');
  assert.equal(warnings.length, 3);
});

test('外した見えない字は、警告では U+200B のように番号で示す', () => {
  const warnings = [];
  const warn = (message) => warnings.push(japanese(message));
  // ゼロ幅スペース、字に付いた ZWJ、ソフトハイフン、タブ、ハングルの埋め字、点字の空白。
  for (const petName of ['ぽち\u{200B}たま', 'ぽ\u{200D}ちたま', 'ぽち\u{AD}たま', 'ぽち\u{9}たま', 'ぽち\u{3164}たま', 'ぽち\u{2800}たま']) {
    assert.equal(buildView(account, { ...options, petName, warn }).petName, 'ぽちたま');
  }
  assert.deepEqual(warnings, ['U+200B', 'U+200D', 'U+00AD', 'U+0009', 'U+3164', 'U+2800'].map((code) => `名前に使えない文字を外しました: ${code}`));
});

test('1 字にまとまった見えない字は、番号を空白で区切って示す', () => {
  const warnings = [];
  const warn = (message) => warnings.push(japanese(message));
  // 改行 (CR と LF) と、ZWJ の付いたハングルの埋め字。
  assert.equal(buildView(account, { ...options, petName: 'ぽち\u{D}\u{A}たま', warn }).petName, 'ぽちたま');
  assert.equal(buildView(account, { ...options, petName: '\u{3164}\u{200D}ぽち', warn }).petName, 'ぽち');
  assert.deepEqual(warnings, ['U+000D U+000A', 'U+3164 U+200D'].map((code) => `名前に使えない文字を外しました: ${code}`));
});

test('前に付く字 (U+0600 など) は外し、つながった後ろの字は 1 字として扱う', () => {
  const warnings = [];
  const warn = (message) => warnings.push(japanese(message));
  assert.equal(buildView(account, { ...options, petName: '\u{600}ぽち', warn }).petName, 'ぽち');
  assert.equal(buildView(account, { ...options, petName: 'ぽ\u{6DD}ち', warn }).petName, 'ぽち');
  // 後ろの字が絵文字なら、絵文字として外す。
  assert.equal(buildView(account, { ...options, petName: '\u{600}✨ぽち', warn }).petName, 'ぽち');
  assert.deepEqual(warnings, ['U+0600', 'U+06DD', 'U+0600 ✨'].map((text) => `名前に使えない文字を外しました: ${text}`));
});

test('ふつうの字に付いた ZWJ や肌の色は、絵文字のつながりとみなさず、それだけを外す', () => {
  const warnings = [];
  const warn = (message) => warnings.push(japanese(message));
  // 1 や ™ や © は絵文字にもなる字だが、ZWJ のあとに絵文字が続かず、肌の色を付けられる字でもない。
  assert.equal(buildView(account, { ...options, petName: '1\u{200D}ぽち', warn }).petName, '1ぽち');
  assert.equal(buildView(account, { ...options, petName: '™\u{200D}ぽち', warn }).petName, '™ぽち');
  assert.equal(buildView(account, { ...options, petName: '©\u{1F3FD}ぽち', warn }).petName, '©ぽち');
  assert.deepEqual(warnings, ['U+200D', 'U+200D', '\u{1F3FD}'].map((text) => `名前に使えない文字を外しました: ${text}`));
});

test('色つきで表示される絵文字は外し、❤ や ★ のように字としても使う記号はドットの字で描く', () => {
  const warnings = [];
  const warn = (message) => warnings.push(japanese(message));
  assert.equal(buildView(account, { ...options, petName: '✨ぽち☕', warn }).petName, 'ぽち');
  assert.deepEqual(warnings, ['名前に使えない文字を外しました: ✨ ☕']);
  warnings.length = 0;
  assert.equal(buildView(account, { ...options, petName: '❤️ぽち★', warn }).petName, '❤ぽち★');
  assert.deepEqual(warnings, []);
});

test('⭐︎ のように VS15 で字として表示するよう指定した記号は、ドットの字で描く', () => {
  const warnings = [];
  const warn = (message) => warnings.push(japanese(message));
  assert.equal(buildView(account, { ...options, petName: 'ぽち\u{2B50}\u{FE0E}', warn }).petName, 'ぽち\u{2B50}');
  assert.equal(buildView(account, { ...options, petName: '\u{2615}\u{FE0E}たま', warn }).petName, '\u{2615}たま');
  assert.deepEqual(warnings, []);
  // 指定がなければ、色つきの絵文字として外す。
  assert.equal(buildView(account, { ...options, petName: 'ぽち\u{2B50}\u{FE0F}', warn }).petName, 'ぽち');
  assert.equal(buildView(account, { ...options, petName: 'ぽち\u{2B50}', warn }).petName, 'ぽち');
  assert.deepEqual(warnings, ['\u{2B50}\u{FE0F}', '\u{2B50}'].map((emoji) => `名前に使えない文字を外しました: ${emoji}`));
});

test('つないだ絵文字や肌の色の付いた絵文字は、先頭の記号だけを残さず丸ごと外す', () => {
  const warnings = [];
  const warn = (message) => warnings.push(japanese(message));
  const emojis = [
    '\u{2764}\u{FE0F}\u{200D}\u{1F525}', // 燃えるハート
    '\u{26D3}\u{FE0F}\u{200D}\u{1F4A5}', // 切れた鎖
    '\u{2764}\u{200D}\u{1FA79}', // 包帯を巻いたハート (VS16 なし)
    '\u{261D}\u{1F3FD}', // 肌の色の付いた指
    '1\u{FE0F}\u{20E3}', // 数字のキーキャップ
    // ★ や ♡ は絵文字ではないが、ZWJ でつなぐと後ろの絵文字と 1 字になる。
    '\u{2605}\u{200D}\u{2728}', // ★ と ✨
    '\u{2661}\u{200D}\u{26A1}', // ♡ と ⚡
  ];
  for (const emoji of emojis) assert.equal(buildView(account, { ...options, petName: `ぽち${emoji}`, warn }).petName, 'ぽち', emoji);
  assert.deepEqual(warnings, emojis.map((emoji) => `名前に使えない文字を外しました: ${emoji}`));
});

test('VS15 の付いたキーキャップは、⭐︎ と同じく字として描き、描けない囲みだけを外す', () => {
  const warnings = [];
  const warn = (message) => warnings.push(japanese(message));
  assert.equal(buildView(account, { ...options, petName: 'ぽち1\u{FE0E}\u{20E3}', warn }).petName, 'ぽち1');
  // 数字のほかの字に付いた囲みも、囲みだけを外す。
  assert.equal(buildView(account, { ...options, petName: 'ぽちa\u{20E3}', warn }).petName, 'ぽちa');
  assert.deepEqual(warnings, ['◌\u{20E3}', '◌\u{20E3}'].map((mark) => `名前に使えない文字を外しました: ${mark}`));
});

test('フォントには、NFC で別の字に変わる字が入っていない', () => {
  // 正規化の結果は、Unicode の版が新しくなっても変わらないので、どの版の Node でも確かめられる。
  const chars = Object.keys(loadFont().tables.cmap.glyphIndexMap).map((code) => String.fromCodePoint(Number(code)));
  assert.ok(chars.length > 40000);
  assert.deepEqual(chars.filter((char) => char.normalize('NFC') !== char), []);
});

// どの字が結合文字や見えない字かは、Unicode の版で変わることがあるので、フォントを作ったときと同じ版の Node でだけ確かめる。
const otherUnicode =
  process.versions.unicode !== FONT_UNICODE_VERSION &&
  `フォントは Unicode ${FONT_UNICODE_VERSION} で作ったので、Unicode ${process.versions.unicode} の Node では確かめない`;

test('フォントには、カードで描く字だけが入っている', { skip: otherUnicode }, () => {
  // すべての字の形を作るので、使い回しているフォントに形を残さないよう、別に読んだフォントで確かめる。
  const font = parseFont();
  const glyphs = Object.entries(font.tables.cmap.glyphIndexMap).map(([code, index]) => ({
    char: String.fromCodePoint(Number(code)),
    empty: font.glyphs.get(index).path.commands.length === 0,
  }));
  assert.deepEqual(glyphs.filter(({ char }) => !isDrawnChar(char)), []);
  // 形が空なのは空白の字だけで、見えない名前にはならない。
  assert.deepEqual(glyphs.filter(({ char, empty }) => empty !== /\p{Zs}/u.test(char)), []);
});

test('文の最後の字も、文の途中の字と同じ形で描く', () => {
  const font = loadFont();
  // d の右の縦棒は 1 ドットの幅なので、opentype.js の optimize を使うと文の最後でだけ欠ける。
  for (const char of ['d', 'b', 'l', 'H', 'ぽ']) {
    const alone = textPathData(font, char, 0, 16, 16);
    assert.ok(textPathData(font, char + char, 0, 16, 16).startsWith(`${alone}M`), char);
  }
});

test('字の角は、1 em を DOTS_PER_EM に分けたドットの格子にある', () => {
  const font = loadFont();
  const onPixels = (size) =>
    font.getPath('@Lv.20 ぽち 포치 小龙 Мурка ★', 0, size, size).commands
      .every((command) => Object.values(command).filter((value) => typeof value === 'number').every(Number.isInteger));
  // DOTS_PER_EM px の字は 1 ドットが 1px、その 2 倍の字は 2px なので、角は px にある。
  // 半分や 1.5 倍の大きさでは、角が px の途中に来る。
  assert.ok(onPixels(DOTS_PER_EM));
  assert.ok(onPixels(DOTS_PER_EM * 2));
  assert.ok(!onPixels(DOTS_PER_EM / 2));
  assert.ok(!onPixels(DOTS_PER_EM * 1.5));
});

test('カードの字は 1 ドットが 1px か 2px の大きさで描き、角はすべて px にある', (t) => {
  const font = loadFont();
  const getPath = t.mock.method(font, 'getPath');
  const cards = LANGUAGES.flatMap((language) =>
    [[], HIDEABLE].map((hide) => buildCards(account, { ...options, language, hide, petName: 'ぽち' })['card-light-still.svg']),
  );
  const sizes = new Set(getPath.mock.calls.map(({ arguments: [, , , size] }) => size));
  assert.deepEqual([...sizes].sort((a, b) => a - b), [DOTS_PER_EM, DOTS_PER_EM * 2]);
  for (const svg of cards) {
    const texts = [...svg.matchAll(/shape-rendering="geometricPrecision" d="([^"]*)"/g)].map(([, d]) => d);
    assert.ok(texts.length > 0);
    for (const d of texts) assert.ok(d.match(/-?[\d.]+/g).every((value) => Number.isInteger(Number(value))), d);
  }
});

test('カードに決まって出る文字は、すべてフォントにある', (t) => {
  const font = loadFont();
  const getPath = t.mock.method(font, 'getPath');
  // 1 日だけの連続 (day) と、取れなかった数 (-) も出す。
  const oneDay = { ...account, days: [{ date: '2026-11-08', count: 1 }], totalPullRequests: null };
  for (const character of Object.keys(CHARACTERS)) {
    for (const language of LANGUAGES) {
      for (const exp of THRESHOLDS) {
        // 何も隠さないと広いカードで連続の文、すべて隠すと細いカードで待っている文になる。
        for (const hide of [[], HIDEABLE]) {
          for (const stats of [account, oneDay]) buildCards(stats, { character, exp, language, hide });
        }
      }
    }
  }
  const texts = new Set(getPath.mock.calls.map(({ arguments: [text] }) => text));
  assert.ok(texts.has('おうさまサボテン') && texts.has('GITHUB STATUS'));
  const missing = new Set([...texts].flatMap((text) => [...text]).filter((char) => !font.hasChar(char)));
  assert.deepEqual([...missing], []);
});

test('半角の字は 8 ドット、全角の字は 16 ドットの幅で並ぶ', () => {
  const font = loadFont();
  assert.equal(font.getAdvanceWidth('Turnip', 16), 6 * 8);
  assert.equal(font.getAdvanceWidth('Мурка', 16), 5 * 8);
  assert.equal(font.getAdvanceWidth('ぽち포치小龙𩸽', 16), 7 * 16);
  assert.equal(font.getAdvanceWidth('Lv.20 ぽち', 16), 6 * 8 + 2 * 16);
});

test('描けない結合文字は外して知らせ、元の字は残す', () => {
  const warnings = [];
  const warn = (message) => warnings.push(japanese(message));
  assert.equal(buildView(account, { ...options, petName: 'g\u{331}o', warn }).petName, 'go');
  // 名前の先頭の結合文字は、重ねる字がないので、それだけで 1 字になる。
  assert.equal(buildView(account, { ...options, petName: '\u{301}ぽち', warn }).petName, 'ぽち');
  assert.deepEqual(warnings, ['◌\u{331}', '◌\u{301}'].map((mark) => `名前に使えない文字を外しました: ${mark}`));
});

test('異体字セレクタだけの字は外して知らせる', () => {
  const warnings = [];
  const warn = (message) => warnings.push(japanese(message));
  assert.equal(buildView(account, { ...options, petName: '\u{FE0F}', warn }).petName, 'Turnip');
  assert.equal(buildView(account, { ...options, petName: '\u{E0100}ぽち', warn }).petName, 'ぽち');
  assert.deepEqual(warnings, ['U+FE0F', 'U+E0100'].map((code) => `名前に使えない文字を外しました: ${code}`));
});

test('全部描けない名前なら種類名になり、名前の空白と記号は残る', () => {
  assert.equal(buildView(account, { ...options, petName: '🌱🌱' }).petName, 'Turnip');
  assert.equal(buildView(account, { ...options, petName: 'ぽち ♥\uFE0F' }).petName, 'ぽち ♥');
});

test('文字を外した名前の端に空白を残さない', () => {
  const nameOf = (petName) => buildView(account, { ...options, petName }).petName;
  assert.equal(nameOf('🌱 🌱'), 'Turnip');
  assert.equal(nameOf('🌱 ぽち'), 'ぽち');
  assert.equal(nameOf('ぽち 🌱'), 'ぽち');
  assert.equal(nameOf('あいうえおかきくけ こ'), 'あいうえおかきくけ');
  assert.equal(nameOf('🌱 あいうえおかきくけこ'), 'あいうえおかきくけこ');
});

test('隠した項目はタイトルにも残らない', () => {
  const shown = buildCards(account, options)['card-light.svg'];
  assert.match(shown, /<title[^>]*>[^<]*Total contributions 2,486/);
  for (const svg of Object.values(buildCards(account, { ...options, hide: ['contrib'] }))) {
    assert.doesNotMatch(svg, /Total contributions|2,486/);
  }
});

test('取れなかった数値があってもカードを作れる', () => {
  const partial = { ...account, totalPullRequests: null, totalIssues: null };
  const hidden = buildCards(account, { ...options, hide: ['prs', 'issues'] })['card-light.svg'];
  const unknown = buildCards(partial, options)['card-light.svg'];
  assert.ok(unknown.length > hidden.length);
});

test('0.00% と表示される言語は棒を塗らない', () => {
  const tiny = { ...account, repositories: [{ languages: [{ name: 'Go', size: 1000000 }, { name: 'C', size: 1 }] }] };
  const view = buildView(tiny, options);
  assert.deepEqual(view.stats.languages.map((row) => [row.name, row.percent.toFixed(2)]), [['Go', '100.00'], ['C', '0.00']]);
  const svg = buildCards(tiny, options)['card-light-still.svg'];
  const secondColor = '#BE8208';
  assert.doesNotMatch(svg, new RegExp(`<path fill="${secondColor}"`));
});

// 文字はパスに変換されるので、変換せずに本文のまま出すフォントで確かめる。
const plainFont = { getAdvanceWidth: () => 0, getPath: (text) => ({ commands: [], toPathData: () => text }) };
const dialogOf = (view) => renderCard({ ...view, mode: 'light' }, plainFont);

// 文字の位置も残すフォント。右揃えの文字は、右端の位置になる。
const placedFont = { getAdvanceWidth: () => 0, getPath: (text, x, y) => ({ commands: [], toPathData: () => `${text}@${x},${y}` }) };
const layoutOf = (hide) => renderCard({ ...buildView(account, { ...options, hide }), mode: 'light', motion: false }, placedFont);
// 右の列の枠の中身の四角 (昼のカード)。
const rightPanel = (y, height) => `<rect x="392" y="${y}" width="420" height="${height}" fill="#FFFDF6"/>`;

test('ドット絵と棒は crispEdges のまま描き、文字だけは縮めても線が消えないようになめらかに描く', () => {
  const svg = layoutOf([]);
  assert.match(svg, /<svg [^>]*shape-rendering="crispEdges"/);
  const paths = [...svg.matchAll(/<path [^>]*>/g)].map(([tag]) => tag);
  // placedFont の文字のパスは「文字@x,y」になる。
  const texts = paths.filter((tag) => /d="[^"]*@/.test(tag));
  assert.ok(texts.some((tag) => tag.includes('d="GITHUB STATUS@')));
  assert.ok(texts.length < paths.length);
  for (const tag of paths) assert.equal(tag.includes('shape-rendering="geometricPrecision"'), texts.includes(tag), tag);
});

test('何も隠さなければ、数字は 3 行に並び、右の列の 2 つの枠で左の枠と同じ高さを埋める', () => {
  const svg = layoutOf([]);
  assert.ok(svg.includes(rightPanel(28, 252)));
  assert.ok(svg.includes(rightPanel(300, 170)));
  assert.ok(svg.includes('d="Stars earned@408,208"'));
  assert.ok(svg.includes('d="Total issues@620,236"'));
  assert.ok(svg.includes('d="Repositories@408,264"'));
  assert.ok(svg.includes('d="37@590,264"'));
});

test('隠した数字の項目は、前から詰めて並べる', () => {
  const svg = layoutOf(['stars']);
  assert.ok(svg.includes('d="Contrib (1yr)@408,208"'));
  assert.ok(svg.includes('d="Total PRs@620,208"'));
  assert.ok(svg.includes('d="Total issues@408,236"'));
  assert.ok(svg.includes('d="Repositories@620,236"'));
  // 2 行に減った分だけステータスの枠が縮み、言語の枠が伸びる。
  assert.ok(svg.includes(rightPanel(28, 224)));
  assert.ok(svg.includes(rightPanel(272, 198)));
  // 3 つでも 2 行なので、枠の高さは 4 つのときと変わらない。
  assert.ok(layoutOf(['stars', 'repos']).includes(rightPanel(28, 224)));
});

test('数字の項目をすべて隠すと、ステータスの枠が縮み、その分だけ言語の枠が伸びる', () => {
  const svg = layoutOf(['stars', 'contrib1yr', 'prs', 'issues', 'repos']);
  assert.ok(svg.includes(rightPanel(28, 168)));
  assert.ok(svg.includes(rightPanel(216, 254)));
  assert.ok(!svg.includes('Stars earned'));
});

test('current を隠すと、longest を左に詰め、連続記録の棒も出さない', () => {
  const svg = layoutOf(['current']);
  assert.ok(svg.includes('d="Longest streak@408,118"'));
  assert.ok(!svg.includes('Current streak'));
  assert.doesNotMatch(svg, /h15v12/);
  // 棒の分だけステータスの枠が縮む。
  assert.ok(svg.includes(rightPanel(28, 224)));
  assert.ok(svg.includes(rightPanel(272, 198)));
});

test('言語を隠すと、ステータスの枠を左の枠と同じ高さにして、項目の間を広げる', () => {
  const svg = layoutOf(['langs']);
  assert.ok(svg.includes(rightPanel(28, 442)));
  assert.ok(!svg.includes('Most used languages'));
  assert.ok(svg.includes('d="GITHUB STATUS@408,54"'));
  assert.ok(svg.includes('d="Total contributions@408,136"'));
  assert.ok(svg.includes('d="Current streak@408,213"'));
  assert.ok(svg.includes('d="Repositories@408,407"'));
});

test('ステータスの項目をすべて隠すと、言語の枠を左の枠と同じ高さにする', () => {
  const svg = layoutOf(HIDEABLE.filter((key) => key !== 'langs'));
  assert.ok(svg.includes(rightPanel(28, 442)));
  assert.ok(!svg.includes('GITHUB STATUS'));
  assert.ok(svg.includes('d="Most used languages@408,54"'));
});

// 1 文字を文字の大きさの半分の幅として数えるフォント。折り返しを確かめる。
const monoFont = { getAdvanceWidth: (text, size) => [...text].length * size / 2, getPath: placedFont.getPath };

test('すべて隠すと、右の列のない細いキャラクターだけのカードになる', () => {
  const svg = layoutOf(HIDEABLE);
  // 文字の幅が 0 のフォントなので折り返さず、下枠は 2 行になる。
  assert.match(svg, /^<svg [^>]*width="396" height="616" viewBox="0 0 396 616"/);
  assert.ok(!svg.includes('x="392"'));
  assert.ok(svg.includes('d="Turnip is waiting in the room again today!@52,530"'));
  assert.ok(svg.includes('d="42 more EXP to Sprout@52,562"'));
  assert.ok(svg.includes('<rect x="0" y="0" width="396" height="616"'));
});

test('hide に all と書くと、すべての項目を隠す', () => {
  assert.deepEqual(parseHide('all').hide, HIDEABLE);
  assert.deepEqual(parseHide(' stars , all ').hide, ['stars', ...HIDEABLE]);
});

test('hide の項目の名前は、大文字で書いても受け付ける', () => {
  assert.deepEqual(parseHide('Stars, PRS').hide, ['stars', 'prs']);
  assert.deepEqual(parseHide('ALL').hide, HIDEABLE);
});

test('細いカードの下枠は、文を折り返した行の数だけ高くなる', () => {
  const svg = renderCard({ ...buildView(account, { ...options, hide: HIDEABLE }), mode: 'light', motion: false }, monoFont);
  assert.ok(svg.includes('d="Turnip is waiting in the room@52,530"'));
  assert.ok(svg.includes('d="again today!@52,554"'));
  assert.ok(svg.includes('d="42 more EXP to Sprout@52,586"'));
  assert.match(svg, /^<svg [^>]*width="396" height="640"/);
});

test('広いカードの下枠も、細いカードと同じ間隔で文を並べる', () => {
  const svg = renderCard({ ...buildView(account, options), mode: 'light', motion: false }, monoFont);
  assert.ok(svg.includes('d="Turnip is on a 2-day streak and full of energy!@52,530"'));
  assert.ok(svg.includes('d="42 more EXP to Sprout@52,562"'));
  assert.match(svg, /^<svg [^>]*width="840" height="616"/);
});

test('単語の切れ目で折り返し、ペットや姿の名前の途中では折り返さない', () => {
  assert.deepEqual(wrapWords('Turnip is waiting in the room again today!', 20, 276, monoFont), ['Turnip is waiting in the', 'room again today!']);
  assert.deepEqual(wrapWords('350 more EXP to King Sunflower', 20, 276, monoFont), ['350 more EXP to King', 'Sunflower']);
  assert.deepEqual(wrapWords('350 more EXP to King Sunflower', 20, 276, monoFont, ['King Sunflower']), ['350 more EXP to', 'King Sunflower']);
  assert.deepEqual(wrapWords('ひまりは きょうも', 20, 276, monoFont), ['ひまりは きょうも']);
  // 1 語で幅を超えるときは、その語だけの行にする。
  assert.deepEqual(wrapWords('a verylongwordthatcannotfitinoneline b', 20, 276, monoFont), ['a', 'verylongwordthatcannotfitinoneline', 'b']);
});

test('言語の枠が伸びても、行の間隔は言語の数で変わらない', () => {
  const hide = ['stars', 'contrib1yr', 'prs', 'issues', 'repos'];
  const rowsOf = (languages) => {
    const view = buildView({ ...account, repositories: [{ languages }] }, { ...options, hide });
    const svg = renderCard({ ...view, mode: 'light', motion: false }, placedFont);
    return [...svg.matchAll(/d="(?:Go|C)@408,(\d+)"/g)].map((match) => Number(match[1]));
  };
  const one = rowsOf([{ name: 'Go', size: 10 }]);
  const two = rowsOf([{ name: 'Go', size: 10 }, { name: 'C', size: 5 }]);
  assert.deepEqual(two.slice(0, 1), one);
  assert.equal(two.length, 2);
});

test('言語は 5 つまで、それぞれ別の色と小数 2 桁の割合で出す', () => {
  const names = ['Go', 'C', 'Rust', 'Ruby', 'Lua', 'Perl'];
  const five = { ...account, repositories: [{ languages: names.map((name, i) => ({ name, size: 60 - i * 10 })) }] };
  const svg = renderCard({ ...buildView(five, options), mode: 'light', motion: false }, plainFont);
  for (const color of ['#E04E90', '#BE8208', '#1FA583', '#8B6BEE', '#3B8EDB']) assert.match(svg, new RegExp(`<path fill="${color}"`));
  assert.match(svg, /d="30\.00%"/);
  assert.doesNotMatch(svg, /d="Perl"|d="Other"/);
});

test('過去 1 年の contributions の合計は、全期間の Total contributions と区別できる名前で、別の数として出す', () => {
  const svg = renderCard({ ...buildView(account, options), mode: 'light', motion: false }, plainFont);
  assert.match(svg, /d="Contrib \(1yr\)"/);
  assert.match(svg, /d="1,874"/);
  // Total contributions (全期間の 2,486) とは別の数で、過去 1 年の合計だけを変えても全期間の合計は変わらない。
  assert.match(svg, /d="2,486"/);
  const other = renderCard({ ...buildView({ ...account, yearContributions: 1875 }, options), mode: 'light', motion: false }, plainFont);
  assert.match(other, /d="1,875"/);
  assert.match(other, /d="2,486"/);
  assert.doesNotMatch(other, /d="1,874"/);
  assert.doesNotMatch(svg, /Commits/);
});

test('hide に前の名前 (commits) を書くと、Contrib (1yr) を隠して、名前が変わったと知らせる', () => {
  const { hide, warnings } = parseHide('Commits, commits, stars');
  assert.deepEqual(hide, ['contrib1yr', 'contrib1yr', 'stars']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /hide の commits は contrib1yr に名前が変わりました/);
  assert.match(warnings[0], /The hide item commits was renamed to contrib1yr/);
  assert.deepEqual(parseHide('contrib1yr, all').warnings, []);
  const svg = renderCard({ ...buildView(account, { ...options, hide }), mode: 'light', motion: false }, plainFont);
  assert.doesNotMatch(svg, /Contrib \(1yr\)|1,874/);
  assert.match(svg, /d="Total PRs"/);
});

test('下枠は連続記録と次の姿までの EXP を英語で伝える', () => {
  const view = buildView(account, { ...options, petName: 'ぽち', since: '2026-11-07' });
  const svg = dialogOf(view);
  assert.ok(svg.includes('ぽち is on a 2-day streak and full of energy!'));
  assert.ok(svg.includes('42 more EXP to Sprout'));
});

test('連続日数の単位は 1 日のときだけ day になる', () => {
  const cardWith = (days) => dialogOf(buildView({ ...account, days }, options));
  const one = cardWith([{ date: '2026-11-08', count: 1 }]);
  assert.ok(one.includes('d="day"') && !one.includes('d="days"'));
  const two = cardWith(account.days);
  assert.ok(two.includes('d="days"') && !two.includes('d="day"'));
  assert.ok(cardWith([]).includes('d="days"'));
});

test('下枠の連続日数も、右のステータスと同じく 3 桁ごとに区切る', () => {
  const days = Array.from({ length: 1234 }, (_, i) => ({ date: addDays(account.today, -i), count: 1 }));
  const dialog = (language) => dialogOf(buildView({ ...account, days }, { ...options, petName: 'ぽち', language }));
  assert.ok(dialog('en').includes('ぽち is on a 1,234-day streak and full of energy!'));
  assert.ok(dialog('ja').includes('ぽちは 1,234にち れんぞくで げんきいっぱい！'));
});

test('下枠は連続記録がなければ待っている文になる', () => {
  const view = buildView({ ...account, days: [] }, { ...options, petName: 'ぽち' });
  assert.ok(dialogOf(view).includes('ぽち is waiting in the room again today!'));
});

test('下枠は current を隠すと連続日数を出さない', () => {
  const view = buildView(account, { ...options, petName: 'ぽち', hide: ['current'] });
  const svg = dialogOf(view);
  assert.ok(svg.includes('ぽち is waiting in the room again today!'));
  assert.ok(!svg.includes('streak and full'));
});

test('下枠は最後の姿まで育つと完了の文になる', () => {
  const grown = { ...account, days: [{ date: '2026-11-08', count: 1000 }] };
  assert.ok(dialogOf(buildView(grown, options)).includes('Reached the final form!'));
});

test('language: ja なら下枠は日本語になる', () => {
  const ja = { ...options, language: 'ja' };
  const svg = dialogOf(buildView(account, { ...ja, petName: 'ぽち' }));
  assert.ok(svg.includes('ぽちは 2にち れんぞくで げんきいっぱい！'));
  assert.ok(svg.includes('ふたばまで あと 42 EXP'));
  const idle = dialogOf(buildView({ ...account, days: [] }, { ...ja, petName: 'ぽち' }));
  assert.ok(idle.includes('ぽちは きょうも おへやで まっているよ'));
  const grown = { ...account, days: [{ date: '2026-11-08', count: 1000 }] };
  assert.ok(dialogOf(buildView(grown, ja)).includes('さいごの すがたまで そだった！'));
});

test('language を書かなければ、日本語のカードになる', () => {
  const { language, ...withoutLanguage } = options;
  const view = buildView(account, { ...withoutLanguage, character: 'cactus' });
  assert.equal(view.language, 'ja');
  assert.equal(view.petName, 'サボテン');
  assert.equal(view.growth.formName, 'こつぶ');
  assert.match(buildCards(account, withoutLanguage)['card-light.svg'], /<title[^>]*>octocat のドットのおへや: たね Lv\.1/);
});

test('既定の名前は language に合わせる', () => {
  assert.equal(buildView(account, { ...options, character: 'cactus', language: 'ja' }).petName, 'サボテン');
  assert.equal(buildView(account, { ...options, character: 'cactus', language: 'en' }).petName, 'Cactus');
  assert.equal(buildView(account, { ...options, character: 'cactus', language: 'ja', petName: 'ぽち' }).petName, 'ぽち');
});

test('左枠の姿の名前も language に合わせる', () => {
  const svg = (language) => dialogOf(buildView(account, { ...options, language }));
  assert.ok(svg('ja').includes('たね'));
  assert.ok(!svg('en').includes('たね'));
  assert.ok(svg('en').includes('Seed'));
});

test('タイトルも language に合わせる', () => {
  const title = (language) => buildCards(account, { ...options, language })['card-light.svg'].match(/<title[^>]*>([^<]*)</)[1];
  assert.equal(title('en'), 'octocat&apos;s Tiny Pixel Room: Seed Lv.1, Total contributions 2,486');
  assert.equal(title('ja'), 'octocat のドットのおへや: たね Lv.1、Total contributions 2,486');
});

test('language を変えても成長の数字は変わらない', () => {
  const pick = ({ exp, stage, level, levelExp }) => ({ exp, stage, level, levelExp });
  const en = buildView(account, { ...options, language: 'en' });
  const ja = buildView(account, { ...options, language: 'ja' });
  assert.deepEqual(pick(en.growth), pick(ja.growth));
  assert.deepEqual(en.stats, ja.stats);
});

test('ステータスは開始日の影響を受けず、成長だけが変わる', () => {
  const early = buildView(account, { ...options, since: '2026-01-01' });
  const late = buildView(account, { ...options, since: '2026-11-08' });
  assert.equal(early.stats.totalContributions, late.stats.totalContributions);
  assert.deepEqual(early.stats, late.stats);
  assert.equal(early.growth.exp, 8);
  assert.equal(late.growth.exp, 3);
});

test('exp を渡したら、コントリビューションのグラフから数え直さずにその EXP で育ち具合を決める', () => {
  const view = buildView(account, { ...options, exp: 500 });
  assert.equal(view.growth.exp, 500);
  assert.equal(view.growth.stage, 3);
});

test('取れなかった数は、見えている項目の分だけ知らせる', () => {
  const partial = { ...account, totalPullRequests: null };
  const warningsOf = (hide) => {
    const warnings = [];
    buildView(partial, { ...options, hide, warn: (message) => warnings.push(message) });
    return warnings;
  };
  const warnings = warningsOf([]);
  assert.deepEqual(warnings.map(japanese), ['GitHub から PR と Issue の一部の数を取れませんでした。カードには - と表示します']);
  // 「権限の強いトークンを作って渡せばよい」と受け取られないよう、日本語の行でも英語の行でも、トークンや権限に触れない。
  assert.doesNotMatch(warnings[0], /トークン|権限|token|permission|scope/i);
  assert.deepEqual(warningsOf(['prs']), []);
});

test('4 枚のカードで、同じ文字の形は 1 回だけ作り、次の buildCards には持ち越さない', (t) => {
  const font = loadFont();
  const getPath = t.mock.method(font, 'getPath');
  // 1 枚分の形を作る回数。
  renderCard({ ...buildView(account, options, font), mode: 'light', motion: true }, font);
  const once = getPath.mock.callCount();
  assert.ok(once > 0);
  for (let i = 0; i < 2; i++) {
    getPath.mock.resetCalls();
    buildCards(account, options);
    assert.equal(getPath.mock.callCount(), once);
  }
});
