// GitHub GraphQL API からアカウント全体のデータを取る。
import { setTimeout as delay } from 'node:timers/promises';
import { bilingual } from './messages.mjs';
import { addDays } from './stats.mjs';

const ENDPOINT = 'https://api.github.com/graphql';
const YEARS_PER_REQUEST = 5;
// GitHub は重いクエリにときどき 502 やタイムアウトを返すので、一時的な失敗は間をあけてやり直す。
export const RETRY_DELAYS_MS = [3000, 10000];
const TIMEOUT_MS = 30000;
// 回数の上限に当たったとき、待つ時間が示されていなければ 1 分待つ (GitHub の案内どおり)。
// これより長く待つ必要があるときはやり直さず、その日の更新はあきらめる。
export const RATE_LIMIT_WAIT_MS = 60000;

// テストで待ち時間を飛ばせるよう、待つ処理をオブジェクトに入れておく。
export const retryTimer = { wait: (ms) => delay(ms) };

// 既定のトークンでは起きない。自分で作ったトークン (サポート外) を渡したときに、期限切れなどで起きる。
const UNAUTHORIZED_MESSAGE = bilingual(
  'github-token のトークンが使えません (401)。有効期限が切れているか、取り消されています。' +
    '自分で作ったトークンを渡しているときは、ワークフローの github-token の行を消して、既定のトークンに戻してください',
  "The github-token can't be used (401). It has expired or been revoked. " +
    "If you're passing your own token, remove the github-token line from the workflow to go back to the default token",
);
const rateLimitMessage = (reason) =>
  bilingual(
    `GitHub API の回数の上限に達しました (${reason})。上限が戻れば、次の実行で更新されます`,
    `Reached the GitHub API rate limit (${reason}). The cards will be updated on a later run after the limit resets`,
  );

const headers = (token) => ({
  authorization: `bearer ${token}`,
  'user-agent': 'tiny-pixel-room',
});

// やり直してよい失敗には、最低限待つ時間 (retryAfterMs) を付ける。
const failure = (message, fields = {}) => Object.assign(new Error(message), fields);

const UNREADABLE_RESPONSE = bilingual('GitHub API の応答を読めませんでした', "Couldn't read the GitHub API response");

// GitHub が理由を返していれば、状態コードと一緒に出す。
// 組織の SSO でトークンの承認が要るときなど、403 だけでは何を直せばよいか分からない。
function httpError(status, body, fields = {}) {
  const reason = body?.message ? `: ${body.message}` : '';
  return failure(bilingual(`GitHub API が ${status} を返しました${reason}`, `GitHub API returned ${status}${reason}`), { status, ...fields });
}

// 見つからないユーザーは、user が null の応答に NOT_FOUND のエラーが付いて返る。
// username の既定はリポジトリの持ち主なので、組織のリポジトリで動かしたときも、組織の名前でこうなる。
const userNotFound = (login) =>
  bilingual(
    `GitHub のユーザー ${login} が見つかりません。username には GitHub のユーザー名を書いてください (組織の名前は使えません)`,
    `GitHub user ${login} was not found. Set username to a GitHub username (organization names can't be used)`,
  );

async function withRetry(attempt) {
  for (let i = 0; ; i += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (error.retryAfterMs === undefined || i === RETRY_DELAYS_MS.length) throw error;
      await retryTimer.wait(Math.max(error.retryAfterMs, RETRY_DELAYS_MS[i]));
    }
  }
}

// 1 回分の通信。本文を読み終えるまでをタイムアウトに含める。
async function send(url, init) {
  let response;
  let text;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    text = await response.text();
  } catch (error) {
    const seconds = TIMEOUT_MS / 1000;
    const reason = error.cause?.message ?? error.message;
    const message = error.name === 'TimeoutError'
      ? bilingual(`GitHub API から ${seconds} 秒以内に応答がありませんでした`, `The GitHub API didn't respond within ${seconds} seconds`)
      : bilingual(`GitHub API に接続できませんでした: ${reason}`, `Couldn't connect to the GitHub API: ${reason}`);
    throw failure(message, { retryAfterMs: 0 });
  }
  const { status, ok } = response;
  if (status === 401) throw failure(UNAUTHORIZED_MESSAGE, { status });
  if (status >= 500) throw httpError(status, null, { retryAfterMs: 0 });
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    if (ok) throw failure(UNREADABLE_RESPONSE, { retryAfterMs: 0 });
  }
  return { status, ok, headers: response.headers, body };
}

// 回数の上限は、429 か、待つ時間などが付いた 403 で返る。
function isRateLimited({ status, headers, body }) {
  if (status === 429) return true;
  return status === 403 &&
    (headers.has('retry-after') || headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(body?.message ?? ''));
}

