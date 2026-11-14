import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HEAVIER_READING_REQUESTS,
  HISTORY_PAGE_SIZES,
  KEEP_PRIVATE_COMMITS_DAYS,
  LIGHTER_READING_DAYS,
  MAX_COUNT_MS,
  MAX_HISTORY_REQUESTS,
  MAX_PRIVATE_REQUESTS,
  RATE_LIMIT_WAIT_MS,
  RETRY_DELAYS_MS,
  fetchAccount,
  retryTimer,
} from '../src/github.mjs';
import { addDays } from '../src/stats.mjs';

const forbidden = {
  data: { user: null },
  errors: [{ type: 'FORBIDDEN', path: ['user'], message: 'Resource not accessible by integration' }],
};

// 草の最後の日 (2026-11-08) が、草の日付での今日になる。
const profileCalendar = { weeks: [{ contributionDays: [{ date: '2026-11-01' }, { date: '2026-11-02' }] }, { contributionDays: [{ date: '2026-11-08' }] }] };
// 範囲を指定しない contributionsCollection。コミットの数は、この草の期間 (およそ過去 1 年) の値を使う。
// restricted は非公開の活動数で、Private contributions がオンのときだけ 0 より大きくなる。
// 非公開リポジトリのコミットは、このコントリビューションの期間 (2026-11-01 から 2026-11-08) の日付で数える。
const profileWith = (restricted) => ({
  data: {
    user: {
      id: 'U_octocat',
      contributionsCollection: {
        contributionYears: [2026, 2025],
        totalCommitContributions: 3,
        restrictedContributionsCount: restricted,
        contributionCalendar: profileCalendar,
      },
    },
  },
});
const profileResponse = profileWith(0);

const defaultYears = {
  data: {
    user: {
      y2026: { contributionCalendar: { totalContributions: 5, weeks: [{ contributionDays: [{ date: '2026-01-01', contributionCount: 5 }] }] } },
      y2025: { contributionCalendar: { totalContributions: 3, weeks: [{ contributionDays: [{ date: '2025-01-01', contributionCount: 3 }] }] } },
    },
  },
};

// スターの多い順に並んだ、1 ページ分のリポジトリのスター数。totalCount は、すべてのページを合わせたリポジトリの数。
const starsPage = (counts, hasNextPage = false, totalCount = counts.length) => ({
  data: {
    user: {
      repositories: {
        totalCount,
        pageInfo: { hasNextPage, endCursor: hasNextPage ? `after-${counts.join('-')}` : null },
        nodes: counts.map((stargazerCount) => ({ stargazerCount })),
      },
    },
  },
});

// 1 ページ分のリポジトリの言語。names は 1 リポジトリに 1 つずつ入れる言語の名前。
const languagesPage = (names, hasNextPage = false) => ({
  data: {
    user: {
      repositories: {
        pageInfo: { hasNextPage, endCursor: hasNextPage ? `after-${names.join('-')}` : null },
        nodes: names.map((name) => ({ languages: { edges: [{ size: 10, node: { name } }] } })),
      },
    },
  },
});

// トークンで読める非公開リポジトリ。pushedAt は最後に push された時刻。
// branch は既定のブランチの名前で、null は空のリポジトリ。ghPages は gh-pages ブランチがあるか。
// commits と ghPagesCommits は、一覧で分かる、ブランチにある期間のコミットの数。読む量を見積もるのに使う。
const repo = (name, { pushedAt = '2026-11-05T00:00:00Z', branch = 'main', ghPages = false, commits = 1, ghPagesCommits = 1 } = {}) => ({
  id: `R_${name}`,
  pushedAt,
  owner: { login: 'octocat' },
  name,
  defaultBranchRef: branch ? { name: branch, target: { history: { totalCount: commits } } } : null,
  ghPages: ghPages ? { target: { history: { totalCount: ghPagesCommits } } } : null,
});

// 1 ページ分の、トークンで読める非公開リポジトリ。next は次のページのカーソルで、null なら最後のページ。
const repositoriesPage = (nodes, next = null) => ({
  data: { user: { repositories: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } } },
});

// カーソルで選んで返す一覧。1 ページ目 (after が null) は responses[0] で、after が '1' なら responses[1]。
// 1 ページ目を読み直しても、1 ページ目を返す。
const byCursor = (responses) => ({ variables }) => Response.json(responses[variables.after === null ? 0 : Number(variables.after)]);

// コミット。date は author date で、書いた地域の時差が付く。as は本人 (U_octocat) の役。
// author は git の author、co-author は Co-authored-by に名前がある人、committer は rebase などで commit し直した人、
// none は本人がかかわっていないコミット。
const commit = (oid, { date = '2026-11-05T12:00:00+09:00', as = 'author' } = {}) => {
  const me = { user: { id: 'U_octocat' } };
  const other = { user: { id: 'U_other' } };
  const authors = { author: [me], 'co-author': [other, me], committer: [other], none: [other] }[as];
  return { oid, author: { date, ...(as === 'author' ? me : other) }, committer: as === 'committer' ? me : other, authors: { nodes: authors } };
};

const historyPage = (commits, endCursor = null) => ({
  data: { repository: { ref: { target: { history: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes: commits } } } } },
});

// ブランチごとの履歴。キーは「リポジトリの名前 ブランチの名前」で、値はページごとのコミットの配列か、応答の本文。
// 書いていないブランチは、コミットのない履歴を返す。
const histories = (branches) => ({ variables }) => {
  const entry = branches[`${variables.name} ${variables.ref.replace('refs/heads/', '')}`] ?? [[]];
  if (!Array.isArray(entry)) return Response.json(entry);
  const index = variables.after === null ? 0 : Number(variables.after);
  return Response.json(historyPage(entry[index], index + 1 < entry.length ? String(index + 1) : null));
};

// クエリの内容ごとの応答を差し替えて fetch を置きかえる。
// 応答は、本文のオブジェクトか、Response を返す関数で書く。配列なら 1 回ごとに順に返し、最後の 1 つを繰り返す。
function stubApi(t, overrides = {}) {
  const defaults = {
    profile: profileResponse,
    pullRequests: { data: { user: { pullRequests: { totalCount: 4 } } } },
    issues: { data: { user: { issues: { totalCount: 2 } } } },
    stars: starsPage([3]),
    languages: languagesPage(['Go']),
    years: defaultYears,
    // トークンの持ち主。既定では本人のトークン。非公開リポジトリの一覧を読む前に確かめる。
    // user を書いていなければ、counted から作って足す。
    viewer: { data: { viewer: { id: 'U_octocat' } } },
    // GitHub がもうコミットを数えているリポジトリの id。トークンの持ち主と一緒に返す。
    counted: [],
    privateRepositories: repositoriesPage([]),
    history: histories({}),
    // REST API で読むリポジトリ。既定では Pages のサイトがある。
    rest: () => Response.json({ has_pages: true }),
  };
  const responses = { ...defaults, ...overrides };
  // failures は、どの問い合わせかに関係なく最初の数回だけ返す失敗。
  // 数字は HTTP の状態コード、Error は通信エラー、それ以外はそのまま fetch の結果にする。
  const failures = [...(responses.failures ?? [])];
  // やり直す前に待つ処理。既定では待たない。
  t.mock.method(retryTimer, 'wait', responses.wait ?? (async () => {}));
  // 関数の応答には、問い合わせの本文 (query と variables) を渡す。
  const next = (key, body) => {
    const entry = responses[key];
    const value = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
    return typeof value === 'function' ? value(body) : Response.json(value);
  };
  // トークンの持ち主と、GitHub がもうコミットを数えているリポジトリ。
  const viewerResponse = () => {
    const { viewer, counted } = responses;
    if (!viewer.data || 'user' in viewer.data) return Response.json(viewer);
    const commitContributionsByRepository = counted.map((id) => ({ repository: { id } }));
    return Response.json({ ...viewer, data: { ...viewer.data, user: { contributionsCollection: { commitContributionsByRepository } } } });
  };
  // 応答は、そのクエリにしかない項目で選ぶ。ほかのクエリに項目を足しても、行き先が変わらない。
  const pick = async (body) => {
    const { query } = body;
    if (query.includes('contributionYears')) return next('profile', body);
    if (query.includes('pullRequests {')) return next('pullRequests', body);
    if (query.includes('issues {')) return next('issues', body);
    if (query.includes('languages(')) return next('languages', body);
    if (query.includes('stargazerCount')) return next('stars', body);
    if (query.includes('viewer {')) return viewerResponse();
    if (query.includes('privacy: PRIVATE')) return next('privateRepositories', body);
    if (query.includes('history(')) return next('history', body);
    if (query.includes('contributionsCollection(from:')) return next('years', body);
    throw new Error(`知らないクエリです: ${query}`);
  };
  const respond = async (url, init) => {
    const failure = failures.shift();
    if (failure instanceof Error) throw failure;
    if (typeof failure === 'number') return Response.json({ message: 'failure' }, { status: failure });
    if (failure) return failure;
    if (String(url).startsWith('https://api.github.com/repos/')) return next('rest', { url: String(url) });
    assert.equal(String(url), 'https://api.github.com/graphql');
    return pick(JSON.parse(init.body));
  };
  // 本物の fetch と同じく、signal が中止されたら、応答を待たずに中止の理由で失敗する。
  t.mock.method(globalThis, 'fetch', (url, init) => new Promise((resolve, reject) => {
    const { signal } = init;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    respond(url, init).then(resolve, reject);
  }));
}

// 接続が切れたときの fetch の失敗。重すぎたのではない、一時的な失敗なので、同じ問い合わせでやり直す。
const connectionReset = () => Object.assign(new TypeError('fetch failed'), { cause: new Error('read ECONNRESET') });

const fetchedUrls = () => globalThis.fetch.mock.calls.map((call) => String(call.arguments[0]));
const graphqlCalls = () =>
  globalThis.fetch.mock.calls.filter((call) => String(call.arguments[0]).endsWith('/graphql')).map((call) => JSON.parse(call.arguments[1].body));
const restCalls = () => fetchedUrls().filter((url) => url.startsWith('https://api.github.com/repos/'));

test('アカウント全体の数字をまとめる', async (t) => {
  stubApi(t);
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalContributions, 8);
  assert.equal(account.totalCommits, 3);
  assert.equal(account.totalPullRequests, 4);
  assert.equal(account.totalIssues, 2);
  assert.equal(account.stars, 3);
  assert.equal(account.totalRepositories, 1);
  assert.equal(account.days.length, 2);
});

test('スター、リポジトリの数、言語は、トークンで読める非公開リポジトリも数える', async (t) => {
  stubApi(t);
  await fetchAccount('octocat', 'token');
  const queries = graphqlCalls()
    .map(({ query }) => query)
    .filter((query) => query.includes('stargazerCount') || query.includes('languages('));
  assert.equal(queries.length, 2);
  for (const query of queries) assert.doesNotMatch(query, /privacy:/);
});

test('github-readme-stats と同じく、スターはフォークも数え、言語はフォークを除く', async (t) => {
  stubApi(t);
  const account = await fetchAccount('octocat', 'token');
  const queries = graphqlCalls().map(({ query }) => query);
  assert.doesNotMatch(queries.find((query) => query.includes('stargazerCount')), /isFork/);
  assert.match(queries.find((query) => query.includes('languages(')), /isFork: false/);
  assert.deepEqual(account.repositories, [{ languages: [{ name: 'Go', size: 10 }] }]);
});

test('スターは次のページも足し、スターが 0 のリポジトリが出たら次のページは取らない', async (t) => {
  stubApi(t, { stars: [starsPage([10, 5], true), starsPage([2, 0], true), starsPage([99])] });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.stars, 17);
  const afters = graphqlCalls().filter(({ query }) => query.includes('stargazerCount')).map(({ variables }) => variables.after);
  assert.deepEqual(afters, [null, 'after-10-5']);
});

test('リポジトリの数は、スターと同じく、フォークも含めた自分のリポジトリを数える', async (t) => {
  // スターを数え終えて途中のページで止めても、すべてのページを合わせた数になる。
  // ページを取るあいだにリポジトリが増えても、1 ページ目の数を使う。
  stubApi(t, { stars: [starsPage([10, 5], true, 250), starsPage([2, 0], true, 251)] });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalRepositories, 250);
  const query = graphqlCalls().map(({ query }) => query).find((query) => query.includes('stargazerCount'));
  assert.match(query, /ownerAffiliations: OWNER/);
  assert.match(query, /totalCount/);
});

test('言語は先頭 100 件で止めず、次のページのリポジトリも数える', async (t) => {
  stubApi(t, { languages: [languagesPage(['Go', 'C'], true), languagesPage(['Rust'])] });
  const account = await fetchAccount('octocat', 'token');
  assert.deepEqual(account.repositories.map((repo) => repo.languages[0].name), ['Go', 'C', 'Rust']);
  const afters = graphqlCalls().filter(({ query }) => query.includes('languages(')).map(({ variables }) => variables.after);
  assert.deepEqual(afters, [null, 'after-Go-C']);
});

test('PR の権限だけがなければ、PR は不明にして残りは取る', async (t) => {
  stubApi(t, { pullRequests: forbidden });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalPullRequests, null);
  assert.equal(account.totalIssues, 2);
  assert.equal(account.totalContributions, 8);
});

