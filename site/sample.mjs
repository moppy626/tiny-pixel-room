// 設定サイトのプレビューで使う、見本のアカウントと育ち具合。
// プレビュー (main.mjs) と、フォントを読み終えるまで見せる見本のカード (scripts/build-site.mjs) で使う。
import { addDays } from '../src/stats.mjs';

// 育ち具合ごとの見本の EXP。育ち方のしきい値 (growth.mjs の THRESHOLDS) の、それぞれ少し上。
export const PREVIEW_EXP = [26, 86, 312, 640, 1240];

// 見本のアカウント。README のサンプルのカードと同じ数字にしている (scripts/samples.mjs)。
export function sampleAccount(now = new Date()) {
  const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, '0')).join('-');
  const run = (end, length) => Array.from({ length }, (_, i) => ({ date: addDays(end, i - length + 1), count: 4 }));
  return {
    login: 'your-name',
    today,
    days: [...run(addDays(today, -100), 61), ...run(today, 23)],
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
}
