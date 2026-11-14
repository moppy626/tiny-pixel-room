// GitHub GraphQL API からアカウント全体のデータを取る。
import { setTimeout as delay } from 'node:timers/promises';
import { bilingual } from './messages.mjs';

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

// 問い合わせに使うトークン (token) と、そのトークンを渡した入力の名前 (inputs)。
// トークンは github-token と contributions-token の 2 つあるので、断られたときに、どちらの入力を直せばよいかを名前で示す。
// 2 つの入力に同じトークンを渡していれば、どちらも直すことになるので、inputs に両方の名前を入れる。
// attributed は、2 つの入力のトークンが違うとき。401 のほかのエラーにも、どちらのトークンで読んだときかを添える。
const credential = (token, inputs, attributed = false) => ({ token, inputs, attributed });

// 自分で作ったトークン (サポート外) を渡しているときの直し方。既定のトークンに戻す。
function defaultTokenAdvice({ inputs }) {
  const ja = inputs.join(' と ');
  const en = inputs.join(' and ');
  return {
    ja: `自分で作ったトークンを渡しているときは、ワークフローの ${ja} の行を消して、既定のトークンに戻してください`,
    en: `If you're passing your own token, remove the ${en} ${inputs.length > 1 ? 'lines' : 'line'} from the workflow to go back to the default token`,
  };
}

// 既定のトークンでは起きない。自分で作ったトークン (サポート外) を渡したときに、期限切れなどで起きる。
function unauthorizedMessage(by) {
  const advice = defaultTokenAdvice(by);
  return bilingual(
    `${by.inputs.join(' と ')} のトークンが使えません (401)。有効期限が切れているか、取り消されています。${advice.ja}`,
    `The ${by.inputs.join(' and ')} can't be used (401). It has expired or been revoked. ${advice.en}`,
  );
}

// エラーの文に添える、どちらのトークンで読んだときか。2 つの入力のトークンが同じなら、分ける意味がないので添えない (null)。
// by は、問い合わせに使ったトークン (credential)。トークンに関係のない失敗 (5xx) では渡さない。
const readWith = (by) =>
  by?.attributed ? { ja: `${by.inputs[0]} で読んだとき`, en: `while reading with ${by.inputs[0]}` } : null;

// 回数の上限はトークンごとに数えるので、どちらのトークンで当たったかも添える。
function rateLimitMessage(reason, by) {
  const who = readWith(by);
  return bilingual(
    `GitHub API の回数の上限に達しました (${reason}${who ? `、${who.ja}` : ''})。上限が戻れば、次の実行で更新されます`,
    `Reached the GitHub API rate limit (${reason}${who ? `, ${who.en}` : ''}). The cards will be updated on a later run after the limit resets`,
  );
}

const headers = (token) => ({
  authorization: `bearer ${token}`,
  'user-agent': 'tiny-pixel-room',
});

// やり直してよい失敗には、最低限待つ時間 (retryAfterMs) を付ける。
const failure = (message, fields = {}) => Object.assign(new Error(message), fields);

const UNREADABLE_RESPONSE = bilingual('GitHub API の応答を読めませんでした', "Couldn't read the GitHub API response");