test('権限以外のエラーは隠さない', async (t) => {
  stubApi(t, { issues: { data: null, errors: [{ type: 'INTERNAL', message: 'boom' }] } });
  await assert.rejects(fetchAccount('octocat', 'token'), /boom/);
});

test('回数の上限ではない 403 は、GitHub が返した理由も示して止まる', async (t) => {
  const sso = 'Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.';
  stubApi(t, { profile: () => Response.json({ message: sso }, { status: 403 }) });
  const expected = `GitHub API が 403 を返しました: ${sso}\nGitHub API returned 403: ${sso}`;
  await assert.rejects(fetchAccount('octocat', 'token'), (error) => error.message === expected);
});

test('理由のない失敗は、状態コードだけを示す', async (t) => {
  stubApi(t, { profile: () => new Response('', { status: 404 }) });
  const expected = 'GitHub API が 404 を返しました\nGitHub API returned 404';
  await assert.rejects(fetchAccount('octocat', 'token'), (error) => error.message === expected);
});

test('GraphQL のエラーは、GitHub が返した理由を日本語と英語の行の両方に入れる', async (t) => {
  stubApi(t, { issues: { data: null, errors: [{ type: 'INTERNAL', message: 'boom' }] } });
  const expected = 'GitHub API がエラーを返しました: boom\nGitHub API returned an error: boom';
  await assert.rejects(fetchAccount('octocat', 'token'), (error) => error.message === expected);
});

test('contributions が取れないときは、間違った数字を出さずに止まる', async (t) => {
  stubApi(t, { years: forbidden });
  await assert.rejects(fetchAccount('octocat', 'token'), /Resource not accessible/);
});

test('草の最後の日を、草の日付での今日にする', async (t) => {
  stubApi(t);
  assert.equal((await fetchAccount('octocat', 'token')).today, '2026-11-08');
});

test('草の日付が読めなければ、間違った日付で数えずに止まる', async (t) => {
  const empty = { data: { user: { contributionsCollection: { contributionYears: [2026], contributionCalendar: { weeks: [] } } } } };
  stubApi(t, { profile: empty });
  await assert.rejects(fetchAccount('octocat', 'token'), /今日の日付を読めませんでした/);
});

// GitHub は、見つからないユーザー (組織の名前も) を、user が null の応答に NOT_FOUND のエラーを付けて返す。
const notFound = {
  data: { user: null },
  errors: [{ type: 'NOT_FOUND', path: ['user'], message: "Could not resolve to a User with the login of 'octocat'." }],
};

for (const [label, profile] of [['NOT_FOUND のエラーが付いた', notFound], ['エラーのない', { data: { user: null } }]]) {
  test(`ユーザーが見つからなければ、username の直し方を示して止まる: ${label}応答`, async (t) => {
    stubApi(t, { profile });
    await assert.rejects(
      fetchAccount('octocat', 'token'),
      (error) =>
        /^GitHub のユーザー octocat が見つかりません。username には GitHub のユーザー名を書いてください \(組織の名前は使えません\)\n/.test(error.message) &&
        /\nGitHub user octocat was not found\. Set username to a GitHub username \(organization names can't be used\)$/.test(error.message),
    );
  });
}

// 非公開リポジトリのコミットは、contributionsCollection では種類の分からない活動の数 (restricted) にしか入らない。
// restricted が 0 より大きい (Private contributions がオン) ときだけ、トークンで読める非公開リポジトリの分を数える。
const sharingProfile = profileWith(40);
const callsWith = (text) => graphqlCalls().filter(({ query }) => query.includes(text));
const historyCalls = () => callsWith('history(first:').map(({ variables }) => variables);
const branchesRead = () => historyCalls().map(({ name, ref }) => `${name} ${ref.replace('refs/heads/', '')}`);
const listCalls = () => callsWith('privacy: PRIVATE').map(({ variables }) => variables);

// コントリビューションの日付での今日。非公開リポジトリのコミットを数えきれなくなったら、この日を数えきれなくなった日 (failedSince) にする。
const TODAY = '2026-11-08';
// state.json に残す privateCommits。数えた人 (userId) は、プロフィールの id。
// 数えきれなかった日は、fields に数えきれなくなった日 (failedSince) も入れる。
const record = (count, reading, fields = {}) => ({ count, reading, userId: 'U_octocat', ...fields });
// 今日数えきれなくなって、前の実行で数えた数を使ったときの privateCommits。
const failedToday = (count, reading) => record(count, reading, { failedSince: TODAY });

// 前の実行で state.json に残した privateCommits を渡して数え、知らせた警告も返す。
async function fetchWithRecord(t, privateCommits) {
  const warn = t.mock.fn();
  const account = await fetchAccount('octocat', 'token', { privateCommits, warn });
  return { account, warnings: warn.mock.calls.map((call) => call.arguments[0]) };
}

test('コミットは、公開リポジトリの分に、トークンで読める非公開リポジトリの分を足す', async (t) => {
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('notes'), repo('diary'), repo('empty', { branch: null })]),
    history: histories({ 'notes main': [[commit('a'), commit('b')]], 'diary main': [[commit('c')]] }),
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 6);
  assert.deepEqual(branchesRead().sort(), ['diary main', 'notes main']);
});

test('Private contributions がオフなら、非公開リポジトリが読めてもコミットに足さず、問い合わせもしない', async (t) => {
  stubApi(t, {
    profile: profileWith(0),
    privateRepositories: repositoriesPage([repo('notes')]),
    history: histories({ 'notes main': [[commit('a')]] }),
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 3);
  assert.equal(callsWith('privacy: PRIVATE').length, 0);
  assert.equal(callsWith('history(').length, 0);
});

// ほかの人のカードに、トークンの持ち主が読めるリポジトリから数えた、その人の非公開のコミットの数を出さない。
// トークンの持ち主は、一覧を読む前に確かめる。
for (const [label, viewer] of [
  ['ほかの人のトークン', { data: { viewer: { id: 'U_other' } } }],
  ['viewer が読めないトークン', { data: null, errors: [{ type: 'FORBIDDEN', path: ['viewer'], message: 'Resource not accessible by integration' }] }],
]) {
  test(`トークンの持ち主が本人でなければ、非公開リポジトリが読めてもコミットに足さない: ${label}`, async (t) => {
    stubApi(t, {
      profile: sharingProfile,
      viewer,
      privateRepositories: byCursor([repositoriesPage([repo('notes')], '1'), repositoriesPage([repo('diary')])]),
      history: histories({ 'notes main': [[commit('a')]] }),
    });
    const account = await fetchAccount('octocat', 'token');
    assert.equal(account.totalCommits, 3);
    assert.equal(account.totalContributions, 8);
    assert.equal(account.privateCommits, undefined);
    // 非公開リポジトリの一覧も読まない。
    assert.equal(callsWith('privacy: PRIVATE').length, 0);
    assert.equal(callsWith('history(first:').length, 0);
  });
}

test('既定のトークン (ghs_ で始まる) は本人のトークンではないので、非公開リポジトリは問い合わせもしない', async (t) => {
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('notes')]),
    history: histories({ 'notes main': [[commit('a')]] }),
  });
  const account = await fetchAccount('octocat', 'ghs_0123456789abcdefghijklmnopqrstuvwxyz');
  assert.equal(account.totalCommits, 3);
  assert.equal(callsWith('privacy: PRIVATE').length, 0);
  assert.equal(callsWith('history(').length, 0);
});

test('読める非公開リポジトリがなければ、コミットは公開リポジトリの分だけで、非公開の活動の数は足さない', async (t) => {
  stubApi(t, { profile: sharingProfile });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 3);
  assert.equal(callsWith('history(first:').length, 0);
});

test('非公開リポジトリは、組織のものも含め、フォークを除いて、最後に push された順に読む', async (t) => {
  stubApi(t, { profile: sharingProfile });
  await fetchAccount('octocat', 'token');
  const [{ query }] = callsWith('privacy: PRIVATE');
  assert.match(query, /isFork: false/);
  assert.match(query, /ownerAffiliations: \[OWNER, COLLABORATOR, ORGANIZATION_MEMBER\]/);
  assert.match(query, /orderBy: \{ field: PUSHED_AT, direction: DESC \}/);
  // ブランチのコミットの数も取るので、多く取ると GitHub がタイムアウトする。
  assert.match(query, /repositories\(first: 25,/);
});

test('期間の前の日より前に push された非公開リポジトリは読まず、次のページも取らない', async (t) => {
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: byCursor([
      repositoriesPage([repo('new', { pushedAt: '2026-10-31T00:00:00Z' }), repo('old', { pushedAt: '2026-10-30T23:59:59Z' }), repo('older')], '1'),
      repositoriesPage([repo('next')]),
    ]),
    history: histories({ 'new main': [[commit('a')]], 'older main': [[commit('b')]], 'next main': [[commit('c')]] }),
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 4);
  assert.deepEqual(branchesRead(), ['new main']);
  assert.equal(listCalls().length, 1);
});

test('非公開リポジトリは、次のページのリポジトリも、履歴の次のページも読む', async (t) => {
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: byCursor([repositoriesPage([repo('a')], '1'), repositoriesPage([repo('b')])]),
    history: histories({ 'a main': [[commit('1'), commit('2')], [commit('3')]], 'b main': [[commit('4')]] }),
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 7);
  // 2 ページ以上読んだら、読んでいるあいだに push されたリポジトリがないか、1 ページ目を読み直す。
  // トークンの持ち主などは、一覧の前に 1 回だけ取る。
  assert.deepEqual(listCalls().map(({ after }) => after), [null, '1', null]);
  assert.equal(callsWith('viewer {').length, 1);
  assert.deepEqual(historyCalls().filter(({ name }) => name === 'a').map(({ after }) => after), [null, '1']);
});

test('一覧を読んでいるあいだに push されて前に移ったリポジトリも、1 ページ目を読み直して数える', async (t) => {
  // 1 ページ目を読んだあとで、2 ページ目にあった moved が push されて、1 ページ目の先頭に移った。
  const firstPages = [repositoriesPage([repo('a')], '1'), repositoriesPage([repo('moved', { pushedAt: '2026-11-08T00:00:00Z' }), repo('a')], '1')];
  let reads = 0;
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: ({ variables }) => {
      if (variables.after !== null) return Response.json(repositoriesPage([repo('b')]));
      reads += 1;
      return Response.json(firstPages[reads - 1]);
    },
    history: histories({ 'a main': [[commit('1')]], 'b main': [[commit('2')]], 'moved main': [[commit('3')]] }),
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 6);
  assert.deepEqual(branchesRead().sort(), ['a main', 'b main', 'moved main']);
});

test('コミットは、author date の書いた地域の日付が、コントリビューションの期間に入るものを数える', async (t) => {
  const dates = {
    // UTC では期間の外でも、書いた地域の日付では期間の初日と最後の日。
    first: '2026-11-01T00:30:00+09:00',
    last: '2026-11-08T23:30:00-10:00',
    // UTC では期間の中でも、書いた地域の日付では期間の外。
    before: '2026-10-31T23:30:00-05:00',
    // 期間の最後の日より後。
    after: '2026-11-09T12:00:00+09:00',
    // rebase などで最近 commit し直しても、author date が期間より前なら数えない。
    rebased: '2025-06-01T12:00:00+09:00',
  };
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('notes')]),
    history: histories({ 'notes main': [Object.entries(dates).map(([oid, date]) => commit(oid, { date }))] }),
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 5);
  // どの地域で書いたコミットも期間の初日に入るよう、前の日の UTC の 0 時より後に commit された履歴を、author で絞らずに読む。
  assert.deepEqual(historyCalls(), [
    { owner: 'octocat', name: 'notes', ref: 'refs/heads/main', since: '2026-10-31T00:00:00Z', all: true, author: null, first: 100, after: null },
  ]);
  // 読む量を見積もるコミットの数も、同じ時刻より後で数える。
  assert.equal(listCalls()[0].since, '2026-10-31T00:00:00Z');
});

// GitHub のドキュメントでは、Co-authored-by に名前がある人にも、rebase した人にもコントリビューションが付く。
test('本人が author か、Co-authored-by に名前があるか、commit し直したコミットを数え、ほかの人だけのコミットは数えない', async (t) => {
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('team')]),
    history: histories({
      'team main': [[commit('a', { as: 'author' }), commit('b', { as: 'co-author' }), commit('c', { as: 'committer' }), commit('d', { as: 'none' })]],
    }),
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 6);
});

// 同じコミットが別のリポジトリ (公開リポジトリを写したものなど) にもあれば、そちらでも数える。GitHub もリポジトリごとに数える。
test('既定のブランチと gh-pages ブランチを読み、同じリポジトリにある同じコミットは 1 回だけ数え、別のリポジトリにあればそこでも数える', async (t) => {
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('site', { ghPages: true }), repo('copy'), repo('pages', { branch: 'gh-pages', ghPages: true })]),
    history: histories({
      'site main': [[commit('a'), commit('b')]],
      'site gh-pages': [[commit('b'), commit('c')]],
      'copy main': [[commit('a'), commit('d')]],
      'pages gh-pages': [[commit('e')]],
    }),
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 9);
  assert.deepEqual(branchesRead().sort(), ['copy main', 'pages gh-pages', 'site gh-pages', 'site main']);
  // gh-pages ブランチが既定のブランチなら、既定のブランチとして読むので、Pages のサイトは確かめない。
  assert.deepEqual(restCalls(), ['https://api.github.com/repos/octocat/site']);
});

