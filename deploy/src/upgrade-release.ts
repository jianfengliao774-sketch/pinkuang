/** There is no independently verified live API/static cutover proof yet. */
export const upgradeExecutionRelease = {
  ready: false,
  reason: '当前产品服务仍只识别旧合约图。后端双版本兼容及过渡静态页面尚无发布证明，禁止执行升级批次。',
} as const;

export function requireUpgradeExecutionRelease(): void {
  throw new Error(upgradeExecutionRelease.reason);
}
