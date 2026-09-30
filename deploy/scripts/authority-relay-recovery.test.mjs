import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorityRecoveryLaunchArguments, runAuthorityRecovery } from './authority-relay-recovery.mjs';
import { AUTHORITY_RECOVERY_SENDERS, V4_AUTHORITY_JOURNAL, V4_KEEPER_STATE_ROOT } from './authority-relay.mjs';
import { relativeImports, RUNTIME_MODULES } from './package-fresh-console.mjs';

const env = { BEMINE_V2_GAS_SENDER_DRAINED: '1' };
const hash = '0x' + 'a'.repeat(64);
const send = ['--command', '/private/action.json', '--journal', V4_AUTHORITY_JOURNAL,
  '--rpc', 'https://rpc.example', '--send', '--rebroadcast-signed', '--expected-hash', hash];
const acknowledge = ['--command', '/private/action.json', '--journal', V4_AUTHORITY_JOURNAL,
  '--rpc', 'https://rpc.example', '--acknowledge-failure', hash];

test('private v4 recovery entrypoint has a complete source import closure and stays out of public release', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const expected = [
    'scripts/authority-relay-recovery.mjs', 'scripts/authority-relay.mjs',
    'scripts/budget-multicall-read.mjs', 'scripts/keeper-credential.mjs',
    'scripts/official-market-discovery.mjs', 'scripts/purchase-keeper.mjs',
    'shared/authority-typed.mjs', 'shared/original-gas-wallet.mjs',
    'src/firsto-purchase.mjs',
  ];
  const seen = new Set();
  const queue = ['scripts/authority-relay-recovery.mjs'];
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    assert(expected.includes(name), `Unreviewed recovery dependency: ${name}`);
    const path = resolve(root, name);
    const stat = lstatSync(path);
    assert(stat.isFile() && !stat.isSymbolicLink(), `Invalid recovery source: ${name}`);
    seen.add(name);
    for (const specifier of relativeImports(readFileSync(path, 'utf8'))) {
      const target = relative(root, resolve(root, dirname(name), specifier)).split(sep).join('/');
      assert(!target.startsWith('../'), `Recovery dependency escapes deploy: ${name}`);
      queue.push(target);
    }
  }
  assert.deepEqual([...seen].sort(), expected.sort());
  for (const name of ['scripts/authority-relay-recovery.mjs',
    'scripts/authority-relay.mjs', 'scripts/keeper-credential.mjs',
    'scripts/purchase-keeper.mjs']) assert(!RUNTIME_MODULES.includes(name));
});

test('prelaunch fails before systemd-run if any original or v4 sender is active', () => {
  for (const active of AUTHORITY_RECOVERY_SENDERS) {
    const events = [];
    assert.throws(() => runAuthorityRecovery(send, { env, now: () => 1000,
      query: unit => { events.push(`check:${unit}`); return unit === active ? 'active' : 'inactive'; },
      spawn: () => { events.push('systemd-run'); return { status: 0 }; },
    }), /Stop and reconcile/);
    assert.equal(events.includes('systemd-run'), false);
  }
});

