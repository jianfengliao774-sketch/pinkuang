#!/usr/bin/env node
import { JsonRpcProvider } from 'ethers';
import { inspectLegacyPools } from './legacy-pool-preflight.mjs';

const usage = 'Usage: BSC_RPC_URL=<archive RPC> node scripts/legacy-pool-preflight.cli.mjs --factory 0x... --factory-codehash 0x... --from-block <Factory deployment block> [--pools 0xA,0xB] [--confirmations 15] [--scan-range 10000]';

function argumentsFrom(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--factory', '--factory-codehash', '--from-block', '--pools', '--confirmations', '--scan-range'].includes(key)
      || !argv[i + 1] || values[key] !== undefined) throw new Error(usage);
    values[key] = argv[i + 1];
  }
  if (!values['--factory'] || !values['--factory-codehash'] || !values['--from-block']) throw new Error(usage);
  const numeric = (key, fallback) => {
    const value = values[key];
    if (value === undefined) return fallback;
    if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`Invalid ${key}.`);
    return Number(value);
  };
  return { factory: values['--factory'], factoryCodehash: values['--factory-codehash'], fromBlock: numeric('--from-block'),
    confirmations: numeric('--confirmations', 15), scanRange: numeric('--scan-range', 10000),
    ...(values['--pools'] ? { pools: values['--pools'].split(',') } : {}) };
}

try {
  const options = argumentsFrom(process.argv.slice(2));
  if (!process.env.BSC_RPC_URL) throw new Error('BSC_RPC_URL is required.');
  const provider = new JsonRpcProvider(process.env.BSC_RPC_URL, 56, { staticNetwork: true });
  const report = await inspectLegacyPools(provider, options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.releaseGate !== 'NO_F04_BLOCKER_FOUND') process.exitCode = 2;
} catch (error) {
  const raw = error?.code ? `RPC/ABI failure (${error.code})` : String(error?.message ?? error);
  const sanitized = (process.env.BSC_RPC_URL ? raw.replaceAll(process.env.BSC_RPC_URL, '[RPC URL]') : raw)
    .replace(/https?:\/\/[^\s"']+/gi, '[RPC endpoint]');
  process.stderr.write(`Legacy pool preflight failed closed: ${sanitized}\n`);
  process.exitCode = 1;
}
