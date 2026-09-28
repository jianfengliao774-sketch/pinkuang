/** Local compatibility code is not proof that both product runtimes were published and accepted. */
export const upgradeExecutionRelease = {
  ready: false,
  reason: '后端双版本兼容和过渡静态页面尚未取得独立的正式发布与验收证明，禁止安排或执行升级批次。',
} as const;

export function requireUpgradeExecutionRelease(): void {
  throw new Error(upgradeExecutionRelease.reason);
}
