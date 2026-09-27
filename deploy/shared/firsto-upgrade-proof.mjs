import { AbiCoder, Interface, ZeroHash, getAddress, getCreateAddress, keccak256, toUtf8Bytes } from 'ethers';

export const FIRSTO_UPGRADE_KIND = 'firsto-permanent-unique-upgrade-v1';
export const FIRSTO_UPGRADE_NAMES = Object.freeze(['PurchaseValidation', 'FlexiblePurchase', 'PoolVault', 'PoolFactory']);
const HASH = /^0x[\da-f]{64}$/i;
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const check = (ok,message) => { if (!ok) throw new Error(message); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])) : value;
export const evidenceDigest = value => keccak256(toUtf8Bytes(JSON.stringify(canonical(value))));
export function buildDigest(bundle) { const { sourceCommit:_source,...content } = bundle; return evidenceDigest(content); }
export async function settleReads(operations) {
  const results = await Promise.allSettled(operations);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  return results.map(result => result.value);
}

/** Only these four reviewed artifacts may replace a node of the local genesis graph. */
export function validateFirstoUpgradeRecord(record, genesisRecord, genesisBundle, upgradeBundle) {
  check(record?.schemaVersion === 2 && record.kind === FIRSTO_UPGRADE_KIND && record.chainId === 56
    && record.status === 'complete', 'Unsupported trusted upgrade record.');
  check(genesisRecord?.schemaVersion === 1 && same(record.genesisRecordDigest,evidenceDigest(genesisRecord))
    && same(record.genesisArtifactDigest,buildDigest(genesisBundle))
    && same(record.genesisArtifactDigest,genesisRecord.artifactDigest), 'Upgrade genesis evidence differs from the local trusted record.');
  check(same(record.artifactDigest,buildDigest(upgradeBundle)) && /^[\da-f]{40}$/i.test(record.sourceCommit ?? '')
    && /^[\da-f]{40}$/i.test(upgradeBundle.sourceCommit ?? ''), 'Upgrade source artifact digest is invalid.');
  check(record.deployments && Object.keys(record.deployments).sort().join(',') === [...FIRSTO_UPGRADE_NAMES].sort().join(','), 'Only the four reviewed upgrade deployments are supported.');
  const addresses = { ...genesisRecord.addresses }, used = new Set(Object.values(addresses).map(address => address.toLowerCase()));
  const transactions = new Set();
  for (const name of FIRSTO_UPGRADE_NAMES) {
    const item = record.deployments[name], address = getAddress(item?.address);
    check(!used.has(address.toLowerCase()) && address !== '0x0000000000000000000000000000000000000000'
      && HASH.test(item?.txHash) && !transactions.has(item.txHash.toLowerCase()), `Invalid replacement deployment: ${name}.`);
    used.add(address.toLowerCase()); transactions.add(item.txHash.toLowerCase()); addresses[name] = address;
    check(upgradeBundle.artifacts?.[name], `Missing upgrade artifact: ${name}.`);
  }
  const operation = record.operation;
  check(operation && HASH.test(operation.scheduleTxHash) && HASH.test(operation.executeTxHash)
    && HASH.test(operation.salt) && operation.predecessor === ZeroHash
    && !same(operation.scheduleTxHash,operation.executeTxHash), 'Invalid fixed upgrade operation evidence.');
  for (const txHash of [operation.scheduleTxHash,operation.executeTxHash]) {
    check(!transactions.has(txHash.toLowerCase()), 'Upgrade transaction hashes must be distinct.'); transactions.add(txHash.toLowerCase());
  }
  check(record.verification && Number.isSafeInteger(record.verification.blockNumber) && record.verification.blockNumber > 0
    && HASH.test(record.verification.blockHash) && Number.isFinite(Date.parse(record.verification.checkedAt)), 'Missing upgrade verification anchor.');
  // The dependencies are fixed policy, not a user-supplied graph or arbitrary codehash allowlist.
  for (const name of FIRSTO_UPGRADE_NAMES) {
    const expected = name === 'FlexiblePurchase' ? ['PoolFunds','PurchaseValidation'] : name === 'PoolVault'
      ? ['FlexiblePurchase','MiningOperations','PoolFunds','RewardAccounting','SaleGovernance','SaleSettlement','ShareCheckpoints'] : [];
    for (const refs of [upgradeBundle.artifacts[name].linkReferences,upgradeBundle.artifacts[name].deployedLinkReferences]) {
      const actual = [...new Set(Object.values(refs ?? {}).flatMap(libraries => Object.keys(libraries)))].sort();
      check(actual.join(',') === expected.sort().join(','), `Unexpected upgrade link graph: ${name}.`);
    }
  }
  return addresses;
}