// GitHub のドキュメントでは、gh-pages ブランチは、プロジェクトのサイトがあるリポジトリのものだけを数える。
test('Pages のサイトがないリポジトリの gh-pages ブランチは読まない', async (t) => {
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('nosite', { ghPages: true })]),
    history: histories({ 'nosite main': [[commit('a')]], 'nosite gh-pages': [[commit('b')]] }),
    rest: () => Response.json({ has_pages: false }),
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 4);
  assert.deepEqual(branchesRead(), ['nosite main']);
});

// Pages のサイトがあるかが読めなければ、サイトがあるとは確かめられないので、ないものとする。
// GraphQL では読めるのに REST API では読めない状態が続いても、既定のブランチの分は毎回数えられ、数も実行ごとに変わらない。
for (const status of [403, 404]) {
  test(`Pages のサイトがあるかが読めない (${status}) リポジトリは、サイトがないものとして、gh-pages ブランチだけを読まない`, async (t) => {
    stubApi(t, {
      profile: sharingProfile,
      privateRepositories: repositoriesPage([repo('site', { ghPages: true }), repo('hidden', { commits: 0, ghPages: true }), repo('notes')]),
      history: histories({
        'site main': [[commit('a')]],
        'site gh-pages': [[commit('b')]],
        'hidden gh-pages': [[commit('c')]],
        'notes main': [[commit('d')]],
      }),
      rest: () => Response.json({ message: 'failure' }, { status }),
    });
    const { account, warnings } = await fetchWithRecord(t, record(7, 'all'));
    assert.equal(account.totalCommits, 5);
    assert.deepEqual(account.privateCommits, record(2, 'all'));
    assert.deepEqual(branchesRead().sort(), ['notes main', 'site main']);
    assert.deepEqual(warnings, []);
  });
}

test('一覧で、期間のコミットがないと分かったブランチは読まない', async (t) => {
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('quiet', { commits: 0, ghPages: true, ghPagesCommits: 0 }), repo('notes')]),
    history: histories({ 'notes main': [[commit('a')]] }),
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 4);
  assert.deepEqual(branchesRead(), ['notes main']);
  assert.deepEqual(restCalls(), []);
});

// いまの GitHub は、非公開リポジトリのコミットを totalCommitContributions に入れないので、ふつうは起きない。
test('GitHub がもうコミットを数えている非公開リポジトリは、もう一度は数えない', async (t) => {
  stubApi(t, {
    profile: sharingProfile,
    counted: ['R_counted'],
    privateRepositories: repositoriesPage([repo('counted'), repo('notes')]),
    history: histories({ 'counted main': [[commit('a')]], 'notes main': [[commit('b')]] }),
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 4);
  assert.deepEqual(branchesRead(), ['notes main']);
});

// commitContributionsByRepository の repository は null にならない項目なので、1 つが読めないだけで user ごと null になる。
test('GitHub がもうコミットを数えているリポジトリが読めなくても、一覧は読めて、非公開リポジトリのコミットを数える', async (t) => {
  const path = ['user', 'contributionsCollection', 'commitContributionsByRepository', 0, 'repository'];
  stubApi(t, {
    profile: sharingProfile,
    viewer: {
      data: { viewer: { id: 'U_octocat' }, user: null },
      errors: [{ type: 'FORBIDDEN', path, message: 'Resource protected by organization SAML enforcement.' }],
    },
    privateRepositories: repositoriesPage([repo('notes')]),
    history: histories({ 'notes main': [[commit('a')]] }),
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 4);
  // 一覧の問い合わせには入れない。
  assert.doesNotMatch(callsWith('privacy: PRIVATE')[0].query, /commitContributionsByRepository/);
});

test('非公開リポジトリのコミットは、非公開の活動の数より多くは足さない', async (t) => {
  stubApi(t, {
    profile: profileWith(2),
    privateRepositories: repositoriesPage([repo('notes')]),
    history: histories({ 'notes main': [['a', 'b', 'c', 'd', 'e'].map((oid) => commit(oid))] }),
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 5);
});

// 待っているあいだに出る問い合わせが、すべて出るまで待つ。時間では待たないので、マシンの速さで結果が変わらない。
const settle = async () => {
  for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

// name のリポジトリの履歴を読む、最初の fetch の呼び出し。
const historyRequest = (name) => globalThis.fetch.mock.calls.find(
  (call) => String(call.arguments[0]).endsWith('/graphql') && JSON.parse(call.arguments[1].body).variables.name === name,
);

// 本文をあとから送る応答。fetch はすぐ返るが、本文は send を呼ぶまで届かない。
// 応答を受け取ったあとで中止され、そのあとの処理で失敗するときを作るのに使う。
function heldResponse() {
  let controller;
  const response = new Response(new ReadableStream({ start: (c) => { controller = c; } }));
  const send = (body) => {
    controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
    controller.close();
  };
  return { response, send };
}

// 形の違うコミット。数えるときに TypeError になる。
const malformedHistory = historyPage([{ oid: 'bad', author: { date: 20261105 } }]);

// 同時に読む数が 4 より少ないと 4 つ目が届かず待ちつづけるので、そのときだけ時間で止める。
test('非公開リポジトリは、同時に 4 つまで読む', { timeout: 5000 }, async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // mock.calls には fetch が返ってから入るので、届いた数はここで数える。
  let fourRead;
  const reading = new Promise((resolve) => { fourRead = resolve; });
  let read = 0;
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  const respond = histories(Object.fromEntries(names.map((name) => [`${name} main`, [[commit(name)]]])));
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage(names.map((name) => repo(name))),
    history: (body) => {
      read += 1;
      if (read === 4) fourRead();
      return gate.then(() => respond(body));
    },
  });
  const pending = fetchAccount('octocat', 'token');
  await reading;
  await settle();
  assert.equal(callsWith('history(first:').length, 4);
  release();
  assert.equal((await pending).totalCommits, 9);
});

// 組織の SSO でトークンが承認されていないリポジトリなどは、権限のエラーと一緒に null で返る。
const samlError = {
  type: 'FORBIDDEN',
  path: ['user', 'repositories', 'nodes', 1],
  message: 'Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.',
};

test('読めない非公開リポジトリは除いて、読めるものだけを数え、それまでに数えた分も残す', async (t) => {
  const partialPage = repositoriesPage([repo('shared'), null, repo('blocked')]);
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: byCursor([repositoriesPage([repo('mine')], '1'), { ...partialPage, errors: [samlError] }]),
    history: histories({
      'mine main': [[commit('a')]],
      'shared main': [[commit('b')]],
      'blocked main': { data: { repository: null }, errors: [{ ...samlError, path: ['repository'] }] },
    }),
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 5);
  assert.equal(retryTimer.wait.mock.calls.length, 0);
});

// 一覧を取ったあとに消されたリポジトリは、NOT_FOUND のエラーと一緒に null で返る。
// 読めない理由のエラーがいくつまざっていても、応答の全体が null でも、そのリポジトリだけを除く。
const notFoundError = { type: 'NOT_FOUND', path: ['repository'], message: "Could not resolve to a Repository with the name 'octocat/gone'." };
const scopesError = { type: 'INSUFFICIENT_SCOPES', path: ['repository'], message: 'Your token has not been granted the required scopes' };

test('一覧を取ったあとに消されたり読めなくなったりしたリポジトリも、除いて数える', async (t) => {
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('mine'), repo('gone'), repo('mixed'), repo('hidden')]),
    history: histories({
      'mine main': [[commit('a')]],
      'gone main': { data: { repository: null }, errors: [notFoundError] },
      'mixed main': { data: { repository: null }, errors: [{ ...samlError, path: ['repository'] }, scopesError] },
      'hidden main': { data: null, errors: [{ ...samlError, path: ['repository'] }] },
    }),
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 4);
  assert.equal(retryTimer.wait.mock.calls.length, 0);
});

// プロフィール用の公開リポジトリでは、実行結果もだれでも見られる。
test('非公開リポジトリのコミットを数えきれなかったと知らせるときも、読めなかった非公開リポジトリの名前は出さない', async (t) => {
  const mixed = { data: { repository: null }, errors: [notFoundError, { type: 'INTERNAL', message: 'boom' }] };
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('gone')]),
    history: histories({ 'gone main': mixed }),
  });
  const { warnings } = await fetchWithRecord(t);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /GitHub API がエラーを返しました: boom/);
  assert.doesNotMatch(warnings[0], /octocat\/gone/);
});

test('回数の上限で数えきれなかったと知らせるときも、読めなかった非公開リポジトリの名前は出さない', async (t) => {
  const limited = { data: { repository: null }, errors: [notFoundError, { type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] };
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('gone')]),
    history: histories({ 'gone main': limited }),
  });
  const { warnings } = await fetchWithRecord(t);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /GitHub API の回数の上限に達しました \(API rate limit exceeded\)/);
  assert.doesNotMatch(warnings[0], /octocat\/gone/);
});

// 読めない理由のエラーの文には、リポジトリの名前が入る。名前に timeout があっても、タイムアウトとは見ない。
test('読めないリポジトリの名前に timeout が入っていても、ほかのエラーをタイムアウトとしてやり直さない', async (t) => {
  const named = { ...notFoundError, message: "Could not resolve to a Repository with the name 'octocat/timeout-svc'." };
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('timeout-svc')]),
    history: histories({ 'timeout-svc main': { data: { repository: null }, errors: [named, { type: 'INTERNAL', message: 'boom' }] } }),
  });
  const { warnings } = await fetchWithRecord(t);
  assert.match(warnings[0], /GitHub API がエラーを返しました: boom/);
  assert.equal(retryTimer.wait.mock.calls.length, 0);
});

// トークンの権限によっては、リポジトリは読めても、その下の項目が、権限のエラーと一緒に null で返る。
const tokenError = (path) => ({ type: 'FORBIDDEN', path, message: 'Resource not accessible by personal access token' });

test('リポジトリは読めても、ブランチや履歴が読めなければ、そのリポジトリは除いて数え、止まらない', async (t) => {
  const historyPath = ['repository', 'ref', 'target', 'history'];
  const unreadableNodes = { ...historyPage(null), errors: [tokenError([...historyPath, 'nodes'])] };
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('mine'), repo('ref'), repo('target'), repo('nodes')]),
    history: histories({
      'mine main': [[commit('a')]],
      'ref main': { data: { repository: { ref: null } }, errors: [tokenError(['repository', 'ref'])] },
      'target main': { data: { repository: { ref: { target: null } } }, errors: [tokenError(['repository', 'ref', 'target'])] },
      'nodes main': unreadableNodes,
    }),
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 4);
  assert.equal(retryTimer.wait.mock.calls.length, 0);
});

// authors には git の author も入るが、authors が null になっても、author は別に取っているので数えられる。
test('Co-authored-by の人が読めないコミットも、止まらずに author と committer で決める', async (t) => {
  const unreadableAuthors = (oid, as) => ({ ...commit(oid, { as }), authors: { nodes: null } });
  const page = historyPage([unreadableAuthors('a', 'committer'), unreadableAuthors('b', 'none'), unreadableAuthors('c', 'author')]);
  const errors = [tokenError(['repository', 'ref', 'target', 'history', 'nodes', 0, 'authors', 'nodes'])];
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('team')]),
    history: histories({ 'team main': { ...page, errors } }),
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 5);
  // author の user は、だれのコミットも読むときにしか使わないので、そのときだけ取る。
  assert.match(callsWith('history(first:')[0].query, /author \{ date user @include\(if: \$all\) \{ id \} \}/);
});

const unreadableRepository = { data: { repository: null }, errors: [{ ...samlError, path: ['repository'] }] };
const changedMessage = /リポジトリかブランチが消されたか、名前が変わったか、読めなくなりました/;
const usedRecord = /非公開リポジトリのコミットを数えきれなかったので、前に数えた数を使います \(2026-11-15 まで\)。次の実行で数え直します/;

