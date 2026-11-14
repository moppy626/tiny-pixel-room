// カードの SVG を組み立てる。外部フォントは読めないので、文字はパスに変換して埋め込む (フォントは fonts.mjs)。
import { DOTS_PER_EM } from './fonts.mjs';
import { EXP_PER_LEVEL } from './growth.mjs';
import { NAME } from './messages.mjs';
import { PALETTE, TICK_MS, formOf, framesOf, stepsOf } from './sprites.mjs';

const CELL = 10;

export const THEMES = {
  dark: {
    page: '#1C1636', panel: '#2A2350', frame: '#E7DFFF', text: '#F5F0FF', muted: '#C9C2E8',
    head: '#BBA4FF', gold: '#FFE066', pink: '#FF7AB6', pinkBar: '#FF7AB6', mint: '#6FF0C4', empty: '#473C7E',
    wall: '#3A3070', floor: '#5B4A9E', floor2: '#52428F', rug: '#FF7AB6', dialog: '#17122F',
  },
  light: {
    page: '#CFE8FF', panel: '#FFFDF6', frame: '#4A3C8C', text: '#2A2350', muted: '#574C7E',
    head: '#6246C8', gold: '#8F5C00', pink: '#C22A70', pinkBar: '#E04E90', mint: '#128F6B', empty: '#D6D0EA',
    wall: '#FFE3C2', floor: '#D9A066', floor2: '#C98F58', rug: '#FF9DC4', dialog: '#FFFDF6',
  },
};

// 言語は最大 5 つなので、5 色を順に使う。
const LANGUAGE_COLORS = ['#E04E90', '#BE8208', '#1FA583', '#8B6BEE', '#3B8EDB'];

// language で切り替える文。GITHUB STATUS の項目名はどちらも英語のまま。
// title は、その言葉での名前 (messages.mjs の NAME) を使う。
const MESSAGES = {
  en: {
    streak: (pet, days) => `${pet} is on a ${days}-day streak and full of energy!`,
    waiting: (pet) => `${pet} is waiting in the room again today!`,
    next: (form, exp) => `${exp} more EXP to ${form}`,
    done: 'Reached the final form!',
    title: (login, form, level) => `${login}'s ${NAME.en}: ${form} Lv.${level}`,
    separator: ', ',
  },
  ja: {
    streak: (pet, days) => `${pet}は ${days}にち れんぞくで げんきいっぱい！`,
    waiting: (pet) => `${pet}は きょうも おへやで まっているよ`,
    next: (form, exp) => `${form}まで あと ${exp} EXP`,
    done: 'さいごの すがたまで そだった！',
    title: (login, form, level) => `${login} の${NAME.ja}: ${form} Lv.${level}`,
    separator: '、',
  },
};

export const escapeXml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

// トークンの権限で取れなかった数値は null になる。
const format = (value) => value?.toLocaleString('en-US') ?? '-';

const rect = (x, y, width, height, fill) =>
  `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fill}"/>`;

function panel(x, y, width, height, fill, frame) {
  return [
    rect(x, y - 4, width, 4, frame),
    rect(x, y + height, width, 4, frame),
    rect(x - 4, y, 4, height, frame),
    rect(x + width, y, 4, height, frame),
    rect(x, y, width, height, fill),
  ].join('');
}

function blocks(x, y, count, width, gap, height, fill) {
  if (count <= 0) return '';
  const d = Array.from({ length: count }, (_, i) => `M${x + i * (width + gap)} ${y}h${width}v${height}h${-width}z`);
  return `<path fill="${fill}" d="${d.join('')}"/>`;
}

// 字の大きさ。1 ドットがちょうど 1px か 2px になるよう、DOTS_PER_EM の倍数にする。
// 24px のような大きさでは 1 ドットが 1.5px になり、角が px の途中に来て縁がぼやける。
// 角を px にそろえても、1 ドットの線の太さが 1px と 2px にばらつく。
export const TEXT_SIZE = DOTS_PER_EM;
export const LARGE_TEXT_SIZE = DOTS_PER_EM * 2;

