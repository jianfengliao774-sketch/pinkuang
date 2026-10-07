import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import solc from 'solc';
import { compilerSettings, repositoryRoot, verifyBuildConfiguration } from './build-artifacts.mjs';
import { buildDigest } from '../shared/firsto-upgrade-proof.mjs';

export const governance24Contracts = Object.freeze(['FlexiblePurchase', 'PoolVault', 'BudgetPortfolioVault',
  'PoolTimelock24', 'Governance24Beacon', 'Governance24Dispatcher', 'Governance24Validation',
  'Governance24FreshPoolFactory', 'Governance24BudgetPortfolioFactory', 'Governance24ShareMarket']);
const sorted = value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')));
const sha256 = value => createHash('sha256').update(value).digest('hex');
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a,b)=>a.name.localeCompare(b.name,'en'))
    .flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name))
      : entry.isFile() && entry.name.endsWith('.sol') ? [join(directory, entry.name)] : []);
}
export function compileGovernance24Artifacts({root=repositoryRoot}={}) {
  verifyBuildConfiguration(root);
  const sources={},sourceHashes={};
  for(const path of files(join(root,'contracts/src'))){
    const name=relative(join(root,'contracts'),path).split('\\').join('/'),content=readFileSync(path,'utf8');
    sources[name]={content};sourceHashes[name]=sha256(content);
  }
  const settings={...compilerSettings,outputSelection:{'*':{'': ['ast'], '*': [...compilerSettings.outputSelection['*']['*']]}}};
  const output=JSON.parse(solc.compile(JSON.stringify({language:'Solidity',sources,settings}),{import(name){
    if(!/^@openzeppelin\/(contracts|contracts-upgradeable)\/[A-Za-z0-9_./-]+\.sol$/.test(name)||name.split('/').includes('..'))return {error:'Unsupported pinned import'};
    const contents=readFileSync(join(root,'node_modules',name),'utf8');sourceHashes[name]=sha256(contents);return {contents};
  }}));
  const errors=(output.errors??[]).filter(x=>x.severity==='error');assert.equal(errors.length,0,errors.map(x=>x.formattedMessage).join('\n'));
  const declarations={};
  function visit(node){if(!node||typeof node!=='object')return;if(node.nodeType==='VariableDeclaration'&&node.mutability==='immutable')declarations[node.id]=node.name;for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}
  Object.values(output.sources).forEach(source=>visit(source.ast));
  const artifacts={};
  for(const contractName of governance24Contracts){
    const sourceName=`src/${['FlexiblePurchase','Governance24Validation'].includes(contractName)?'libraries/':''}${contractName}.sol`;
    const contract=output.contracts[sourceName]?.[contractName];assert(contract,`Missing ${contractName}`);
    const {bytecode,deployedBytecode}=contract.evm,immutableReferences=deployedBytecode.immutableReferences??{};
    const immutableBindings=Object.fromEntries(Object.keys(immutableReferences).map(id=>{assert(declarations[id],`Unresolved immutable AST ID ${id}`);return [id,declarations[id]];}));
    assert(deployedBytecode.object.length/2<=24576,`${contractName} exceeds EIP170`);
    artifacts[contractName]={contractName,sourceName,abi:contract.abi,bytecode:`0x${bytecode.object}`,deployedBytecode:`0x${deployedBytecode.object}`,
      linkReferences:bytecode.linkReferences??{},deployedLinkReferences:deployedBytecode.linkReferences??{},immutableReferences,immutableBindings};
  }
  return {schemaVersion:1,compilerVersion:solc.version(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),settings,sourceHashes:sorted(sourceHashes),artifacts:sorted(artifacts)};
}
if(process.argv[1]===new URL(import.meta.url).pathname){
  const path=process.argv[2];assert(path?.startsWith('/'),'Supply an absolute isolated output path.');
  const bundle=compileGovernance24Artifacts();writeFileSync(path,JSON.stringify(bundle,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({artifactDigest:buildDigest(bundle),sourceCommit:bundle.sourceCommit,sources:Object.keys(bundle.sourceHashes).length,artifacts:Object.entries(bundle.artifacts).map(([name,a])=>({name,bytes:(a.deployedBytecode.length-2)/2,immutableBindings:a.immutableBindings}))}));
}