function linkCreation(artifact, addresses) {
  let result = artifact.bytecode.slice(2);
  for (const libraries of Object.values(artifact.linkReferences ?? {})) for (const [name, locations] of Object.entries(libraries)) {
    const address = getAddress(addresses[name]).slice(2).toLowerCase();
    for (const { start,length } of locations) {
      check(Number.isSafeInteger(start) && start >= 0 && length === 20 && (start+length)*2 <= result.length,'Invalid creation link reference.');
      result = result.slice(0,start*2)+address+result.slice((start+length)*2);
    }
  }
  check(/^[\da-f]+$/i.test(result) && result.length%2 === 0,'Unresolved upgrade creation bytecode.');
  return `0x${result}`;
}
export function firstoUpgradeDeploymentData(name, bundle, addresses) {
  check(FIRSTO_UPGRADE_NAMES.includes(name),'Unsupported upgrade deployment.');
  const artifact = bundle.artifacts[name], iface = new Interface(artifact.abi);
  const args = name === 'PoolVault' ? [addresses.factory] : [];
  return linkCreation(artifact,addresses)+iface.encodeDeploy(args).slice(2);
}

const factoryAbi = new Interface(['function upgradeToAndCall(address,bytes)', 'function beginMachineRegistryMigration()',
  'function poolCount() view returns(uint256)', 'function machineRegistryStatus() view returns(bool initialized,bool ready,uint256 cursor,uint256 cutoff)',
  'event Upgraded(address indexed implementation)', 'event MachineRegistryMigrationStarted(uint256 cutoff)',
  'event MachineRegistryMigrationProgress(uint256 cursor,uint256 cutoff,bool ready)']);
const beaconAbi = new Interface(['function upgradeTo(address)', 'event Upgraded(address indexed implementation)']);
const timelockAbi = new Interface(['function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)',
  'function executeBatch(address[],uint256[],bytes[],bytes32,bytes32) payable', 'function isOperationDone(bytes32) view returns(bool)',
  'event CallScheduled(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data,bytes32 predecessor,uint256 delay)',
  'event CallExecuted(bytes32 indexed id,uint256 indexed index,address target,uint256 value,bytes data)']);

export function firstoUpgradeBatch(addresses, operation) {
  const targets = [addresses.factory,addresses.beacon,addresses.factory], values = [0n,0n,0n];
  const payloads = [factoryAbi.encodeFunctionData('upgradeToAndCall',[addresses.PoolFactory,'0x']),
    beaconAbi.encodeFunctionData('upgradeTo',[addresses.PoolVault]), factoryAbi.encodeFunctionData('beginMachineRegistryMigration')];
  const args = [targets,values,payloads,ZeroHash,operation.salt];
  const operationId = keccak256(AbiCoder.defaultAbiCoder().encode(['address[]','uint256[]','bytes[]','bytes32','bytes32'],args));
  return { targets,values,payloads,args,operationId,executeData:timelockAbi.encodeFunctionData('executeBatch',args) };
}

async function finalizedTransaction(provider, txHash, snapshot, finalized) {
  const [tx,receipt] = await settleReads([provider.getTransaction(txHash),provider.getTransactionReceipt(txHash)]);
  check(tx && receipt && same(tx.hash,txHash) && same(receipt.hash ?? receipt.transactionHash,txHash)
    && tx.chainId === 56n && receipt.status === 1 && same(tx.from,receipt.from)
    && Number.isSafeInteger(receipt.blockNumber) && receipt.blockNumber > 0 && receipt.blockNumber <= snapshot.number
    && receipt.blockNumber <= finalized.number && tx.blockNumber === receipt.blockNumber
    && same(tx.blockHash,receipt.blockHash), 'Upgrade transaction is not a matching successful finalized inclusion.');
  const block = await provider.getBlock(receipt.blockNumber);
  check(block?.number === receipt.blockNumber && same(block.hash,receipt.blockHash)
    && Number.isSafeInteger(receipt.index) && receipt.index >= 0 && tx.index === receipt.index
    && Array.isArray(block.transactions) && same(block.transactions[receipt.index],txHash),
  'Upgrade receipt is not a canonical block transaction inclusion.');
  return { tx,receipt,block };
}

function eventLogs(proof,address,abi,name) {
  return (proof.receipt.logs ?? []).filter(log => !log.removed && same(log.address,address)
    && same(log.transactionHash,proof.tx.hash) && same(log.blockHash,proof.receipt.blockHash)).flatMap(log => {
    try { const parsed = abi.parseLog(log); return parsed?.name === name ? [parsed] : []; } catch { return []; }
  });
}

