import { createServer, request as httpRequest } from 'node:http';
import { existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FULL_TEST_ORIGIN, FULL_TEST_STATE, FULL_TEST_COOKIE, FULL_TEST_COOKIE_PATH, FULL_TEST_DEPLOYERS,
  validateFullTestProfile, assertTestDeployment, activationEvidence, manifestFromVerifiedGraph,
  profileDigest, readRegularJson, privateDirectory, writePrivateJson,
} from './server-profile.mjs';

const fail=(status,message)=>{const error=new Error(message);error.status=status;throw error;};
const same=(a,b)=>typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
const HASH=/^0x[0-9a-f]{64}$/i;
const READINESS_REFRESH_MS=15_000, READINESS_DISPLAY_TTL_MS=30_000;
const json=(res,status,value)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value));};
async function readActivationBody(req) {
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))fail(415,'JSON is required.');
  if(req.headers['content-encoding'] && req.headers['content-encoding']!=='identity')fail(415,'Compressed activation is not supported.');
  const size=Number(req.headers['content-length']??0);
  if(!Number.isSafeInteger(size) || size<0 || size>1024)fail(413,'Activation request is too large.');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
  const abort=()=>req.destroy();controller.signal.addEventListener('abort',abort,{once:true});
  try {
    const chunks=[];let count=0;
    for await(const chunk of req){count+=chunk.length;if(count>1024)fail(413,'Activation request is too large.');chunks.push(chunk);}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'Invalid activation JSON.');}
    if(!body || Array.isArray(body) || Object.keys(body).some(k=>k!=='account')
      || !/^0x[0-9a-f]{40}$/i.test(body.account))fail(400,'Activation accepts only the selected public wallet.');
    return body;
  } finally {clearTimeout(timer);controller.signal.removeEventListener('abort',abort);}
}

/** No formal module fallback: ops must install the independently scoped runtime. */
export async function loadFullTestRuntime() {
  const root=new URL('./runtime/deploy/',import.meta.url);
  const [journal,graph,proxy,firsto,index,overview,fresh,ipc,activation,digest]=await Promise.all([
    import(new URL('server/journal-api.mjs',root)),import(new URL('server/product-graph.mjs',root)),
    import(new URL('server/live-data-proxy.mjs',root)),import(new URL('server/firsto-proxy.mjs',root)),
    import(new URL('server/chain-index/server.mjs',root)),import(new URL('server/chain-index/overview-stats.mjs',root)),
    import(new URL('server/chain-index/fresh-manifest.mjs',root)),import(new URL('server/authority-ipc.mjs',root)),
    import(new URL('server/fresh-activation-journal.mjs',root)),import(new URL('server/artifact-digest.mjs',root)),
  ]);
  return {...journal,...graph,...proxy,...firsto,...index,...overview,...fresh,...ipc,...activation,...digest};
}