// 文字の形を SVG のパスにする。
// opentype.js の optimize は、最後の線の終わりが始点から 1 単位 (ここでは 1px) 以内だとその線を消すので、
// 文の最後の字の 1 ドットの線が欠ける。optimize は使わない。
export function textPathData(font, text, x, y, size) {
  return font.getPath(text, x, y, size).toPathData({ decimalPlaces: 1, optimize: false, flipY: false });
}

// outlines に作った文字の形を覚え、同じ文字は作り直さない。
function textWriter(font, outlines) {
  const outline = (text, left, y, size) => {
    const key = `${size} ${left} ${y} ${text}`;
    if (!outlines.has(key)) outlines.set(key, textPathData(font, text, left, y, size));
    return outlines.get(key);
  };
  return (value, x, y, { size = TEXT_SIZE, fill, anchor = 'start', maxWidth } = {}) => {
    const text = String(value);
    let fitted = size;
    if (maxWidth) {
      const width = font.getAdvanceWidth(text, size);
      if (width > maxWidth) fitted = Math.max(8, Math.floor((size * maxWidth) / width));
    }
    const width = font.getAdvanceWidth(text, fitted);
    const left = anchor === 'end' ? x - width : x;
    // 字の線は 1 ドットの太さなので、カードを縮めて見せたときや maxWidth で小さくしたときは 1px より細くなる。
    // crispEdges のままだと細い線が消えて読めなくなるので、文字だけはなめらかに描く。
    // TEXT_SIZE と LARGE_TEXT_SIZE の字は、位置が px にあれば角も px にあるので、等倍ならなめらかに描いてもぼやけない。
    return `<path fill="${fill}" shape-rendering="geometricPrecision" d="${outline(text, left, y, fitted)}"/>`;
  };
}

function spriteGroup(rows) {
  const paths = {};
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      let run = 1;
      while (row[x + run] === row[x]) run += 1;
      if (row[x] !== '.') {
        (paths[row[x]] ??= []).push(`M${x * CELL} ${y * CELL}h${run * CELL}v${CELL}h${-run * CELL}z`);
      }
      x += run;
    }
  });
  return Object.entries(paths)
    .map(([key, d]) => `<path fill="${PALETTE[key]}" d="${d.join('')}"/>`)
    .join('');
}

function windowArt(x, y, night) {
  const u = 4;
  const cell = (cx, cy, w, h, fill) => rect(x + cx * u, y + cy * u, w * u, h * u, fill);
  const frame = night ? '#E7DFFF' : '#B9834F';
  const parts = [cell(0, 0, 24, 21, frame), cell(1, 1, 22, 19, night ? '#17122F' : '#8FD8FF')];
  const glow = night ? '#FFE066' : '#FFC93D';
  parts.push(cell(15, 3, 4, 1, glow), cell(14, 4, 6, 3, glow), cell(15, 7, 4, 1, glow));
  const white = '#FFFFFF';
  if (night) {
    for (const [cx, cy] of [[4, 4], [8, 7], [4, 14], [9, 16], [15, 13], [20, 16]]) parts.push(cell(cx, cy, 1, 1, white));
  } else {
    for (const [cx, cy, w, h] of [[4, 4, 4, 1], [3, 5, 6, 2], [14, 14, 4, 1], [13, 15, 7, 2], [3, 15, 3, 1], [2, 16, 6, 1]]) {
      parts.push(cell(cx, cy, w, h, white));
    }
  }
  parts.push(cell(11, 1, 1, 19, frame), cell(1, 10, 22, 1, frame));
  return parts.join('');
}

