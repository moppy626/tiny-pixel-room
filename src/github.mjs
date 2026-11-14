// GitHub GraphQL API からアカウント全体のデータを取る。
import { setTimeout as delay } from 'node:timers/promises';
import { bilingual } from './messages.mjs';
import { addDays, isDate } from './stats.mjs';

const ENDPOINT = 'https://api.github.com/graphql';
const YEARS_PER_REQUEST = 5;
// GitHub は重いクエリにときどき 502 やタイムアウトを返すので、一時的な失敗は間をあけてやり直す。
export const RETRY_DELAYS_MS = [3000, 10000];
const TIMEOUT_MS = 30000;
// 回数の上限に当たったとき、待つ時間が示されていなければ 1 分待つ (GitHub の案内どおり)。
// これより長く待つ必要があるときはやり直さず、その日の更新はあきらめる。
export const RATE_LIMIT_WAIT_MS = 60000;

// テストで待ち時間を飛ばせるよう、待つ処理をオブジェクトに入れておく。signal が中止されたら、待つのをやめる。
// now は、かかった時間を測るための時刻 (ミリ秒)。テストで時間を進められるよう、ここに入れておく。
export const retryTimer = { wait: (ms, signal) => delay(ms, undefined, { signal }), now: () => performance.now() };

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

// GitHub から思うように読めなかったときの失敗。コードのバグ (TypeError など) と分けるのに使う。
class FetchFailure extends Error {}

// やり直してよい失敗には、最低限待つ時間 (retryAfterMs) を付ける。
// GraphQL の問い合わせで、重いクエリを GitHub が返しきれなかったかもしれない失敗には、tooHeavy も付ける。
// 応答が来ずにタイムアウトしたとき、TOO_HEAVY_STATUSES の状態コードのとき、200 のままタイムアウトのエラーになったとき。
// ほかの 5xx も、やり直しても続いたら、重すぎたかもしれない失敗にする (tooHeavyIfRepeated を付けておき、withRetry で tooHeavy にする)。
// ページを小さくして読み直すか (readRepository)、軽い読み方なら数えられるかを決めるのに使う (fetchPrivateCommits)。
const failure = (message, fields = {}) => Object.assign(new FetchFailure(message), fields);

// 重いクエリで GitHub が返す状態コード。500 や 503 は、まず重さと関係のない一時的な失敗として、同じ問い合わせでやり直す。
// 一時的な失敗でページを小さくすると、そのブランチの残りのページも小さいまま読み、問い合わせが増えるため。
// やり直しても続くなら、重すぎて返しきれないのかもしれないので、そこで重すぎたかもしれない失敗にする。
// そうしないと、500 や 503 を返しつづけるリポジトリがあるとき、ページを小さくすることも、軽い読み方で数え直すこともできない。
const TOO_HEAVY_STATUSES = new Set([502, 504]);

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

// signal が中止されたら、やり直さずに、待っているところでもやめる。
// retryTooHeavy が false なら、重すぎたかもしれない失敗 (tooHeavy) は、同じ問い合わせではやり直さない。
// 呼ぶ側が、軽くした問い合わせで読み直すとき (readRepository)。同じ重さでは、やり直しても待つ時間がかかるだけになりやすいため。
// やり直しても続いた失敗に tooHeavyIfRepeated が付いていれば、重すぎたかもしれない失敗 (tooHeavy) にして投げる。
async function withRetry(attempt, signal, { retryTooHeavy = true } = {}) {
  for (let i = 0; ; i += 1) {
    signal?.throwIfAborted();
    try {
      return await attempt();
    } catch (error) {
      if (signal?.aborted) throw error;
      const retryable = error.retryAfterMs !== undefined && (retryTooHeavy || !error.tooHeavy);
      if (retryable && i < RETRY_DELAYS_MS.length) {
        await retryTimer.wait(Math.max(error.retryAfterMs, RETRY_DELAYS_MS[i]), signal);
        continue;
      }
      if (retryable && error.tooHeavyIfRepeated) error.tooHeavy = true;
      throw error;
    }
  }
}

// 1 回分の通信。本文を読み終えるまでをタイムアウトに含める。signal が中止されたら、応答を待たずにやめる。
// heavy なら、重すぎたかもしれない失敗に tooHeavy を付ける。GraphQL の問い合わせだけが使う。
async function send(url, init, signal, heavy) {
  let response;
  let text;
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    response = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    text = await response.text();
  } catch (error) {
    // 呼ぶ側が中止したときは、やり直す失敗にしない。
    if (signal?.aborted) throw signal.reason;
    const seconds = TIMEOUT_MS / 1000;
    const reason = error.cause?.message ?? error.message;
    const timedOut = error.name === 'TimeoutError';
    const message = timedOut
      ? bilingual(`GitHub API から ${seconds} 秒以内に応答がありませんでした`, `The GitHub API didn't respond within ${seconds} seconds`)
      : bilingual(`GitHub API に接続できませんでした: ${reason}`, `Couldn't connect to the GitHub API: ${reason}`);
    throw failure(message, { retryAfterMs: 0, tooHeavy: heavy && timedOut });
  }
  const { status, ok } = response;
  if (status === 401) throw failure(UNAUTHORIZED_MESSAGE, { status });
  if (status >= 500) {
    const tooHeavy = heavy && TOO_HEAVY_STATUSES.has(status);
    throw httpError(status, null, { retryAfterMs: 0, tooHeavy, tooHeavyIfRepeated: heavy && !tooHeavy });
  }
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
// heavy は send に、残りの options は withRetry に渡す。
function call(url, init, read, signal, { heavy = false, ...options } = {}) {
  return withRetry(async () => {
    const response = await send(url, init, signal, heavy);
    if (isRateLimited(response)) throw rateLimitFailure(response.status, response.headers, { status: response.status });
    return read(response);
  }, signal, options);
}