test('prelaunch checks all sender states before systemd-run and passes a fresh proof', () => {
  const events = [];
  const status = runAuthorityRecovery(send, { env, now: () => 1234567890,
    query: unit => { events.push(`check:${unit}`); return 'inactive'; },
    spawn: (program, args) => {
      events.push(program);
      assert.equal(program, 'systemd-run');
      assert(args.includes(`--setenv=PINKUANG_KEEPER_STATE_ROOT=${V4_KEEPER_STATE_ROOT}`));
      assert(args.includes(`--setenv=AUTHORITY_RELAY_JOURNAL=${V4_AUTHORITY_JOURNAL}`));
      assert(args.includes('--setenv=BEMINE_V4_AUTHORITY_PREFLIGHT_AT=1234567890'));
      assert(args.includes('--property=LoadCredential=keeper-private-key:/etc/pinkuang/keeper.key'));
      assert(args.some(value => value.startsWith('--property=Conflicts=')
        && AUTHORITY_RECOVERY_SENDERS.every(unit => value.includes(unit))));
      return { status: 0 };
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(events, [...AUTHORITY_RECOVERY_SENDERS.map(unit => `check:${unit}`), 'systemd-run']);
  assert(!authorityRecoveryLaunchArguments(acknowledge, env, 1234567890)
    .some(value => value.startsWith('--property=LoadCredential=')));
});

test('the actual launcher blocks active mining before systemd-run and excludes it for the entire recovery', () => {
  const mining = 'pinkuang-v4-mining.service';
  let spawned = false;
  assert.throws(() => runAuthorityRecovery(send, { env,
    query: unit => unit === mining ? 'active' : 'inactive',
    spawn: () => { spawned = true; return { status: 0 }; },
  }), /Stop and reconcile pinkuang-v4-mining/);
  assert.equal(spawned, false);
  for (const args of [send, acknowledge]) {
    const launch = authorityRecoveryLaunchArguments(args, env, 1234);
    for (const property of ['Conflicts', 'After']) {
      const value = launch.find(item => item.startsWith(`--property=${property}=`));
      assert(value && value.split('=')[2].split(' ').includes(mining));
    }
  }
});

test('hash-pinned recovery can use the private journal when the original admin command is unavailable', () => {
  const commandless = ['--journal', V4_AUTHORITY_JOURNAL, '--authority',
    '0x0000000000000000000000000000000000000011', '--expected-codehash', '0x'+'c'.repeat(64),
    '--rpc', 'https://rpc.example', '--send', '--rebroadcast-signed', '--expected-hash', hash];
  const launch=authorityRecoveryLaunchArguments(commandless,env,1234);
  assert(launch.includes('--rebroadcast-signed'));
  assert(!launch.includes('--command'));
  const replacement=['--journal',V4_AUTHORITY_JOURNAL,'--authority',
    '0x0000000000000000000000000000000000000011','--expected-codehash','0x'+'c'.repeat(64),
    '--acknowledge-replacement',hash,'--replacement-hash','0x'+'b'.repeat(64)];
  const archive=authorityRecoveryLaunchArguments(replacement,env,1234);
  assert(archive.includes('--acknowledge-replacement'));
  assert(!archive.some(item=>item.startsWith('--property=LoadCredential=')));
  const cancellation=['--journal',V4_AUTHORITY_JOURNAL,'--authority',
    '0x0000000000000000000000000000000000000011','--expected-codehash','0x'+'c'.repeat(64),
    '--send','--cancel-expired-signed','--expected-hash',hash];
  const cancelLaunch=authorityRecoveryLaunchArguments(cancellation,env,1234);
  assert(cancelLaunch.includes('--cancel-expired-signed'));
  assert(cancelLaunch.includes('--property=LoadCredential=keeper-private-key:/etc/pinkuang/keeper.key'));
  const cancelArchive=['--journal',V4_AUTHORITY_JOURNAL,'--authority',
    '0x0000000000000000000000000000000000000011','--expected-codehash','0x'+'c'.repeat(64),
    '--acknowledge-expired-cancel',hash,'--cancel-hash','0x'+'d'.repeat(64)];
  const archiveLaunch=authorityRecoveryLaunchArguments(cancelArchive,env,1234);
  assert(archiveLaunch.includes('--acknowledge-expired-cancel'));
  assert(!archiveLaunch.some(item=>item.startsWith('--property=LoadCredential=')));
});

test('prelaunch rejects legacy paths, inline private keys and undrained sender without starting', () => {
  const spawn = () => { throw new Error('systemd-run must not start'); };
  const query = () => { throw new Error('systemctl must not start'); };
  assert.throws(() => runAuthorityRecovery(send, { env: {}, query, spawn }), /drained and disabled v2/);
  assert.throws(() => runAuthorityRecovery(send, { env: { ...env, KEEPER_PRIVATE_KEY: '' }, query, spawn }),
    /forbids private keys/);
  assert.throws(() => runAuthorityRecovery(['--command', '/private/action.json', '--journal', '/tmp/v2.json',
    '--send', '--gas-limit', '650000'], { env, query, spawn }), /v4 Authority journal/);
  assert.throws(() => runAuthorityRecovery(['--command', 'relative.json', '--journal', V4_AUTHORITY_JOURNAL,
    '--send', '--gas-limit', '650000'], { env, query, spawn }), /paths must be absolute/);
});

test('expired cancellation cannot start when a sender is active or a private key is inline', () => {
  const cancel=['--journal',V4_AUTHORITY_JOURNAL,'--authority',
    '0x0000000000000000000000000000000000000011','--expected-codehash','0x'+'c'.repeat(64),
    '--send','--cancel-expired-signed','--expected-hash',hash];
  let spawned=false;
  const spawn=()=>{spawned=true;return {status:0};};
  assert.throws(()=>runAuthorityRecovery(cancel,{env,query:()=> 'active',spawn}),/Stop and reconcile/);
  assert.equal(spawned,false);
  assert.throws(()=>runAuthorityRecovery(cancel,{env:{...env,KEEPER_PRIVATE_KEY:''},
    query:()=> 'inactive',spawn}),/forbids private keys/);
  assert.equal(spawned,false);
});