// GitHub が示す時間だけ待つ。長く待つ必要があれば、やり直さない (undefined を返す)。
function rateLimitWait(headers) {
  let ms = RATE_LIMIT_WAIT_MS;
  if (headers.has('retry-after')) ms = Number(headers.get('retry-after')) * 1000;
  else if (headers.get('x-ratelimit-remaining') === '0') ms = Number(headers.get('x-ratelimit-reset')) * 1000 - Date.now();
  return ms <= RATE_LIMIT_WAIT_MS ? Math.max(ms, 0) : undefined;
}

// 回数の上限に当たった失敗。待つ時間が短ければ、やり直す。
const rateLimitFailure = (reason, headers, fields = {}) =>
  failure(rateLimitMessage(reason), { ...fields, retryAfterMs: rateLimitWait(headers) });

// 読めない項目の理由。権限がない (組織の SSO でトークンが承認されていないなど)、見つからない (問い合わせのあいだに消された)、
// トークンの権限が足りない。
const isForbidden = (error) => error.type === 'FORBIDDEN' || /not accessible/i.test(error.message);
const isUnreadable = (error) => isForbidden(error) || error.type === 'NOT_FOUND' || error.type === 'INSUFFICIENT_SCOPES';

// 1 回分の通信を、一時的な失敗や回数の上限ならやり直して送る。回数の上限でない応答は read に渡し、その戻り値を返す。
function call(url, init, read) {
  return withRetry(async () => {
    const response = await send(url, init);
    if (isRateLimited(response)) throw rateLimitFailure(response.status, response.headers, { status: response.status });
    return read(response);
  });
}