/** Isolated public API. All trust enters through its private journal and the bound test build. */
export async function createFullTestService({runtime,profile,bundle,artifactDigest,provider,rpcUrl,
  stateRoot=FULL_TEST_STATE,origin=FULL_TEST_ORIGIN,gasWalletProofReader,freshProductReadinessReader,
  authorityRelayFactory,assertInputsCurrent=()=>{},allowTemporaryState=false,manageIndex=false,now=Date.now,
  salePolicyCatalogPath,salePolicyArtifactPath}={}) {
  if(!runtime || !provider || typeof rpcUrl!=='string' || !/^https:\/\//.test(rpcUrl))
    throw new Error('Full-test requires its isolated runtime and HTTPS read provider.');
  if(origin!==FULL_TEST_ORIGIN && !(allowTemporaryState && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)))
    throw new Error('Full-test origin differs.');
  if(!allowTemporaryState && resolve(stateRoot)!==FULL_TEST_STATE)throw new Error('Full-test state must use its dedicated directory.');
  const trustedProfile=validateFullTestProfile(profile,bundle,artifactDigest),binding=profileDigest(trustedProfile);
  const state=privateDirectory(stateRoot),journalPath=join(state,'journal.sqlite'),activePath=join(state,'activation-state.json');
  const graphPaths={record:join(state,'genesis.json'),activation:join(state,'authority-activation.json'),
    manifest:join(state,'active-manifest.json'),index:join(state,'index-manifest.json'),
    ready:join(state,'activation-ready.json')};
  const cookie={sessionCookieName:FULL_TEST_COOKIE,sessionCookiePath:FULL_TEST_COOKIE_PATH};
  const currentDigest=()=>{assertInputsCurrent();return artifactDigest;};
  const deploymentJournal=runtime.createJournalService({dbPath:journalPath,origin,rpcUrl,provider,
    ...cookie,secureCookies:origin.startsWith('https:'),currentArtifactDigest:currentDigest,
    assertSigningInputsCurrent:assertInputsCurrent,deploymentAccountAllowlist:FULL_TEST_DEPLOYERS,
    genesisBundle:bundle,expectedGasWallet:trustedProfile.roles.gasWallet,gasWalletProofReader,
    freshConsolePreGenesis:false,freshStage2Hold:false});
  let active=null,indexService=null,productJournal=null,relayService=null,activating=null,closed=false;
  const rpcProxy=runtime.createLiveDataProxy({rpcUrl,indexUrl:'http://127.0.0.1:4204'});
  let activeProxy=null;
  const streams=new Set(),requests=new Set();
  let readinessPending=null,readiness={ready:false,checkedAt:null};
  function readyMarker(candidate) {
    return {schemaVersion:1,profile:'full-test',chainId:56,sourceHead:trustedProfile.sourceHead,
      artifactDigest,profileDigest:binding,deploymentId:candidate.record.id,creator:candidate.record.account,
      factory:candidate.manifest.factory,portfolioFactory:candidate.manifest.portfolioFactory,
      manifestSha256:createHash('sha256').update(JSON.stringify(candidate.manifest,null,2)+'\n').digest('hex'),
      indexManifestSha256:createHash('sha256').update(JSON.stringify(candidate.indexManifest,null,2)+'\n').digest('hex'),
      activatedAt:candidate.activatedAt};
  }
  function ensureReadyMarker(candidate) {
    const expected=readyMarker(candidate);
    if(existsSync(graphPaths.ready)) {
      if(JSON.stringify(readRegularJson(graphPaths.ready,16384))!==JSON.stringify(expected))
        fail(409,'Test activation ready marker differs from the installed graph.');
      return;
    }
    writePrivateJson(graphPaths.ready,expected);
  }
  const config=async()=>{
    const age=readiness.checkedAt===null?Infinity:now()-readiness.checkedAt;
    if(productJournal && freshProductReadinessReader && !readinessPending && (age<0 || age>=READINESS_REFRESH_MS)) {
      // Bootstrap stays cheap while an independent proof runs. Until that
      // proof succeeds, automation is explicitly unavailable to the UI.
      const pending=Promise.resolve().then(()=>productJournal.verifyFreshOperationalReadiness())
        .then(result=>{readiness={ready:result?.ready===true,checkedAt:now()};},
          ()=>{readiness={ready:false,checkedAt:now()};});
      readinessPending=pending;requests.add(pending);
      pending.finally(()=>{requests.delete(pending);if(readinessPending===pending)readinessPending=null;});
    }
    // Retain the last live result while the next display refresh runs. Actual
    // privileged submissions still invoke the journal's fresh readiness gate.
    const operationalReady=readiness.ready && age>=0 && age<READINESS_DISPLAY_TTL_MS;
    const cachedGraph=productJournal?.currentProductGraphSnapshot?.();
    const salePolicyUpgrade=cachedGraph?.salePolicyUpgrade && same(cachedGraph.artifactDigest,artifactDigest)
      && same(cachedGraph.factory,active?.manifest.factory) ? cachedGraph.salePolicyUpgrade : active?.salePolicyUpgrade;
    return {schemaVersion:1,profile:'full-test',productFamily:'fresh-v4',testProfile:true,chainId:56,
      artifactDigest,sourceHead:trustedProfile.sourceHead,roles:trustedProfile.roles,timings:trustedProfile.timings,
      status:active?'ready':'unconfigured',stage:active?'fresh-active':'unconfigured',operationalReady,
      ...(active?{manifest:active.manifest,creator:active.record.account,activatedAt:active.activatedAt,
        ...(salePolicyUpgrade?{salePolicyUpgrade}:{})}:{}),
      dataServicesReady:operationalReady,automationReady:operationalReady,
      operationalReadinessCheckedAt:readiness.checkedAt};
  };
  async function verify(record,activation) {
    assertInputsCurrent();assertTestDeployment(record,activation,trustedProfile);
    runtime.validateFreshActivation(activation,record.account,record,trustedProfile.roles.gasWallet);
    await runtime.verifyCompletedDeployment(provider,record,{trustedArtifactBundle:bundle});
    const evidence=activationEvidence(activation);
    const trusted=runtime.productGraphConfiguration({record,bundle,productActivation:evidence,
      expectedGasWallet:trustedProfile.roles.gasWallet,salePolicyCatalogPath,salePolicyArtifactPath});
    const block=await provider.getBlock('latest');
    if(!Number.isSafeInteger(block?.number) || !HASH.test(block.hash))fail(503,'Canonical test graph block is unavailable.');
    const graph=await runtime.verifyProductGraph(provider,record.addresses.factory,trusted,block);
    if(!same((await provider.getBlock(block.number))?.hash,block.hash))fail(409,'Chain changed during test activation.');
    const manifestGraph=graph.salePolicyUpgrade ? {...graph,
      addresses:{...graph.addresses,BudgetPortfolioVault:record.addresses.BudgetPortfolioVault},
      codehash:{...graph.codehash,BudgetPortfolioVault:record.verification.code.BudgetPortfolioVault.codehash}} : graph;
    const manifest=manifestFromVerifiedGraph(record,evidence,manifestGraph);
    const indexManifest=runtime.createFreshIndexManifest(manifest);
    return {schemaVersion:1,profile:'full-test',profileDigest:binding,artifactDigest,
      record:structuredClone(record),activationRecord:structuredClone(activation),evidence,manifest,indexManifest,
      ...(graph.salePolicyUpgrade?{salePolicyUpgrade:graph.salePolicyUpgrade}:{}),
      activatedAt:new Date(now()).toISOString()};
  }
  async function activateServices(candidate) {
    const m=candidate.manifest;
    // Bridge files are operator-owned derivations of the independently verified
    // graph. They are never accepted as browser request payloads.
    writePrivateJson(graphPaths.record,candidate.record);writePrivateJson(graphPaths.activation,candidate.evidence);
    writePrivateJson(graphPaths.manifest,m);writePrivateJson(graphPaths.index,candidate.indexManifest);
    const freshProduct={manifest:candidate.indexManifest,sourceHead:trustedProfile.sourceHead,
      machineSourceHead:trustedProfile.sourceHead,indexUrl:'http://127.0.0.1:4204/health'};
    let nextIndex,nextJournal,nextRelay;
    try {
      if(manageIndex)nextIndex=await runtime.startChainIndex({rpc:rpcUrl,logsRpc:rpcUrl,host:'127.0.0.1',port:4204,
        dbPath:join(privateDirectory(join(state,'index')),'index.sqlite'),scanRange:500,confirmations:12,
        factory:m.factory,market:m.shareMarket,lens:m.lens,portfolioFactory:m.portfolioFactory,
        portfolioMarket:m.portfolioMarket,startBlock:m.deployment.blockNumber,reservationMode:'required',
        freshCodehashes:[...Object.entries(m.codehash).map(([name,expected])=>({address:m[name],expected})),
          {address:m.authority,expected:m.freshAuthority.codehash}],
        overviewQuoteLoader:runtime.overviewQuoteLoader({baseUrl:'http://127.0.0.1:4207/firsto-api'})});
      nextJournal=runtime.createJournalService({dbPath:journalPath,origin,rpcUrl,provider,...cookie,
        secureCookies:origin.startsWith('https:'),currentArtifactDigest:currentDigest,
        assertSigningInputsCurrent:assertInputsCurrent,allowedProductFactories:[m.factory,m.portfolioFactory],
        productDeploymentRecord:candidate.record,productArtifactBundle:bundle,genesisBundle:bundle,
        freshActivationEvidencePath:graphPaths.activation,expectedGasWallet:trustedProfile.roles.gasWallet,
        salePolicyCatalogPath,salePolicyArtifactPath,
        freshProduct:freshProductReadinessReader?freshProduct:null,freshProductReadinessReader,
        freshConsolePreGenesis:false,freshStage2Hold:true});
      if(authorityRelayFactory)nextRelay=await authorityRelayFactory(nextJournal);
      activeProxy=runtime.createLiveDataProxy({rpcUrl,logsRpcUrl:rpcUrl,indexUrl:'http://127.0.0.1:4204',
        feeHistoryLogScope:{authority:m.authority,deploymentBlock:m.deployment.blockNumber}});
      indexService=nextIndex;productJournal=nextJournal;relayService=nextRelay;
    } catch(error) {await Promise.allSettled([nextIndex?.close(),nextJournal?.close(),nextRelay?.close()]);throw error;}
  }
  async function activate(req,account) {
    const saved=deploymentJournal.readAuthenticatedDeployment(req);
    if(!same(saved.account,account))fail(409,'Selected wallet differs from the authenticated journal.');
    if(!FULL_TEST_DEPLOYERS.includes(saved.account.toLowerCase()))fail(403,'Test deployer is not allowed.');
    const record=saved.deployment.record, activation=saved.activation.record;
    if(active) {
      if(active.record.id!==record?.id || !same(active.record.account,saved.account)
        || !same(active.manifest.authority,activation?.authorityAddress))fail(409,'This test site already uses a different activated deployment.');
      ensureReadyMarker(active);return config();
    }
    if(activating)fail(409,'A test activation is already running.');
    const lockPath=join(state,'activation.lock');let lock;
    try {lock=openSync(lockPath,'wx',0o600);}catch(error){if(error.code==='EEXIST')fail(409,'Another process is activating this test site.');throw error;}
    const pending=(async()=>{
      let candidate;
      try {candidate=await verify(record,activation);}catch(error){if(!error.status)error.status=409;throw error;}
      // Re-read the authoritative journal after the RPC proof; wallet progress
      // or another deployment must not race the activation handoff.
      const current=deploymentJournal.readAuthenticatedDeployment(req);
      if(current.deployment.revision!==saved.deployment.revision || current.activation.revision!==saved.activation.revision
        || JSON.stringify(current.deployment.record)!==JSON.stringify(record)
        || JSON.stringify(current.activation.record)!==JSON.stringify(activation))fail(409,'Deployment journal changed during activation.');
      if(existsSync(activePath))fail(409,'An activation was installed by another process.');
      await activateServices(candidate);
      try {writePrivateJson(activePath,candidate);}catch(error){await Promise.allSettled([indexService?.close(),productJournal?.close(),relayService?.close()]);
        indexService=productJournal=relayService=activeProxy=null;throw error;}
      active=candidate;
      ensureReadyMarker(candidate);
      return config();
    })();
    activating=pending;
    try {return await pending;}finally{if(activating===pending)activating=null;closeSync(lock);unlinkSync(lockPath);}
  }
  if(existsSync(activePath)) {
    const saved=readRegularJson(activePath);
    if(saved.profile!=='full-test' || saved.profileDigest!==binding || !same(saved.artifactDigest,artifactDigest))
      throw new Error('Persisted test activation belongs to another build or profile.');
    try {
      const candidate=await verify(saved.record,saved.activationRecord);
      const comparable=value=>{const result=structuredClone(value);delete result.verifiedAt;return JSON.stringify(result);};
      if(comparable(candidate.manifest)!==comparable(saved.manifest)
        || JSON.stringify(runtime.createFreshIndexManifest(saved.manifest))!==JSON.stringify(saved.indexManifest))
        throw new Error('Persisted test graph changed.');
      // Preserve the exact handoff bytes already pinned by the root
      // provisioner; a fresh RPC proof must not silently rewrite its manifest.
      candidate.activatedAt=saved.activatedAt;candidate.evidence=saved.evidence;
      candidate.manifest=saved.manifest;candidate.indexManifest=saved.indexManifest;
      await activateServices(candidate);active=candidate;ensureReadyMarker(candidate);
    } catch(error) {await deploymentJournal.close();throw error;}
  }
  function stream(req,res) {
    if(streams.size>=100)return json(res,429,{error:'Too many test data streams.'});
    const upstream=httpRequest({hostname:'127.0.0.1',port:4204,path:'/v1/display/events',method:'GET',
      headers:{accept:'text/event-stream'}},response=>{
      if(response.statusCode!==200 || !/^text\/event-stream\b/.test(response.headers['content-type']??'')) {
        response.destroy();if(!res.headersSent)json(res,503,{error:'Test data stream is unavailable.'});return;
      }
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});
      response.pipe(res);response.on('error',()=>res.destroy());
    });
    streams.add(upstream);upstream.setTimeout(45_000,()=>upstream.destroy());
    upstream.on('error',()=>{if(!res.headersSent)json(res,503,{error:'Test data stream is unavailable.'});else res.destroy();});
    const stop=()=>{upstream.destroy();streams.delete(upstream);};res.once('close',stop);upstream.once('close',()=>streams.delete(upstream));upstream.end();
  }
  async function handle(req,res) {
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    try {
      if(closed)fail(503,'Test API is stopping.');
      if(typeof req.url!=='string' || req.url.length>2048 || !req.url.startsWith('/') || req.url.startsWith('//'))fail(400,'Invalid test route.');
      const url=new URL(req.url,origin),path=url.pathname;
      if(path==='/api/full-test/config') {
        if(req.method!=='GET' || url.search)fail(405,'Configuration accepts a plain GET.');
        return json(res,200,await config());
      }
      if(path==='/api/full-test/activate') {
        if(req.method!=='POST' || url.search)fail(405,'Activation requires a plain POST.');
        if(req.headers.origin!==origin)fail(403,'Request origin is not allowed.');
        const body=await readActivationBody(req);return json(res,200,await activate(req,body.account));
      }
      if(path==='/api/journal/authority-relay' || path==='/api/journal/authority-relay/status') {
        if(!relayService)fail(503,'Independent test automation is not active.');return relayService.handle(req,res);
      }
      if(path.startsWith('/api/journal/')) {
        const isDeployment=/^\/api\/journal\/(deployment|fresh-activation|challenge|session|build)(?:\/|$)/.test(path);
        if(!active && !isDeployment && !path.startsWith('/api/journal/notifications/'))fail(503,'The full test graph is not activated.');
        return (isDeployment?deploymentJournal:productJournal??deploymentJournal).handle(req,res);
      }
      if(path==='/api/chain-index/v1/display/events') {
        if(!active)fail(503,'The test index is not activated.');
        if(req.method!=='GET' || url.search)fail(400,'Data stream accepts a plain GET.');return stream(req,res);
      }
      if(path==='/api/rpc')return (activeProxy??rpcProxy).handle(req,res);
      if(path.startsWith('/api/chain-index/')) {
        if(!active)fail(503,'The test index is not activated.');return activeProxy.handle(req,res);
      }
      if(path.startsWith('/firsto-api/'))return runtime.proxyFirsto(req,res);
      fail(404,'Unknown full-test API route.');
    } catch(error){if(!res.headersSent && !res.writableEnded)json(res,[400,401,403,405,409,413,415,429,503].includes(error.status)?error.status:503,
      {error:error.status?error.message:'Independent test service is unavailable.'});}
  }
  return {config,graphPaths,handle(req,res){const pending=handle(req,res);requests.add(pending);
    pending.finally(()=>requests.delete(pending));return pending;},async close(){closed=true;
    for(const stream of streams)stream.destroy();await Promise.allSettled([...requests,activating]);
    await Promise.allSettled([deploymentJournal.close(),productJournal?.close(),indexService?.close(),relayService?.close()]);}};
}