// 読めるかどうかは最初のページで決める。あとから読めなくなったリポジトリを、読めた分を引いて除くと、
// ほかのリポジトリを読むのをやめたあとで数が減り、実行ごとに数が変わることがある。
// 届いたあとの失敗は、届いたところで読むのをやめていれば起きないので、応答の順番で数が変わらないよう、見ない。
test('ほかのリポジトリで非公開の活動の数に届いたあとで、読んでいたリポジトリが読めなくなっても、引いた数は出さずに非公開の活動の数にする', { timeout: 5000 }, async (t) => {
  let secondPage;
  const readingSecondPage = new Promise((resolve) => { secondPage = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const commits = (prefix, count) => Array.from({ length: count }, (_, i) => commit(`${prefix}${i}`));
  stubApi(t, {
    profile: profileWith(10),
    // 同時に読むのは 4 つまでなので、d は、ほかで非公開の活動の数に届いたら読まない。
    // b の読めた 7 件を引くと、a と c の 9 件になるが、d も数えれば 15 件で、非公開の活動の数の 10 に届く。
    privateRepositories: repositoriesPage(['b', 'a', 'c', 'x', 'd'].map((name) => repo(name))),
    history: ({ variables: { name, after } }) => {
      if (name === 'b' && after === null) return Response.json(historyPage(commits('b', 7), '1'));
      if (name === 'b') {
        secondPage();
        return gate.then(() => Response.json(unreadableRepository));
      }
      if (name === 'x') return gate.then(() => Response.json(historyPage([])));
      const page = historyPage(commits(name, { a: 4, c: 5, d: 6 }[name]));
      return readingSecondPage.then(() => Response.json(page));
    },
  });
  const pending = fetchWithRecord(t, record(8, 'all'));
  await readingSecondPage;
  await settle();
  release();
  const { account, warnings } = await pending;
  assert.equal(account.totalCommits, 13);
  assert.deepEqual(account.privateCommits, record(10, 'all'));
  assert.deepEqual(warnings, []);
});

test('非公開の活動の数に届いて中止したあとでも、受け取っていた応答からのコードのバグのような失敗は、かくさずに止まる', async (t) => {
  const held = heldResponse();
  stubApi(t, {
    profile: profileWith(2),
    privateRepositories: repositoriesPage([repo('a'), repo('b')]),
    history: (body) => (body.variables.name === 'b' ? held.response : Response.json(historyPage([commit('1'), commit('2')]))),
  });
  const pending = fetchWithRecord(t, record(8, 'all'));
  await settle();
  assert.equal(historyRequest('b').arguments[1].signal.aborted, true);
  held.send(malformedHistory);
  await assert.rejects(pending, TypeError);
});

// 数は非公開の活動の数に決まったので、途中の問い合わせの結果はもう使わない。待つと、そのぶん Action が長くなる。
// 応答もやり直しも、止めなければいつまでも待つようにして、止めたことを確かめる。止めなければ、テストは時間切れになる。
test('非公開の活動の数に届いたら、ほかのリポジトリの途中の問い合わせも、応答を待たずにやめる', { timeout: 5000 }, async (t) => {
  let sent;
  const sentB = new Promise((resolve) => { sent = resolve; });
  stubApi(t, {
    profile: profileWith(1),
    privateRepositories: repositoriesPage([repo('a'), repo('b')]),
    history: (body) => {
      if (body.variables.name === 'a') return sentB.then(() => Response.json(historyPage([commit('1')])));
      sent();
      return new Promise(() => {});
    },
  });
  const { account, warnings } = await fetchWithRecord(t);
  assert.equal(account.totalCommits, 4);
  assert.deepEqual(warnings, []);
  assert.equal(historyRequest('b').arguments[1].signal.aborted, true);
});

test('非公開の活動の数に届いたら、ほかのリポジトリのやり直しも待たずにやめる', { timeout: 5000 }, async (t) => {
  let waiting;
  const waitingB = new Promise((resolve) => { waiting = resolve; });
  stubApi(t, {
    profile: profileWith(1),
    privateRepositories: repositoriesPage([repo('a'), repo('b')]),
    history: (body) => {
      if (body.variables.name === 'a') return waitingB.then(() => Response.json(historyPage([commit('1')])));
      return Promise.reject(connectionReset());
    },
    // signal のない問い合わせのやり直しでも、待ちつづける。
    wait: (ms, signal) => new Promise((resolve, reject) => {
      waiting();
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  const { account, warnings } = await fetchWithRecord(t);
  assert.equal(account.totalCommits, 4);
  assert.deepEqual(warnings, []);
  assert.equal(historyCalls().filter(({ name }) => name === 'b').length, 1);
});

// 数えているあいだに読めるものが変わったら、そこを 0 にしたり途中までの一覧で数えたりせずに、前の実行の数を使う。次の実行では読み直せる。
for (const [label, overrides, message] of [
  [
    'ブランチが消されたか名前が変わった',
    { history: histories({ 'a main': [[commit('1')]], 'b main': { data: { repository: { ref: null } } } }) },
    changedMessage,
  ],
  [
    '履歴の途中のページから読めなくなった',
    {
      history: (body) => {
        if (body.variables.name === 'b' && body.variables.after !== null) return Response.json(unreadableRepository);
        return histories({ 'a main': [[commit('1')]], 'b main': [[commit('2')], [commit('3')]] })(body);
      },
    },
    changedMessage,
  ],
  [
    '既定のブランチは読めたのに、gh-pages ブランチが読めなくなった',
    {
      privateRepositories: repositoriesPage([repo('a', { ghPages: true }), repo('b')]),
      history: histories({ 'a main': [[commit('1')]], 'a gh-pages': unreadableRepository, 'b main': [[commit('2')]] }),
    },
    changedMessage,
  ],
  [
    '一覧が途中から読めなくなった',
    { privateRepositories: byCursor([repositoriesPage([repo('a')], '1'), forbidden]) },
    /非公開リポジトリの一覧が、途中から読めなくなりました/,
  ],
  [
    '一覧の 1 ページ目を読み直したら、読めなくなった',
    {
      privateRepositories: (() => {
        let reads = 0;
        return ({ variables }) => {
          if (variables.after !== null) return Response.json(repositoriesPage([repo('b')]));
          reads += 1;
          return Response.json(reads === 1 ? repositoriesPage([repo('a')], '1') : forbidden);
        };
      })(),
    },
    /非公開リポジトリの一覧が、途中から読めなくなりました/,
  ],
]) {
  test(`非公開リポジトリのコミットを数えているあいだに読めるものが変わったら、前の実行の数を使う: ${label}`, async (t) => {
    stubApi(t, {
      profile: sharingProfile,
      privateRepositories: repositoriesPage([repo('a'), repo('b')]),
      history: histories({ 'a main': [[commit('1')]], 'b main': [[commit('2')]] }),
      ...overrides,
    });
    const { account, warnings } = await fetchWithRecord(t, record(7, 'all'));
    assert.equal(account.totalCommits, 10);
    assert.deepEqual(account.privateCommits, failedToday(7, 'all'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], usedRecord);
    assert.match(warnings[0], message);
  });
}

// だれのコミットも読むと、読む量はリポジトリの大きさで決まる。大きな組織のリポジトリが読めるトークンでも、
// 回数の上限やタイムアウトで毎回止まらないよう、一覧のコミットの数から読む前に見積もり、多すぎるなら本人が author のコミットだけを読む。
// 見積もりは応答の速さで変わらないので、どちらで数えるかは実行ごとに揺れない。
const authorFilters = () => historyCalls().map(({ author }) => author);

// 25 件ずつのページに分けた一覧。names はリポジトリの名前。
function pagedRepositories(names) {
  const listPages = [];
  for (let i = 0; i < names.length; i += 25) listPages.push(names.slice(i, i + 25));
  return byCursor(listPages.map((page, i) => repositoriesPage(page.map((name) => repo(name)), i + 1 < listPages.length ? String(i + 1) : null)));
}
const repositoryNames = (count) => Array.from({ length: count }, (_, i) => `r${i}`);

test('読む量の見積もりが上限までなら、だれのコミットも読み、Co-authored-by に名前があるコミットや commit し直したコミットも数える', async (t) => {
  // 一覧の 1 回と、コミット 100 件ごとに 1 回で、ちょうど上限になる。
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('team', { commits: (MAX_PRIVATE_REQUESTS - 1) * 100 })]),
    history: histories({ 'team main': [[commit('a'), commit('b', { as: 'co-author' }), commit('c', { as: 'committer' })]] }),
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 6);
  assert.deepEqual(authorFilters(), [null]);
  assert.deepEqual(account.privateCommits, record(3, 'all'));
});

test('読む量の見積もりが上限を超えるなら、本人が author のコミットだけを、GitHub で絞って読む', async (t) => {
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('huge', { commits: MAX_PRIVATE_REQUESTS * 100 }), repo('small')]),
    // 絞って読むと、GitHub は本人が author のコミットだけを返す。
    history: histories({ 'huge main': [[commit('a'), commit('b')], [commit('c')]], 'small main': [[commit('d')]] }),
  });
  const { account } = await fetchWithRecord(t);
  assert.equal(account.totalCommits, 7);
  assert.deepEqual(authorFilters(), Array(3).fill({ id: 'U_octocat' }));
  assert.deepEqual(account.privateCommits, record(4, 'authored'));
  // 使わない committer と Co-authored-by の人は取らない。
  assert.ok(historyCalls().every(({ all }) => all === false));
  const [{ query }] = callsWith('history(first:');
  assert.match(query, /committer @include\(if: \$all\)/);
  assert.match(query, /authors\(first: 100\) @include\(if: \$all\)/);
});

// 見積もりで本人が author のコミットだけを読むことになると、本人の活動とは関係なく、カードの数が GitHub の数え方の数より下がる。
// そこで、だれのコミットも読む読み方から変わった日に知らせる。前の実行で数えていなければ、だれのコミットも読む読み方から変わったものとする。
const authoredReading = /非公開リポジトリの読む量の見積もりが上限を超えたので、非公開リポジトリのコミットは、本人が author のコミットだけを読んで数えます/;

for (const [label, recorded, warned] of [
  ['前の実行でだれのコミットも読んだなら、知らせる', record(5, 'all'), true],
  ['前の実行で数えていなければ、知らせる', undefined, true],
  ['前の実行も本人が author のコミットだけを読んだなら、知らせない', record(5, 'authored'), false],
  ['前の実行で読まなかったなら、知らせない', record(0, 'none'), false],
]) {
  test(`見積もりで本人が author のコミットだけを読むことになったとき、${label}`, async (t) => {
    stubApi(t, {
      profile: sharingProfile,
      privateRepositories: repositoriesPage([repo('huge', { commits: MAX_PRIVATE_REQUESTS * 100 })]),
      history: histories({ 'huge main': [[commit('a')]] }),
    });
    const { account, warnings } = await fetchWithRecord(t, recorded);
    assert.deepEqual(account.privateCommits, record(1, 'authored'));
    if (warned) {
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], authoredReading);
      assert.match(warnings[0], /GitHub の数え方より少なくなることがあります/);
    } else {
      assert.deepEqual(warnings, []);
    }
  });
}

// Pages のサイトを確かめる REST の問い合わせは、どちらの読み方でも送るので、見積もりに入れる。
for (const [label, commits, reading] of [
  ['上限までなら、だれのコミットも読む', (MAX_PRIVATE_REQUESTS - 3) * 100, 'all'],
  ['上限を超えるなら、本人が author のコミットだけを読む', (MAX_PRIVATE_REQUESTS - 2) * 100, 'authored'],
]) {
  test(`Pages のサイトを確かめる問い合わせも見積もりに入れ、${label}`, async (t) => {
    // 一覧の 1 回と、既定のブランチのコミット 100 件ごとに 1 回と、gh-pages ブランチの 1 回と、Pages のサイトを確かめる 1 回。
    stubApi(t, {
      profile: sharingProfile,
      privateRepositories: repositoriesPage([repo('site', { commits, ghPages: true })]),
      history: histories({ 'site main': [[commit('a')]] }),
    });
    const { account } = await fetchWithRecord(t);
    assert.equal(account.privateCommits.reading, reading);
    assert.equal(restCalls().length, 1);
  });
}

// 読み方が none に変わると、本人の活動とは関係なく、カードの数が下がる。そこで、変わった日に知らせる。
const notReading = /非公開リポジトリの読む量の見積もりが上限を超えたので、非公開リポジトリのコミットを数えるのをやめました/;

test('本人が author のコミットだけを読んでも上限を超えるなら、非公開リポジトリは数えずにカードを作り、一覧も読み切らない', async (t) => {
  const names = repositoryNames(MAX_PRIVATE_REQUESTS + 50);
  stubApi(t, {
    // 非公開の活動の数に届いて読むのをやめないよう、大きくしておく。
    profile: profileWith(MAX_PRIVATE_REQUESTS * 10),
    privateRepositories: pagedRepositories(names),
  });
  const { account, warnings } = await fetchWithRecord(t, record(5, 'authored'));
  assert.equal(account.totalCommits, 3);
  assert.equal(account.totalContributions, 8);
  assert.deepEqual(account.privateCommits, record(0, 'none'));
  assert.equal(callsWith('history(first:').length, 0);
  assert.ok(listCalls().length < Math.ceil(names.length / 25));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], notReading);
});

// 期間より前に push されたリポジトリが出たページでも、そのページまでの見積もりで決める。
test('期間より前に push されたリポジトリが出たページで見積もりが上限を超えても、非公開リポジトリは読まない', async (t) => {
  // 8 ページで 200 件。一覧の 8 回と合わせて 208 回になる。8 ページ目の最後に、期間より前に push されたリポジトリがある。
  const listPages = Array.from({ length: 8 }, (_, i) => repositoryNames(200).slice(i * 25, i * 25 + 25).map((name) => repo(name)));
  listPages[7].push(repo('old', { pushedAt: '2026-10-01T00:00:00Z' }));
  stubApi(t, {
    profile: profileWith(MAX_PRIVATE_REQUESTS * 10),
    privateRepositories: byCursor([...listPages.map((nodes, i) => repositoriesPage(nodes, String(i + 1))), repositoriesPage([repo('next')])]),
  });
  const { account, warnings } = await fetchWithRecord(t);
  assert.equal(account.totalCommits, 3);
  assert.deepEqual(account.privateCommits, record(0, 'none'));
  assert.equal(callsWith('history(first:').length, 0);
  // 9 ページ目も、1 ページ目の読み直しも取らない。
  assert.equal(listCalls().length, 8);
  // 前の実行で数えた数がなくても、読まないと決めたことを知らせる。
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], notReading);
});