/** Read-only, direct-call proof; wallet wrappers are not silently accepted as equivalent calldata. */
export async function verifyFirstoUpgradeProof(provider, trusted, snapshot) {
  const { upgradeRecord:record, genesisRecord, bundle, record:current } = trusted;
  const addresses = current.addresses, tag = `0x${snapshot.number.toString(16)}`;
  check(snapshot.number >= record.verification.blockNumber,'Snapshot precedes upgrade verification.');
  const [chain,finalized,anchor] = await settleReads([provider.send('eth_chainId',[]),provider.getBlock('finalized'),provider.getBlock(record.verification.blockNumber)]);
  check(BigInt(chain) === 56n && Number.isSafeInteger(finalized?.number) && HASH.test(finalized?.hash)
    && anchor?.number === record.verification.blockNumber && same(anchor.hash,record.verification.blockHash), 'Upgrade chain, finality or verification anchor changed.');
  const names = FIRSTO_UPGRADE_NAMES, proofs = await settleReads(names.map(name => finalizedTransaction(provider,record.deployments[name].txHash,snapshot,finalized)));
  for (let index=0;index<names.length;index++) {
    const name=names[index], {tx,receipt}=proofs[index], expected=addresses[name];
    check(tx.to === null && receipt.to === null && tx.value === 0n && same(tx.from,genesisRecord.account)
      && same(receipt.contractAddress,expected) && same(getCreateAddress({from:tx.from,nonce:tx.nonce}),expected)
      && same(tx.data,firstoUpgradeDeploymentData(name,bundle,addresses)), `Upgrade initcode or constructor differs: ${name}.`);
  }
  const [scheduled,executed] = await settleReads([finalizedTransaction(provider,record.operation.scheduleTxHash,snapshot,finalized),
    finalizedTransaction(provider,record.operation.executeTxHash,snapshot,finalized)]);
  const batch = firstoUpgradeBatch(addresses,record.operation);
  let decoded;
  try { decoded = timelockAbi.parseTransaction({data:scheduled.tx.data}); } catch { /* reject below */ }
  check(decoded?.name === 'scheduleBatch' && decoded.args[5] >= 172800n
    && same(scheduled.tx.data,timelockAbi.encodeFunctionData('scheduleBatch',[...batch.args,decoded.args[5]]))
    && same(scheduled.tx.from,genesisRecord.input.ownerMultisig) && same(scheduled.tx.to,addresses.timelock)
    && same(scheduled.receipt.to,addresses.timelock) && scheduled.tx.value === 0n,
  'Upgrade schedule must be the exact reviewed direct Timelock batch.');
  check(same(executed.tx.to,addresses.timelock) && same(executed.receipt.to,addresses.timelock)
    && executed.tx.value === 0n && same(executed.tx.data,batch.executeData)
    && executed.receipt.blockNumber > scheduled.receipt.blockNumber
    && BigInt(executed.block.timestamp) >= BigInt(scheduled.block.timestamp)+decoded.args[5]
    && proofs.every(proof => proof.receipt.blockNumber < scheduled.receipt.blockNumber),
  'Upgrade execution must atomically upgrade Factory, Beacon and begin migration after the full delay.');
  for (const [proof,name] of [[scheduled,'CallScheduled'],[executed,'CallExecuted']]) {
    const logs=eventLogs(proof,addresses.timelock,timelockAbi,name);
    check(logs.length === 3 && logs.every((log,index) => same(log.args.id,batch.operationId) && log.args.index === BigInt(index)
      && same(log.args.target,batch.targets[index]) && log.args.value === 0n && same(log.args.data,batch.payloads[index])
      && (name !== 'CallScheduled' || log.args.predecessor === ZeroHash && log.args.delay === decoded.args[5])), 'Upgrade Timelock event sequence differs.');
  }
  for (const [name,abi,address,implementation] of [['Factory',factoryAbi,addresses.factory,addresses.PoolFactory],['Beacon',beaconAbi,addresses.beacon,addresses.PoolVault]]) {
    const logs=eventLogs(executed,address,abi,'Upgraded');
    check(logs.length === 1 && same(logs[0].args.implementation,implementation), `${name} upgrade event differs.`);
  }
  const started=eventLogs(executed,addresses.factory,factoryAbi,'MachineRegistryMigrationStarted');
  const progressed=eventLogs(executed,addresses.factory,factoryAbi,'MachineRegistryMigrationProgress');
  check(started.length === 1 && started[0].args.cutoff === 0n && progressed.length === 1 && progressed[0].args.cursor === 0n
    && progressed[0].args.cutoff === 0n && progressed[0].args.ready === true, 'Automatic upgrade evidence currently supports zero historical pools only.');
  const read=async(to,abi,method,args,blockTag)=>abi.decodeFunctionResult(method,await provider.send('eth_call',
    [{to,data:abi.encodeFunctionData(method,args)},blockTag]));
  const [before,status,done] = await settleReads([
    read(addresses.factory,factoryAbi,'poolCount',[],`0x${(executed.receipt.blockNumber-1).toString(16)}`),
    read(addresses.factory,factoryAbi,'machineRegistryStatus',[],tag),read(addresses.timelock,timelockAbi,'isOperationDone',[batch.operationId],tag),
  ]);
  check(before[0] === 0n && status[0] === true && status[1] === true && status[2] === 0n && status[3] === 0n && done[0] === true,
    'Upgrade migration is incomplete or historical pools require a separate reviewed migration proof.');
  const [after,finalizedAfter,finalChain] = await settleReads([
    provider.getBlock(snapshot.number),provider.getBlock(finalized.number),provider.send('eth_chainId',[])]);
  check(after?.number === snapshot.number && same(after.hash,snapshot.hash)
    && finalizedAfter?.number === finalized.number && same(finalizedAfter.hash,finalized.hash)
    && BigInt(finalChain) === 56n,'Chain changed during upgrade proof.');
  return { operationId:batch.operationId, executionTxHash:executed.tx.hash, executedBlock:executed.receipt.blockNumber, historicalPoolCount:0 };
}