// 同じポーズが出るコマをまとめ、visibility を切り替えるキーフレームにする。
function animatedCharacter(form, left, top, floorY) {
  const frames = framesOf(form);
  const steps = stepsOf(form);
  const cols = form.rows[0].length;
  const poses = new Map();
  steps.forEach((step, tick) => {
    const key = `${step.frame}:${step.lift}`;
    if (!poses.has(key)) poses.set(key, { ...step, ticks: new Set() });
    poses.get(key).ticks.add(tick);
  });

  const percent = (tick) => Number(((tick / steps.length) * 100).toFixed(3));
  const css = [];
  const groups = [];
  [...poses.values()].forEach((pose, index) => {
    const stops = [];
    let shown = false;
    for (let tick = 0; tick < steps.length; tick += 1) {
      const visible = pose.ticks.has(tick);
      if (tick === 0 || visible !== shown) stops.push(`${percent(tick)}%{visibility:${visible ? 'visible' : 'hidden'}}`);
      shown = visible;
    }
    css.push(`@keyframes p${index}{${stops.join('')}}.p${index}{animation:p${index} ${(steps.length * TICK_MS) / 1000}s step-end infinite}`);

    const lift = pose.lift;
    const up = lift / CELL;
    const width = Math.round(cols * (0.85 - up * 0.1)) * CELL;
    const shadow = lift > 0 ? rect(left + (cols * CELL - width) / 2, floorY + 2, width, 6, 'rgba(23,18,47,.28)') : '';
    groups.push(`<g class="pose p${index}">${shadow}<use href="#frame-${pose.frame}" x="${left}" y="${top - lift}"/></g>`);
  });

  const defs = Object.entries(frames)
    .map(([key, rows]) => `<g id="frame-${key}">${spriteGroup(rows)}</g>`)
    .join('');
  css.unshift('.pose{visibility:hidden}.p0{visibility:visible}');
  return { css: css.join(''), defs, body: groups.join('') };
}

// 右の列は、左の枠と同じ高さ (上端 28、下端 470) に、ステータスと言語の 2 つの枠を縦に並べる。
const COLUMN = { x: 392, width: 420, top: 28, bottom: 470, gap: 20 };
const STATUS_PADDING = 14;
const LANGUAGES_PADDING = 14;
const LANGUAGE_ROWS = 5;
const STREAK_X = [408, 610];
// 小さな数字は 2 列に並べる。それぞれの列の、項目名の左端と数字の右端。
const NUMBER_CELLS = [{ x: 408, right: 590 }, { x: 620, right: 796 }];
const NUMBER_ROW = 28;

// 区切り ({ height, draw(top) }) の高さの合計に、最後の区切りの下の余白を足したもの。
const heightOf = (sections, padding) => sections.reduce((sum, section) => sum + section.height, 0) + padding;

// 区切りを上から積む。枠が中身より高いときは、余った高さを区切りの間と最後の区切りの下に等しく配る。
function stack(sections, top, height, padding) {
  const extra = Math.max(0, height - heightOf(sections, padding)) / sections.length;
  let y = top;
  return sections
    .map((section, index) => {
      if (index > 0) y += extra;
      const drawn = section.draw(Math.round(y));
      y += section.height;
      return drawn;
    })
    .join('');
}