// 1 回分の問い合わせ。{ data, unreadable } を返す。
// partial なら、エラーがどれも読めない項目のものだけのとき、エラーにせずに返す (unreadable が true)。
// 読めない項目は null になっていて、応答の全体が読めなければ data は空のオブジェクト。
// 呼ぶ側は unreadable で、null が読めないからなのか、ほんとうにないからなのかを分ける。
// 読めない項目のエラーの文には、読めなかった非公開リポジトリの名前が入ることがある。
// 公開リポジトリの実行結果にも出ないよう、ほかのエラーで止まるときも、その文は出さない。
function request(token, query, variables, partial, signal, options) {
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
      tooHeavy: timedOut,
    });
  }, signal, { ...options, heavy: true });
}

const graphql = async (token, query, variables) => (await request(token, query, variables, false)).data;
// 読めない項目があっても止めずに、{ data, unreadable } を返す。非公開リポジトリを読むときに使う。
// signal が中止されたら、応答もやり直しも待たずにやめる。options は withRetry に渡す。
const graphqlPartial = (token, query, variables, signal, options) => request(token, query, variables, true, signal, options);

// REST API の GET。見つからないか読めない (回数の上限ではない 403) ときは null を返す。
// タイムアウトや 5xx でも tooHeavy にしない (heavy を渡さない)。REST の問い合わせは、非公開リポジトリの読み方で重さが変わらず、
// 軽い読み方で数え直しても同じ問い合わせを送るので、数え直しても数えられるとは限らず、数が下がるだけになりうるため。
function restGet(token, path, signal) {
  const init = { headers: { ...headers(token), accept: 'application/vnd.github+json' } };
  return call(`https://api.github.com${path}`, init, ({ status, ok, body }) => {
    if (status === 403 || status === 404) return null;
    if (!ok) throw httpError(status, body);
    return body;
  }, signal);
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
// author の user と committer と authors は、だれのコミットも読むときにしか使わないので、そのときだけ取る。
// author の user は authors にも入っているが、Co-authored-by の人が読めずに authors が null になっても決められるよう、別にも取る。
// $first は 1 ページのコミットの数 (HISTORY_PAGE_SIZES)。
const HISTORY_QUERY = `query ($owner: String!, $name: String!, $ref: String!, $since: GitTimestamp!, $all: Boolean!, $author: CommitAuthor, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) {
      target {
        ... on Commit {
          history(first: $first, after: $after, since: $since, author: $author) {
            pageInfo { hasNextPage endCursor }
            nodes {
              oid
              author { date user @include(if: $all) { id } }
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
// 非公開リポジトリのコミットを数えるのに送る問い合わせ (一覧と履歴のページと、Pages のサイトを確かめる REST の問い合わせ) の数の、見積もりの上限。
// だれのコミットも読むと、読む量はリポジトリの大きさで決まる。大きな組織のリポジトリが読めるトークンでも、
// 回数の上限やタイムアウトで毎回数えきれないことがないよう、見積もりがこれを超えるなら、本人が author のコミットだけを読む。
// それでも超えるなら、非公開リポジトリは読まない。
// だれのコミットも読んでは重すぎて数えきれず、本人が author のコミットだけを読んで数え直す日は、そのぶんも送る (fetchPrivateCommits)。
// 数え直したあとの LIGHTER_READING_DAYS 日は、だれのコミットも読まないので、毎回にはならない。
// 重すぎた履歴のページを小さくして読み直したブランチも、見積もりより多く送る (HISTORY_PAGE_SIZES)。
// 見積もりより多く送っても、履歴の問い合わせは、見積もった分も合わせて、1 回の数え方につき MAX_HISTORY_REQUESTS 回まで。
// かける時間も、1 回の数え方につき MAX_COUNT_MS まで。
export const MAX_PRIVATE_REQUESTS = 200;
// だれのコミットも読むときの、履歴の 1 ページのコミットの数。ふつうは最初の数で読む。
// 重すぎて GitHub が返しきれなければ (tooHeavy)、同じページを次の数で読み直し、そのブランチの残りのページも、その数で読む。
// 1 ページで本人と照らし合わせるコミットと Co-authored-by の人が減るので、GitHub の数え方のまま、軽く読めることがある。
// 軽い読み方 (本人が author のコミットだけを読む) で数え直すと、カードの数が GitHub の数え方の数より下がるので、その前にためす。
// いちばん小さい数でも重すぎれば、その数でやり直してから失敗する (そのあと fetchPrivateCommits で、軽い読み方で数え直す)。
// 本人が author のコミットだけを読むときは、本人のコミットがまばらなら、ページを小さくしても GitHub が読み進める量は減らないので、小さくしない。
export const HISTORY_PAGE_SIZES = [100, 50, 25];
// 1 回の数え方 (countCommits) で送る、履歴の問い合わせの数の上限。見積もった分も、ページを小さくして読み直した分も入れる。
// 見積もりは最初のページの大きさで決めるので、どのブランチも 1 段小さくして読めるだけの数にする。
// 重すぎて、ページを小さくするもとになった問い合わせは数えない。数えると、ブランチの数だけ足りなくなり、
// 1 段小さくすれば読みきれるのに、上限を超えてしまうため。数えない問い合わせは、ブランチごとに HISTORY_PAGE_SIZES.length - 1 回まで。
// 超えたら、重すぎて数えきれなかったものとして失敗する (tooHeavy)。だれのコミットも読んでいたなら、
// fetchPrivateCommits で、本人が author のコミットだけを読んで数え直す。
// ページを小さくしつづけて、見積もりの何倍もの問い合わせを送り、回数の上限に当たらないようにする。
// withRetry のやり直しは数えないので、送る通信は、多くてもこの (RETRY_DELAYS_MS.length + 1) 倍まで。
// 上限は、同時に読むリポジトリ (REPOSITORY_CONCURRENCY) で分け合う。上限に届くほど重いときは、応答の順番によって、
// ほかのリポジトリで非公開の活動の数に届くのが先か、上限を超えるのが先かが変わり、数が実行ごとに変わりうる。
// リポジトリごとに上限を分ければ変わらないが、上限に届くのは見積もりの 2 倍を読んだときだけなので、分けていない。
export const MAX_HISTORY_REQUESTS = MAX_PRIVATE_REQUESTS * 2;
// 1 回の数え方 (countCommits) にかける時間の上限。履歴の問い合わせを送る前に確かめ、過ぎていたら、
// 重すぎて数えきれなかったものとして失敗する (tooHeavy)。問い合わせの数が上限までても、重いページは 1 回に何十秒もかかる。
// だれのコミットも読んで数えきれず、本人が author のコミットだけを読んで数え直す日は、2 回数える。
// それでも、送ったあとの問い合わせを待つ時間を入れて、ワークフローの timeout-minutes (10 分) までに終わる長さにする。
// 終わらないと、カードも state.json も書けず、前の実行の数を使うこともできずに、毎日同じところで止まる。
// 過ぎるかどうかは GitHub の応答の速さで決まるので、ここでも数が実行ごとに変わりうる。止まるよりはよいものとする。
export const MAX_COUNT_MS = 150000;

const tooManyHistoryRequests = () => failure(bilingual(
  `非公開リポジトリの履歴を読む問い合わせが ${MAX_HISTORY_REQUESTS} 回を超えました`,
  `Reading the history of private repositories took more than ${MAX_HISTORY_REQUESTS} requests`,
), { tooHeavy: true });

const tookTooLong = () => failure(bilingual(
  `非公開リポジトリの履歴を読むのに ${MAX_COUNT_MS / 1000} 秒を超えました`,
  `Reading the history of private repositories took more than ${MAX_COUNT_MS / 1000} seconds`,
), { tooHeavy: true });
// 非公開リポジトリの読み方。重い順に、だれのコミットも読む (all)、本人が author のコミットだけを読む (authored)、読まない (none)。
// 見積もりにはほかの人のコミットも入るので、上限の近くでは、ほかの人の活動で読み方が実行ごとに変わり、数も増えたり減ったりしうる。
// そうならないよう、前の実行の読み方を state.json に残しておき、前より重い読み方には、見積もりが上限の 8 割まで下がったときだけ戻す。
const READINGS = ['all', 'authored', 'none'];
export const HEAVIER_READING_REQUESTS = MAX_PRIVATE_REQUESTS * 0.8;
// だれのコミットも読んでは重すぎて数えきれず、本人が author のコミットだけを読んで数え直した日 (lighterSince) から、
// LIGHTER_READING_DAYS 日のあいだは、見積もりが上限より少なくても、だれのコミットも読まない。
// 毎回重すぎるリポジトリがあると、だれのコミットも読んでは毎日失敗し、そのたびに数え直して、問い合わせも時間も 2 倍かかるため。
// 日数がたったら、またためす。重すぎなくなっていれば、だれのコミットも読んで数える。
export const LIGHTER_READING_DAYS = 7;
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

// 一覧の 1 つのリポジトリと、読むブランチと、そのリポジトリを読む問い合わせの数の、読み方ごとの見積もり (requests)。
// all は、だれのコミットも読むとき (コミット 100 件で 1 回)。authored は、本人が author のコミットだけを読むとき (ブランチごとに 1 回)。
// all は、重すぎてページを小さくして読み直すブランチがあれば、そのぶん多く読む (HISTORY_PAGE_SIZES)。
// 重すぎるかは読む前には分からないので、見積もりは最初のページの大きさで決め、実行ごとに揺れないようにする。
// 本人のコミットが 100 件を超えるブランチはそのぶん多く読むが、本人のコミットは非公開の活動の数より少ないので、大きくは増えない。
// コミットの数が読めないブランチは 1 回にする (読めば、読めないリポジトリとして除かれる)。
// gh-pages ブランチは、Pages のサイトがあるかを確かめる前なので、あるものとして見積もる。
// 確かめる REST の問い合わせ (gh-pages ブランチごとに 1 回) は、どちらの読み方でも送るので、どちらにも足す。
function listed(repository) {
  const branches = branchesOf(repository);
  const sites = branches.filter(({ site }) => site).length;
  const all = branches.reduce((sum, { commits }) => sum + Math.max(1, Math.ceil((commits ?? 0) / HISTORY_PAGE_SIZES[0])), 0);
  return { repository, branches, requests: { all: all + sites, authored: branches.length + sites } };
}

// 一覧を読むのに送った問い合わせの数 (requests) に、一覧のリポジトリ (listed) を reading の読み方で読む見積もりを足した、
// 非公開リポジトリのコミットを数えるのに送る問い合わせの数の見積もり。読み方を決めるのに使う。
const estimateRequests = (requests, entries, reading) => entries.reduce((sum, entry) => sum + entry.requests[reading], requests);

// Pages のサイトがあるか。GraphQL API では分からないので、REST API で読む。
// リポジトリが読めなければ (403 か 404)、サイトがあるとは確かめられないので、ないものとする。
// GraphQL では読めるのに REST API では読めない状態が続いても、既定のブランチの分は毎回数えられ、数も実行ごとに変わらない。
async function hasPagesSite(token, { owner: { login: owner }, name }, signal) {
  const repository = await restGet(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, signal);
  return repository?.has_pages === true;
}

// hasPagesSite を、リポジトリごとに 1 回だけ問い合わせるようにしたもの。軽い読み方で数え直すときは、確かめた答えを使う。
// 答えが分かる前に失敗するか中止したら、覚えずに、次に聞かれたときにまた問い合わせる。
function pagesSites(token) {
  const known = new Map();
  return async (repository, signal) => {
    if (!known.has(repository.id)) known.set(repository.id, await hasPagesSite(token, repository, signal));
    return known.get(repository.id);
  };
}

// 中止したことによる失敗か、GitHub から思うように読めなかった失敗か。どちらでもなければ、コードのバグのような失敗。
const isExpectedFailure = (error) => error instanceof FetchFailure || error?.name === 'AbortError';

// items を REPOSITORY_CONCURRENCY 件まで並べて処理する。fn には、中止を知らせる signal と、残りをやめるときに呼ぶ stop も渡す。
// 1 つでも失敗するか、stop が呼ばれたら、signal を中止する。まだ始めていないものは始めず、途中のものも signal を見てやめる。
// 途中の問い合わせとやり直しも待たない。結果はもう決まったか、もう使わないため。
// どれもやめてから、最初の失敗を投げる。投げたあとに問い合わせが残らないようにする。
// 中止したあとの失敗は、中止したことによるものか、GitHub から読めなかったものなら見ない。
// コードのバグのような失敗は、中止したあとでも、GitHub から読めなかった失敗でかくさずに投げる。
async function forEachConcurrently(items, fn) {
  const queue = [...items];
  const controller = new AbortController();
  const { signal } = controller;
  const stop = () => controller.abort();
  let failed;
  const worker = async () => {
    while (!signal.aborted && queue.length > 0) {
      try {
        await fn(queue.shift(), signal, stop);
      } catch (error) {
        if (!signal.aborted) failed = error;
        else if (!isExpectedFailure(error) && (failed === undefined || isExpectedFailure(failed))) failed = error;
        stop();
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: REPOSITORY_CONCURRENCY }, worker));
  if (failed !== undefined) throw failed;
}

// 数えているあいだに読めるものが変わったとき。途中までの数は出さない。
const changedWhileCounting = (ja, en) => failure(bilingual(ja, en));

// lastDay は、本人が author のコミットだけを読む最後の日 (lighterUntil)。
const lighterReading = (lastDay) => bilingual(
  '非公開リポジトリのコミットを、だれのコミットも読んでは数えきれなかったので、本人が author のコミットだけを読んで数えました。' +
    `Co-authored-by に名前があるだけのコミットと、commit し直しただけのコミットは入りません。${lastDay} までは、本人が author のコミットだけを読みます`,
  "Couldn't count the commits in private repositories by reading everyone's commits, so only the commits the user authored were read and counted. " +
    `Commits where the user is only named in Co-authored-by, or only re-committed, aren't included. Until ${lastDay}, only the commits the user authored will be read`,
);