// 見積もりにはほかの人のコミットも入るので、上限の近くでは、ほかの人の活動で読み方が実行ごとに変わりうる。
// 前の実行より重い読み方には、見積もりが上限の 8 割まで下がったときだけ戻し、数が増えたり減ったりしないようにする。
for (const [label, commits, reading] of [
  ['上限の 8 割を超えるなら、author のコミットだけを読みつづける', HEAVIER_READING_REQUESTS * 100, 'authored'],
  ['上限の 8 割まで下がったら、だれのコミットも読む', (HEAVIER_READING_REQUESTS - 1) * 100, 'all'],
]) {
  test(`前の実行で author のコミットだけを読んだときは、だれのコミットも読む見積もりが${label}`, async (t) => {
    // 一覧の 1 回と、コミット 100 件ごとに 1 回。上限は超えないので、前の実行の読み方がなければ、だれのコミットも読む。
    stubApi(t, {
      profile: sharingProfile,
      privateRepositories: repositoriesPage([repo('team', { commits })]),
      history: histories({ 'team main': [[commit('a')]] }),
    });
    const { account } = await fetchWithRecord(t, record(1, 'authored'));
    assert.equal(account.privateCommits.reading, reading);
    assert.deepEqual(authorFilters(), [reading === 'all' ? null : { id: 'U_octocat' }]);
  });
}

for (const [label, count, reading] of [
  ['上限の 8 割を超えるなら、読まないままにする', HEAVIER_READING_REQUESTS + 10, 'none'],
  ['上限の 8 割まで下がったら、読む', HEAVIER_READING_REQUESTS - 10, 'all'],
]) {
  test(`前の実行で非公開リポジトリを読まなかったときは、見積もりが${label}`, async (t) => {
    // リポジトリごとにコミットが 1 件なので、どちらの読み方でも、一覧のページの数とリポジトリの数を足した回数になる。
    stubApi(t, {
      profile: profileWith(MAX_PRIVATE_REQUESTS * 10),
      privateRepositories: pagedRepositories(repositoryNames(count)),
      history: () => Response.json(historyPage([commit('a')])),
    });
    const { account, warnings } = await fetchWithRecord(t, record(0, 'none'));
    assert.equal(account.privateCommits.reading, reading);
    assert.equal(callsWith('history(first:').length > 0, reading !== 'none');
    // 前の実行も読まなかったので、読まないままでも知らせない。
    assert.deepEqual(warnings, []);
  });
}

// 上限より多くのページがある履歴。commits(index) は、index ページ目のコミット。
const endlessHistory = (commits) => ({ variables }) => {
  const index = variables.after === null ? 0 : Number(variables.after);
  return Response.json(historyPage(commits(index), String(index + 1)));
};

test('数えたコミットが非公開の活動の数に届いたら、履歴の残りのページは読まない', async (t) => {
  stubApi(t, {
    profile: profileWith(2),
    privateRepositories: repositoriesPage([repo('huge')]),
    history: endlessHistory((index) => [commit(`c${index}`)]),
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 5);
  assert.equal(callsWith('history(first:').length, 2);
});

// 本人のコミットのないリポジトリを読んでいても、ほかのリポジトリで非公開の活動の数に届いたら、そこでやめて数える。
test('ほかのリポジトリで非公開の活動の数に届いたら、読んでいる途中のリポジトリも、残りのリポジトリも読まない', async (t) => {
  stubApi(t, {
    profile: profileWith(2),
    privateRepositories: repositoriesPage(['huge', 'small', 'c', 'd', 'e', 'f', 'g'].map((name) => repo(name))),
    history: (body) => {
      if (body.variables.name === 'huge') return endlessHistory((index) => [commit(`c${index}`, { as: 'none' })])(body);
      return histories({ 'small main': [[commit('a'), commit('b')]] })(body);
    },
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 5);
  assert.ok(callsWith('history(first:').length < 10);
  assert.ok(!branchesRead().includes('g main'));
});

test('Pages のサイトがあるかを確かめているあいだに非公開の活動の数に届いたら、gh-pages ブランチは読まない', { timeout: 5000 }, async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let checking;
  const checkingSite = new Promise((resolve) => { checking = resolve; });
  stubApi(t, {
    profile: profileWith(2),
    privateRepositories: repositoriesPage([repo('site', { ghPages: true }), repo('small')]),
    history: (body) => {
      const respond = histories({ 'site main': [[commit('x', { as: 'none' })]], 'site gh-pages': [[commit('y')]] });
      // small は、site が Pages のサイトを確かめはじめてから返す。
      if (body.variables.name === 'small') return checkingSite.then(() => Response.json(historyPage([commit('a'), commit('b')])));
      return respond(body);
    },
    rest: () => {
      checking();
      return gate.then(() => Response.json({ has_pages: true }));
    },
  });
  const pending = fetchAccount('octocat', 'token');
  await checkingSite;
  await settle();
  release();
  const account = await pending;
  assert.equal(account.totalCommits, 5);
  await settle();
  assert.ok(!branchesRead().includes('site gh-pages'));
});
// 読む権限がないのは、いつ動かしても同じなので、0 にしてもカードの数は変わらない。
const scopes = { data: null, errors: [{ type: 'INSUFFICIENT_SCOPES', message: 'Your token has not been granted the required scopes' }] };
const unreadableList = {
  data: { user: { repositories: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: null } } },
  errors: [tokenError(['user', 'repositories', 'nodes'])],
};
for (const [label, response] of [['権限のエラー', forbidden], ['トークンの権限が足りないエラー', scopes], ['一覧の中身だけが読めないエラー', unreadableList]]) {
  test(`非公開リポジトリを読む権限がなければ、コミットは公開リポジトリの分だけにして、カードは作る: ${label}`, async (t) => {
    stubApi(t, { profile: sharingProfile, privateRepositories: response });
    const account = await fetchAccount('octocat', 'token');
    assert.equal(account.totalCommits, 3);
    assert.equal(account.totalContributions, 8);
  });
}

// 数えきれないときに 0 や途中まで数えた数を出すと、実行ごとに数が増えたり減ったりする。
// 止まると、1 つのリポジトリが読めつづけないだけで、カード全体がずっと更新されなくなる。そこで、前の実行の数を使う。
const internal = { data: null, errors: [{ type: 'INTERNAL', message: 'boom' }] };
for (const [label, overrides] of [
  ['トークンの持ち主', { viewer: internal }],
  ['非公開リポジトリの一覧', { privateRepositories: byCursor([repositoriesPage([repo('a')], '1'), internal]) }],
  ['履歴', { history: histories({ 'a main': [[commit('1')]], 'b main': internal }) }],
  ['Pages のサイト', { privateRepositories: repositoriesPage([repo('a', { ghPages: true })]), rest: () => Response.json({ message: 'boom' }, { status: 422 }) }],
]) {
  test(`非公開リポジトリのコミットを数えきれなければ、前の実行で数えた数を使って、カードは作る: ${label}`, async (t) => {
    stubApi(t, {
      profile: sharingProfile,
      privateRepositories: repositoriesPage([repo('a'), repo('b')]),
      history: histories({ 'a main': [[commit('1')]], 'b main': [[commit('2')]] }),
      ...overrides,
    });
    const { account, warnings } = await fetchWithRecord(t, record(7, 'authored'));
    assert.equal(account.totalCommits, 10);
    assert.equal(account.totalContributions, 8);
    assert.deepEqual(account.privateCommits, failedToday(7, 'authored'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], usedRecord);
    assert.match(warnings[0], /boom/);
  });
}

// 前の実行の数を使うのは、数えきれなくなった日から KEEP_PRIVATE_COMMITS_DAYS 日あとまで。
// それより長く数えきれないと、前の数には、そのあとに増えたコミットも、期間から外れたコミットも入っていないので、使わずに 0 にする。
const lastKept = addDays(TODAY, -KEEP_PRIVATE_COMMITS_DAYS);

test('数えきれない日が続いても、数えきれなくなった日から決まった日数までは、前の実行で数えた数を使い、数えきれなくなった日は変えない', async (t) => {
  stubApi(t, { profile: sharingProfile, privateRepositories: internal });
  const recorded = record(7, 'authored', { failedSince: lastKept });
  const { account, warnings } = await fetchWithRecord(t, recorded);
  assert.equal(account.totalCommits, 10);
  assert.deepEqual(account.privateCommits, recorded);
  assert.match(warnings[0], new RegExp(`前に数えた数を使います \\(${TODAY} まで\\)`));
});

// 読み方は、次の実行で前より重い読み方にするかを決めるのに使うので残す。数えきれなくなった日も変えない。
// 数は 0 にするが、残して、次の実行でも古いと分かるようにする。
for (const reading of ['authored', 'all']) {
  test(`数えきれなくなった日から決まった日数を過ぎたら、前の実行で数えた数を使わずに非公開リポジトリの分を足さない: 読み方 ${reading}`, async (t) => {
    stubApi(t, { profile: sharingProfile, privateRepositories: internal });
    const tooOld = addDays(lastKept, -1);
    const { account, warnings } = await fetchWithRecord(t, record(7, reading, { failedSince: tooOld }));
    assert.equal(account.totalCommits, 3);
    assert.deepEqual(account.privateCommits, record(0, reading, { failedSince: tooOld }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(`今回は数えません。${tooOld} から ${KEEP_PRIVATE_COMMITS_DAYS} 日を過ぎても数えきれず、前に数えた数は古くなりました`));
    assert.match(warnings[0], /boom/);
  });
}

// だれのコミットも読むと、毎回タイムアウトするリポジトリがある。本人が author のコミットだけを読めば数えられる。
// 重いクエリは、200 のまま「Something went wrong ... timeout」のエラーになるか、5xx になるか、応答が来ずにタイムアウトする。
const heavyError = { data: null, errors: [{ message: 'Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug.' }] };
const tooHeavyResponses = [
  ['200 のままタイムアウトのエラーになる', () => Response.json(heavyError), /Something went wrong/],
  ['502 になる', () => Response.json({ message: 'failure' }, { status: 502 }), /GitHub API が 502 を返しました/],
  ['504 になる', () => Response.json({ message: 'failure' }, { status: 504 }), /GitHub API が 504 を返しました/],
  ['応答が来ずにタイムアウトする', () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), /30 秒以内に応答がありませんでした/],
];
const readsEveryone = histories({ 'a main': [[commit('1')]], 'b main': [[commit('2'), commit('3')]] });
const failsReadingEveryone = (body) => (body.variables.all ? Response.json(heavyError) : readsEveryone(body));
const lighterReading = /非公開リポジトリのコミットを、だれのコミットも読んでは数えきれなかったので、本人が author のコミットだけを読んで数えました/;
// 軽い読み方で数え直したら、本人が author のコミットだけを読む最後の日を知らせる。
const lighterUntilToday = new RegExp(`${addDays(TODAY, LIGHTER_READING_DAYS)} までは、本人が author のコミットだけを読みます`);

// 前の実行の数を使えないと、0 のままになる。数え直すのは同じ一覧で、一覧は読み直さない。
for (const [label, recorded] of [
  ['前の実行で数えた数がない', undefined],
  ['数えきれなくなった日から決まった日数を過ぎた', record(7, 'all', { failedSince: addDays(lastKept, -1) })],
]) {
  for (const [kind, heavy, reason] of tooHeavyResponses) {
    test(`${label}なら、だれのコミットも読んでは重すぎて数えきれないとき、本人が author のコミットだけを読んで数え直す: ${kind}`, async (t) => {
      stubApi(t, {
        profile: sharingProfile,
        privateRepositories: repositoriesPage([repo('a'), repo('b')]),
        history: (body) => (body.variables.all ? heavy() : readsEveryone(body)),
      });
      const { account, warnings } = await fetchWithRecord(t, recorded);
      assert.equal(account.totalCommits, 6);
      assert.deepEqual(account.privateCommits, record(3, 'authored', { lighterSince: TODAY }));
      assert.ok(authorFilters().includes(null));
      assert.deepEqual(authorFilters().filter((author) => author !== null), [{ id: 'U_octocat' }, { id: 'U_octocat' }]);
      assert.equal(listCalls().length, 1);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], lighterReading);
      assert.match(warnings[0], lighterUntilToday);
      assert.match(warnings[0], reason);
    });
  }
}

// だれのコミットも読むときは、重すぎた履歴のページを、ページを小さくして読み直す。
// 1 ページで本人と照らし合わせるコミットと Co-authored-by の人が減るので、軽い読み方に下げずに、GitHub の数え方のまま数えられることがある。
// 同じ大きさでやり直しても、待つ時間がかかるだけになりやすいので、まだ小さくできるうちは、同じ大きさではやり直さない。
const pageReads = () => historyCalls().map(({ all, ref, first, after }) =>
  `${all ? 'all' : 'authored'} ${ref.replace('refs/heads/', '')} ${first} ${after}`);
const recordedWaits = () => retryTimer.wait.mock.calls.map((call) => call.arguments[0]);

