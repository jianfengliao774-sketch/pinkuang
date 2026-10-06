import { getAddress, keccak256 } from 'ethers';
import { buildDigest, evidenceDigest } from '../shared/firsto-upgrade-proof.mjs';
import { reviewedUpgradeBytecode } from '../shared/integrated-upgrade-plan.mjs';
import { TARGET_OWNER_REVIEW_KIND, targetOwnerBaselineNames, validateTargetOwnerUpgradeReview } from '../shared/target-owner-upgrade-plan.mjs';

const same=(a,b)=>typeof a==='string' && typeof b==='string' && a.toLowerCase()===b.toLowerCase();
const need=(ok,message)=>{if(!ok)throw new Error(message);};

/** Pure review packet for an unchanged formal genesis graph. It never attests current chain state. */
export function prepareGenesisTargetOwnerReview(input,{profile='formal',deployer=input.genesisRecord?.account,
  anchor={blockNumber:input.trustedGenesisManifest?.verifiedBlockNumber,blockHash:input.trustedGenesisManifest?.verifiedBlockHash}}={}) {
  const {genesisRecord:record,genesisBundle:bundle,trustedGenesisManifest:manifest}=input;
  const old=reviewedUpgradeBytecode.trustedGenesisAddresses(record,bundle,manifest);
  const candidateArtifactDigest=buildDigest(input.upgradeBundle);
  need(same(candidateArtifactDigest,input.trustedUpgradeArtifactDigest),'Candidate differs from independent artifact pin.');
  const bindings=Object.fromEntries(['factory','portfolioFactory','beacon','portfolioBeacon','timelock','lens',
    'shareMarket','portfolioShareMarket'].map(name=>[name,old[name]]));
  bindings.proposer=getAddress(record.input.ownerMultisig);
  const aliases={factory:'ERC1967Proxy',shareMarket:'ERC1967Proxy',portfolioFactory:'ERC1967Proxy',
    portfolioShareMarket:'ERC1967Proxy',lens:'PoolLens',beacon:'PoolBeacon',portfolioBeacon:'PoolBeacon',timelock:'PoolTimelock'};
  const catalog={schemaVersion:1,kind:TARGET_OWNER_REVIEW_KIND,chainId:56,profile,
    genesisRecordDigest:input.trustedGenesisRecordDigest,genesisArtifactDigest:buildDigest(bundle),
    genesisManifestDigest:input.trustedGenesisManifestDigest,candidateArtifactDigest,anchor,
    deployer:getAddress(deployer),bindings,authority:{...manifest.freshAuthority},nodes:{}};
  for(const name of targetOwnerBaselineNames){
    const artifact=bundle.artifacts[aliases[name]??name];
    const references=Object.values(artifact?.deployedLinkReferences??{}).flatMap(row=>Object.keys(row));
    const links=Object.fromEntries(references.map(dependency=>[dependency,old[dependency]]));
    const immutable=({AtomicDeployment:record.account,PoolVault:old.factory,BudgetPortfolioVault:old.portfolioFactory,
      FreshPoolFactory:old.FreshPoolFactory,ShareMarket:old.ShareMarket,BudgetPortfolioFactory:old.BudgetPortfolioFactory,
      lens:old.factory,beacon:old.factory,portfolioBeacon:old.portfolioFactory})[name]??null;
    const immutableAddress=Object.values(artifact?.immutableReferences??{}).flat().length?immutable:null;
    const runtime=reviewedUpgradeBytecode.expectedRuntime(artifact,links,old[name],immutableAddress);
    const codehash=keccak256(runtime);
    need(same(codehash,record.verification?.code?.[name]?.codehash),`Recorded genesis runtime differs: ${name}.`);
    catalog.nodes[name]={address:old[name],artifact,links,immutableAddress,codehash};
  }
  const catalogDigest=evidenceDigest(catalog);
  validateTargetOwnerUpgradeReview({...input,reviewCatalog:catalog,trustedReviewCatalogDigest:catalogDigest});
  return {catalog,catalogDigest,currentChainStateVerified:false,unsigned:true};
}
