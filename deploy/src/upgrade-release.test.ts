import assert from 'node:assert/strict';
import {test} from 'node:test';
import {requireUpgradeExecutionRelease,upgradeExecutionRelease} from './upgrade-release';

test('upgrade batch scheduling and execution remain fail-closed without an independently verified runtime cutover', () => {
  assert.equal(upgradeExecutionRelease.ready,false);
  assert.match(upgradeExecutionRelease.reason,/后端双版本兼容.*过渡静态页面/);
  assert.throws(() => requireUpgradeExecutionRelease(),/禁止安排或执行升级批次/);
});