for (const [kind, heavy] of tooHeavyResponses) {
  test(`重すぎた履歴のページは、ページを小さくして読み直し、そのブランチの残りのページもその大きさで読む: ${kind}`, async (t) => {
    const [large, medium] = HISTORY_PAGE_SIZES;
    const respond = histories({
      'site main': [[commit('a'), commit('b', { as: 'co-author' })], [commit('c', { as: 'committer' })]],
      'site gh-pages': [[commit('d')]],
    });
    stubApi(t, {
      profile: sharingProfile,
      privateRepositories: repositoriesPage([repo('site', { ghPages: true })]),
      history: (body) => (body.variables.ref === 'refs/heads/main' && body.variables.first === large ? heavy() : respond(body)),
    });
    const { account, warnings } = await fetchWithRecord(t);
    // Co-authored-by に名前があるコミットも、commit し直したコミットも数える。
    assert.equal(account.totalCommits, 7);
    assert.deepEqual(account.privateCommits, record(4, 'all'));
    // 同じページ (after) を小さくして読み直す。gh-pages ブランチは、既定のブランチで小さくした大きさを引き継がない。
    assert.deepEqual(pageReads(), [`all main ${large} null`, `all main ${medium} null`, `all main ${medium} 1`, `all gh-pages ${large} null`]);
    assert.deepEqual(recordedWaits(), []);
    assert.deepEqual(warnings, []);
  });
}

test('いちばん小さいページでも重すぎたら、その大きさでやり直してから、本人が author のコミットだけを読んで数え直す', async (t) => {
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('a')]),
    history: (body) => (body.variables.all ? Response.json(heavyError) : histories({ 'a main': [[commit('1')]] })(body)),
  });
  const { account, warnings } = await fetchWithRecord(t);
  assert.deepEqual(account.privateCommits, record(1, 'authored', { lighterSince: TODAY }));
  const smallest = HISTORY_PAGE_SIZES.at(-1);
  assert.deepEqual(pageReads(), [
    ...HISTORY_PAGE_SIZES.map((size) => `all main ${size} null`),
    ...RETRY_DELAYS_MS.map(() => `all main ${smallest} null`),
    `authored main ${HISTORY_PAGE_SIZES[0]} null`,
  ]);
  assert.deepEqual(recordedWaits(), RETRY_DELAYS_MS);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], lighterReading);
});

// 本人のコミットがまばらなら、ページを小さくしても GitHub が読み進める量は減らない。
test('本人が author のコミットだけを読むときは、重すぎてもページを小さくせずに、同じ大きさでやり直す', async (t) => {
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('huge', { commits: MAX_PRIVATE_REQUESTS * 100 })]),
    history: () => Response.json(heavyError),
  });
  const { account, warnings } = await fetchWithRecord(t, record(3, 'authored'));
  assert.deepEqual(account.privateCommits, failedToday(3, 'authored'));
  assert.deepEqual(pageReads(), Array(RETRY_DELAYS_MS.length + 1).fill(`authored main ${HISTORY_PAGE_SIZES[0]} null`));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], usedRecord);
});

// 重すぎたのではない失敗なら、ページを小さくしても読めるとは限らないので、小さくせずに、同じ大きさでやり直す。
// 一時的な失敗で小さくすると、そのブランチの残りのページも小さいまま読み、問い合わせが増える。
for (const [kind, transient] of [
  ['接続が切れる', () => Promise.reject(connectionReset())],
  ['500 になる', () => Response.json({ message: 'failure' }, { status: 500 })],
  ['503 になる', () => Response.json({ message: 'failure' }, { status: 503 })],
]) {
  test(`重すぎたのではない一時的な失敗なら、ページを小さくせずに、同じ大きさでやり直す: ${kind}`, async (t) => {
    let failed = false;
    const respond = histories({ 'a main': [[commit('1')]] });
    stubApi(t, {
      profile: sharingProfile,
      privateRepositories: repositoriesPage([repo('a')]),
      history: (body) => {
        if (failed) return respond(body);
        failed = true;
        return transient();
      },
    });
    const { account } = await fetchWithRecord(t);
    assert.deepEqual(account.privateCommits, record(1, 'all'));
    assert.deepEqual(pageReads(), Array(2).fill(`all main ${HISTORY_PAGE_SIZES[0]} null`));
    assert.equal(recordedWaits().length, 1);
  });
}

// ページを小さくしつづけると、見積もりの何倍もの問い合わせを送ることがある。
// 一覧では 1 ページと見積もったブランチが、読むと終わらない (読んでいるあいだに増えつづけるなど) ときも同じ。
test('履歴の問い合わせが上限を超えたら、重すぎたものとして、本人が author のコミットだけを読んで数え直す', async (t) => {
  const endless = ({ variables: { after } }) => {
    const index = after === null ? 0 : Number(after);
    return Response.json(historyPage([commit(`x${index}`, { as: 'none' })], String(index + 1)));
  };
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('a')]),
    history: (body) => (body.variables.all ? endless(body) : histories({ 'a main': [[commit('1')]] })(body)),
  });
  const { account, warnings } = await fetchWithRecord(t);
  assert.deepEqual(account.privateCommits, record(1, 'authored', { lighterSince: TODAY }));
  assert.equal(authorFilters().filter((author) => author === null).length, MAX_HISTORY_REQUESTS);
  assert.deepEqual(authorFilters().filter((author) => author !== null), [{ id: 'U_octocat' }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], lighterReading);
  assert.match(warnings[0], new RegExp(`履歴を読む問い合わせが ${MAX_HISTORY_REQUESTS} 回を超えました`));
});

// 上限は、ページを小さくして読み直した分も入れて数える。小さくするもとになった、重すぎた問い合わせは入れない。
test('ページを小さくして読み直した問い合わせは、履歴の問い合わせの上限に入れ、小さくするもとになった問い合わせは入れない', async (t) => {
  const [large] = HISTORY_PAGE_SIZES;
  const endless = ({ variables: { first, after } }) => {
    if (first === large) return Response.json(heavyError);
    const index = after === null ? 0 : Number(after);
    return Response.json(historyPage([commit(`x${index}`, { as: 'none' })], String(index + 1)));
  };
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('a')]),
    history: (body) => (body.variables.all ? endless(body) : histories({ 'a main': [[commit('1')]] })(body)),
  });
  const { account } = await fetchWithRecord(t);
  assert.deepEqual(account.privateCommits, record(1, 'authored', { lighterSince: TODAY }));
  // 最初の 1 回だけが大きいページで、残りはすべて小さくした大きさで読む。
  const everyone = pageReads().filter((read) => read.startsWith('all '));
  assert.equal(everyone.length, MAX_HISTORY_REQUESTS + 1);
  assert.equal(everyone.filter((read) => read.startsWith(`all main ${large} `)).length, 1);
});

// 見積もりは最初のページの大きさで決める。上限は、どのブランチも 1 段小さくして読めるだけの数にしてある。
// 小さくするもとになった問い合わせも数えると、ブランチの数だけ足りなくなる。
test('見積もりが上限いっぱいでも、どのブランチも 1 段小さくすれば読めるなら、だれのコミットも読んで数える', async (t) => {
  const [large] = HISTORY_PAGE_SIZES;
  // 見積もりは、一覧の 1 回と、リポジトリごとに 1 回で、ちょうど上限。
  const names = Array.from({ length: MAX_PRIVATE_REQUESTS - 1 }, (_, index) => `r${index}`);
  const twoSmallerPages = ({ variables: { name, first, after } }) => {
    if (first === large) return Response.json(heavyError);
    if (after === null) return Response.json(historyPage([commit(`${name}-1`, { as: name === 'r0' ? 'author' : 'none' })], '1'));
    return Response.json(historyPage([commit(`${name}-2`, { as: 'none' })]));
  };
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage(names.map((name) => repo(name, { commits: large }))),
    history: twoSmallerPages,
  });
  const { account, warnings } = await fetchWithRecord(t);
  assert.deepEqual(account.privateCommits, record(1, 'all'));
  assert.deepEqual(warnings, []);
  // リポジトリごとに、重すぎた 1 回と、小さくした 2 ページ。
  assert.equal(pageReads().length, names.length * 3);
});

test('履歴の問い合わせの上限は、同時に読むリポジトリで分け合う', async (t) => {
  const endless = ({ variables: { name, after } }) => {
    const index = after === null ? 0 : Number(after);
    return Response.json(historyPage([commit(`${name}${index}`, { as: 'none' })], String(index + 1)));
  };
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('a'), repo('b')]),
    history: (body) => (body.variables.all ? endless(body) : readsEveryone(body)),
  });
  const { account, warnings } = await fetchWithRecord(t);
  assert.deepEqual(account.privateCommits, record(3, 'authored', { lighterSince: TODAY }));
  const everyone = historyCalls().filter(({ all }) => all);
  assert.equal(everyone.length, MAX_HISTORY_REQUESTS);
  assert.ok(everyone.some(({ name }) => name === 'a'));
  assert.ok(everyone.some(({ name }) => name === 'b'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], lighterReading);
});

// 本人が author のコミットだけを読んでいるときは、それより軽い読み方がないので、数え直さない。
test('本人が author のコミットだけを読んでいて履歴の問い合わせが上限を超えたら、数え直さずに、前の実行の数を使う', async (t) => {
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('huge', { commits: MAX_PRIVATE_REQUESTS * 100 })]),
    history: ({ variables: { after } }) => {
      const index = after === null ? 0 : Number(after);
      return Response.json(historyPage([commit(`x${index}`, { date: '2025-01-01T00:00:00Z' })], String(index + 1)));
    },
  });
  const { account, warnings } = await fetchWithRecord(t, record(3, 'authored'));
  assert.deepEqual(account.privateCommits, failedToday(3, 'authored'));
  assert.equal(historyCalls().length, MAX_HISTORY_REQUESTS);
  assert.ok(authorFilters().every((author) => author !== null));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], usedRecord);
  assert.match(warnings[0], new RegExp(`履歴を読む問い合わせが ${MAX_HISTORY_REQUESTS} 回を超えました`));
});

// 500 や 503 は、まず一時的な失敗として、同じ大きさでやり直す。やり直しても続くなら、重すぎて返しきれないのかもしれない。
// 重すぎたものとしないと、500 や 503 を返しつづけるリポジトリがあるとき、ページを小さくすることも、軽い読み方で数え直すこともできない。
for (const status of [500, 503]) {
  const fails = () => Response.json({ message: 'failure' }, { status });

  test(`やり直しても ${status} が続いたら、重すぎたものとして、ページを小さくして読み直す`, async (t) => {
    const [large, medium] = HISTORY_PAGE_SIZES;
    const respond = histories({ 'a main': [[commit('1'), commit('2', { as: 'co-author' })]] });
    stubApi(t, {
      profile: sharingProfile,
      privateRepositories: repositoriesPage([repo('a')]),
      history: (body) => (body.variables.first === large ? fails() : respond(body)),
    });
    const { account, warnings } = await fetchWithRecord(t);
    assert.deepEqual(account.privateCommits, record(2, 'all'));
    assert.deepEqual(pageReads(), [...Array(RETRY_DELAYS_MS.length + 1).fill(`all main ${large} null`), `all main ${medium} null`]);
    assert.deepEqual(recordedWaits(), RETRY_DELAYS_MS);
    assert.deepEqual(warnings, []);
  });

  test(`どの大きさでも、やり直しても ${status} が続いたら、本人が author のコミットだけを読んで数え直す`, async (t) => {
    stubApi(t, {
      profile: sharingProfile,
      privateRepositories: repositoriesPage([repo('a')]),
      history: (body) => (body.variables.all ? fails() : histories({ 'a main': [[commit('1')]] })(body)),
    });
    const { account, warnings } = await fetchWithRecord(t);
    assert.deepEqual(account.privateCommits, record(1, 'authored', { lighterSince: TODAY }));
    assert.deepEqual(pageReads(), [
      ...HISTORY_PAGE_SIZES.flatMap((size) => Array(RETRY_DELAYS_MS.length + 1).fill(`all main ${size} null`)),
      `authored main ${HISTORY_PAGE_SIZES[0]} null`,
    ]);
    assert.deepEqual(recordedWaits(), HISTORY_PAGE_SIZES.flatMap(() => RETRY_DELAYS_MS));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], lighterReading);
    assert.match(warnings[0], new RegExp(`GitHub API が ${status} を返しました`));
  });
}

// 問い合わせの数が上限までても、重いページは 1 回に何十秒もかかる。ワークフローの timeout-minutes までに終わらないと、
// カードも state.json も書けず、毎日同じところで止まる。
const tookTooLong = new RegExp(`履歴を読むのに ${MAX_COUNT_MS / 1000} 秒を超えました`);

test('履歴を読むのに時間がかかりすぎたら、重すぎたものとして、本人が author のコミットだけを読んで数え直す', async (t) => {
  let now = 0;
  const respond = histories({ 'a main': [[commit('1')], [commit('2')], [commit('3')]] });
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('a')]),
    // だれのコミットも読む問い合わせだけが、1 回に上限と同じ時間かかる。
    history: (body) => {
      if (body.variables.all) now += MAX_COUNT_MS;
      return respond(body);
    },
  });
  t.mock.method(retryTimer, 'now', () => now);
  const { account, warnings } = await fetchWithRecord(t);
  // 数え直すときは、時間をはじめから測る。
  assert.deepEqual(account.privateCommits, record(3, 'authored', { lighterSince: TODAY }));
  const [large] = HISTORY_PAGE_SIZES;
  assert.deepEqual(pageReads(), [
    `all main ${large} null`, `all main ${large} 1`,
    `authored main ${large} null`, `authored main ${large} 1`, `authored main ${large} 2`,
  ]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], lighterReading);
  assert.match(warnings[0], tookTooLong);
});

