import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, mkdirSync, realpathSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

export const FULL_TEST_ORIGIN = 'https://tapeout.cc.cd';
export const FULL_TEST_STATE = '/var/lib/bemine-full-test';
export const FULL_TEST_COOKIE = 'bemine_full_test_journal';
export const FULL_TEST_COOKIE_PATH = '/bemine-full-test/api';
export const FULL_TEST_DEPLOYERS = Object.freeze([
  '0x6f4d78fb59ec938cbaf65b9fc822ad04d00c155e',
  '0x7674fa446d42b1f7f150dc5e678cc525d275ea53',
  '0x042b23288e2316dfb6503488292fd0ad2f811ae7',
]);
export const FULL_TEST_TIMINGS = Object.freeze({ holdSeconds:0, proposalCooldownSeconds:0,
  voteSeconds:86400, listingSeconds:604800, upgradeDelaySeconds:0 });
const ADDRESS = /^0x[0-9a-f]{40}$/i, HASH = /^0x[0-9a-f]{64}$/i;
const FORBIDDEN_GAS = '0xa285d1933e32b5990625ac1f5bea205cf2606619';
const need = (ok, message) => { if (!ok) throw new Error(message); };
const lower = value => typeof value === 'string' ? value.toLowerCase() : '';
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;

export function profileDigest(profile) {
  return createHash('sha256').update(JSON.stringify(canonical(profile))).digest('hex');
}

/** Only public deployment inputs are permitted; this process never owns a key. */
export function validateFullTestProfile(profile, bundle, artifactDigest) {
  need(profile?.schemaVersion===1 && profile.profile==='full-test' && profile.chainId===56,
    'An explicit full-test runtime profile is required.');
  need(HASH.test(artifactDigest) && lower(profile.artifactDigest)===lower(artifactDigest)
    && bundle?.metadata?.profile==='full-test' && bundle.metadata.kind==='bemine-full-mainnet-test'
    && bundle.metadata.chainId===56 && HASH.test(bundle.metadata.formalArtifactDigest)
    && lower(bundle.metadata.formalArtifactDigest)!==lower(artifactDigest), 'Full-test artifact identity differs.');
  need(typeof bundle.sourceCommit==='string' && /^[0-9a-f]{40}$/i.test(bundle.sourceCommit)
    && profile.sourceHead===bundle.sourceCommit, 'Full-test source head differs.');
  for (const [name,value] of Object.entries(FULL_TEST_TIMINGS))
    need(profile.timings?.[name]===value && bundle.metadata.timings?.[name]===value,
      'Full-test timing profile differs: '+name);
  const roles=profile.roles;
  need(roles && ['deployer','administratorOne','administratorTwo','gasWallet']
    .every(name=>ADDRESS.test(roles[name]) && BigInt(roles[name])!==0n), 'Full-test public roles are incomplete.');
  need(lower(roles.deployer)==='0x6f4d78fb59ec938cbaf65b9fc822ad04d00c155e'
    && lower(roles.administratorOne)===lower(roles.deployer)
    && lower(roles.administratorTwo)===lower(roles.administratorOne)
    && lower(roles.gasWallet)==='0x0c14b1008cffe78711d65b13c8ce5ca9b944252c',
    'Full-test roles differ from the declared wallets.');
  need(![roles.deployer,roles.administratorOne,roles.administratorTwo,FORBIDDEN_GAS]
    .some(address=>lower(address)===lower(roles.gasWallet)), 'Full-test Gas wallet is not isolated.');
  need(Array.isArray(profile.forbiddenContracts) && profile.forbiddenContracts.length>=2
    && profile.forbiddenContracts.length<=100 && profile.forbiddenContracts.every(a=>ADDRESS.test(a)),
    'Formal contract denylist must be explicit.');
  return JSON.parse(JSON.stringify(profile));
}

export function assertTestDeployment(record, activation, profile) {
  need(record?.status==='complete' && record.kind==='integrated-v2' && record.chainId===56
    && FULL_TEST_DEPLOYERS.includes(lower(record.account))
    && lower(record.artifactDigest)===lower(profile.artifactDigest), 'A completed full-test deployment is required.');
  need(activation?.status==='complete' && activation.kind==='fresh-authority' && activation.chainId===56
    && lower(activation.account)===lower(record.account) && activation.deploymentId===record.id
    && lower(activation.genesisArtifactDigest)===lower(profile.artifactDigest),
    'All seven full-test Authority transactions must be completed.');
  for(const name of ['administratorOne','administratorTwo','gasWallet'])
    need(lower(activation[name])===lower(profile.roles[name]), 'Full-test Authority role differs: '+name);
  const forbidden=new Set(profile.forbiddenContracts.map(lower));
  need(record.addresses && Object.values(record.addresses).every(address=>ADDRESS.test(address)
    && !forbidden.has(lower(address))) && ADDRESS.test(activation.authorityAddress)
    && !forbidden.has(lower(activation.authorityAddress)), 'A formal contract cannot enter the full-test graph.');
}

