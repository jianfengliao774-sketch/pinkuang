import assert from 'node:assert/strict';
import test from 'node:test';
import { AbiCoder, Interface, ZeroHash, keccak256, toUtf8Bytes } from 'ethers';
import {
  buildIntegratedRoleMigrationPlan, buildIntegratedTreasuryMigrationPlan,
  buildIntegratedCreationResumePlan,
} from '../shared/integrated-upgrade-plan.mjs';

const old='0x1111111111111111111111111111111111111111';
const core='0x2222222222222222222222222222222222222222';
const budget='0x3333333333333333333333333333333333333333';
const timelock='0x4444444444444444444444444444444444444444';
const hardware='0x5555555555555555555555555555555555555555';
const authority='0x6666666666666666666666666666666666666666';
const pool='0x7777777777777777777777777777777777777777';
const roleSalt=keccak256(toUtf8Bytes('reviewed-role-handoff'));
const codeOperationId=keccak256(toUtf8Bytes('completed-code-upgrade'));
const bootstrapOperationId=keccak256(toUtf8Bytes('completed-bootstrap'));
const genesisRecord={addresses:{factory:core,portfolioFactory:budget,timelock},
  input:{ownerMultisig:old}};
const codePlan={kind:'integrated-v2-security-upgrade-v1',operationId:codeOperationId};
const bootstrapPlan={kind:'integrated-v2-proposer-bootstrap-v1',
  hardwareWallet:hardware,operationId:bootstrapOperationId};

test('role migration wires four Authority setters before independently scheduled old-role revocation',()=>{
  const plan=buildIntegratedRoleMigrationPlan({genesisRecord,codePlan,bootstrapPlan,
    authorityAddress:authority,hardwareWallet:hardware,salt:roleSalt,delaySeconds:172800});
  assert.equal(plan.directSteps.length,6);
  assert.deepEqual(plan.directSteps.slice(0,4).map(step=>step.method),
    ['setOperator','setTreasury','setOperator','setTreasury']);
  assert.deepEqual(plan.directSteps.slice(0,4).map(step=>step.next),Array(4).fill(authority));
  assert.deepEqual(plan.directSteps.slice(4).map(step=>step.method),
    ['transferOwnership','transferOwnership']);
  assert.deepEqual(plan.directSteps.slice(4).map(step=>step.next),Array(2).fill(timelock));
  const iface=new Interface(['function revokeRole(bytes32,address)','function grantRole(bytes32,address)',
    'function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)']);
  assert.deepEqual(plan.roleBatch.payloads.map(data=>iface.parseTransaction({data}).name),
    ['revokeRole','revokeRole']);
  assert(plan.roleBatch.payloads.every(data=>iface.parseTransaction({data}).args[1]===old));
  assert.equal(iface.parseTransaction({data:plan.roleBatch.scheduleData}).args[5],172800n);
  assert.equal(plan.roleBatch.operationId,keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address[]','uint256[]','bytes[]','bytes32','bytes32'],[
      plan.roleBatch.targets,plan.roleBatch.values.map(BigInt),plan.roleBatch.payloads,ZeroHash,roleSalt])));
  assert.equal(plan.roleMigrationComplete,false);
});

test('creation resumes only through a separate 48-hour Timelock batch',()=>{
  const rolePlan=buildIntegratedRoleMigrationPlan({genesisRecord,codePlan,bootstrapPlan,
    authorityAddress:authority,hardwareWallet:hardware,salt:roleSalt,delaySeconds:172800});
  const codeResult={codeUpgradeComplete:true,roleMigrationComplete:false,
    operationId:codeOperationId,historical:[{kind:'pool',index:0,address:pool,treasury:old}]};
  const migrationPlan=buildIntegratedTreasuryMigrationPlan({genesisRecord,codeResult,
    authorityAddress:authority,saltSeed:keccak256(toUtf8Bytes('reviewed-treasury')),
    delaySeconds:172800});
  const salt=keccak256(toUtf8Bytes('reviewed-creation-resume'));
  const plan=buildIntegratedCreationResumePlan({genesisRecord,rolePlan,migrationPlan,
    salt,delaySeconds:172800});
  const factory=new Interface(['function pauseCreation(bool)']);
  assert.deepEqual(plan.targets,[core,budget]);
  assert(plan.payloads.every(data=>factory.decodeFunctionData('pauseCreation',data)[0]===false));
  assert.equal(plan.operationId,keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address[]','uint256[]','bytes[]','bytes32','bytes32'],[
      plan.targets,[0n,0n],plan.payloads,ZeroHash,salt])));
  assert.equal(plan.keeperCutoverVerified,false);
  assert.equal(plan.deploymentComplete,false);
});

test('historical treasury migration is separate per old pool and preserves prior claims',()=>{
  const codeResult={codeUpgradeComplete:true,roleMigrationComplete:false,
    operationId:codeOperationId,historical:[{kind:'pool',index:0,address:pool,treasury:old}]};
  const plan=buildIntegratedTreasuryMigrationPlan({genesisRecord,codeResult,
    authorityAddress:authority,saltSeed:keccak256(toUtf8Bytes('reviewed-treasury')),
    delaySeconds:172800});
  assert.equal(plan.operations.length,1);
  const op=plan.operations[0];
  const iface=new Interface(['function migrateTreasury(address,address)']);
  const args=iface.decodeFunctionData('migrateTreasury',op.data);
  assert.equal(args[0],old);
  assert.equal(args[1],authority);
  assert.equal(op.operationId,keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address','uint256','bytes','bytes32','bytes32'],[
      pool,0n,op.data,ZeroHash,op.salt])));
  assert.equal(plan.historicalBnbAndBemOwedRemainWithOldTreasury,true);
  assert.throws(()=>buildIntegratedTreasuryMigrationPlan({genesisRecord,
    codeResult:{...codeResult,historical:[...codeResult.historical,
      {kind:'portfolio',index:0,address:budget,treasury:old}]},
    authorityAddress:authority,saltSeed:keccak256(toUtf8Bytes('reviewed-treasury')),
    delaySeconds:172800}),/no reviewed migration setter/);
});
