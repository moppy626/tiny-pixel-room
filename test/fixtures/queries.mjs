// テストと偽の GitHub API (fake-github.mjs) で共通の、クエリの見分け方。

// コントリビューションの数を読む問い合わせ (今日と過去 1 年の合計、年ごとのカレンダー) か。
export const readsContributions = (query) => query.includes('contributionYears') || query.includes('contributionsCollection(from:');