test('本人が author のコミットだけを読んでいて時間がかかりすぎたら、数え直さずに、前の実行の数を使う', async (t) => {
  let now = 0;
  const respond = histories({ 'huge main': [[commit('1')], [commit('2')], [commit('3')]] });
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('huge', { commits: MAX_PRIVATE_REQUESTS * 100 })]),
    history: (body) => {
      now += MAX_COUNT_MS;
      return respond(body);
    },
  });
  t.mock.method(retryTimer, 'now', () => now);
  const { account, warnings } = await fetchWithRecord(t, record(3, 'authored'));
  assert.deepEqual(account.privateCommits, failedToday(3, 'authored'));
  assert.equal(historyCalls().length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], usedRecord);
  assert.match(warnings[0], tookTooLong);
});

// 回数の上限なら、軽い読み方でも同じく数えられず、問い合わせを増やすだけ。
// 数えているあいだに読めるものが変わったときなどは、軽い読み方に下げても、数が下がるだけ。
for (const [label, failure, reason] of [
  ['GitHub のエラー', internal, /boom/],
  ['回数の上限', { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }, /回数の上限に達しました/],
  ['数えているあいだに読めるものが変わった', { data: { repository: { ref: null } } }, changedMessage],
]) {
  test(`重すぎたのではない失敗なら、前の実行の数を使えなくても、軽い読み方では数え直さない: ${label}`, async (t) => {
    stubApi(t, {
      profile: sharingProfile,
      privateRepositories: repositoriesPage([repo('a'), repo('b')]),
      history: (body) => (body.variables.all && body.variables.name === 'b' ? Response.json(failure) : readsEveryone(body)),
    });
    const { account, warnings } = await fetchWithRecord(t);
    assert.equal(account.totalCommits, 3);
    assert.equal(account.privateCommits, undefined);
    assert.ok(authorFilters().every((author) => author === null));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /今回は数えません/);
    assert.match(warnings[0], reason);
  });
}

// 一時的な失敗で、カードの数が軽い読み方の数に下がらないようにする。
test('前の実行で数えた数を使えるあいだは、だれのコミットも読んで数えきれなくても、数え直さずに前の実行の数を使う', async (t) => {
  stubApi(t, { profile: sharingProfile, privateRepositories: repositoriesPage([repo('a'), repo('b')]), history: failsReadingEveryone });
  const { account, warnings } = await fetchWithRecord(t, record(7, 'all', { failedSince: lastKept }));
  assert.equal(account.totalCommits, 10);
  assert.deepEqual(account.privateCommits, record(7, 'all', { failedSince: lastKept }));
  assert.ok(authorFilters().every((author) => author === null));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /前に数えた数を使います/);
});

test('本人が author のコミットだけを読んでも数えきれなければ、あとの失敗を知らせて、非公開リポジトリの分は足さない', async (t) => {
  const failsAuthored = { data: null, errors: [{ type: 'INTERNAL', message: 'bang' }] };
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('a')]),
    history: (body) => Response.json(body.variables.all ? heavyError : failsAuthored),
  });
  const { account, warnings } = await fetchWithRecord(t);
  assert.equal(account.totalCommits, 3);
  assert.equal(account.privateCommits, undefined);
  // だれのコミットも読む問い合わせは、ページを小さくして読み直し、いちばん小さいページでもタイムアウトのエラーなので、
  // その大きさでやり直してから、本人が author のコミットだけを読む。
  assert.deepEqual(authorFilters(), [...Array(HISTORY_PAGE_SIZES.length + RETRY_DELAYS_MS.length).fill(null), { id: 'U_octocat' }]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /今回は数えません/);
  assert.match(warnings[0], /bang/);
  assert.doesNotMatch(warnings[0], lighterReading);
});

// 数え直す日は問い合わせが増えるので、答えの分かっている Pages のサイトは、もう一度は確かめない。
test('軽い読み方で数え直すときは、Pages のサイトを確かめた答えを使い、もう一度は問い合わせない', { timeout: 5000 }, async (t) => {
  let requested;
  const ghPagesRequested = new Promise((resolve) => { requested = resolve; });
  const respond = histories({ 'site main': [[commit('1')]], 'site gh-pages': [[commit('2')]], 'b main': [[commit('3')]] });
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('site', { ghPages: true }), repo('b')]),
    history: (body) => {
      const { all, name, ref } = body.variables;
      if (all && ref === 'refs/heads/gh-pages') requested();
      // b は、site の Pages のサイトを確かめ終えてから、重すぎて数えきれなくなる。
      if (all && name === 'b') return ghPagesRequested.then(() => Response.json(heavyError));
      return respond(body);
    },
  });
  const { account } = await fetchWithRecord(t);
  assert.deepEqual(account.privateCommits, record(3, 'authored', { lighterSince: TODAY }));
  assert.equal(restCalls().length, 1);
  assert.ok(branchesRead().filter((branch) => branch === 'site gh-pages').length >= 2);
});

// Pages のサイトを確かめる REST の問い合わせは、読み方で重さが変わらない。数え直しても同じ問い合わせを送るので、
// 数えられるとは限らず、数えられても、重すぎたのではないのに、カードの数が軽い読み方の数に下がるだけ。
for (const [kind, failing, reason] of tooHeavyResponses.slice(1)) {
  test(`Pages のサイトを確かめる問い合わせが失敗しても、重すぎたことにはせず、軽い読み方では数え直さない: ${kind}`, async (t) => {
    stubApi(t, {
      profile: sharingProfile,
      privateRepositories: repositoriesPage([repo('site', { ghPages: true }), repo('b')]),
      history: histories({ 'site main': [[commit('1')]], 'b main': [[commit('2')]] }),
      rest: failing,
    });
    const { account, warnings } = await fetchWithRecord(t);
    assert.equal(account.totalCommits, 3);
    assert.equal(account.privateCommits, undefined);
    assert.ok(authorFilters().every((author) => author === null));
    assert.equal(restCalls().length, RETRY_DELAYS_MS.length + 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /今回は数えません/);
    assert.match(warnings[0], reason);
    assert.doesNotMatch(warnings[0], lighterReading);
  });
}

// だれのコミットも読むと毎回重すぎるリポジトリがあっても、毎日だれのコミットも読んでは失敗し、数え直すことがないようにする。
const lighterKept = addDays(TODAY, -LIGHTER_READING_DAYS);

test('軽い読み方で数え直した日から決まった日数までは、見積もりが上限より少なくても、本人が author のコミットだけを読み、数え直した日を残す', async (t) => {
  stubApi(t, { profile: sharingProfile, privateRepositories: repositoriesPage([repo('a'), repo('b')]), history: failsReadingEveryone });
  const recorded = record(3, 'authored', { lighterSince: lighterKept });
  const { account, warnings } = await fetchWithRecord(t, recorded);
  assert.equal(account.totalCommits, 6);
  assert.deepEqual(account.privateCommits, recorded);
  assert.deepEqual(authorFilters(), [{ id: 'U_octocat' }, { id: 'U_octocat' }]);
  assert.deepEqual(warnings, []);
});

test('軽い読み方で数え直した日から決まった日数を過ぎたら、だれのコミットも読み、数えられたら数え直した日を消す', async (t) => {
  stubApi(t, { profile: sharingProfile, privateRepositories: repositoriesPage([repo('a'), repo('b')]), history: readsEveryone });
  const { account, warnings } = await fetchWithRecord(t, record(3, 'authored', { lighterSince: addDays(lighterKept, -1) }));
  assert.deepEqual(account.privateCommits, record(3, 'all'));
  assert.deepEqual(authorFilters(), [null, null]);
  assert.deepEqual(warnings, []);
});

// 前の実行も本人が author のコミットだけを読んでいたので、その日のうちに数え直しても、前の実行より軽い読み方の数にはならない。
test('決まった日数を過ぎてだれのコミットも読んでも重すぎたら、その日のうちに本人が author のコミットだけを読んで数え直し、数え直した日を今日にする', async (t) => {
  stubApi(t, { profile: sharingProfile, privateRepositories: repositoriesPage([repo('a'), repo('b')]), history: failsReadingEveryone });
  const { account, warnings } = await fetchWithRecord(t, record(3, 'authored', { lighterSince: addDays(lighterKept, -1) }));
  assert.equal(account.totalCommits, 6);
  assert.deepEqual(account.privateCommits, record(3, 'authored', { lighterSince: TODAY }));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], lighterReading);
  assert.match(warnings[0], lighterUntilToday);
});

test('数えきれなかった日も、軽い読み方で数え直した日は、前の実行のまま残す', async (t) => {
  stubApi(t, { profile: sharingProfile, privateRepositories: internal });
  const { account } = await fetchWithRecord(t, record(3, 'authored', { lighterSince: lighterKept }));
  assert.deepEqual(account.privateCommits, record(3, 'authored', { lighterSince: lighterKept, failedSince: TODAY }));
});

// 読まない日に数え直した日を消すと、見積もりが下がった次の日に、日数がたつ前に、だれのコミットも読んで、また重すぎて数え直す。
test('軽い読み方で数え直した日から決まった日数までは、見積もりが上限を超えて読まない日も、数え直した日を残す', async (t) => {
  stubApi(t, {
    profile: profileWith(MAX_PRIVATE_REQUESTS * 10),
    privateRepositories: pagedRepositories(repositoryNames(MAX_PRIVATE_REQUESTS + 50)),
  });
  const { account, warnings } = await fetchWithRecord(t, record(3, 'authored', { lighterSince: lighterKept }));
  assert.deepEqual(account.privateCommits, record(0, 'none', { lighterSince: lighterKept }));
  assert.equal(callsWith('history(first:').length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], notReading);
});

test('読まなかった次の日も、軽い読み方で数え直した日から決まった日数までは、見積もりが上限より少なくても、本人が author のコミットだけを読む', async (t) => {
  stubApi(t, { profile: sharingProfile, privateRepositories: repositoriesPage([repo('a'), repo('b')]), history: failsReadingEveryone });
  const { account, warnings } = await fetchWithRecord(t, record(0, 'none', { lighterSince: lighterKept }));
  assert.equal(account.totalCommits, 6);
  assert.deepEqual(account.privateCommits, record(3, 'authored', { lighterSince: lighterKept }));
  assert.deepEqual(authorFilters(), [{ id: 'U_octocat' }, { id: 'U_octocat' }]);
  assert.deepEqual(warnings, []);
});

// 数えた日を残すと、カードが変わらない日も state.json が変わり、毎日コミットされる。
test('数えられたら、数えきれなくなった日は消し、数と読み方が前の実行と同じなら、前の実行と同じものを残す', async (t) => {
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('a')]),
    history: histories({ 'a main': [[commit('1'), commit('2')]] }),
  });
  for (const recorded of [record(2, 'all'), record(2, 'all', { failedSince: lastKept })]) {
    const { account, warnings } = await fetchWithRecord(t, recorded);
    assert.deepEqual(account.privateCommits, record(2, 'all'));
    assert.deepEqual(warnings, []);
  }
});

// 本人のコミットかどうか分からないので除く。少なく数えることになるが、毎回同じコミットが読めないなら、数は実行ごとに変わらない。
// 読めないのは組織の SSO などで、知らせても本人には直せないので、読めないリポジトリと同じく知らせない。
test('読めない項目のせいで null になったコミットは、読めないリポジトリと同じく、除いて数え、知らせない', async (t) => {
  const unreadableCommit = {
    ...historyPage([commit('2'), null]),
    errors: [tokenError(['repository', 'ref', 'target', 'history', 'nodes', 1, 'authors'])],
  };
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('a'), repo('b')]),
    history: histories({ 'a main': [[commit('1')]], 'b main': unreadableCommit }),
  });
  const { account, warnings } = await fetchWithRecord(t, record(7, 'all'));
  assert.equal(account.totalCommits, 5);
  assert.deepEqual(account.privateCommits, record(2, 'all'));
  assert.deepEqual(warnings, []);
});

// 非公開リポジトリを数えるのは本人のトークンを渡したときだけなので、止まって困るのは本人だけで、すぐ気づける。
test('コードのバグのような、GitHub から読めなかったのではない失敗は、前の実行の数でかくさずに止まる', async (t) => {
  // 形の違う応答で、数えている途中に TypeError になる。
  stubApi(t, { profile: sharingProfile, viewer: { data: { viewer: { id: 'U_octocat' }, user: { contributionsCollection: null } } } });
  const warn = t.mock.fn();
  await assert.rejects(fetchAccount('octocat', 'token', { privateCommits: record(7, 'all'), warn }), TypeError);
  assert.equal(warn.mock.calls.length, 0);
});

