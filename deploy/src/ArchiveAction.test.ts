import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArchiveCompletedAction } from './ArchiveAction';
import type { DeploymentSnapshot } from './deployment';

const snapshot = (factoryStep: string) => ({
  status: 'complete', steps: [{ id: factoryStep }],
}) as DeploymentSnapshot;

test('fresh genesis never renders an archive action while older deployments retain one', () => {
  const props = { busy: false, journalReady: true, onBsc: true, onArchive: () => {} };
  assert.equal(renderToStaticMarkup(createElement(ArchiveCompletedAction,
    { ...props, snapshot: snapshot('FreshPoolFactory') })), '');
  assert.match(renderToStaticMarkup(createElement(ArchiveCompletedAction,
    { ...props, snapshot: snapshot('PoolFactory') })),
    /归档本次部署并新建/);
});
