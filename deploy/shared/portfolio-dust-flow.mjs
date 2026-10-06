const same = (left, right) => typeof left === 'string' && typeof right === 'string'
  && left.toLowerCase() === right.toLowerCase();
const need = (condition, message) => { if (!condition) throw new Error(message); };
const steps = ['deploy', 'schedule'];
const pendingStep = row => steps.find(step => row?.transactions?.[step]
  && row.transactions[step].status !== 'confirmed');

function journalScope(previous, current) {
  need(current && current.kind === previous.kind && same(current.configDigest, previous.configDigest)
    && same(current.salt, previous.salt) && current.delaySeconds === previous.delaySeconds,
  '部署记录在核验期间发生变化，请核对原交易；不会发送新交易。');
}
function verifiedProof(proof, row) {
  need(proof && proof.chainId === 56 && proof.readOnly === true && proof.chainActionsPerformed === false
    && Number.isSafeInteger(proof.blockNumber) && proof.blockNumber > 0,
  '当前链状态尚未获得完整只读核验；不会发送新交易。');
  if (row?.transactions?.deploy?.status === 'confirmed') {
    need(proof.replacementVerified === true && same(proof.replacement, row.transactions.deploy.address),
      '补丁完整运行代码核验与原部署地址不一致；不会发送新交易。');
  }
  return proof;
}
function confirmedStep(step, previous, current, proof) {
  journalScope(previous, current);
  verifiedProof(proof, current);
  const original = previous.transactions[step], confirmed = current.transactions[step];
  need(confirmed?.status === 'confirmed' && Number.isSafeInteger(confirmed.blockNumber)
    && proof.blockNumber >= confirmed.blockNumber,
  '原交易尚未获得完整链上核验，记录保留；不会发送新交易。');
  if (original) need(same(original.from, confirmed.from) && original.nonce === confirmed.nonce
    && same(original.dataHash, confirmed.dataHash) && (!original.txHash || same(original.txHash, confirmed.txHash)),
  '原交易记录在核验期间发生变化；不会发送新交易。');
  if (step === 'schedule') need(['waiting', 'ready', 'done'].includes(proof.operation),
    '原排程目前不存在或已被取消。记录保留，请先核对原链上操作，不会重复排程。');
}

/**
 * Run inside the caller's exclusive journal lock. No wallet/provider is held here.
 * checkOriginal(step, row, lastProof) returns a fresh complete proof or null while the original
 * receipt is pending; send(step, row) returns the fresh proof obtained after its
 * exact receipt and runtime checks. Both save their confirmed journal before
 * returning. Saved confirmations always pass checkOriginal on a new invocation.
 * Only the last proof obtained during this invocation is reused between phases.
 * A callback may reuse lastProof only after rechecking this exact original receipt
 * and its proof scope; no proof is supplied on the first check of a new invocation.
 */
export async function runPortfolioDustFlow({ getJournal, createJournal, saveJournal, checkOriginal, inspect, send }) {
  let row = getJournal(), proof = null;
  const checked = new Set();
  const recover = pendingStep(row);
  if (recover) {
    proof = await checkOriginal(recover, row, proof);
    if (!proof) return { pending: true, proof: null };
    const current = getJournal();
    confirmedStep(recover, row, current, proof);
    row = current; checked.add(recover);
  }
  // Local confirmed records are never accepted without this invocation's receipt checks.
  for (const step of steps) {
    if (row?.transactions?.[step]?.status !== 'confirmed' || checked.has(step)) continue;
    proof = await checkOriginal(step, row, proof);
    need(proof, '原确认记录尚不能在当前链上复核，请稍后继续。');
    const current = getJournal();
    confirmedStep(step, row, current, proof);
    row = current; checked.add(step);
  }
  need(!pendingStep(row), '原交易尚待核验，记录保留；不会发送新交易。');
  if (!proof) proof = verifiedProof(await inspect(row), row);
  if (!row) {
    row = createJournal(proof); saveJournal(row);
    const current = getJournal(); journalScope(row, current); row = current;
  }
  if (!row.transactions.deploy) {
    need(proof.implState === 'old', '当前合约已变化，请重新核对升级范围。');
    proof = await send('deploy', row);
    const current = getJournal();
    confirmedStep('deploy', row, current, proof);
    row = current;
  }
  // A deployment's confirmed receipt already supplied all candidate/graph/operation checks.
  verifiedProof(proof, row);
  need(!pendingStep(row), '原交易尚待核验，记录保留；不会发送新交易。');
  if (!row.transactions.schedule && proof.operation === 'unscheduled') {
    need(proof.implState === 'old', '此补丁已生效或实现发生变化。');
    proof = await send('schedule', row);
    const current = getJournal();
    confirmedStep('schedule', row, current, proof);
    row = current;
  }
  // In particular, a saved confirmed schedule must not hide subsequent cancellation.
  need(['waiting', 'ready', 'done'].includes(proof.operation),
    '排程尚未在当前链上确认或已被取消，原记录已保留；不会重复排程。');
  need(proof.implState === (proof.operation === 'done' ? 'new' : 'old'),
    '当前实现与升级排程阶段不一致。');
  return { pending: false, proof };
}
