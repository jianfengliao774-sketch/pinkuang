import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAuthorityArguments, requireAuthorityRecoverySendersStopped,
  AUTHORITY_RECOVERY_SENDERS, V4_AUTHORITY_JOURNAL, V4_KEEPER_STATE_ROOT } from './authority-relay.mjs';
import { ORIGINAL_GAS_WALLET, requireOriginalSenderDrained } from '../shared/original-gas-wallet.mjs';

const relayScript = join(dirname(fileURLToPath(import.meta.url)), 'authority-relay.mjs');
const credentialSource = '/etc/pinkuang/keeper.key';

/** Check the old sender *before* systemd resolves Conflicts= and could stop it. */
export function authorityRecoveryLaunchArguments(args, env = process.env, checkedAt = Date.now()) {
  const options = parseAuthorityArguments(args);
  if (options.help || (!options.send && !options.acknowledgeFailure
    && !options.acknowledgeReplacement && !options.acknowledgeExpiredCancel))
    throw new Error('The recovery launcher accepts only --send or a hash-pinned acknowledgement.');
  if (options.journal !== V4_AUTHORITY_JOURNAL
    || (env.PINKUANG_KEEPER_STATE_ROOT && env.PINKUANG_KEEPER_STATE_ROOT !== V4_KEEPER_STATE_ROOT)
    || (env.AUTHORITY_RELAY_JOURNAL && env.AUTHORITY_RELAY_JOURNAL !== V4_AUTHORITY_JOURNAL))
    throw new Error('Recovery launcher requires the v4 Authority journal and keeper state root.');
  if ((options.command && !isAbsolute(args[args.indexOf('--command') + 1] ?? ''))
    || !isAbsolute(args[args.indexOf('--journal') + 1] ?? ''))
    throw new Error('Recovery command, when supplied, and journal paths must be absolute.');
  if (env.KEEPER_PRIVATE_KEY !== undefined || env.KEEPER_PRIVATE_KEY_FILE !== undefined)
    throw new Error('Recovery launcher forbids private keys in the process environment.');
  requireOriginalSenderDrained(ORIGINAL_GAS_WALLET, env);
  if (!Number.isSafeInteger(checkedAt) || checkedAt <= 0)
    throw new Error('Invalid recovery preflight time.');
  const excluded = AUTHORITY_RECOVERY_SENDERS.join(' ');
  return [
    '--wait', '--pipe', '--collect', '--unit=pinkuang-v4-authority-recovery',
    '--uid=pinkuang-v4-signer',
    ...(options.send ? [`--property=LoadCredential=keeper-private-key:${credentialSource}`] : []),
    `--property=Conflicts=${excluded}`, `--property=After=${excluded}`,
    `--setenv=PINKUANG_KEEPER_STATE_ROOT=${V4_KEEPER_STATE_ROOT}`,
    `--setenv=AUTHORITY_RELAY_JOURNAL=${V4_AUTHORITY_JOURNAL}`,
    '--setenv=BEMINE_V2_GAS_SENDER_DRAINED=1',
    `--setenv=BEMINE_V4_AUTHORITY_PREFLIGHT_AT=${checkedAt}`,
    '/usr/bin/node', relayScript, ...args,
  ];
}

export function runAuthorityRecovery(args = process.argv.slice(2), dependencies = {}) {
  const env = dependencies.env ?? process.env;
  // Validate arguments and the drained assertion before querying or changing unit state.
  authorityRecoveryLaunchArguments(args, env, 1);
  requireAuthorityRecoverySendersStopped(dependencies.query);
  const checkedAt = (dependencies.now ?? Date.now)();
  const launchArgs = authorityRecoveryLaunchArguments(args, env, checkedAt);
  const result = (dependencies.spawn ?? spawnSync)('systemd-run', launchArgs, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (!Number.isInteger(result.status)) throw new Error('Authority recovery systemd-run status is unknown.');
  return result.status;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.exitCode = runAuthorityRecovery(); }
  catch (error) {
    console.error(String(error.message).slice(0, 300));
    process.exitCode = 1;
  }
}
