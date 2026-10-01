"""Apply the user-selected sender before Authority deployment; no chain writes.

Run as root with a reviewed source directory and its Git commit. Existing
bootstrap artifacts and all sixteen deployment receipts remain unchanged.
"""
from pathlib import Path
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
import urllib.request

CONFIG = Path('/etc/bemine-full-test')
STATE = Path('/var/lib/bemine-full-test')
CURRENT = Path('/srv/bemine-full-test/current')
OLD = '0xaD95dFf16FE0e09C47bADe687aB549929AC66c80'
NEW = '0x0C14b1008cFFe78711d65b13C8Ce5ca9B944252C'
UNITS = ['bemine-full-test-' + name + '.service' for name in
         ['api', 'signer', 'index', 'purchase', 'mining', 'activate']]


def write(path, data, mode=None):
    path = Path(path)
    previous_mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    temporary = path.with_name(path.name + '.gas-update.tmp')
    with open(temporary, 'xb') as f:
        os.chmod(temporary, previous_mode if mode is None else mode)
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temporary, path)


def call(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)


def main():
    source, head = Path(sys.argv[1]), sys.argv[2]
    assert os.geteuid() == 0 and len(head) == 40 and all(c in '0123456789abcdef' for c in head)
    old_release = CURRENT.resolve()
    new_release = old_release.parent / ('gas-reader-' + head[:12])
    profile = json.loads((old_release / 'public/runtime-profile.json').read_text())
    assert profile['roles']['gasWallet'].lower() == OLD.lower()
    assert not (STATE / 'activation-ready.json').exists()
    pending = CONFIG / 'pending-wallet/keeper.key'
    assert pending.is_file() and not pending.is_symlink() and pending.stat().st_mode & 0o077 == 0
    # Derive the address locally without exposing the credential to argv/stdout.
    check = "import{readFileSync}from'node:fs';import{Wallet}from'ethers';if(new Wallet(readFileSync('/etc/bemine-full-test/pending-wallet/keeper.key','utf8').trim()).address.toLowerCase()!=='" + NEW.lower() + "')throw Error('Pending wallet address differs');"
    subprocess.run(
        ['/usr/bin/node', '--input-type=module', '-e', check], cwd=old_release, check=True,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    values = {}
    for line in (CONFIG / 'rpc.env').read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            key, value = line.split('=', 1)
            values[key] = value.strip().strip('"').strip("'")

    def rpc(method, params):
        req = urllib.request.Request(values['FULL_TEST_RPC_URL'], data=json.dumps(
            {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode(),
            headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=20) as response:
            result = json.load(response)
        assert 'error' not in result, 'Read RPC failed'
        return result['result']

    block = rpc('eth_getBlockByNumber', ['finalized', False])
    assert rpc('eth_chainId', []) == '0x38'
    assert all(int(rpc('eth_getTransactionCount', [NEW, tag]), 16) == 0
               for tag in ['latest', 'pending', block['number']]), 'New sender has transaction history'
    proof = {'schemaVersion': 1, 'profile': 'full-test', 'chainId': 56, 'gasWallet': NEW,
             'initialLatestNonce': 0, 'initialPendingNonce': 0, 'separateCredential': True,
             'blockNumber': int(block['number'], 16), 'blockHash': block['hash']}
    assert not new_release.exists()
    call('cp', '-al', str(old_release), str(new_release))
    # Atomic replacement leaves the hard-linked prior release untouched.
    for name, target in [('full-test/server-profile.mjs', 'server-profile.mjs'),
                         ('scripts/full-test/sender-isolation.mjs', 'runtime/deploy/server/full-test-sender-isolation.mjs')]:
        original = (old_release / target).read_text()
        updated = (source / name).read_text()
        assert original.replace(OLD.lower(), NEW.lower()).replace(OLD, NEW) == updated
        write(new_release / target, updated.encode())
    profile['roles']['gasWallet'] = NEW
    write(new_release / 'public/runtime-profile.json', (json.dumps(profile, indent=2) + '\n').encode())
    for name in ['runtime-source-manifest.json', 'runtime/deploy/public/fresh-release-manifest.json']:
        manifest = json.loads((new_release / name).read_text())
        for target in ['server-profile.mjs', 'runtime/deploy/server/full-test-sender-isolation.mjs']:
            manifest['files'][target]['installedSha256'] = hashlib.sha256((new_release / target).read_bytes()).hexdigest()
        manifest['runtimePatchSourceHead'] = head
        write(new_release / name, (json.dumps(manifest, indent=2) + '\n').encode())
    write(new_release / '.gas-reader-repair.json', (json.dumps({'sourceHead': head,
        'contractSourceHead': profile['sourceHead'], 'artifactDigest': profile['artifactDigest'],
        'previousRelease': str(old_release), 'gasWallet': NEW, 'chainTransactionsSent': 0}, indent=2) + '\n').encode())
    site = Path('/etc/nginx/sites-enabled/bem2075').resolve()
    original_site = site.read_text()
    marker = 'location ^~ /bemine-full-test/api/ {'
    assert original_site.count(marker) == 1
    assert 'location = /bemine-full-test/deploy/api/rpc {' not in original_site
    route = (source / 'full-test/ops/deploy-reader-rpc.conf').read_text()
    updated_site = original_site.replace(marker, route + '\n    ' + marker)
    paths = [CONFIG / name for name in ['public.env', 'attest.env', 'public-roles.json',
             'independent-signer.json', 'credentials/keeper-private-key']]
    unit_paths = [Path('/etc/systemd/system') / name for name in UNITS]
    paths += unit_paths + [site]
    backup = CONFIG / ('gas-repair-backup-' + head[:12])
    backup.mkdir(mode=0o700)
    originals = {p: p.read_bytes() for p in paths}
    for i, p in enumerate(paths):
        dest = backup / str(i)
        dest.write_bytes(originals[p])
        dest.chmod(0o600)
    write(backup / 'paths.json', (json.dumps([str(p) for p in paths], indent=2) + '\n').encode())
    # Pause only this test API and test signer while replacing their binding.
    call('systemctl', 'stop', UNITS[0], UNITS[1])
    try:
        db = sqlite3.connect('file:' + str(STATE / 'journal.sqlite') + '?mode=ro', uri=True)
        assert db.execute('select count(*) from fresh_activation').fetchone()[0] == 0
        records = [json.loads(row[0]) for row in db.execute('select record from deployment')]
        assert len(records) == 1 and records[0]['status'] == 'complete'
        assert len(records[0]['steps']) == 16 and all(s['status'] == 'confirmed' for s in records[0]['steps'])
        db.close()
        for name in ['public.env', 'attest.env']:
            p = CONFIG / name
            text = p.read_text()
            assert OLD in text
            write(p, text.replace(OLD, NEW).encode())
        roles = json.loads((CONFIG / 'public-roles.json').read_text())
        roles['gasWallet'] = NEW
        write(CONFIG / 'public-roles.json', (json.dumps(roles, indent=2) + '\n').encode())
        write(CONFIG / 'independent-signer.json', (json.dumps(proof, indent=2) + '\n').encode())
        write(CONFIG / 'credentials/keeper-private-key', pending.read_bytes(), 0o600)
        for p in unit_paths:
            write(p, originals[p].replace(str(old_release).encode(), str(new_release).encode()))
        write(site, updated_site.encode())
        call('nginx', '-t')
        temporary = CURRENT.with_name('current.gas-update')
        temporary.symlink_to(new_release)
        os.replace(temporary, CURRENT)
        call('systemctl', 'daemon-reload')
        call('systemctl', 'start', UNITS[1], UNITS[0])
        call('systemctl', 'reload', 'nginx')
        for _ in range(20):
            try:
                with urllib.request.urlopen('http://127.0.0.1:4207/api/full-test/config', timeout=3) as response:
                    config = json.load(response)
                assert config['roles']['gasWallet'] == NEW
                assert config['artifactDigest'] == profile['artifactDigest']
                break
            except Exception:
                time.sleep(0.5)
        else:
            raise RuntimeError('Updated test API did not become ready')
        print(json.dumps({'status': 'updated', 'gasWallet': NEW, 'artifactDigest': profile['artifactDigest'],
                          'bootstrapTransactionsPreserved': 16, 'chainTransactionsSent': 0}))
    except Exception:
        for p, data in originals.items():
            write(p, data)
        temporary = CURRENT.with_name('current.gas-rollback')
        temporary.symlink_to(old_release)
        os.replace(temporary, CURRENT)
        call('nginx', '-t')
        call('systemctl', 'daemon-reload')
        call('systemctl', 'restart', UNITS[1], UNITS[0])
        call('systemctl', 'reload', 'nginx')
        raise


if __name__ == '__main__':
    main()
