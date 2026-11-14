import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RATE_LIMIT_WAIT_MS, RETRY_DELAYS_MS, fetchAccount, retryTimer } from '../src/github.mjs';
import { readsContributions } from './fixtures/queries.mjs';

const forbidden = {
  data: { user: null },
  errors: [{ type: 'FORBIDDEN', path: ['user'], message: 'Resource not accessible by integration' }],
};

// コントリビューションのグラフの最後の日 (2026-11-08) が、コントリビューションのグラフの日付での今日になる。
// totalContributions は過去 1 年の contributions の合計で、Contrib (1yr) に使う。
// 全期間の合計 (年ごとの問い合わせの合計。defaultYears では 8) と取り違えたら分かるよう、違う数にしておく。
const profileCalendar = {
  totalContributions: 6,
  weeks: [{ contributionDays: [{ date: '2026-11-01' }, { date: '2026-11-02' }] }, { contributionDays: [{ date: '2026-11-08' }] }],
};
// 範囲を指定しない contributionsCollection。
const profileResponse = {
  data: {
    user: {
      contributionsCollection: {
        contributionYears: [2026, 2025],
        contributionCalendar: profileCalendar,
      },
    },
  },
};

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
  };
  const responses = { ...defaults, ...overrides };
  // failures は、どの問い合わせかに関係なく最初の数回だけ返す失敗。
  // 数字は HTTP の状態コード、Error は通信エラー、それ以外はそのまま fetch の結果にする。
  const failures = [...(responses.failures ?? [])];
  t.mock.method(retryTimer, 'wait', async () => {});
  const next = (key) => {
    const entry = responses[key];
    const value = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
    return typeof value === 'function' ? value() : Response.json(value);
  };
  // 応答は、そのクエリにしかない項目で選ぶ。ほかのクエリに項目を足しても、行き先が変わらない。
  const pick = (query) => {
    if (query.includes('contributionYears')) return next('profile');
    if (query.includes('pullRequests {')) return next('pullRequests');
    if (query.includes('issues {')) return next('issues');
    if (query.includes('languages(')) return next('languages');
    if (query.includes('stargazerCount')) return next('stars');
    if (query.includes('contributionsCollection(from:')) return next('years');
    throw new Error(`知らないクエリです: ${query}`);
  };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const failure = failures.shift();
    if (failure instanceof Error) throw failure;
    if (typeof failure === 'number') return Response.json({ message: 'failure' }, { status: failure });
    if (failure) return failure;
    assert.equal(String(url), 'https://api.github.com/graphql');
    return pick(JSON.parse(init.body).query);
  });
}

const graphqlCalls = () => globalThis.fetch.mock.calls.map((call) => JSON.parse(call.arguments[1].body));

test('アカウント全体の数字をまとめる', async (t) => {
  stubApi(t);
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.totalContributions, 8);
  assert.equal(account.yearContributions, 6);
  assert.equal(account.totalPullRequests, 4);
  assert.equal(account.totalIssues, 2);
  assert.equal(account.stars, 3);
  assert.equal(account.totalRepositories, 1);
  assert.equal(account.days.length, 2);
});

test('スター、リポジトリの数、言語は、トークンで読める非公開リポジトリも数える', async (t) => {
  stubApi(t);
  await fetchAccount('octocat', 'token');
  const queries = graphqlCalls().map(({ query }) => query).filter((query) => query.includes('repositories('));
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
  await assert.rejects(fetchAccount('octocat', 'token'), /GitHub API がエラーを返しました: FORBIDDEN \(user\)/);
});