// ステータスの枠の区切り。隠した項目は前から詰める。出す項目がなければ空。
function statusSections({ c, write, font, stats, show }) {
  const sections = [];
  if (show('contrib')) {
    sections.push({
      height: 30,
      draw: (top) =>
        write('Total contributions', 408, top + 26, { size: TEXT_SIZE, fill: c.text }) +
        write(format(stats.totalContributions), 796, top + 28, { size: LARGE_TEXT_SIZE, fill: c.text, anchor: 'end' }),
    });
  }

  const streaks = [
    { key: 'current', label: 'Current streak', value: stats.currentStreak, fill: c.pink },
    { key: 'longest', label: 'Longest streak', value: stats.longestStreak, fill: c.text },
  ].filter((streak) => show(streak.key));
  if (streaks.length) {
    // 棒は current を longest と比べたものなので、current を隠したら出さない。
    const bar = show('current');
    sections.push({
      height: bar ? 90 : 62,
      draw: (top) => {
        const parts = streaks.map(({ label, value, fill }, index) => {
          const x = STREAK_X[index];
          const digits = format(value);
          return (
            write(label, x, top + 26, { size: TEXT_SIZE, fill: c.text }) +
            write(digits, x, top + 60, { size: LARGE_TEXT_SIZE, fill }) +
            write(value === 1 ? 'day' : 'days', x + font.getAdvanceWidth(digits, LARGE_TEXT_SIZE) + 8, top + 60, { size: TEXT_SIZE, fill: c.text })
          );
        });
        if (bar) {
          const filled = stats.currentStreak > 0
            ? Math.max(1, Math.round((stats.currentStreak / Math.max(stats.longestStreak, 1)) * 20))
            : 0;
          parts.push(blocks(408, top + 70, 20, 15, 4, 12, c.empty));
          parts.push(blocks(408, top + 70, Math.min(filled, 20), 15, 4, 12, c.pinkBar));
        }
        return parts.join('');
      },
    });
  }

  const numbers = [
    { key: 'stars', label: 'Stars earned', value: stats.stars, fill: c.gold },
    // プロフィールのコントリビューションのグラフと同じ、過去 1 年の contributions の合計。
    // 全期間の Total contributions と区別できるよう (1yr) を付ける。数字と重ならないよう、半角 13 文字までにする。
    { key: 'contrib1yr', label: 'Contrib (1yr)', value: stats.yearContributions, fill: c.text },
    { key: 'prs', label: 'Total PRs', value: stats.pullRequests, fill: c.text },
    { key: 'issues', label: 'Total issues', value: stats.issues, fill: c.text },
    { key: 'repos', label: 'Repositories', value: stats.repositories, fill: c.text },
  ].filter((item) => show(item.key));
  if (numbers.length) {
    sections.push({
      height: Math.ceil(numbers.length / 2) * NUMBER_ROW,
      draw: (top) =>
        numbers
          .map(({ label, value, fill }, index) => {
            const { x, right } = NUMBER_CELLS[index % 2];
            const y = top + 26 + Math.floor(index / 2) * NUMBER_ROW;
            return write(label, x, y, { size: TEXT_SIZE, fill: c.text }) + write(format(value), right, y, { size: TEXT_SIZE, fill, anchor: 'end', maxWidth: 66 });
          })
          .join(''),
    });
  }

  if (!sections.length) return [];
  return [{ height: 34, draw: (top) => write('GITHUB STATUS', 408, top + 26, { size: TEXT_SIZE, fill: c.head }) }, ...sections];
}

// 言語の枠の区切り。言語が 5 つより少なくても、行の間隔は 5 行分で決める。
function languageSections({ c, write, stats }) {
  const header = { height: 26, draw: (top) => write('Most used languages', 408, top + 26, { size: TEXT_SIZE, fill: c.head }) };
  const rows = Array.from({ length: LANGUAGE_ROWS }, (_, index) => ({
    height: 26,
    draw: (top) => {
      const language = stats.languages[index];
      if (!language) return '';
      const y = top + 26;
      const fill = LANGUAGE_COLORS[index % LANGUAGE_COLORS.length];
      // github-readme-stats と同じく小数 2 桁で出す。棒も表示した値で塗り、0.00% なら塗らない。
      const percent = language.percent.toFixed(2);
      const filled = Number(percent) > 0 ? Math.min(20, Math.max(1, Math.round(Number(percent) / 5))) : 0;
      return (
        write(language.name, 408, y, { size: TEXT_SIZE, fill: c.text, maxWidth: 96 }) +
        blocks(512, y - 12, 20, 9, 2, 14, c.empty) +
        blocks(512, y - 12, filled, 9, 2, 14, fill) +
        write(`${percent}%`, 796, y, { size: TEXT_SIZE, fill: c.text, anchor: 'end' })
      );
    },
  }));
  return [header, ...rows];
}