// 1 回分の問い合わせ。{ data, unreadable } を返す。
// partial なら、エラーがどれも読めない項目のものだけのとき、エラーにせずに返す (unreadable が true)。
// 読めない項目は null になっていて、応答の全体が読めなければ data は空のオブジェクト。
// 呼ぶ側は unreadable で、null が読めないからなのか、ほんとうにないからなのかを分ける。
// 読めない項目のエラーの文には、読めなかった非公開リポジトリの名前が入ることがある。
// 公開リポジトリの実行結果にも出ないよう、ほかのエラーで止まるときも、その文は出さない。
function request(token, query, variables, partial) {
  const init = {
    method: 'POST',
    headers: { ...headers(token), 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  };
  return call(ENDPOINT, init, (response) => {
    const { status, ok, body } = response;
    if (!ok) throw httpError(status, body);
    const errors = body?.errors ?? [];
    // data も errors もない応答は、途中で切れた応答と同じく、読み直す。
    if (body?.data == null && errors.length === 0) throw failure(UNREADABLE_RESPONSE, { retryAfterMs: 0 });
    if (errors.length === 0) return { data: body.data, unreadable: false };
    const shown = partial ? errors.filter((e) => !isUnreadable(e)) : errors;
    const message = shown.map((e) => e.message).join('; ');
    if (errors.some((e) => e.type === 'RATE_LIMITED')) throw rateLimitFailure(message, response.headers);
    if (shown.length === 0) return { data: body.data ?? {}, unreadable: true };
    // 重いクエリは、200 のまま「Something went wrong ... timeout」というエラーになることがある。
    // 読めない項目のエラーは、文にリポジトリの名前などが入り、タイムアウトでもないので見ない。
    const timedOut = errors.some((e) => !isUnreadable(e) && /something went wrong|timeout|timed out/i.test(e.message));
    throw failure(bilingual(`GitHub API がエラーを返しました: ${message}`, `GitHub API returned an error: ${message}`), {
      forbidden: errors.every(isForbidden),
      notFound: errors.every((e) => e.type === 'NOT_FOUND'),
      retryAfterMs: timedOut ? 0 : undefined,
    });
  });
}

const graphql = async (token, query, variables) => (await request(token, query, variables, false)).data;
// 読めない項目があっても止めずに、{ data, unreadable } を返す。非公開リポジトリを読むときに使う。
const graphqlPartial = (token, query, variables) => request(token, query, variables, true);

// REST API の GET。見つからないか読めない (回数の上限ではない 403) ときは null を返す。
function restGet(token, path) {
  const init = { headers: { ...headers(token), accept: 'application/vnd.github+json' } };
  return call(`https://api.github.com${path}`, init, ({ status, ok, body }) => {
    if (status === 403 || status === 404) return null;
    if (!ok) throw httpError(status, body);
    return body;
  });
}

// 範囲を指定しない contributionsCollection の草は、草と同じ地域の今日で終わる。
// 草の日付の区切りはトークンで変わる (既定のトークンなら UTC、本人のトークンなら本人の地域) ので、今日もここから決める。
// コミットの数も、github-readme-stats と同じく、この範囲 (草の期間。およそ過去 1 年) で数える。
// restrictedContributionsCount は種類の分からない非公開の活動の数で、Private contributions がオンのときだけ 0 より大きい。
const PROFILE_QUERY = `query ($login: String!) {
  user(login: $login) {
    id
    contributionsCollection {
      contributionYears
      totalCommitContributions
      restrictedContributionsCount
      contributionCalendar { weeks { contributionDays { date } } }
    }
  }
}`;

function lastDate(calendar) {
  const lastWeek = calendar.weeks.at(-1)?.contributionDays ?? [];
  return lastWeek.at(-1)?.date;
}

// 日のない週は飛ばす。lastDate が読めていれば日のある週があるので、必ず決まる。
const firstDate = (calendar) => calendar.weeks.find((week) => week.contributionDays.length > 0)?.contributionDays[0].date;

// 1 つのクエリにまとめると、片方の権限エラーで user ごと null になるので分けて取る。
const countQuery = (field) => `query ($login: String!) { user(login: $login) { ${field} { totalCount } } }`;

// スターと言語は、github-readme-stats と同じ範囲のリポジトリで数える。
// スター、リポジトリの数、言語のどれも privacy は指定しない。トークンで読める非公開リポジトリも数える。

// スターとリポジトリの数は、フォークも含めた自分のリポジトリで数える。スターの多い順に取る。
// プロフィールの Repositories は見る人で数が変わる (本人には非公開リポジトリも数える) ので、それとは合わせない。
// 既定のトークンでも、ワークフローを動かしている非公開リポジトリは読めるので、そのリポジトリは数に入る。
const OWNED_QUERY = `query ($login: String!, $after: String) {
  user(login: $login) {
    repositories(first: 100, after: $after, ownerAffiliations: OWNER, orderBy: { field: STARGAZERS, direction: DESC }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { stargazerCount }
    }
  }
}`;

// 言語は、フォークを除いた自分のリポジトリで数える。
// github-readme-stats は先頭 100 件までしか見ないが、ここでは次のページも取ってすべて数える。
const LANGUAGES_QUERY = `query ($login: String!, $after: String) {
  user(login: $login) {
    repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false) {
      pageInfo { hasNextPage endCursor }
      nodes {
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name } }
        }
      }
    }
  }
}`;

// 非公開リポジトリのコミットは、contributionsCollection ではどのトークンでも種類の分からない活動の合計になり、
// totalCommitContributions に入らない。そこで、トークンで読める非公開リポジトリの履歴から、
// GitHub がコントリビューションに数えるのと同じ決まりで、本人のコミットを直接数える (fetchPrivateCommits)。
// Private contributions がオフの人は非公開の活動を見せないと決めているので、数えない (fetchAccount)。
// トークンの持ち主が本人でないときも数えない。ほかの人のカードに、トークンの持ち主が読めるリポジトリから数えた、
// その人の非公開のコミットの数を出さないため。既定のトークンも本人のトークンではないので、数えない。

// 一覧の 1 ページのリポジトリの数。リポジトリごとに、ブランチのコミットの数も取るので、1 回で多く取ると GitHub がタイムアウトする
// (大きな組織の、最近 push されたリポジトリ 100 件では 502 になり、25 件なら 2 秒ほどで返った)。
const PRIVATE_REPOSITORIES_PER_PAGE = 25;

// ブランチにある、since より後に commit されたコミットの数。読む量を、読む前に見積もるのに使う。
const COMMIT_COUNT = 'target { ... on Commit { history(since: $since) { totalCount } } }';

// トークンの持ち主 (viewer) と、GitHub がもうコミットを数えているリポジトリ。一覧を読む前に 1 回だけ取る。
// commitContributionsByRepository の repository は null にならない項目なので、どれか 1 つが読めない (組織の SSO など) だけで、
// null が user まで広がる。一覧と一緒に取ると一覧まで読めなくなるので、分けて取る。
const VIEWER_QUERY = `query ($login: String!) {
  viewer { id }
  user(login: $login) {
    contributionsCollection { commitContributionsByRepository(maxRepositories: 100) { repository { id } } }
  }
}`;

// トークンで読める非公開リポジトリを、最後に push された順に取る。組織のリポジトリも入れる。
// コントリビューションと同じく、フォークは数えない (フォークの履歴には、元のリポジトリのコミットも入っている)。
// gh-pages ブランチがなければ ghPages は null。
const PRIVATE_REPOSITORIES_QUERY = `query ($login: String!, $after: String, $since: GitTimestamp!) {
  user(login: $login) {
    repositories(first: ${PRIVATE_REPOSITORIES_PER_PAGE}, after: $after, privacy: PRIVATE, isFork: false, ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: { field: PUSHED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id pushedAt owner { login } name
        defaultBranchRef { name ${COMMIT_COUNT} }
        ghPages: ref(qualifiedName: "refs/heads/gh-pages") { ${COMMIT_COUNT} }
      }
    }
  }
}`;

// 1 つのブランチの、since より後に commit された履歴。authors は git の author と、Co-authored-by に名前がある人。
// $all なら、Co-authored-by に名前があるだけのコミットも数えるので、だれのコミットも読む ($author は null)。
// そうでなければ、$author のユーザーが author のコミットだけを読む (ユーザーのメールアドレスで、GitHub が絞る)。
// committer と authors は、だれのコミットも読むときにしか使わないので、そのときだけ取る。
const HISTORY_QUERY = `query ($owner: String!, $name: String!, $ref: String!, $since: GitTimestamp!, $all: Boolean!, $author: CommitAuthor, $after: String) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) {
      target {
        ... on Commit {
          history(first: 100, after: $after, since: $since, author: $author) {
            pageInfo { hasNextPage endCursor }
            nodes {
              oid
              author { date }
              committer @include(if: $all) { user { id } }
              authors(first: 100) @include(if: $all) { nodes { user { id } } }
            }
          }
        }
      }
    }
  }
}`;

const CALENDAR_FIELDS = `contributionCalendar {
          totalContributions
          weeks { contributionDays { date contributionCount } }
        }`;

// contributionsCollection は 1 回で 1 年分までなので、年ごとに分けて取る。
// 範囲の日付は from と to の日付部分で決まり、その日の分がまるごと入るので、年どうしで日は重ならない。
function yearsQuery(years, fields) {
  const collections = years
    .map((year) => `y${year}: contributionsCollection(from: "${year}-01-01T00:00:00Z", to: "${year}-12-31T23:59:59Z") {
        ${fields}
      }`)
    .join('\n');
  return `query ($login: String!) { user(login: $login) { ${collections} } }`;
}

async function fetchByYear(login, token, years, fields) {
  const batches = [];
  for (let i = 0; i < years.length; i += YEARS_PER_REQUEST) batches.push(years.slice(i, i + YEARS_PER_REQUEST));
  const results = await Promise.all(batches.map((batch) => graphql(token, yearsQuery(batch, fields), { login })));
  return results.flatMap((data, i) => batches[i].map((year) => data.user[`y${year}`]));
}

// トークンの権限が足りない項目は不明 (null) にして、カードの作成は続ける。
async function fetchCount(field, login, token) {
  try {
    const data = await graphql(token, countQuery(field), { login });
    return data.user[field].totalCount;
  } catch (error) {
    if (error.forbidden) return null;
    throw error;
  }
}

async function fetchContributions(login, token, years) {
  const collections = await fetchByYear(login, token, years, CALENDAR_FIELDS);
  const days = collections.flatMap((collection) =>
    collection.contributionCalendar.weeks.flatMap((week) =>
      week.contributionDays.map((day) => ({ date: day.date, count: day.contributionCount })),
    ),
  );
  const totalContributions = collections.reduce((sum, c) => sum + c.contributionCalendar.totalContributions, 0);
  return { days, totalContributions };
}

// カーソルでページを順に取る。fetchPage は、カーソル (1 ページ目は null) を受け取って、ページ (pageInfo と nodes) を返す。
// for await を途中で抜ければ、次のページは取らない。fetchPage が null (読めないページ) を返したら、そこで終わる。
async function* pages(fetchPage) {
  let after = null;
  do {
    const page = await fetchPage(after);
    yield page;
    after = page?.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
}

// 自分のリポジトリの一覧のページ。
const userRepositories = (token, query, login) => async (after) => (await graphql(token, query, { login, after })).user.repositories;

// 自分のリポジトリのスターの合計と、リポジトリの数。リポジトリの数は 1 ページ目で分かる。
async function fetchOwned(login, token) {
  let stars = 0;
  let totalRepositories;
  for await (const page of pages(userRepositories(token, OWNED_QUERY, login))) {
    totalRepositories ??= page.totalCount;
    const counts = page.nodes.map((node) => node.stargazerCount);
    stars += counts.reduce((sum, count) => sum + count, 0);
    // スターの多い順なので、0 のリポジトリが出たら残りもすべて 0。次のページは取らない。
    if (counts.includes(0)) break;
  }
  return { stars, totalRepositories };
}

// リポジトリごとの言語とバイト数。
async function fetchLanguages(login, token) {
  const repositories = [];
  for await (const page of pages(userRepositories(token, LANGUAGES_QUERY, login))) {
    for (const node of page.nodes) {
      repositories.push({ languages: node.languages.edges.map((edge) => ({ name: edge.node.name, size: edge.size })) });
    }
  }
  return repositories;
}

// 非公開リポジトリのコミットを数えるときに、同時に読むリポジトリの数。
const REPOSITORY_CONCURRENCY = 4;
// 非公開リポジトリのコミットを数えるのに送る問い合わせ (一覧と履歴のページ) の数の、見積もりの上限。
// だれのコミットも読むと、読む量はリポジトリの大きさで決まる。大きな組織のリポジトリが読めるトークンでも、
// 回数の上限やタイムアウトで毎回数えきれないことがないよう、見積もりがこれを超えるなら、本人が author のコミットだけを読む。
// それでも超えるなら、非公開リポジトリは読まない。
export const MAX_PRIVATE_REQUESTS = 200;
// 非公開リポジトリの読み方。重い順に、だれのコミットも読む (all)、本人が author のコミットだけを読む (authored)、読まない (none)。
// 見積もりにはほかの人のコミットも入るので、上限の近くでは、ほかの人の活動で読み方が実行ごとに変わり、数も増えたり減ったりしうる。
// そうならないよう、前の実行の読み方を state.json に残しておき、前より重い読み方には、見積もりが上限の 8 割まで下がったときだけ戻す。
const READINGS = ['all', 'authored', 'none'];
export const HEAVIER_READING_REQUESTS = MAX_PRIVATE_REQUESTS * 0.8;
const readingLimit = (reading, previous) =>
  READINGS.indexOf(reading) < READINGS.indexOf(previous) ? HEAVIER_READING_REQUESTS : MAX_PRIVATE_REQUESTS;

// 読むブランチ。コントリビューションと同じく、既定のブランチと、Pages のサイトがあるリポジトリの gh-pages ブランチ。
// commits は一覧で分かった、since より後に commit されたコミットの数で、読めなければ undefined。コミットのないブランチは読まない。
// site があるブランチ (gh-pages) は、Pages のサイトがあるかを確かめてから読む。
function branchesOf(repository) {
  const { defaultBranchRef: main, ghPages } = repository;
  const branches = [];
  if (main) branches.push({ ref: `refs/heads/${main.name}`, commits: main.target?.history?.totalCount });
  if (ghPages && main?.name !== 'gh-pages') {
    branches.push({ ref: 'refs/heads/gh-pages', commits: ghPages.target?.history?.totalCount, site: true });
  }
  return branches.filter((branch) => branch.commits !== 0);
}

// 一覧の 1 つのリポジトリと、読むブランチと、ブランチを読む問い合わせの数の、読み方ごとの見積もり (requests)。
// all は、だれのコミットも読むとき (コミット 100 件で 1 回)。authored は、本人が author のコミットだけを読むとき (ブランチごとに 1 回)。
// 本人のコミットが 100 件を超えるブランチはそのぶん多く読むが、本人のコミットは非公開の活動の数より少ないので、大きくは増えない。
// コミットの数が読めないブランチは 1 回にする (読めば、読めないリポジトリとして除かれる)。
// gh-pages ブランチは、Pages のサイトがあるかを確かめる前なので、あるものとして見積もる。
function listed(repository) {
  const branches = branchesOf(repository);
  const all = branches.reduce((sum, { commits }) => sum + Math.max(1, Math.ceil((commits ?? 0) / 100)), 0);
  return { repository, branches, requests: { all, authored: branches.length } };
}

// Pages のサイトがあるか。GraphQL API では分からないので、REST API で読む。リポジトリが読めなければ null。
async function hasPagesSite(token, { owner: { login: owner }, name }) {
  const repository = await restGet(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  return repository === null ? null : repository.has_pages === true;
}

// items を REPOSITORY_CONCURRENCY 件まで並べて処理する。fn には、やめてよいかを返す stopped も渡す。
// 1 つでも失敗するか、done が true を返したら、まだ始めていないものは始めない。
// 途中のものも stopped を見て、残りのページを取らずにやめる。
async function forEachConcurrently(items, done, fn) {
  const queue = [...items];
  let failed = false;
  const stopped = () => failed || done();
  const worker = async () => {
    while (!stopped() && queue.length > 0) {
      try {
        await fn(queue.shift(), stopped);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: REPOSITORY_CONCURRENCY }, worker));
}

// 数えているあいだに読めるものが変わったとき。途中までの数は出さない。
const changedWhileCounting = (ja, en) => failure(bilingual(ja, en));

// 読めない項目のせいで null になったコミット。本人のコミットかどうか分からず、除くと少なく数えるので、数えきれなかったことにする。
const UNREADABLE_COMMITS = bilingual('非公開リポジトリのコミットの一部が読めませんでした', "Some commits in a private repository couldn't be read");

// since より後に push された、トークンで読める非公開リポジトリ (listed) と、一覧を読むのに送った問い合わせの数。
// counted (GitHub がもうコミットを数えているリポジトリ) は入れない。
// 本人が author のコミットだけを読む見積もりが budget を超えたら、もう読まないと決まるので、残りのページは取らずに、そこまでを返す。
// 読み方は、返したリポジトリから呼ぶ側で決める。トークンで一覧が読めなければ null。
async function activePrivateRepositories(token, { login, since, counted, budget }) {
  const repositories = new Map();
  let requests = 0;
  let authored = 0;
  let readable = true;
  const overBudget = () => requests + authored > budget;
  const fetchPage = async (after) => {
    requests += 1;
    const { data } = await graphqlPartial(token, PRIVATE_REPOSITORIES_QUERY, { login, since, after });
    const page = data.user?.repositories;
    if (page?.nodes) return page;
    // 最初のページから読めないのは、トークンで一覧が読めないとき。いつ動かしても同じなので、数えない。
    if (requests === 1) {
      readable = false;
      return null;
    }
    throw changedWhileCounting(
      '非公開リポジトリの一覧が、途中から読めなくなりました',
      'The list of private repositories became unreadable partway through',
    );
  };
  // 1 ページ目から maxPages ページまで読み、まだ入れていないリポジトリを足す。
  // push された順なので、since より前に push されたものが出たら、残りのページは取らない。
  const readActive = async (maxPages) => {
    let read = 0;
    for await (const page of pages(fetchPage)) {
      if (!page) return;
      read += 1;
      const old = page.nodes.findIndex((repository) => repository?.pushedAt && Date.parse(repository.pushedAt) < Date.parse(since));
      for (const repository of old === -1 ? page.nodes : page.nodes.slice(0, old)) {
        if (!repository?.pushedAt || repositories.has(repository.id) || counted.has(repository.id)) continue;
        const entry = listed(repository);
        repositories.set(repository.id, entry);
        authored += entry.requests.authored;
      }
      if (old !== -1 || overBudget() || read === maxPages) return;
    }
  };
  await readActive(Infinity);
  if (!readable) return null;
  // 一覧は最後に push された順なので、読んでいるあいだに push されたリポジトリは、読み終えたページの前に移って読めない。
  // 2 ページ以上読んだときは 1 ページ目を読み直して、そうしたリポジトリも入れる。もう読まないと決まったときは読み直さない。
  if (requests > 1 && !overBudget()) await readActive(1);
  return { repositories: [...repositories.values()], requests };
}

// 1 つのリポジトリ (listed) の、読むブランチにある、since より後に commit されたコミットを、ページごとに onCommits に渡す。
// author があれば、そのユーザーが author のコミットだけを読む。なければ、だれのコミットも読む。
// 読めるかどうかは、最初の履歴のページで決める。それまでに履歴か Pages のサイトが読めなければ、何も渡さずに終わり、
// そのリポジトリは数えない。そのあとで読めなくなったり、ブランチが消されたりしたら、数えているあいだに変わったので失敗する。
// 読めた分を引くと、ほかのリポジトリを読むのをやめたあとで数が減り、実行ごとに数が変わることがあるため。
// stopped が true になったら、残りのページもブランチも読まない。
async function readRepository(token, { repository, branches }, { since, author }, stopped, onCommits) {
  const { owner: { login: owner }, name } = repository;
  let first = true;
  const changed = () => changedWhileCounting(
    '非公開リポジトリのコミットを数えているあいだに、リポジトリかブランチが消されたか、名前が変わったか、読めなくなりました',
    'A private repository or branch was deleted, renamed or became unreadable while counting commits',
  );
  for (const { ref, site } of branches) {
    if (stopped()) return;
    if (site) {
      const hasSite = await hasPagesSite(token, repository);
      if (hasSite === null) {
        if (first) return;
        throw changed();
      }
      if (!hasSite) continue;
      if (stopped()) return;
    }
    const fetchPage = async (after) => {
      const variables = { owner, name, ref, since, all: !author, author, after };
      const { data, unreadable } = await graphqlPartial(token, HISTORY_QUERY, variables);
      const history = data.repository?.ref?.target?.history;
      if (history?.nodes) return history;
      // 履歴が読めていなければ応答にコミットはないので、読めない項目のエラーは、このリポジトリかブランチか履歴のもの。
      // トークンの権限によっては、リポジトリは読めても、ブランチや履歴が読めない。
      if (first && (!data.repository || unreadable)) return null;
      throw changed();
    };
    for await (const history of pages(fetchPage)) {
      if (!history) return;
      first = false;
      if (history.nodes.includes(null)) throw failure(UNREADABLE_COMMITS);
      onCommits(history.nodes);
      if (stopped()) return;
    }
  }
}

// 非公開リポジトリのコミットを数えないとき。数えた結果がこれと同じなら、state.json にも残さない。
const NOT_COUNTED = { count: 0, reading: 'all' };

// トークンで読める非公開リポジトリにある、コントリビューションの期間 (firstDay から lastDay) の本人のコミットの数 (count) と、
// 読み方 (reading)。previous は前の実行の読み方。
// GitHub のドキュメント (Profile contributions reference) にある、コントリビューションに数える決まりで数える。
// - フォークではないリポジトリの、既定のブランチと、Pages のサイトがあるリポジトリの gh-pages ブランチのコミット
// - 本人が author か、Co-authored-by に名前があるか、rebase などで commit し直した人 (committer)。
//   ドキュメントに、rebase した人にもコントリビューションが付くとある
// - 日付は author date の、コミットを書いた地域の日付。ドキュメントに、author date を使い、コミットの時刻にある時差で数えるとある
//   (GitTimestamp は書いた地域の時差のまま返る)
// - リポジトリごとに数える。同じリポジトリのブランチにある同じコミットは 1 回だけ数え、
//   別のリポジトリ (公開リポジトリを写したものなど) にもあれば、そちらでも数える。
//   ドキュメントには書かれていないが、GitHub もリポジトリごとに数えると考えられる
//   (フォークを数えないのは、フォークにある元のリポジトリのコミットを、もう一度数えないため)
// 非公開のコミットは非公開の活動の数 (restricted) に入っているので、それより多くはしない。
// 数えた分が restricted に届いたら、残りのページもリポジトリも読まない。
// 読む量は、一覧に出るブランチのコミットの数から、読む前に見積もる。だれのコミットも読むと MAX_PRIVATE_REQUESTS を超えるなら、
// 本人が author のコミットだけを読む (Co-authored-by に名前があるだけのコミットと、commit し直しただけのコミットは数えない)。
// それでも超えるなら読まずに 0 にする。前の実行より重い読み方にするのは、見積もりが HEAVIER_READING_REQUESTS までのときだけ。
// トークンの持ち主が本人でないときと、トークンで一覧が読めないときも 0 にする。どれも実行ごとにはまず変わらないので、カードの数も変わらない。
// 数えきれないとき (やり直しても続くタイムアウトや回数の上限、数えているあいだに読めるものが変わったときなど) は失敗する。
// そのときは、呼ぶ側 (fetchAccount) で前の実行の数を使う。
async function fetchPrivateCommits(login, token, { id, firstDay, lastDay, restricted }, previous) {
  // 既定のトークンは GitHub App のトークン (ghs_ で始まる) で、本人のトークンではない。問い合わせずに数えない。
  if (token.startsWith('ghs_')) return NOT_COUNTED;
  // ほかのトークンでも、viewer が読めないか、本人ではないアカウントなら、一覧も読まずに数えない。
  const { data } = await graphqlPartial(token, VIEWER_QUERY, { login });
  if (data.viewer?.id !== id) return NOT_COUNTED;
  // もう数えているリポジトリが読めなければ、ないものとする。いまの GitHub は非公開リポジトリのコミットを数えないので、ふつうはない。
  const contributions = data.user?.contributionsCollection.commitContributionsByRepository ?? [];
  const counted = new Set(contributions.map((contribution) => contribution.repository.id));
  // committer date はふつう author date と同じかそれより後なので、初日より前に commit されたコミットは読まなくてよい。
  // author date は書いた地域の日付で数えるので、どの地域の初日も入るよう、前の日の UTC の 0 時から読む。
  const since = `${addDays(firstDay, -1)}T00:00:00Z`;
  const active = await activePrivateRepositories(token, { login, since, counted, budget: readingLimit('authored', previous) });
  if (!active) return NOT_COUNTED;
  const { repositories, requests } = active;
  const estimate = (reading) => requests + repositories.reduce((sum, entry) => sum + entry.requests[reading], 0);
  const reading = ['all', 'authored'].find((candidate) => estimate(candidate) <= readingLimit(candidate, previous)) ?? 'none';
  if (reading === 'none') return { count: 0, reading };
  const author = reading === 'all' ? null : { id };
  const isContribution = (commit) => {
    const day = commit.author?.date?.slice(0, 10);
    if (!day || day < firstDay || day > lastDay) return false;
    // author で絞って読んだコミットは、どれも本人が author のコミット。
    if (author) return true;
    // Co-authored-by の人が読めなければ、committer だけで決める。
    return commit.committer?.user?.id === id || (commit.authors?.nodes ?? []).some((person) => person?.user?.id === id);
  };

  // 読めたリポジトリで数えたコミットの数。読んでいる途中のリポジトリの分も入れる。
  // 読めるかどうかは最初のページで決まり、あとから引くことはないので、届いたところでやめても数は変わらない。
  // コミットはリポジトリごとに数えるので、リポジトリどうしでは重ならず、足すだけでよい。
  let total = 0;
  await forEachConcurrently(repositories, () => total >= restricted, async (entry, stopped) => {
    const found = new Set();
    await readRepository(token, entry, { since, author }, stopped, (commits) => {
      for (const commit of commits) {
        if (!isContribution(commit) || found.has(commit.oid)) continue;
        found.add(commit.oid);
        total += 1;
      }
    });
  });
  return { count: Math.min(total, restricted), reading };
}

// 前の実行の state.json に残した、非公開リポジトリのコミットの数と読み方。形が違えば、残していないものとする。
const isPrivateCommits = (value) =>
  Number.isSafeInteger(value?.count) && value.count >= 0 && READINGS.includes(value.reading);

const privateCommitsFallback = (recorded) =>
  recorded
    ? bilingual(
      '非公開リポジトリのコミットを数えきれなかったので、前の実行で数えた数を使います。次の実行で数え直します',
      "Couldn't count the commits in private repositories, so the count from the previous run is used. They will be counted again on the next run",
    )
    : bilingual(
      '非公開リポジトリのコミットを数えきれなかったので、今回は数えません。次の実行で数え直します',
      "Couldn't count the commits in private repositories, so they aren't counted this time. They will be counted again on the next run",
    );

// privateCommits は、前の実行が返した privateCommits (state.json に残したもの)。warn は、カードは作れるが知らせたいことを出す。
export async function fetchAccount(login, token, { privateCommits: recorded, warn = console.warn } = {}) {
  const profile = await graphql(token, PROFILE_QUERY, { login }).catch((error) => {
    if (error.notFound) return { user: null };
    throw error;
  });
  if (!profile.user) throw new Error(userNotFound(login));
  const collection = profile.user.contributionsCollection;
  const calendar = collection.contributionCalendar;
  const today = lastDate(calendar);
  if (!today) {
    throw new Error(bilingual('GitHub API の応答から今日の日付を読めませんでした', "Couldn't read today's date from the GitHub API response"));
  }

  // 非公開リポジトリのコミットは、Private contributions がオン (非公開の活動の数が 0 より大きい) のときだけ数える。
  // 数えきれないときは、前の実行の数を使う。0 や途中まで数えた数にすると実行ごとに数が増えたり減ったりし、
  // 止まると、1 つのリポジトリが読めつづけないだけで、カード全体がずっと更新されなくなるため。
  const restricted = collection.restrictedContributionsCount;
  const previous = isPrivateCommits(recorded) ? recorded : NOT_COUNTED;
  const countPrivateCommits = async () => {
    if (!(restricted > 0)) return NOT_COUNTED;
    const period = { id: profile.user.id, firstDay: firstDate(calendar), lastDay: today, restricted };
    try {
      return await fetchPrivateCommits(login, token, period, previous.reading);
    } catch (error) {
      warn(`${privateCommitsFallback(previous !== NOT_COUNTED)}\n${error.message}`);
      return { ...previous, count: Math.min(previous.count, restricted) };
    }
  };

  // 残りの問い合わせは互いに関係しないので、まとめて送る。
  const [contributions, privateCommits, owned, repositories, totalPullRequests, totalIssues] = await Promise.all([
    fetchContributions(login, token, collection.contributionYears),
    countPrivateCommits(),
    fetchOwned(login, token),
    fetchLanguages(login, token),
    fetchCount('pullRequests', login, token),
    fetchCount('issues', login, token),
  ]);
  const notCounted = privateCommits.count === NOT_COUNTED.count && privateCommits.reading === NOT_COUNTED.reading;
  return {
    login,
    // 草の日付での今日。連続記録とキャラクターの開始日は、この日付で数える。
    today,
    ...contributions,
    // コントリビューションの期間 (およそ過去 1 年) のコミットの数。公開リポジトリの分 (totalCommitContributions) に、
    // Private contributions がオンで、トークンの持ち主が本人なら、トークンで読める非公開リポジトリの分を、リポジトリごとに数えて足す。
    // 読めない非公開リポジトリの分は入らない。
    totalCommits: collection.totalCommitContributions + privateCommits.count,
    // state.json に残して、次の実行の fetchAccount に渡す、非公開リポジトリのコミットの数と読み方。
    // 数えないときと同じなら undefined で、残さない。
    privateCommits: notCounted ? undefined : privateCommits,
    // 言語を数えるリポジトリ (フォークを除いたすべて)。
    repositories,
    totalPullRequests,
    totalIssues,
    // スターの合計 (stars) と、自分のリポジトリの数 (totalRepositories)。
    ...owned,
  };
}
