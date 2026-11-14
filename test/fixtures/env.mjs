// 子プロセスで動かすテスト用の環境変数。開発者の環境や git の設定に結果を左右されないようにする。
// git フックの中で動かすと GIT_DIR などが外のリポジトリを指すので、GIT_ で始まるものは渡さない。
// Actions の中で動かしても既定のブランチの判定が効かないよう、GITHUB_ で始まるものも渡さない。
// CLI が読む CONTRIBUTIONS_TOKEN と、偽の GitHub API の設定 (FAKE_ で始まるもの) も、テストが渡したものだけにする。
import { devNull } from 'node:os';

const INHERITED = /^(INPUT_|GIT_|GITHUB_|FAKE_|CONTRIBUTIONS_TOKEN$)/;

export function isolatedEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !INHERITED.test(name)));
  return { ...env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', ...extra };
}