// 2 つの枠の高さの合計は、いつも左の枠と揃える。
// ステータスの枠は中身の高さにして、残りを言語の枠に回す。片方しか出さないときは、その枠を左の枠と同じ高さにする。
function rightColumn(context) {
  const { c, show } = context;
  const status = statusSections(context);
  const languages = show('langs') ? languageSections(context) : [];
  const parts = [];
  let top = COLUMN.top;
  if (status.length) {
    const height = languages.length ? heightOf(status, STATUS_PADDING) : COLUMN.bottom - top;
    parts.push(panel(COLUMN.x, top, COLUMN.width, height, c.panel, c.frame), stack(status, top, height, STATUS_PADDING));
    top += height + COLUMN.gap;
  }
  if (languages.length) {
    const height = COLUMN.bottom - top;
    parts.push(panel(COLUMN.x, top, COLUMN.width, height, c.panel, c.frame), stack(languages, top, height, LANGUAGES_PADDING));
  }
  return parts.join('');
}

// 下枠。カードの左右と下に、左の枠と同じ 28 の余白をとる。
const CARD_WIDTH = 840;
const DIALOG = { x: 28, top: 494, textX: 52 };
// キャラクターだけのカードは、左の枠と同じ幅にする。
const NARROW_CARD_WIDTH = 396;
// 下枠の文の行の間隔 (line)、文と文の間に足す間隔 (gap)、枠の上端から 1 行目まで (first)、最後の行から枠の下端まで (last)。
const DIALOG_TEXT = { line: 24, gap: 8, first: 36, last: 26 };

// 下枠の右下の、次へ進む印。right と bottom は枠の右端と下端。
const nextMark = (right, bottom, fill) =>
  rect(right - 40, bottom - 22, 20, 4, fill) + rect(right - 36, bottom - 18, 12, 4, fill) + rect(right - 32, bottom - 14, 4, 4, fill);

// 単語の切れ目 (半角の空白) で折り返す。日本語の文も単語ごとに空白で区切ってある。
// phrases (ペットや姿の名前) の中の空白では折り返さない。
// 1 語で幅を超えるときは、その語だけの行にする (書くときに文字を小さくして収める)。
export function wrapWords(text, size, maxWidth, font, phrases = []) {
  const glue = '\u0000';
  let marked = text;
  for (const phrase of phrases) marked = marked.split(phrase).join(phrase.replaceAll(' ', glue));
  const lines = [];
  let line = '';
  for (const word of marked.split(' ').map((part) => part.replaceAll(glue, ' '))) {
    const longer = line ? `${line} ${word}` : word;
    if (line && font.getAdvanceWidth(longer, size) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = longer;
    }
  }
  lines.push(line);
  return lines;
}

// 下枠は、文を折り返し、行の数に合わせて高さを決める。広いカードでは、文は折り返さずに 1 行ずつ収まる。
function dialog({ c, write, font }, messages, phrases, cardWidth) {
  const width = cardWidth - DIALOG.x * 2;
  // 右下の印に文字が重ならないよう、印の左端までを文字の幅にする。
  const maxWidth = DIALOG.x + width - 40 - DIALOG.textX;
  const texts = [];
  let y = DIALOG.top + DIALOG_TEXT.first - DIALOG_TEXT.line;
  messages.forEach((message, index) => {
    wrapWords(message, TEXT_SIZE, maxWidth, font, phrases).forEach((line, lineIndex) => {
      y += DIALOG_TEXT.line + (index > 0 && lineIndex === 0 ? DIALOG_TEXT.gap : 0);
      texts.push(write(line, DIALOG.textX, y, { size: TEXT_SIZE, fill: c.text, maxWidth }));
    });
  });
  const height = y + DIALOG_TEXT.last - DIALOG.top;
  const svg = panel(DIALOG.x, DIALOG.top, width, height, c.dialog, c.frame) + texts.join('') + nextMark(DIALOG.x + width, DIALOG.top + height, c.gold);
  return { svg, height };
}

// 同じフォントで何枚も描くときは、作った文字の形を使い回す (buildCards の 4 枚)。
// 形はフォントごとに覚えるので、別のフォントの形が混ざらない。
export function cardRenderer(font) {
  const outlines = new Map();
  return (view) => drawCard(view, font, outlines);
}

export function renderCard(view, font) {
  return cardRenderer(font)(view);
}

