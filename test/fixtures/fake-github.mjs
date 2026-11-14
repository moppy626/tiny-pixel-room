// Action の実行テストで --import する。GitHub API の代わりに決まった応答を返す。
// FAKE_GITHUB=forbidden なら、既定のトークンで権限が足りない場合の応答を返す。
// FAKE_GITHUB=unauthorized なら、トークンの期限が切れた場合の 401 を返す。
const DAY_MS = 24 * 60 * 60 * 1000;
// 既定のトークンと同じく、草は UTC の今日で終わる。
const contributionDays = Array.from({ length: 9 }, (_, i) => ({
  date: new Date(Date.now() - (8 - i) * DAY_MS).toISOString().slice(0, 10),
  contributionCount: 3,
}));

const forbidden = {
  data: { user: null },
  errors: [{ type: 'FORBIDDEN', path: ['user'], message: 'Resource not accessible by integration' }],
};

// 応答は、そのクエリにしかない項目で選ぶ。ほかのクエリに項目を足しても、行き先が変わらない。
function respond(query) {
  if (query.includes('contributionYears')) {
    const calendar = { weeks: [{ contributionDays: contributionDays.map(({ date }) => ({ date })) }] };
    const collection = {
      contributionYears: [2026],
      totalCommitContributions: 30,
      // Private contributions がオンの人。非公開リポジトリのコミットを数える前の、トークンの持ち主を確かめる問い合わせも通る。
      restrictedContributionsCount: 12,
      contributionCalendar: calendar,
    };
    return { data: { user: { id: 'U_fake', contributionsCollection: collection } } };
  }
  // トークンの持ち主。ふだんは本人ではないので、非公開リポジトリのコミットは数えない。
  // FAKE_GITHUB=private-error なら本人で、非公開リポジトリの一覧を読むと、数えきれないエラーになる。
  if (query.includes('viewer {')) {
    const viewer = { id: process.env.FAKE_GITHUB === 'private-error' ? 'U_fake' : 'BOT_fake' };
    return { data: { viewer, user: { contributionsCollection: { commitContributionsByRepository: [] } } } };
  }
  if (query.includes('privacy: PRIVATE')) {
    return { data: null, errors: [{ type: 'INTERNAL', message: 'boom' }] };
  }
  if (query.includes('languages(')) {
    const languages = { edges: [{ size: 100, node: { name: 'JavaScript' } }] };
    const page = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ languages }] };
    return { data: { user: { repositories: page } } };
  }
  if (query.includes('stargazerCount')) {
    const page = { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ stargazerCount: 1 }] };
    return { data: { user: { repositories: page } } };
  }
  if (query.includes('pullRequests {') || query.includes('issues {')) {
    if (process.env.FAKE_GITHUB === 'forbidden') return forbidden;
    return { data: { user: { pullRequests: { totalCount: 4 }, issues: { totalCount: 2 } } } };
  }
  if (query.includes('contributionsCollection(from:')) {
    const calendar = { totalContributions: 2486, weeks: [{ contributionDays }] };
    return { data: { user: { y2026: { contributionCalendar: calendar } } } };
  }
  throw new Error(`偽の GitHub API が知らないクエリです: ${query}`);
}

globalThis.fetch = async (url, init) => {
  if (process.env.FAKE_GITHUB === 'unauthorized') return Response.json({ message: 'Bad credentials' }, { status: 401 });
  if (String(url) !== 'https://api.github.com/graphql') throw new Error(`偽の GitHub API が知らない URL です: ${url}`);
  return Response.json(respond(JSON.parse(init.body).query));
};
