import { loadFreshIndexManifest } from './chain-index/fresh-manifest.mjs';
import { freshRuntimeLayout,freshRuntimeSource,freshGraphIdentity,assertFreshIdentity,need,same,HASH } from '../shared/fresh-runtime-identity.mjs';

export function freshProductConfiguration(env=process.env) {
  if(env.BEMINE_FRESH_PRODUCT_ENABLED===undefined || env.BEMINE_FRESH_PRODUCT_ENABLED==='0')return null;
  const layout=freshRuntimeLayout(env);
  need(env.BEMINE_FRESH_PRODUCT_ENABLED==='1' && env.BEMINE_FRESH_CONSOLE_PRE_GENESIS==='0'
    && env.BEMINE_FRESH_STAGE2_HOLD==='1' && env.HOST==='127.0.0.1' && env.PORT===layout.apiPort
    && env.AUTHORITY_RELAY_PUBLIC_ENABLED==='1' && env.AUTHORITY_RELAY_ENABLED==='0',
  'Fresh product mode requires its separate 4187 process and private relay proxy.');
  need(env.BEMINE_INDEX_URL===`http://127.0.0.1:${layout.indexPort}`,'Fresh product requires the dedicated v4 index.');
  const machineSourceHead=env.BEMINE_FRESH_MACHINE_SOURCE_HEAD;
  need(machineSourceHead===undefined || typeof machineSourceHead==='string' && /^[0-9a-f]{40}$/.test(machineSourceHead),
    'Fresh machine source head must be an explicit lowercase forty-character commit.');
  const manifest=loadFreshIndexManifest(env.BEMINE_FRESH_PRODUCT_MANIFEST_PATH,env.BEMINE_FRESH_PRODUCT_MANIFEST_SHA256),
    sourceHead=freshRuntimeSource();
  return {manifest,sourceHead,machineSourceHead:machineSourceHead??sourceHead,
    indexUrl:`http://127.0.0.1:${layout.indexPort}/health`};
}

export function validateFreshProductBindings(config,trusted,factories) {
  const m=config?.manifest,a=trusted?.record?.addresses,f=trusted?.freshAuthority;
  need(m && m.kind==='fresh-v4-index' && a?.FreshPoolFactory && f
    && trusted.record.chainId===56 && same(m.artifactDigest,trusted.record.artifactDigest),
  'Fresh product must pin a completed independent fresh deployment.');
  for(const [key,name] of Object.entries({factory:'factory',shareMarket:'shareMarket',portfolioFactory:'portfolioFactory',
    portfolioMarket:'portfolioShareMarket',lens:'lens',beacon:'beacon',timelock:'timelock',portfolioBeacon:'portfolioBeacon',
    portfolioImplementation:'BudgetPortfolioVault',portfolioFactoryImplementation:'BudgetPortfolioFactory'}))
    need(same(m[key],a[name]) && same(m.codehash[key],trusted.record.verification.code[name]?.codehash),
      'Fresh product manifest differs from genesis: '+key);
  const initialize=trusted.record.steps.find(s=>s.id==='initialize'),last=f.steps.at(-1);
  need(same(m.deployment.txHash,initialize.txHash) && m.deployment.blockNumber===initialize.receipt.blockNumber
    && same(m.deployment.blockHash,initialize.receipt.blockHash) && m.verifiedBlockNumber===last.blockNumber
    && same(m.verifiedBlockHash,last.blockHash) && same(m.authority,f.authority.address)
    && same(m.gasWallet,f.authority.gasWallet) && same(m.freshAuthority.deploymentTxHash,f.authority.deploymentTxHash)
    && same(m.freshAuthority.administratorOne,f.authority.administratorOne)
    && same(m.freshAuthority.administratorTwo,f.authority.administratorTwo),'Fresh activation manifest differs.');
  need(factories.size===2 && [a.factory,a.portfolioFactory].every(address=>factories.has(address.toLowerCase())),
    'Fresh product allowlist must contain exactly its two Factories.');
}