function drawCard(view, font, outlines) {
  const { login, petName, mode, motion, hide, stats, growth, language } = view;
  const c = THEMES[mode];
  const messages = MESSAGES[language];
  const write = textWriter(font, outlines);
  const show = (key) => !hide.has(key);
  const out = [];

  // 左: キャラクターの成長
  out.push(panel(28, 28, 340, 442, c.panel, c.frame));
  out.push(write(`@${login}`, 44, 56, { size: TEXT_SIZE, fill: c.text, maxWidth: 216 }));
  out.push(write(`Lv.${growth.level}`, 352, 56, { size: TEXT_SIZE, fill: c.gold, anchor: 'end' }));

  const scene = { x: 44, y: 72, width: 308, height: 320 };
  const bottom = scene.y + scene.height;
  out.push(rect(scene.x, scene.y, scene.width, scene.height, c.wall));
  out.push(windowArt(58, 86, mode === 'dark'));
  out.push(rect(scene.x, bottom - 62, scene.width, 62, c.floor));
  for (let x = scene.x + 28; x < scene.x + scene.width; x += 32) out.push(rect(x, bottom - 62, 4, 62, c.floor2));
  out.push(rect(84, bottom - 24, 228, 16, c.rug));

  const form = formOf(growth.character, growth.stage);
  const cols = form.rows[0].length;
  const left = 198 - (cols * CELL) / 2;
  const floorY = bottom - 22;
  const top = floorY - form.rows.length * CELL;
  let css = '';
  let defs = '';
  if (motion) {
    const animated = animatedCharacter(form, left, top, floorY);
    css = animated.css;
    defs = animated.defs;
    out.push(animated.body);
  } else {
    out.push(`<g transform="translate(${left} ${top})">${spriteGroup(form.rows)}</g>`);
  }

  out.push(write(growth.formName, 44, 420, { size: TEXT_SIZE, fill: c.text, maxWidth: 190 }));
  out.push(write(`${format(growth.exp)} EXP`, 352, 420, { size: TEXT_SIZE, fill: c.text, anchor: 'end' }));
  out.push(write('EXP', 44, 450, { size: TEXT_SIZE, fill: c.muted }));
  out.push(blocks(92, 437, EXP_PER_LEVEL, 8, 2, 14, c.empty));
  out.push(blocks(92, 437, growth.levelExp, 8, 2, 14, c.mint));
  out.push(write(`${growth.levelExp}/${EXP_PER_LEVEL}`, 352, 450, { size: TEXT_SIZE, fill: c.muted, anchor: 'end' }));

  // 右: GitHub アカウント全体のステータスと、よく使う言語
  const right = rightColumn({ c, write, font, stats, show });
  out.push(right);

  // 下: ひとこと。右の列に出す項目がなければ、キャラクターだけの細いカードにする。
  const lines = [
    // 日数は、右のステータスと同じく 3 桁ごとに区切る。
    show('current') && stats.currentStreak > 0 ? messages.streak(petName, format(stats.currentStreak)) : messages.waiting(petName),
    growth.nextForm ? messages.next(growth.nextForm, format(growth.toNext)) : messages.done,
  ];
  const phrases = [petName, growth.nextForm].filter(Boolean);
  const width = right ? CARD_WIDTH : NARROW_CARD_WIDTH;
  const box = dialog({ c, write, font }, lines, phrases, width);
  out.push(box.svg);
  const height = DIALOG.top + box.height + DIALOG.x;

  const contributions = show('contrib') ? `${messages.separator}Total contributions ${format(stats.totalContributions)}` : '';
  const title = `${messages.title(login, growth.formName, growth.level)}${contributions}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="card-title" shape-rendering="crispEdges">`,
    `<title id="card-title">${escapeXml(title)}</title>`,
    css ? `<style>${css}</style>` : '',
    defs ? `<defs>${defs}</defs>` : '',
    rect(0, 0, width, height, c.page),
    out.join(''),
    '</svg>',
    '',
  ].join('');
}