test('数えきれないと分かって中止したあとでも、受け取っていた応答からのコードのバグのような失敗は、前の実行の数でかくさずに止まる', async (t) => {
  const held = heldResponse();
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('a'), repo('b')]),
    history: (body) => (body.variables.name === 'b' ? held.response : Response.json(internal)),
  });
  const warn = t.mock.fn();
  const pending = fetchAccount('octocat', 'token', { privateCommits: record(7, 'all'), warn });
  await settle();
  assert.equal(historyRequest('b').arguments[1].signal.aborted, true);
  held.send(malformedHistory);
  await assert.rejects(pending, TypeError);
  assert.equal(warn.mock.calls.length, 0);
});

// 数えないとき (本人のトークンでないときなど) は残さないが、数えて 0 だったときは、数えた数として残す。
test('数えたコミットが 0 でも、数えた数として残す', async (t) => {
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('a')]),
    history: histories({ 'a main': [[commit('1', { as: 'none' })]] }),
  });
  const { account, warnings } = await fetchWithRecord(t);
  assert.equal(account.totalCommits, 3);
  assert.deepEqual(account.privateCommits, record(0, 'all'));
  assert.deepEqual(warnings, []);
});

test('前の実行で数えた数がなければ、数えきれなかった日は非公開リポジトリの分を足さず、数えた数として残しもしない', async (t) => {
  stubApi(t, { profile: sharingProfile, privateRepositories: internal });
  const { account, warnings } = await fetchWithRecord(t);
  assert.equal(account.totalCommits, 3);
  assert.equal(account.privateCommits, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /非公開リポジトリのコミットを数えきれなかったので、今回は数えません。次の実行で数え直します/);
  assert.match(warnings[0], /boom/);
});

for (const [label, recorded] of [
  ['数が整数でない', { count: 1.5, reading: 'all' }],
  ['数がマイナス', { count: -1, reading: 'all' }],
  ['読み方を知らない', { count: 7, reading: 'some' }],
  ['数えた人がない', { count: 7, reading: 'all' }],
  ['数えきれなくなった日が実在しない', record(7, 'all', { failedSince: '2026-02-30' })],
  ['軽い読み方で数え直した日が実在しない', record(7, 'authored', { lighterSince: '2026-02-30' })],
  ['形が違う', 7],
]) {
  test(`前の実行で数えた数の形が違えば、ないものとする: ${label}`, async (t) => {
    stubApi(t, { profile: sharingProfile, privateRepositories: internal });
    const { account, warnings } = await fetchWithRecord(t, recorded);
    assert.equal(account.totalCommits, 3);
    assert.equal(account.privateCommits, undefined);
    assert.match(warnings[0], /今回は数えません/);
  });
}

// username を変えたときなど。トークンの持ち主が本人かを確かめる問い合わせが失敗しても、ほかのユーザーの数は足さない。
test('前の実行で数えた数がほかのユーザーのものなら、数えきれなかった日も足さない', async (t) => {
  stubApi(t, { profile: sharingProfile, viewer: internal });
  const { account, warnings } = await fetchWithRecord(t, { ...record(7, 'all'), userId: 'U_someone' });
  assert.equal(account.totalCommits, 3);
  assert.equal(account.privateCommits, undefined);
  assert.match(warnings[0], /今回は数えません。次の実行で数え直します/);
});

// 非公開のコミットは非公開の活動の数に入っているので、前の実行の数でも、それより多くはしない。
test('前の実行で数えた数が、いまの非公開の活動の数より多ければ、非公開の活動の数にする', async (t) => {
  stubApi(t, { profile: profileWith(5), privateRepositories: internal });
  const { account } = await fetchWithRecord(t, record(7, 'all'));
  assert.equal(account.totalCommits, 8);
  assert.deepEqual(account.privateCommits, failedToday(5, 'all'));
});

test('Private contributions がオフなら、前の実行で数えた数も足さず、残しもしない', async (t) => {
  stubApi(t, { profile: profileWith(0) });
  const { account, warnings } = await fetchWithRecord(t, record(7, 'authored'));
  assert.equal(account.totalCommits, 3);
  assert.equal(account.privateCommits, undefined);
  assert.deepEqual(warnings, []);
});

test('非公開リポジトリのブランチを 1 つ読めなければ、読んでいる途中のブランチも、残りのページを取らずにやめる', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const respond = histories({ 'a main': [[commit('1')], [commit('2')]], 'b main': internal });
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('a'), repo('b')]),
    history: (body) => (body.variables.name === 'a' ? gate.then(() => respond(body)) : respond(body)),
  });
  // 前の実行で数えた数を使うので、本人が author のコミットだけを読んで数え直しはしない。
  const { warnings } = await fetchWithRecord(t, record(7, 'all'));
  assert.match(warnings[0], usedRecord);
  assert.match(warnings[0], /boom/);
  release();
  await settle();
  assert.deepEqual(historyCalls().filter(({ name }) => name === 'a').map(({ after }) => after), [null]);
});

// 1 つ数えきれなければ、結果はもう使わない。途中の問い合わせが残ると、カードを作ったあとも Action が終わらない。
// 応答もやり直しも、止めなければいつまでも待つようにして、止めたことを確かめる。止めなければ、テストは時間切れになる。
test('非公開リポジトリを 1 つ数えきれなければ、ほかのリポジトリの途中の問い合わせも、応答を待たずにやめる', { timeout: 5000 }, async (t) => {
  let sent;
  const sentA = new Promise((resolve) => { sent = resolve; });
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('a'), repo('b')]),
    history: (body) => {
      if (body.variables.name === 'b') return sentA.then(() => Response.json(internal));
      sent();
      return new Promise(() => {});
    },
  });
  const { warnings } = await fetchWithRecord(t, record(7, 'all'));
  assert.match(warnings[0], usedRecord);
  assert.equal(historyRequest('a').arguments[1].signal.aborted, true);
  assert.equal(retryTimer.wait.mock.calls.length, 0);
});

test('非公開リポジトリを 1 つ数えきれなければ、ほかのリポジトリのやり直しも待たずにやめる', { timeout: 5000 }, async (t) => {
  let waiting;
  const waitingA = new Promise((resolve) => { waiting = resolve; });
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('a'), repo('b')]),
    history: (body) => {
      if (body.variables.name === 'b') return waitingA.then(() => Response.json(internal));
      return Promise.reject(connectionReset());
    },
    // signal のない問い合わせのやり直しでも、待ちつづける。
    wait: (ms, signal) => new Promise((resolve, reject) => {
      waiting();
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  const { warnings } = await fetchWithRecord(t, record(7, 'all'));
  assert.match(warnings[0], usedRecord);
  assert.equal(historyCalls().filter(({ name }) => name === 'a').length, 1);
});

test('コントリビューションの最初の週に日がなくても、日のある最初の日から非公開リポジトリのコミットを数える', async (t) => {
  const { contributionsCollection } = sharingProfile.data.user;
  const contributionCalendar = { weeks: [{ contributionDays: [] }, ...profileCalendar.weeks] };
  stubApi(t, {
    profile: { data: { user: { ...sharingProfile.data.user, contributionsCollection: { ...contributionsCollection, contributionCalendar } } } },
    privateRepositories: repositoriesPage([repo('notes')]),
    history: histories({ 'notes main': [[commit('a', { date: '2026-11-01T12:00:00+09:00' })]] }),
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 4);
  assert.equal(historyCalls()[0].since, '2026-10-31T00:00:00Z');
});

// 重すぎたかもしれない失敗で、ページを小さくして読み直すところは、「重すぎた履歴のページ」のテストで確かめる。
test('非公開リポジトリのコミットを数えるときも、一時的な失敗はやり直す', async (t) => {
  const respond = histories({ 'notes main': [[commit('a')]] });
  let first = true;
  stubApi(t, {
    profile: sharingProfile,
    privateRepositories: repositoriesPage([repo('notes', { ghPages: true })]),
    history: (body) => {
      if (!first) return respond(body);
      first = false;
      return Promise.reject(connectionReset());
    },
    rest: [() => Response.json({ message: 'failure' }, { status: 502 }), { has_pages: true }],
  });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalCommits, 4);
  assert.equal(retryTimer.wait.mock.calls.length, 2);
});

test('コミットは草の期間だけで数え、年ごとの草の問い合わせには入れない', async (t) => {
  stubApi(t, { profile: profileWith(40) });
  await fetchAccount('octocat', 'token');
  const years = graphqlCalls().map(({ query }) => query).filter((query) => query.includes('y2026:'));
  assert.ok(years.length > 0);
  for (const query of years) assert.doesNotMatch(query, /Commit/);
});

const waits = () => retryTimer.wait.mock.calls.map((call) => call.arguments[0]);

test('GitHub が一時的に 5xx を返したら、間をあけてやり直す', async (t) => {
  stubApi(t, { failures: [502, 503] });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalContributions, 8);
  assert.deepEqual(waits(), RETRY_DELAYS_MS);
});

test('通信エラーもやり直す', async (t) => {
  stubApi(t, { failures: [connectionReset()] });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalContributions, 8);
  assert.equal(waits().length, 1);
});

test('やり直しても 5xx なら止まる', async (t) => {
  stubApi(t, { failures: [502, 502, 502] });
  await assert.rejects(fetchAccount('octocat', 'token'), /502/);
  assert.equal(waits().length, RETRY_DELAYS_MS.length);
});

test('やり直しても通信できなければ、理由を示して止まる', async (t) => {
  stubApi(t, { failures: [connectionReset(), connectionReset(), connectionReset()] });
  await assert.rejects(fetchAccount('octocat', 'token'), /接続できませんでした: read ECONNRESET/);
});

test('どの通信にもタイムアウトを付ける', async (t) => {
  stubApi(t);
  await fetchAccount('octocat', 'token');
  for (const call of globalThis.fetch.mock.calls) assert.ok(call.arguments[1].signal instanceof AbortSignal);
});

test('トークンが無効なら、やり直さずに直し方を示して止まる', async (t) => {
  stubApi(t, { failures: [401] });
  await assert.rejects(fetchAccount('octocat', 'token'), /有効期限が切れている.*既定のトークンに戻して/);
  assert.equal(waits().length, 0);
});

test('権限で断られたときは、やり直さない', async (t) => {
  stubApi(t, { pullRequests: forbidden });
  await fetchAccount('octocat', 'token');
  assert.equal(waits().length, 0);
});

const rateLimited = (status, headers = {}) => () => Response.json({ message: 'You have exceeded a secondary rate limit' }, { status, headers });

test('回数の上限に当たったら、GitHub が示す時間だけ待ってやり直す', async (t) => {
  stubApi(t, { profile: [rateLimited(429, { 'retry-after': '5' }), profileResponse] });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalContributions, 8);
  assert.deepEqual(waits(), [5000]);
});

test('待つ時間が示されない回数の上限は、1 分待ってやり直す', async (t) => {
  stubApi(t, { profile: [rateLimited(403), profileResponse] });
  await fetchAccount('octocat', 'token');
  assert.deepEqual(waits(), [RATE_LIMIT_WAIT_MS]);
});

test('回数の上限が長く続くときは、やり直さずに理由を示して止まる', async (t) => {
  const reset = String(Math.floor(Date.now() / 1000) + 3600);
  stubApi(t, { profile: rateLimited(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }) });
  await assert.rejects(fetchAccount('octocat', 'token'), /回数の上限に達しました \(403\)/);
  assert.equal(waits().length, 0);
});

test('重いクエリが 200 のままタイムアウトのエラーになったら、やり直す', async (t) => {
  const timedOut = { data: null, errors: [{ message: 'Something went wrong while executing your query. This may be the result of a timeout, or it could be a GitHub bug.' }] };
  stubApi(t, { years: [timedOut, defaultYears] });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalContributions, 8);
  assert.equal(waits().length, 1);
});

test('data も errors もない応答は、途中で切れた応答と同じく読み直す', async (t) => {
  stubApi(t, { years: [{}, defaultYears] });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalContributions, 8);
  assert.equal(waits().length, 1);
});

test('読み直しても data も errors もない応答なら、読めなかったと示して止まる', async (t) => {
  stubApi(t, { years: {} });
  await assert.rejects(fetchAccount('octocat', 'token'), /GitHub API の応答を読めませんでした/);
  assert.equal(waits().length, RETRY_DELAYS_MS.length);
});

const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError');

test('本文を受け取っている途中でタイムアウトしても、やり直す', async (t) => {
  const slowBody = { status: 200, ok: true, headers: new Headers(), text: async () => { throw timeout(); } };
  stubApi(t, { failures: [slowBody] });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalContributions, 8);
  assert.equal(waits().length, 1);
});

test('やり直してもタイムアウトするなら、時間切れだと示して止まる', async (t) => {
  stubApi(t, { failures: [timeout(), timeout(), timeout()] });
  await assert.rejects(fetchAccount('octocat', 'token'), /30 秒以内に応答がありませんでした/);
});

test('最初の問い合わせのあとは、互いに関係しない問い合わせをまとめて送る', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  stubApi(t, { years: () => gate.then(() => Response.json(defaultYears)) });
  const pending = fetchAccount('octocat', 'token');
  await new Promise((resolve) => setImmediate(resolve));
  const queries = globalThis.fetch.mock.calls.map((call) => JSON.parse(call.arguments[1].body).query);
  assert.ok(queries.some((query) => query.includes('repositories(')));
  assert.ok(queries.some((query) => query.includes('pullRequests')));
  assert.ok(queries.some((query) => query.includes('issues')));
  release();
  assert.equal((await pending).totalContributions, 8);
});
