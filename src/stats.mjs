// API の応答から表示用の数字を作る。外部アクセスはしない。

// Date は 2026-02-30 を 3 月に繰り上げるので、元の文字列に戻るかどうかまで確かめる。
export function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function addDays(date, delta) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// 同じ日が 2 回入っていても 1 日として数える。範囲を日の途中で区切ると、GitHub はその日をどちらの範囲にもまるごと入れる。
function countsByDate(days) {
  const counts = new Map();
  for (const { date, count } of days) counts.set(date, Math.max(count, counts.get(date) ?? 0));
  return counts;
}

// today はコントリビューションのグラフの日付での今日 (fetchAccount の today)。
export function computeStreaks(days, today) {
  const counts = countsByDate(days);
  const active = [...counts.keys()].filter((date) => counts.get(date) > 0).sort();

  let longest = 0;
  let run = 0;
  let previous = null;
  for (const date of active) {
    run = previous && addDays(previous, 1) === date ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = date;
  }

  const runEndingAt = (date) => {
    let length = 0;
    for (let cursor = date; (counts.get(cursor) ?? 0) > 0; cursor = addDays(cursor, -1)) length += 1;
    return length;
  };

  // 今日がまだ 0 件でも、昨日まで続いていれば連続記録は切らない。
  const current = Math.max(runEndingAt(today), runEndingAt(addDays(today, -1)));
  return { current, longest };
}

export function expSince(days, since) {
  let exp = 0;
  for (const [date, count] of countsByDate(days)) {
    if (date >= since) exp += count;
  }
  return exp;
}

// github-readme-stats の既定 (normal レイアウト) と同じく、バイト数の多い順に 5 つの言語を出す。
// 割合は、出す 5 つの合計に対する値にする (残りの言語は分母に入れない)。
export function summarizeLanguages(repositories, top = 5) {
  const sizes = new Map();
  for (const repo of repositories) {
    for (const { name, size } of repo.languages) sizes.set(name, (sizes.get(name) ?? 0) + size);
  }
  const shown = [...sizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
  const total = shown.reduce((sum, [, size]) => sum + size, 0);
  if (total === 0) return [];
  return shown.map(([name, size]) => ({ name, percent: (size / total) * 100 }));
}
