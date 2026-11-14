// 設定サイトの「カードに出す項目」。名前はカードと同じく英語のまま出し、マウスを重ねると説明を出す。
// 説明はサイトの言葉に合わせる。日本語の名前と説明は、README の「カードに出す項目」の表と同じにしている
// (test/site.test.mjs で確かめている)。
export const ITEMS = {
  contrib: {
    label: 'Total contributions',
    description: {
      ja: 'プロフィールのコントリビューションのグラフに出る contributions の、これまでの合計',
      en: "All-time total of the contributions shown in your profile's contribution graph",
    },
  },
  current: {
    label: 'Current streak',
    description: { ja: 'contributions がある日が、今日まで続いている日数', en: 'Days in a row with contributions, up to today' },
  },
  longest: {
    label: 'Longest streak',
    description: { ja: 'contributions がある日が、これまでで一番長く続いた日数', en: 'Your longest run of days in a row with contributions' },
  },
  langs: {
    label: 'Most used languages',
    description: { ja: '自分のリポジトリでよく使っている言語の上位 5 つと、その割合', en: 'Your top 5 languages across your repositories, with their shares' },
  },
  stars: {
    label: 'Stars earned',
    description: { ja: '自分のリポジトリについたスターの合計', en: 'Total stars on your repositories' },
  },
  contrib1yr: {
    label: 'Contrib (1yr)',
    description: {
      ja: 'プロフィールのコントリビューションのグラフに出る、過去 1 年の contributions の合計 (少し違うことがあります)',
      en: "Total contributions in the past year, as shown in your profile's contribution graph (the two can differ slightly)",
    },
  },
  prs: {
    label: 'Total PRs',
    description: { ja: '自分が作った PR の数', en: "Pull requests you've opened" },
  },
  issues: {
    label: 'Total issues',
    description: { ja: '自分が作った Issue の数', en: "Issues you've opened" },
  },
  repos: {
    label: 'Repositories',
    description: { ja: '自分のリポジトリの数', en: 'Number of your repositories' },
  },
};