export function activationEvidence(record) {
  const ids=['deployAuthority','coreOperator','coreTreasury','budgetOperator','budgetTreasury','coreOwner','budgetOwner'];
  need(record.steps?.length===ids.length && record.steps.every((s,i)=>s.id===ids[i]
    && s.status==='confirmed' && s.receipt?.status===1 && HASH.test(s.txHash)
    && HASH.test(s.receipt.blockHash) && Number.isSafeInteger(s.receipt.blockNumber)
    && s.receipt.blockNumber>0), 'Authority activation receipts are incomplete.');
  return {schemaVersion:1,kind:'fresh-authority',chainId:56,deployer:record.account,
    deploymentId:record.deploymentId,genesisArtifactDigest:record.genesisArtifactDigest,
    authority:{address:record.authorityAddress,deploymentTxHash:record.steps[0].txHash,
      administratorOne:record.administratorOne,administratorTwo:record.administratorTwo,gasWallet:record.gasWallet},
    steps:record.steps.map(s=>({id:s.id,txHash:s.txHash,blockNumber:s.receipt.blockNumber,blockHash:s.receipt.blockHash})),
    verifiedAt:new Date().toISOString()};
}

export function manifestFromVerifiedGraph(record, evidence, graph) {
  need(graph?.freshFactoryVerified===true && graph.freshAuthority
    && lower(graph.artifactDigest)===lower(record.artifactDigest), 'Fresh Authority graph verification did not complete.');
  const names={factory:'factory',shareMarket:'shareMarket',lens:'lens',beacon:'beacon',timelock:'timelock',
    portfolioFactory:'portfolioFactory',portfolioMarket:'portfolioShareMarket',portfolioBeacon:'portfolioBeacon',
    portfolioImplementation:'BudgetPortfolioVault',portfolioFactoryImplementation:'BudgetPortfolioFactory'};
  const addresses=Object.fromEntries(Object.entries(names).map(([key,name])=>[key,graph.addresses[name]]));
  const codehash=Object.fromEntries(Object.entries(names).map(([key,name])=>[key,graph.codehash[name]]));
  need(Object.values(addresses).every(a=>ADDRESS.test(a)) && Object.values(codehash).every(h=>HASH.test(h))
    && new Set(Object.values(addresses).map(lower)).size===10, 'Verified graph has missing or aliased contracts.');
  const init=record.steps.find(s=>s.id==='initialize'), last=evidence.steps.at(-1), f=graph.freshAuthority;
  need(init?.receipt?.status===1 && HASH.test(init.txHash) && HASH.test(init.receipt.blockHash)
    && lower(f.address)===lower(evidence.authority.address) && HASH.test(f.codehash)
    && lower(f.gasWallet)===lower(evidence.authority.gasWallet), 'Verified Authority manifest differs.');
  return {schemaVersion:1,kind:'integrated-v2',chainId:56,...addresses,codehash,
    authority:f.address,gasWallet:f.gasWallet,freshAuthority:{address:f.address,codehash:f.codehash,
      deploymentTxHash:f.deploymentTxHash,administratorOne:f.administratorOne,
      administratorTwo:f.administratorTwo,gasWallet:f.gasWallet},
    deployment:{txHash:init.txHash,blockNumber:init.receipt.blockNumber,blockHash:init.receipt.blockHash},
    artifactDigest:record.artifactDigest,sourceCommit:record.sourceCommit,verifiedAt:evidence.verifiedAt,
    verifiedBlockNumber:last.blockNumber,verifiedBlockHash:last.blockHash};
}

export function readRegularJson(path, maxBytes=20_000_000) {
  const info=lstatSync(path);
  need(info.isFile() && !info.isSymbolicLink() && info.size>0 && info.size<=maxBytes,
    'Full-test input must be a bounded regular file.');
  return JSON.parse(readFileSync(path,'utf8'));
}

export function privateDirectory(path) {
  const absolute=resolve(path);
  mkdirSync(absolute,{recursive:true,mode:0o700});
  let current=absolute;
  for (;;) {
    need(!lstatSync(current).isSymbolicLink(), 'Full-test state cannot use symlink directories.');
    const parent=dirname(current);if(parent===current)break;current=parent;
  }
  need(realpathSync(absolute)===absolute, 'Full-test state directory differs from its resolved path.');
  return absolute;
}

export function writePrivateJson(path, value) {
  const parent=privateDirectory(dirname(path)), target=resolve(path);
  need(target.startsWith(parent+sep), 'Full-test state escaped its directory.');
  const temporary=target+'.'+createHash('sha256').update(String(Math.random())).digest('hex').slice(0,16)+'.tmp';
  let fd;
  try {
    fd=openSync(temporary,'wx',0o600);writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);closeSync(fd);fd=undefined;
    try { need(!lstatSync(target).isSymbolicLink(), 'Full-test state cannot replace a symlink.'); }
    catch(error) { if(error.code!=='ENOENT')throw error; }
    renameSync(temporary,target);
  } catch(error) { if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary);}catch{}throw error; }
}