export async function startFullTestServer({env=process.env,runtime:providedRuntime}={}) {
  if(env.HOST && env.HOST!=='127.0.0.1' || env.PORT && env.PORT!=='4207')throw new Error('Full-test API must listen only on 127.0.0.1:4207.');
  if(env.KEEPER_PRIVATE_KEY || env.AUTHORITY_RELAY_ENABLED==='1')throw new Error('Public test API cannot own a transaction signer.');
  const runtime=providedRuntime??await loadFullTestRuntime();
  const bundlePath=fileURLToPath(new URL('./public/deployment-artifacts.json',import.meta.url));
  const profilePath=fileURLToPath(new URL('./public/runtime-profile.json',import.meta.url));
  const bundle=readRegularJson(bundlePath),profile=readRegularJson(profilePath,16384),artifactDigest=runtime.servedArtifactDigest(bundlePath);
  const rpcUrl=env.FULL_TEST_RPC_URL;
  if(!/^https:\/\//.test(rpcUrl??''))throw new Error('FULL_TEST_RPC_URL requires the separate HTTPS BSC read endpoint.');
  const assertInputsCurrent=()=>{
    if(runtime.servedArtifactDigest(bundlePath)!==artifactDigest || profileDigest(readRegularJson(profilePath,16384))!==profileDigest(profile))
      throw new Error('Test build changed; restart before signing or activating.');
  };
  const provider=runtime.createProductVerifierProvider(rpcUrl);
  // The installed runtime validates an exact full-test socket and an HMAC
  // credential. A missing private test process leaves Stage 2 unverified.
  const ipc=runtime.authorityIpcConfiguration(env);
  const salePolicyCatalogPath=env.BEMINE_SALE_POLICY_CATALOG_PATH,salePolicyArtifactPath=env.BEMINE_SALE_POLICY_ARTIFACT_PATH;
  if(Boolean(salePolicyCatalogPath)!==Boolean(salePolicyArtifactPath)
    || salePolicyCatalogPath && (!isAbsolute(salePolicyCatalogPath)||!isAbsolute(salePolicyArtifactPath)))
    throw new Error('Full-test sale policy requires both absolute reviewed local paths.');
  const service=await createFullTestService({runtime,profile,bundle,artifactDigest,provider,rpcUrl,assertInputsCurrent,
    salePolicyCatalogPath,salePolicyArtifactPath,
    gasWalletProofReader:ipc?runtime.createGasSignerProofReader(ipc):undefined,
    freshProductReadinessReader:ipc?runtime.createFreshProductReadinessReader(ipc):undefined,
    authorityRelayFactory:ipc && env.AUTHORITY_RELAY_PUBLIC_ENABLED==='1'
      ?journal=>runtime.createAuthorityRelayProxy(ipc,{verifyOperationalReadiness:()=>journal.verifyFreshOperationalReadiness()}):undefined});
  const server=createServer((req,res)=>void service.handle(req,res));
  try {await new Promise((accept,reject)=>{server.once('error',reject);server.listen(4207,'127.0.0.1',accept);});}
  catch(error){await service.close();provider.destroy();throw error;}
  return {service,server,async close(){const closing=new Promise(accept=>server.close(accept));await service.close();
    server.closeAllConnections?.();await closing;provider.destroy();}};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const running=await startFullTestServer();
  console.log('Independent full-test API listening on 127.0.0.1:4207.');
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void running.close().then(()=>process.exit(0)));
}