// GitHub が理由を返していれば、状態コードと一緒に出す。
// 組織の SSO でトークンの承認が要るときなど、403 だけでは何を直せばよいか分からない。
function httpError(status, { body, by, ...fields } = {}) {
  const reason = body?.message ? `: ${body.message}` : '';
  const who = readWith(by);
  return failure(
    bilingual(
      `GitHub API が ${status} を返しました${who ? ` (${who.ja})` : ''}${reason}`,
      `GitHub API returned ${status}${who ? ` (${who.en})` : ''}${reason}`,
    ),
    { status, ...fields },
  );
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

// 1 回分の通信。本文を読み終えるまでをタイムアウトに含める。by は、この通信に使うトークン (credential)。
async function send(url, init, by) {
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
  if (status === 401) throw failure(unauthorizedMessage(by), { status });
  if (status >= 500) throw httpError(status, { retryAfterMs: 0 });
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

// 読めない項目のエラー。権限がない (組織の SSO でトークンが承認されていないなど)、見つからない、トークンの権限が足りない。
const isForbidden = (error) => error.type === 'FORBIDDEN' || /not accessible/i.test(error.message ?? '');
const isUnreadable = (error) => isForbidden(error) || error.type === 'NOT_FOUND' || error.type === 'INSUFFICIENT_SCOPES';

// エラーの文に出す、GitHub が返した理由。
// 読めない項目のエラーの文には、読めなかった非公開リポジトリや組織の名前が入ることがある。
// 自分で作ったトークン (サポート外) を渡していると、スターや言語の問い合わせは非公開リポジトリも読むので、
// 公開リポジトリの実行結果に名前が出ないよう、GitHub の文は出さず、エラーの種類と、応答のどの項目か (path) だけを出す。
// GitHub の文がないと何を直せばよいか分からないので、代わりに、既定のトークンに戻す直し方を添える (graphqlError)。
function shownReason(error) {
  if (!isUnreadable(error)) return error.message;
  const type = error.type ?? 'FORBIDDEN';
  return error.path?.length ? `${type} (${error.path.join('.')})` : type;
}

function graphqlError(errors, by) {
  const message = errors.map(shownReason).join('; ');
  const who = readWith(by);
  const advice = errors.some(isUnreadable) ? defaultTokenAdvice(by) : null;
  return bilingual(
    `GitHub API がエラーを返しました${who ? ` (${who.ja})` : ''}: ${message}${advice ? `。${advice.ja}` : ''}`,
    `GitHub API returned an error${who ? ` (${who.en})` : ''}: ${message}${advice ? `. ${advice.en}` : ''}`,
  );
}

// by は、問い合わせに使うトークン (credential)。
async function graphql(by, query, variables) {
  return withRetry(async () => {
    const response = await send(ENDPOINT, {
      method: 'POST',
      headers: { ...headers(by.token), 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    }, by);
    const { status, ok, body } = response;
    if (isRateLimited(response)) {
      throw failure(rateLimitMessage(status, by), { status, retryAfterMs: rateLimitWait(response.headers) });
    }
    if (!ok) throw httpError(status, { body, by });
    const errors = body?.errors ?? [];
    // data も errors もない応答は、途中で切れた応答と同じく、読み直す。
    if (body?.data == null && errors.length === 0) throw failure(UNREADABLE_RESPONSE, { retryAfterMs: 0 });
    if (errors.length) {
      if (errors.some((e) => e.type === 'RATE_LIMITED')) {
        throw failure(rateLimitMessage(errors.map(shownReason).join('; '), by), { retryAfterMs: rateLimitWait(response.headers) });
      }
      // 重いクエリは、200 のまま「Something went wrong ... timeout」というエラーになることがある。
      // 読めない項目のエラーは、タイムアウトではないので見ない。
      const timedOut = errors.some((e) => !isUnreadable(e) && /something went wrong|timeout|timed out/i.test(e.message));
      throw failure(graphqlError(errors, by), {
        forbidden: errors.every(isForbidden),
        notFound: errors.every((e) => e.type === 'NOT_FOUND'),
        retryAfterMs: timedOut ? 0 : undefined,
      });
    }
    return body.data;
  });
}

// 範囲を指定しない contributionsCollection のカレンダーは、コントリビューションのグラフと同じ地域の今日で終わる。
// グラフの日付の区切りはトークンで変わる (既定のトークンなら UTC、本人のトークンなら本人の地域) ので、今日もここから決める。
// この範囲 (およそ過去 1 年) の contributions の合計 (totalContributions) を、Contrib (1yr) にそのまま使う。
// プロフィールのコントリビューションのグラフに「N contributions in the last year」と出る数にあたるが、少しずれることがある。
const PROFILE_QUERY = `query ($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionYears
      contributionCalendar { totalContributions weeks { contributionDays { date } } }
    }
  }
}`;

function lastDate(calendar) {
  const lastWeek = calendar.weeks.at(-1)?.contributionDays ?? [];
  return lastWeek.at(-1)?.date;
}

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

async function fetchByYear(login, by, years, fields) {
  const batches = [];
  for (let i = 0; i < years.length; i += YEARS_PER_REQUEST) batches.push(years.slice(i, i + YEARS_PER_REQUEST));
  const results = await Promise.all(batches.map((batch) => graphql(by, yearsQuery(batch, fields), { login })));
  return results.flatMap((data, i) => batches[i].map((year) => data.user[`y${year}`]));
}

// トークンの権限が足りない項目は不明 (null) にして、カードの作成は続ける。
async function fetchCount(field, login, by) {
  try {
    const data = await graphql(by, countQuery(field), { login });
    return data.user[field].totalCount;
  } catch (error) {
    if (error.forbidden) return null;
    throw error;
  }
}

async function fetchContributions(login, by, years) {
  const collections = await fetchByYear(login, by, years, CALENDAR_FIELDS);
  const days = collections.flatMap((collection) =>
    collection.contributionCalendar.weeks.flatMap((week) =>
      week.contributionDays.map((day) => ({ date: day.date, count: day.contributionCount })),
    ),
  );
  const totalContributions = collections.reduce((sum, c) => sum + c.contributionCalendar.totalContributions, 0);
  return { days, totalContributions };
}

// 自分のリポジトリのスターの合計と、リポジトリの数。リポジトリの数は 1 ページ目で分かる。
async function fetchOwned(login, by) {
  let stars = 0;
  let totalRepositories;
  let after = null;
  do {
    const data = await graphql(by, OWNED_QUERY, { login, after });
    const page = data.user.repositories;
    totalRepositories ??= page.totalCount;
    const counts = page.nodes.map((node) => node.stargazerCount);
    stars += counts.reduce((sum, count) => sum + count, 0);
    // スターの多い順なので、0 のリポジトリが出たら残りもすべて 0。次のページは取らない。
    after = page.pageInfo.hasNextPage && !counts.includes(0) ? page.pageInfo.endCursor : null;
  } while (after);
  return { stars, totalRepositories };
}

// リポジトリごとの言語とバイト数。
async function fetchLanguages(login, by) {
  const repositories = [];
  let after = null;
  do {
    const data = await graphql(by, LANGUAGES_QUERY, { login, after });
    const page = data.user.repositories;
    for (const node of page.nodes) {
      repositories.push({ languages: node.languages.edges.map((edge) => ({ name: edge.node.name, size: edge.size })) });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return repositories;
}

// コントリビューションの数 (グラフの日ごとの数、今日、全期間と過去 1 年の合計) は contributionsToken で、
// リポジトリの数、スター、言語、PR、Issue は token で読む。
// 非公開リポジトリを読めるトークンでコントリビューションの数を読むと、だれでも見られるプロフィールのグラフより少なくなることがあった
// (2026-11 に、fine-grained のトークンで過去 1 年が 467、グラフは 482。期間を UTC にしても同じだった)。
// Action は contributionsToken に既定のトークンを渡す。既定のトークンは、ワークフローを動かしているリポジトリしか読めないので、
// だれでも見られるグラフと同じ見え方で読める。日付の区切りも、グラフと同じ UTC になる。
// contributionsToken を渡さなければ (CLI で CONTRIBUTIONS_TOKEN がないとき)、すべて token で読み、入力の名前は github-token だけを示す。
export async function fetchAccount(login, token, { contributionsToken } = {}) {
  const separate = contributionsToken !== undefined && contributionsToken !== token;
  const shared = contributionsToken === undefined ? ['github-token'] : ['github-token', 'contributions-token'];
  const api = credential(token, separate ? ['github-token'] : shared, separate);
  const contributionsApi = separate ? credential(contributionsToken, ['contributions-token'], true) : api;
  const profile = await graphql(contributionsApi, PROFILE_QUERY, { login }).catch((error) => {
    if (error.notFound) return { user: null };
    throw error;
  });
  if (!profile.user) throw new Error(userNotFound(login));
  const collection = profile.user.contributionsCollection;
  const today = lastDate(collection.contributionCalendar);
  if (!today) {
    throw new Error(bilingual('GitHub API の応答から今日の日付を読めませんでした', "Couldn't read today's date from the GitHub API response"));
  }

  // 残りの問い合わせは互いに関係しないので、まとめて送る。
  const [contributions, owned, repositories, totalPullRequests, totalIssues] = await Promise.all([
    fetchContributions(login, contributionsApi, collection.contributionYears),
    fetchOwned(login, api),
    fetchLanguages(login, api),
    fetchCount('pullRequests', login, api),
    fetchCount('issues', login, api),
  ]);
  const yearContributions = collection.contributionCalendar.totalContributions;
  return {
    login,
    // コントリビューションのグラフの日付での今日。連続記録とキャラクターの開始日は、この日付で数える。
    today,
    days: contributions.days,
    // 全期間の合計は、過去 1 年の合計より少なくならない。2 つは別の問い合わせで読むので、そのあいだに contributions が増えると、
    // 活動がすべて過去 1 年にあるアカウントでは、全期間の合計のほうが少なくなることがある。そのときは過去 1 年の合計に合わせる。
    totalContributions: Math.max(contributions.totalContributions, yearContributions),
    // 過去 1 年の contributions の合計。コミットのほか、PR、Issue、レビューなども入る。
    yearContributions,
    // 言語を数えるリポジトリ (フォークを除いたすべて)。
    repositories,
    totalPullRequests,
    totalIssues,
    // スターの合計 (stars) と、自分のリポジトリの数 (totalRepositories)。
    ...owned,
  };
}