/** No cached/display snapshot can issue a fresh transaction permission. */
export function createFreshProductGate(config,{trusted,factories,machineReader,fetcher=fetch,now=Date.now}={}) {
  if(!config)return null;
  validateFreshProductBindings(config,trusted,factories);
  need(config.machineSourceHead===undefined || typeof config.machineSourceHead==='string' && /^[0-9a-f]{40}$/.test(config.machineSourceHead),
    'Fresh machine source head must be an explicit lowercase forty-character commit.');
  const machineSourceHead=config.machineSourceHead??config.sourceHead;
  need(typeof machineReader==='function','Fresh product machine readiness reader is required.');
  const m=config.manifest;
  const readIndex=async()=>{
    const signal=AbortSignal.timeout(5000);
    while(true) {
      signal.throwIfAborted();
      const response=await fetcher(config.indexUrl,{cache:'no-store',signal});
      need(response.ok,'Fresh index health is unavailable.');
      const bytes=await response.text();signal.throwIfAborted();
      need(bytes.length<=65536,'Fresh index health is oversized.');
      const source=JSON.parse(bytes).source;signal.throwIfAborted();
      const valid=source?.chainId===56 && same(source.factory,m.factory) && same(source.market,m.shareMarket)
        && same(source.portfolioFactory,m.portfolioFactory) && same(source.portfolioMarket,m.portfolioMarket)
        && source.startBlock===m.deployment.blockNumber && Number.isSafeInteger(source.indexedThrough)
        && source.indexedThrough>=m.verifiedBlockNumber && Number.isSafeInteger(source.observedSafeHead)
        && source.observedSafeHead>=source.indexedThrough && HASH.test(source.indexedBlockHash)
        && Number.isSafeInteger(source.indexedTimestamp) && now()/1000-source.indexedTimestamp>=0
        && now()/1000-source.indexedTimestamp<=90;
      need(valid,'Fresh index is incomplete, stale or belongs to another graph.');
      if(source.complete===true && !source.unknownReason && source.indexedThrough===source.observedSafeHead)return source;
      need(source.complete===false && source.unknownReason==='index_refreshing',
        'Fresh index is incomplete, stale or belongs to another graph.');
      // Wait only on the fixed local health surface; its existing sync task does
      // the work. Every response and pause shares the original five-second budget.
      await new Promise((resolve,reject)=>{
        const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);resolve();};
        const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);};
        const timer=setTimeout(finish,100);signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted)abort();
      });
    }
  };
  const graphIdentity=graph=>{
    const identity=freshGraphIdentity(graph);
    assertFreshIdentity(identity,{chainId:56,artifactDigest:m.artifactDigest,factory:m.factory,market:m.shareMarket,
      portfolioFactory:m.portfolioFactory,portfolioMarket:m.portfolioMarket,authority:m.authority,
      authorityCodehash:m.freshAuthority.codehash,gasWallet:m.gasWallet});
    return identity;
  };
  const validate=async(provider,identity,block,source,machine)=>{
    try {need(source?.chainId===56 && source.complete===true && !source.unknownReason
      && same(source.factory,m.factory) && same(source.market,m.shareMarket)
      && same(source.portfolioFactory,m.portfolioFactory) && same(source.portfolioMarket,m.portfolioMarket)
      && source.startBlock===m.deployment.blockNumber
      && Number.isSafeInteger(source.indexedThrough) && source.indexedThrough>=m.verifiedBlockNumber
      && source.indexedThrough===source.observedSafeHead && source.indexedThrough<=block.number
      && block.number-source.indexedThrough<=120 && HASH.test(source.indexedBlockHash)
      && Number.isSafeInteger(source.indexedTimestamp) && now()/1000-source.indexedTimestamp>=0
      && now()/1000-source.indexedTimestamp<=90,'Fresh index is incomplete, stale or belongs to another graph.');
    } catch(error) {
      // Diagnostics expose only fixed predicates, never index payloads or RPC details.
      const indexed=source?.indexedThrough,integer=Number.isSafeInteger(indexed),age=now()/1000-source?.indexedTimestamp;
      error.indexFacts={
        indexNotAheadOfGraph:integer && indexed<=block.number,
        indexFresh:Number.isSafeInteger(source?.indexedTimestamp) && age>=0 && age<=90,
        indexComplete:source?.complete===true && !source.unknownReason,
        indexSameGraph:source?.chainId===56 && same(source.factory,m.factory) && same(source.market,m.shareMarket)
          && same(source.portfolioFactory,m.portfolioFactory) && same(source.portfolioMarket,m.portfolioMarket)
          && source.startBlock===m.deployment.blockNumber,
        indexAtSafeHead:integer && indexed===source?.observedSafeHead,
        indexInBlockWindow:integer && block.number-indexed<=120,
        indexHasCanonicalHash:HASH.test(source?.indexedBlockHash),
        indexAfterActivation:integer && indexed>=m.verifiedBlockNumber,
      };
      throw error;
    }
    need(machine?.schemaVersion===1 && machine.ready===true && machine.relayEnabled===true
      && machine.attestOnly===false && machine.sourceHead===machineSourceHead
      && Number.isSafeInteger(machine.checkedAt) && now()-machine.checkedAt>=0
      && now()-machine.checkedAt<=15_000 && machine.drain?.oldSendersDisabled===true,
    'Fresh operational services have not proved readiness.');
    assertFreshIdentity(machine.identity,identity);
    for(const role of ['purchase','mining']) need(machine.workers?.[role]?.ready===true
      && machine.workers[role].sourceHead===machineSourceHead,'Fresh '+role+' worker is unavailable.');
    need(same((await provider.getBlock(source.indexedThrough))?.hash,source.indexedBlockHash)
      && same((await provider.getBlock(block.number))?.hash,block.hash),'Fresh readiness chain changed.');
    return {ready:true,indexedThrough:source.indexedThrough,checkedAt:now()};
  };
  const gate=async(provider,graph,block)=>{
    const identity=graphIdentity(graph);
    // Fully consume the body during its own timeout, even if the independent
    // machine proof takes longer. Existing three-argument callers remain valid.
    const [source,machine]=await Promise.all([readIndex(),machineReader()]);
    return validate(provider,identity,block,source,machine);
  };
  gate.prepareIndex=async()=>{
    // Capture this request's index before the caller pins its graph block. An
    // index that advances during the graph proof cannot become its future tip.
    const source=await readIndex();let used=false;
    return async(provider,graph,block)=>{
      need(!used,'Fresh index validation has already been used.');used=true;
      const identity=graphIdentity(graph),machine=await machineReader();
      return validate(provider,identity,block,source,machine);
    };
  };
  return gate;
}

export const FRESH_AUTHORITY_ONLY = new Set(['createPool','createPoolWithExpiry','createFlexiblePool',
  'createFlexiblePoolChecked','createBudgetChildPool','createPortfolio','mine','buyOfficial','buyFirsto']);