// since より後に push された、トークンで読める非公開リポジトリ (listed) と、一覧を読むのに送った問い合わせの数。
// counted (GitHub がもうコミットを数えているリポジトリ) は入れない。
// 本人が author のコミットだけを読む見積もりが budget を超えたら、もう読まないと決まるので、残りのページは取らずに、そこまでを返す。
// 読み方は、返したリポジトリから呼ぶ側で決める。トークンで一覧が読めなければ null。
async function activePrivateRepositories(token, { login, since, counted, budget }) {
  const repositories = new Map();
  let requests = 0;
  let readable = true;
  const overBudget = () => estimateRequests(requests, [...repositories.values()], 'authored') > budget;
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
        repositories.set(repository.id, listed(repository));
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
// 読めるかどうかは、最初の履歴のページで決める。それまでに履歴が読めなければ、何も渡さずに終わり、
// そのリポジトリは数えない。そのあとで読めなくなったり、ブランチが消されたりしたら、数えているあいだに変わったので失敗する。
// Pages のサイトがあるかは hasSite (pagesSites) で確かめ、読めなければ、サイトがないものとして、gh-pages ブランチだけを読まない。
// 読めた分を引くと、ほかのリポジトリを読むのをやめたあとで数が減り、実行ごとに数が変わることがあるため。
// コミットには、読めない項目のせいで null になったものもある。
// だれのコミットも読むときは、重すぎた履歴のページを、ページを小さくして読み直す (HISTORY_PAGE_SIZES)。
// 履歴の問い合わせは、送る前に budget.sent に数え、MAX_HISTORY_REQUESTS を超えたら送らずに失敗する。
// budget.deadline (retryTimer.now の時刻) を過ぎていても、送らずに失敗する (MAX_COUNT_MS)。
// signal が中止されたら、残りのページもブランチも読まず、途中の問い合わせもやめる。
async function readRepository(token, { repository, branches }, { since, author, hasSite, budget, signal }, onCommits) {
  const { owner: { login: owner }, name } = repository;
  const pageSizes = author ? HISTORY_PAGE_SIZES.slice(0, 1) : HISTORY_PAGE_SIZES;
  let first = true;
  const changed = () => changedWhileCounting(
    '非公開リポジトリのコミットを数えているあいだに、リポジトリかブランチが消されたか、名前が変わったか、読めなくなりました',
    'A private repository or branch was deleted, renamed or became unreadable while counting commits',
  );
  for (const { ref, site } of branches) {
    if (signal.aborted) return;
    if (site) {
      if (!(await hasSite(repository, signal))) continue;
      if (signal.aborted) return;
    }
    // このブランチで、いま使っているページの大きさ (pageSizes の何番目か)。
    let size = 0;
    // after のカーソルからの 1 ページを読む。まだ小さくできるうちは、重すぎた失敗を同じ大きさではやり直さずに、小さくして読み直す。
    const readHistory = async (after) => {
      for (;;) {
        // 小さくして読み直すときに拾わないよう、try の外で失敗する。
        if (retryTimer.now() > budget.deadline) throw tookTooLong();
        budget.sent += 1;
        if (budget.sent > MAX_HISTORY_REQUESTS) throw tooManyHistoryRequests();
        const smaller = size + 1 < pageSizes.length;
        const variables = { owner, name, ref, since, all: !author, author, first: pageSizes[size], after };
        try {
          return await graphqlPartial(token, HISTORY_QUERY, variables, signal, { retryTooHeavy: !smaller });
        } catch (error) {
          if (!(smaller && error instanceof FetchFailure && error.tooHeavy)) throw error;
          size += 1;
          // 小さくするもとになった問い合わせは、上限に数えない (MAX_HISTORY_REQUESTS)。
          budget.sent -= 1;
        }
      }
    };
    const fetchPage = async (after) => {
      const { data, unreadable } = await readHistory(after);
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
      onCommits(history.nodes);
      if (signal.aborted) return;
    }
  }
}

// トークンで読める非公開リポジトリにある、コントリビューションの期間 (firstDay から lastDay) の本人のコミットの数 (count) と、
// 読み方 (reading)。数えないとき (本人のトークンでないときと、トークンで一覧が読めないとき) は undefined。
// previous は前の実行の読み方。lighterSince は、前の実行までに軽い読み方で数え直した日で、
// まだだれのコミットも読まないあいだ (lighterUntil まで) だけ渡す。lighterOnFailure は、重すぎたときに軽い読み方で数え直すか。
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
// トークンの持ち主が本人でないときと、トークンで一覧が読めないときは数えない。どれも実行ごとにはまず変わらないので、カードの数も変わらない。
// 読めない項目のせいで null になったコミットは除いて数える。
// 数えきれないとき (やり直しても続くタイムアウトや回数の上限、数えているあいだに読めるものが変わったときなど) は FetchFailure で失敗する。
// そのときは、呼ぶ側 (fetchAccount) で前の実行の数を使う。
// ただし lighterOnFailure なら、だれのコミットも読んでは重すぎて (tooHeavy) 数えきれなかったとき、
// 同じ一覧のまま、本人が author のコミットだけを読んで数え直す。それでも数えきれなければ、そのときの失敗で失敗する。
// 数え直したら、その日を lighterSince として返す。そこから LIGHTER_READING_DAYS 日あとまでは、だれのコミットも読まない。
// lighterOnFailure は、前の実行の数を使えないときと、前の実行がだれのコミットも読んでいないとき (fetchAccount)。
// だれのコミットも読むと毎回タイムアウトするリポジトリがあっても、前の実行の数が古くなったあと、0 のままにならない。
// 前の実行がだれのコミットも読んでいて、その数を使えるあいだは数え直さない。一時的な失敗で、カードの数が軽い読み方の数に下がらないようにするため。
// 回数の上限や、数えているあいだに読めるものが変わったときは、軽い読み方にしても数えられないか、数が下がるだけなので、数え直さない。
async function fetchPrivateCommits(login, token, period, { previous, lighterSince, lighterOnFailure }, warn) {
  const { id, firstDay, lastDay: today } = period;
  // 既定のトークンは GitHub App のトークン (ghs_ で始まる) で、本人のトークンではない。問い合わせずに数えない。
  if (token.startsWith('ghs_')) return undefined;
  // ほかのトークンでも、viewer が読めないか、本人ではないアカウントなら、一覧も読まずに数えない。
  const { data } = await graphqlPartial(token, VIEWER_QUERY, { login });
  if (data.viewer?.id !== id) return undefined;
  // もう数えているリポジトリが読めなければ、ないものとする。いまの GitHub は非公開リポジトリのコミットを数えないので、ふつうはない。
  const contributions = data.user?.contributionsCollection.commitContributionsByRepository ?? [];
  const counted = new Set(contributions.map((contribution) => contribution.repository.id));
  // committer date はふつう author date と同じかそれより後なので、初日より前に commit されたコミットは読まなくてよい。
  // author date は書いた地域の日付で数えるので、どの地域の初日も入るよう、前の日の UTC の 0 時から読む。
  const since = `${addDays(firstDay, -1)}T00:00:00Z`;
  const active = await activePrivateRepositories(token, { login, since, counted, budget: readingLimit('authored', previous) });
  if (!active) return undefined;
  const { repositories, requests } = active;
  const fits = (candidate) => estimateRequests(requests, repositories, candidate) <= readingLimit(candidate, previous);
  const reading = (lighterSince ? ['authored'] : ['all', 'authored']).find(fits) ?? 'none';
  // だれのコミットも読まないあいだは、軽い読み方で数え直した日を残す。見積もりが上限を超えて読まない日も残す。
  // 消すと、見積もりが下がった次の日に、日数がたつ前に、だれのコミットも読んで、また重すぎて数え直すことになるため。
  const keepLighter = (result) => (lighterSince ? { ...result, lighterSince } : result);
  if (reading === 'none') return keepLighter({ count: 0, reading });
  const hasSite = pagesSites(token);
  const countAs = (candidate) => countCommits(token, repositories, { ...period, since, hasSite, reading: candidate });
  if (reading === 'authored') return keepLighter(await countAs(reading));
  if (!lighterOnFailure) return countAs(reading);
  try {
    return await countAs(reading);
  } catch (error) {
    if (!(error instanceof FetchFailure && error.tooHeavy)) throw error;
    // 本人が author のコミットだけを読む見積もりは、だれのコミットも読む見積もりより多くならず、上限も低くならないので、
    // だれのコミットも読む見積もりが上限までなら、確かめなくても上限まで。
    const result = await countAs('authored');
    warn(`${lighterReading(lighterUntil(today))}\n${error.message}`);
    return { ...result, lighterSince: today };
  }
}

// 一覧のリポジトリ (listed) にある、コントリビューションの期間 (firstDay から lastDay) の本人のコミットの数 (count) を、
// reading の読み方 (all か authored) で数えて、読み方と一緒に返す。restricted より多くはしない。
// Pages のサイトがあるかは hasSite (pagesSites) で確かめる。
async function countCommits(token, repositories, { id, firstDay, lastDay, restricted, since, hasSite, reading }) {
  const author = reading === 'all' ? null : { id };
  const isContribution = (commit) => {
    const day = commit.author?.date?.slice(0, 10);
    if (!day || day < firstDay || day > lastDay) return false;
    // author で絞って読んだコミットは、どれも本人が author のコミット。
    if (author) return true;
    // Co-authored-by の人が読めずに authors が null になっても、author と committer で決める。
    return commit.author?.user?.id === id || commit.committer?.user?.id === id ||
      (commit.authors?.nodes ?? []).some((person) => person?.user?.id === id);
  };

  // 読めたリポジトリで数えたコミットの数。読んでいる途中のリポジトリの分も入れる。
  // 読めるかどうかは最初のページで決まり、あとから引くことはないので、届いたところでやめても数は変わらない。
  // コミットはリポジトリごとに数えるので、リポジトリどうしでは重ならず、足すだけでよい。
  let total = 0;
  // 送った履歴の問い合わせの数と、読むのをやめる時刻。どのリポジトリのものも合わせて、MAX_HISTORY_REQUESTS 回と MAX_COUNT_MS までにする。
  const budget = { sent: 0, deadline: retryTimer.now() + MAX_COUNT_MS };
  try {
    await forEachConcurrently(repositories, async (entry, signal, stop) => {
      const found = new Set();
      await readRepository(token, entry, { since, author, hasSite, budget, signal }, (commits) => {
        for (const commit of commits) {
          // 読めない項目のせいで null になったコミットは、本人のコミットかどうか分からないので除く。
          // 少なく数えることになるが、読めないリポジトリと同じく、毎回同じコミットが読めないなら、数は実行ごとに変わらない。
          // 読めないのは組織の SSO などで、知らせても本人には直せないので、読めないリポジトリと同じく知らせない。
          if (!commit || !isContribution(commit) || found.has(commit.oid)) continue;
          found.add(commit.oid);
          total += 1;
        }
        // restricted に届いたら、数は決まったので、残りは読まない。
        if (total >= restricted) stop();
      });
    });
  } catch (error) {
    // 数えた分はあとから引かないので、restricted に届いたら、数は restricted に決まる。
    // 届いたあとの失敗は、届いたところで読むのをやめるので見ない (forEachConcurrently)。
    // 失敗のあとで、もう届いていた応答で restricted に届いたときも、応答の順番で数が変わらないよう、失敗は見ない。
    if (!(error instanceof FetchFailure && total >= restricted)) throw error;
  }
  return { count: Math.min(total, restricted), reading };
}

// 前の実行の state.json に残した、非公開リポジトリのコミットの数と読み方と、数えた人 (userId) と、数えきれなくなった日 (failedSince) と、
// 軽い読み方で数え直した日 (lighterSince)。
// 形が違うか、ほかのユーザーのもの (username を変えたときなど) なら、残していないものとする。
// ほかのユーザーの数を、数えきれなかった日に足さないため。
const isOptionalDate = (value) => value === undefined || isDate(value);
const isPrivateCommits = (value, userId) =>
  Number.isSafeInteger(value?.count) && value.count >= 0 && READINGS.includes(value.reading) && value.userId === userId &&
  isOptionalDate(value.failedSince) && isOptionalDate(value.lighterSince);

// 本人が author のコミットだけを読む最後の日。軽い読み方で数え直した日 (lighterSince) から LIGHTER_READING_DAYS 日あと。
const lighterUntil = (lighterSince) => addDays(lighterSince, LIGHTER_READING_DAYS);

// 数えきれなかった日に、前の実行で数えた数を使うのは、数えきれなくなった日 (failedSince) から KEEP_PRIVATE_COMMITS_DAYS 日あとまで。
// それより長く数えきれないと、前の数には、そのあとに増えたコミットも、期間から外れたコミットも入っていないので、使わずに 0 にする。
// 数えきれない日が続いても、カードの数が下がって気づける。
// 使えなくなった日からは、だれのコミットも読んでは重すぎて数えきれなければ、本人が author のコミットだけを読んで数える (fetchPrivateCommits)。
// 数えた日ではなく、数えきれなくなった日を残す。数えた日を残すと、カードが変わらない日も state.json が変わり、毎日コミットされるため。
export const KEEP_PRIVATE_COMMITS_DAYS = 7;

// 今日数えきれなかったときに、前の実行の数 (previous) を使うかどうか。数えきれなくなった日 (failedSince) と、使える最後の日 (lastUsed) と、
// 今日使えるか (usable)。前の実行で数えられていれば、今日が数えきれなくなった日になる。
function previousUse(previous, today) {
  const failedSince = previous.failedSince ?? today;
  const lastUsed = addDays(failedSince, KEEP_PRIVATE_COMMITS_DAYS);
  return { failedSince, lastUsed, usable: lastUsed >= today };
}

// 数えきれなかった日の、非公開リポジトリのコミットの数と読み方と数えきれなくなった日 (privateCommits) と、知らせる文 (message)。
// previous は前の実行の state.json に残した数で、なければ undefined。そのときは privateCommits も undefined で、数えない。use は previousUse で決めた、前の実行の数の使い方。
// 読み方と軽い読み方で数え直した日 (lighterSince) は、次の実行の読み方を決めるのに使うので、前の実行のまま残す。
function privateCommitsFallback(previous, use, restricted) {
  if (previous === undefined) {
    const message = bilingual(
      '非公開リポジトリのコミットを数えきれなかったので、今回は数えません。次の実行で数え直します',
      "Couldn't count the commits in private repositories, so they aren't counted this time. They will be counted again on the next run",
    );
    return { privateCommits: undefined, message };
  }
  const { failedSince, lastUsed, usable } = use;
  if (!usable) {
    const message = bilingual(
      `非公開リポジトリのコミットを数えきれなかったので、今回は数えません。${failedSince} から ${KEEP_PRIVATE_COMMITS_DAYS} 日を過ぎても数えきれず、前に数えた数は古くなりました。次の実行で数え直します`,
      `Couldn't count the commits in private repositories, so they aren't counted this time. They still couldn't be counted more than ${KEEP_PRIVATE_COMMITS_DAYS} days after ${failedSince}, so the previous count is out of date. They will be counted again on the next run`,
    );
    // 数えきれなくなった日も変えない。
    return { privateCommits: { ...previous, count: 0, failedSince }, message };
  }
  const message = bilingual(
    `非公開リポジトリのコミットを数えきれなかったので、前に数えた数を使います (${lastUsed} まで)。次の実行で数え直します`,
    `Couldn't count the commits in private repositories, so the previous count is used (until ${lastUsed}). They will be counted again on the next run`,
  );
  return { privateCommits: { ...previous, count: Math.min(previous.count, restricted), failedSince }, message };
}

// 読み方が none に変わった日に知らせる。カードの数が、本人の活動とは関係なく下がるため。
const NOT_READING = bilingual(
  '非公開リポジトリの読む量の見積もりが上限を超えたので、非公開リポジトリのコミットを数えるのをやめました。' +
    '見積もりには、ほかの人のコミットも入ります。見積もりが減れば、また数えます',
  'The estimated amount to read in private repositories went over the limit, so their commits are no longer counted. ' +
    "The estimate includes other people's commits too. They will be counted again when the estimate goes down",
);

// 見積もりで、だれのコミットも読む読み方から、本人が author のコミットだけを読む読み方に変わった日に知らせる。
// カードの数が、本人の活動とは関係なく下がり、GitHub の数え方の数より少なくなるため。
// 重すぎて数え直した日は、数え直したことを知らせる (lighterReading) ので、これは知らせない。
const AUTHORED_READING = bilingual(
  '非公開リポジトリの読む量の見積もりが上限を超えたので、非公開リポジトリのコミットは、本人が author のコミットだけを読んで数えます。' +
    'Co-authored-by に名前があるだけのコミットと、commit し直しただけのコミットは入らないので、GitHub の数え方より少なくなることがあります。' +
    '見積もりには、ほかの人のコミットも入ります。見積もりが減れば、また、だれのコミットも読んで数えます',
  'The estimated amount to read in private repositories went over the limit, so only the commits the user authored are counted in them. ' +
    "Commits where the user is only named in Co-authored-by, or only re-committed, aren't included, so the count can be lower than GitHub's. " +
    "The estimate includes other people's commits too. Everyone's commits will be read and counted again when the estimate goes down",
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
  // 数えきれないときは、前の実行の数を使う (privateCommitsFallback)。0 や途中まで数えた数にすると実行ごとに数が増えたり減ったりし、
  // 止まると、1 つのリポジトリが読めつづけないだけで、カード全体がずっと更新されなくなるため。
  // ただし、コードのバグなど、GitHub から読めなかったのではない失敗 (FetchFailure でないもの) は、前の実行の数でかくさずに止まる。
  // 非公開リポジトリを数えるのは本人のトークンを渡したときだけなので、止まって困るのは本人だけで、すぐ気づける。
  const restricted = collection.restrictedContributionsCount;
  const { id } = profile.user;
  const previous = isPrivateCommits(recorded, id) ? recorded : undefined;
  const use = previous && previousUse(previous, today);
  const countPrivateCommits = async () => {
    if (!(restricted > 0)) return undefined;
    const period = { id, firstDay: firstDate(calendar), lastDay: today, restricted };
    const readings = {
      previous: previous?.reading ?? READINGS[0],
      // 軽い読み方で数え直した日から決まった日数のあいだは、だれのコミットも読まない。
      lighterSince: previous?.lighterSince && lighterUntil(previous.lighterSince) >= today ? previous.lighterSince : undefined,
      // 前の実行がだれのコミットも読んでいなければ、軽い読み方で数え直しても、前の実行より軽い読み方の数にはならない。
      lighterOnFailure: !use?.usable || previous.reading !== 'all',
    };
    try {
      const counted = await fetchPrivateCommits(login, token, period, readings, warn);
      if (counted?.reading === 'none' && previous?.reading !== 'none') warn(NOT_READING);
      // 軽い読み方で数え直した日がある (lighterSince) ときは、見積もりで変わったのではない。
      if (counted?.reading === 'authored' && readings.previous === 'all' && counted.lighterSince === undefined) warn(AUTHORED_READING);
      return counted;
    } catch (error) {
      if (!(error instanceof FetchFailure)) throw error;
      const { privateCommits, message } = privateCommitsFallback(previous, use, restricted);
      warn(`${message}\n${error.message}`);
      return privateCommits;
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
  return {
    login,
    // 草の日付での今日。連続記録とキャラクターの開始日は、この日付で数える。
    today,
    ...contributions,
    // コントリビューションの期間 (およそ過去 1 年) のコミットの数。公開リポジトリの分 (totalCommitContributions) に、
    // Private contributions がオンで、トークンの持ち主が本人なら、トークンで読める非公開リポジトリの分を、リポジトリごとに数えて足す。
    // 読めない非公開リポジトリの分は入らない。
    totalCommits: collection.totalCommitContributions + (privateCommits?.count ?? 0),
    // state.json に残して、次の実行の fetchAccount に渡す、非公開リポジトリのコミットの数と読み方と数えた人 (userId)。
    // 数えきれなかった日は、数えきれなくなった日 (failedSince) も残す。軽い読み方で数え直したら、その日 (lighterSince) も、
    // だれのコミットも読まないあいだ残す。数えないときは undefined で、残さない。数えて 0 だったときは残す。
    privateCommits: privateCommits && { ...privateCommits, userId: id },
    // 言語を数えるリポジトリ (フォークを除いたすべて)。
    repositories,
    totalPullRequests,
    totalIssues,
    // スターの合計 (stars) と、自分のリポジトリの数 (totalRepositories)。
    ...owned,
  };
}