// 自分で作ったトークンを渡していると、スターや言語の問い合わせは非公開リポジトリも読む。
// 読めない項目のエラーの文には、そのリポジトリや組織の名前が入ることがあるので、公開リポジトリの実行結果に出さない。
test('読めない項目のエラーは、GitHub の文を出さずに、エラーの種類と項目だけを示す', async (t) => {
  const errors = [
    { type: 'NOT_FOUND', path: ['user', 'repositories', 'nodes', 3], message: "Could not resolve to a Repository with the name 'octocat/secret-plan'." },
    { type: 'FORBIDDEN', path: ['user', 'repositories'], message: 'The `secret-org` organization has enabled OAuth App access restrictions.' },
    { type: 'INSUFFICIENT_SCOPES', message: "Your token has not been granted the required scopes for 'secret-field'." },
    { type: 'INTERNAL', message: 'boom' },
  ];
  stubApi(t, { stars: { data: null, errors } });
  const expected = 'NOT_FOUND (user.repositories.nodes.3); FORBIDDEN (user.repositories); INSUFFICIENT_SCOPES; boom';
  // GitHub の文の代わりに、既定のトークンに戻す直し方を添える。
  await assert.rejects(fetchAccount('octocat', 'token'), (error) => {
    assert.equal(
      error.message,
      `GitHub API がエラーを返しました: ${expected}。自分で作ったトークンを渡しているときは、ワークフローの github-token の行を消して、既定のトークンに戻してください\n` +
        `GitHub API returned an error: ${expected}. If you're passing your own token, remove the github-token line from the workflow to go back to the default token`,
    );
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});

test('読めない項目のエラーの直し方は、読んだトークンの入力の名前で伝える', async (t) => {
  stubApi(t, { years: forbidden });
  await assert.rejects(
    fetchAccount('octocat', 'personal', { contributionsToken: 'workflow' }),
    /\(contributions-token で読んだとき\): FORBIDDEN \(user\)。.*ワークフローの contributions-token の行を消して[^]*remove the contributions-token line from/,
  );
});

test('読めない項目のエラーの文にタイムアウトと書いてあっても、やり直さない', async (t) => {
  const errors = [{ type: 'NOT_FOUND', path: ['user'], message: "Could not resolve to a Repository with the name 'octocat/timeout'." }];
  stubApi(t, { stars: { data: null, errors } });
  await assert.rejects(fetchAccount('octocat', 'token'), /NOT_FOUND \(user\)/);
  assert.equal(retryTimer.wait.mock.calls.length, 0);
});

// 2 つは別の問い合わせで読むので、そのあいだに contributions が増えると、全期間の合計のほうが少なくなることがある。
test('Total contributions は、Contrib (1yr) より少なくしない', async (t) => {
  const calendar = { ...profileCalendar, totalContributions: 9 };
  stubApi(t, { profile: { data: { user: { contributionsCollection: { contributionYears: [2026, 2025], contributionCalendar: calendar } } } } });
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.yearContributions, 9);
  assert.equal(account.totalContributions, 9);
});

test('コントリビューションのグラフの最後の日を、コントリビューションのグラフの日付での今日にする', async (t) => {
  stubApi(t);
  assert.equal((await fetchAccount('octocat', 'token')).today, '2026-11-08');
});

test('コントリビューションのグラフの日付が読めなければ、間違った日付で数えずに止まる', async (t) => {
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

// プロフィールのコントリビューションのグラフに「N contributions in the last year」と出る数と同じ。
test('Contrib (1yr) は、範囲を指定しない contributionsCollection の、過去 1 年の合計をそのまま使う', async (t) => {
  stubApi(t);
  const account = await fetchAccount('octocat', 'token');
  assert.equal(account.yearContributions, 6);
  const profile = graphqlCalls().map(({ query }) => query).find((query) => query.includes('contributionYears'));
  assert.match(profile, /contributionsCollection \{/);
  assert.match(profile, /totalContributions/);
});

test('コミットの数は数えない', async (t) => {
  stubApi(t);
  await fetchAccount('octocat', 'token');
  for (const { query } of graphqlCalls()) assert.doesNotMatch(query, /Commit/);
});

// 問い合わせごとの、クエリと送ったトークン。
const sentTokens = () => globalThis.fetch.mock.calls.map((call) => ({
  query: JSON.parse(call.arguments[1].body).query,
  authorization: call.arguments[1].headers.authorization,
}));

// 非公開リポジトリを読めるトークンでは、コントリビューションの数がグラフより少なくなることがあったので、別のトークンで読めるようにしている。
test('コントリビューションの数だけを contributionsToken で読み、リポジトリの数などは token で読む', async (t) => {
  stubApi(t);
  await fetchAccount('octocat', 'personal', { contributionsToken: 'workflow' });
  const sent = sentTokens();
  assert.ok(sent.some(({ query }) => query.includes('contributionYears')));
  assert.ok(sent.some(({ query }) => query.includes('contributionsCollection(from:')));
  assert.ok(sent.some(({ query }) => query.includes('stargazerCount')));
  for (const { query, authorization } of sent) {
    assert.equal(authorization, `bearer ${readsContributions(query) ? 'workflow' : 'personal'}`, query);
  }
});

test('contributionsToken を渡さなければ、すべて token で読む', async (t) => {
  stubApi(t);
  await fetchAccount('octocat', 'token');
  for (const { authorization } of sentTokens()) assert.equal(authorization, 'bearer token');
});

const waits = () => retryTimer.wait.mock.calls.map((call) => call.arguments[0]);
const connectionReset = () => Object.assign(new TypeError('fetch failed'), { cause: new Error('read ECONNRESET') });

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

// トークンは 2 つあるので、断られたほうの入力の名前で伝える。
test('contributionsToken が無効なら、contributions-token を直すよう伝える', async (t) => {
  stubApi(t, { failures: [401] });
  await assert.rejects(
    fetchAccount('octocat', 'personal', { contributionsToken: 'workflow' }),
    /Error: contributions-token のトークンが使えません \(401\).*contributions-token の行を消して[^]*The contributions-token can't be used/,
  );
  assert.equal(waits().length, 0);
});

test('contributionsToken は読めて token が無効なら、github-token を直すよう伝える', async (t) => {
  const unauthorized = () => Response.json({ message: 'Bad credentials' }, { status: 401 });
  stubApi(t, { stars: unauthorized, languages: unauthorized, pullRequests: unauthorized, issues: unauthorized });
  await assert.rejects(fetchAccount('octocat', 'personal', { contributionsToken: 'workflow' }), /Error: github-token のトークンが使えません \(401\)/);
});

test('2 つの入力に同じトークンを渡していて無効なら、どちらの入力も直すよう伝える', async (t) => {
  stubApi(t, { failures: [401] });
  await assert.rejects(
    fetchAccount('octocat', 'personal', { contributionsToken: 'personal' }),
    /Error: github-token と contributions-token のトークンが使えません \(401\).*github-token と contributions-token の行を消して[^]*remove the github-token and contributions-token lines/,
  );
});

// 401 のほかのエラーも、2 つの入力のトークンが違えば、どちらを直せばよいか分かるようにする。
test('2 つのトークンが違えば、401 のほかのエラーにも、どちらのトークンで読んだときかを添える', async (t) => {
  stubApi(t, { years: () => Response.json({ message: 'denied' }, { status: 403 }) });
  const expected = 'GitHub API が 403 を返しました (contributions-token で読んだとき): denied\n' +
    'GitHub API returned 403 (while reading with contributions-token): denied';
  await assert.rejects(fetchAccount('octocat', 'personal', { contributionsToken: 'workflow' }), (error) => error.message === expected);
});

test('2 つのトークンが違えば、GraphQL のエラーにも、どちらのトークンで読んだときかを添える', async (t) => {
  stubApi(t, { stars: { data: null, errors: [{ type: 'INTERNAL', message: 'boom' }] } });
  const expected = 'GitHub API がエラーを返しました (github-token で読んだとき): boom\n' +
    'GitHub API returned an error (while reading with github-token): boom';
  await assert.rejects(fetchAccount('octocat', 'personal', { contributionsToken: 'workflow' }), (error) => error.message === expected);
});

// 回数の上限はトークンごとに数えるので、どちらのトークンの上限かが分かるようにする。
test('2 つのトークンが違えば、回数の上限にも、どちらのトークンで読んだときかを添える', async (t) => {
  const reset = String(Math.floor(Date.now() / 1000) + 3600);
  const limited = () => Response.json({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } });
  stubApi(t, { stars: limited });
  const expected = 'GitHub API の回数の上限に達しました (403、github-token で読んだとき)。上限が戻れば、次の実行で更新されます\n' +
    'Reached the GitHub API rate limit (403, while reading with github-token). The cards will be updated on a later run after the limit resets';
  await assert.rejects(fetchAccount('octocat', 'personal', { contributionsToken: 'workflow' }), (error) => error.message === expected);
});

test('2 つのトークンが違えば、GraphQL の回数の上限にも、どちらのトークンで読んだときかを添える', async (t) => {
  const reset = String(Math.floor(Date.now() / 1000) + 3600);
  const limited = () => Response.json(
    { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] },
    { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } },
  );
  stubApi(t, { years: limited });
  await assert.rejects(
    fetchAccount('octocat', 'personal', { contributionsToken: 'workflow' }),
    /回数の上限に達しました \(API rate limit exceeded、contributions-token で読んだとき\)[^]*\(API rate limit exceeded, while reading with contributions-token\)/,
  );
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
