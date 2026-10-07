import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Contract, getAddress, keccak256, toQuantity } from 'ethers';
import { buildGovernance24UpgradePlan, prepareGovernance24UpgradeDeployment,
  governance24UpgradeDeploymentOrder } from '../shared/governance24-upgrade-plan.mjs';
import { evidenceDigest } from '../shared/firsto-upgrade-proof.mjs';


const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const governance24GasCeiling = used => ((BigInt(used) * 120n + 99n) / 100n + 50000n + 9999n) / 10000n * 10000n;

/** Disposable loopback EVM only. No fork, external RPC, production signing key or production wallet. */
export async function measureGovernance24Gas(input) {
  const listener = createServer(); await new Promise(done => listener.listen(0, '127.0.0.1', done));
  const port = listener.address().port; await new Promise((done, fail) => listener.close(error => error ? fail(error) : done()));
  const node = spawn(resolve(root, 'deploy/node_modules/.bin/anvil'),
    ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '56', '--gas-limit', '30000000', '--silent'], { stdio: 'ignore' });
  const provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, 56, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
  try {
    let available = false;
    for (let attempt = 0; attempt < 50; attempt++) { try { assert.equal(await provider.send('eth_chainId', []), '0x38'); available = true; break; } catch { await delay(100); } }
    assert(available, 'Disposable loopback Anvil failed to start.');
    // Impersonation is confined to this fresh un-forked local EVM. It produces no usable production signature.
    const from = getAddress(input.reviewCatalog.deployer);
    await provider.send('anvil_setBalance', [from, toQuantity(10n ** 20n)]);
    await provider.send('anvil_impersonateAccount', [from]);
    async function receiptFor(hash) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const receipt = await provider.getTransactionReceipt(hash); if (receipt) return receipt;
        await delay(50);
      }
      throw new Error('Disposable CREATE receipt did not arrive.');
    }
    const prefix = {}, rows = [];
    for (const name of governance24UpgradeDeploymentOrder) {
      const prepared = prepareGovernance24UpgradeDeployment(name, input, { deploymentsPrefix: prefix });
      const hash = await provider.send('eth_sendTransaction', [{ from, data: prepared.data, value: '0x0', gas: toQuantity(9000000) }]);
      const receipt = await receiptFor(hash), tx = await provider.getTransaction(hash);
      assert(receipt?.status === 1 && receipt.contractAddress && tx?.to === null && tx.value === 0n);
      assert.equal(tx.data, prepared.data); assert.equal(tx.gasLimit, 9000000n);
      const address = getAddress(receipt.contractAddress); prefix[name] = { address, txHash: hash };
      rows.push({ name, address, localTransactionHash: hash, nonce: tx.nonce, dataHash: keccak256(prepared.data),
        initcodeBytes: (prepared.data.length - 2) / 2, gasUsed: receipt.gasUsed.toString(), gasLimit: governance24GasCeiling(receipt.gasUsed).toString(),
        blockHash: receipt.blockHash, blockNumber: receipt.blockNumber });
    }
    const plan = buildGovernance24UpgradePlan({ ...input, replacements: Object.fromEntries(Object.entries(prefix).map(([name, row]) => [name, row.address])),
      salt: `0x${'17'.repeat(32)}`, delaySeconds: 172800 });
    for (const [index, entry] of plan.deployments.entries()) {
      const runtime = await provider.getCode(entry.address); assert.equal(runtime.toLowerCase(), entry.expectedRuntime.toLowerCase());
      rows[index].runtimeBytes = (runtime.length - 2) / 2; rows[index].runtimeCodehash = keccak256(runtime);
      rows[index].libraries = entry.libraries; rows[index].constructorArgs = entry.constructorArgs;
    }
    assert.equal(getAddress(await new Contract(prefix.PoolVault.address, ['function OFFICIAL_FACTORY() view returns(address)'], provider).OFFICIAL_FACTORY()),
      getAddress(input.predecessorInput.genesisRecord.addresses.factory));
    // Exercise exactly the fixed reviewed limits once more, rather than relying on an estimate.
    await provider.send('anvil_reset', []);
    await provider.send('anvil_setBalance', [from, toQuantity(10n ** 20n)]); await provider.send('anvil_impersonateAccount', [from]);
    const repeat = {};
    for (const row of rows) {
      const data = prepareGovernance24UpgradeDeployment(row.name, input, { deploymentsPrefix: repeat }).data;
      const hash = await provider.send('eth_sendTransaction', [{ from, data, value: '0x0', gas: toQuantity(BigInt(row.gasLimit)) }]);
      const receipt = await receiptFor(hash); assert(receipt?.status === 1 && receipt.contractAddress);
      assert.equal(receipt.gasUsed.toString(), row.gasUsed); assert.equal(keccak256(data), row.dataHash);
      repeat[row.name] = { address: getAddress(receipt.contractAddress), txHash: hash };
    }
    return { schemaVersion: 1, kind: 'governance24-offline-create-gas-review-v1', measuredAt: new Date().toISOString(),
      pins: { ...Object.fromEntries(Object.entries(input).filter(([name]) => name.startsWith('trusted') && name.endsWith('Digest'))),
        trustedGenesisRecordDigest: input.predecessorInput.trustedGenesisRecordDigest,
        trustedGenesisManifestDigest: input.predecessorInput.trustedGenesisManifestDigest },
      environment: { disposableLoopbackEvm: true, forked: false, chainId: 56, productionTransactions: false,
        anvilVersion: '1.7.1', sendGasCeiling: '9000000', ethEstimateGasCalls: 0 },
      margin: { percent: 20, absoluteGas: 50000, roundUpGas: 10000 }, deployments: rows,
      fixedCeilingsTested: true, preservedFactory: input.predecessorInput.genesisRecord.addresses.factory };
  } finally { provider.destroy(); node.kill('SIGTERM'); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); assert(args.length === 2 && args[0] === '--input', 'Usage: node scripts/measure-governance24-gas.mjs --input /absolute/review-input.json');
  const evidence = await measureGovernance24Gas(JSON.parse(await readFile(resolve(args[1]), 'utf8'))), path = resolve(root, 'deploy/evidence/governance24-create-gas-20261007.json');
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ evidencePath: path, evidenceDigest: evidenceDigest(evidence),
    gas: evidence.deployments.map(row => ({ name: row.name, gasUsed: row.gasUsed, gasLimit: row.gasLimit })) }, null, 2)}\n`);
}
