"""Publish only the read-only index overlay; preserve all signer/worker state and assets."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.request

BASE = Path('/srv/pinkuang-v5/releases/v5-product-23b48e6adb2a')
UNIT = 'pinkuang-index-v5'
DROPIN = Path('/etc/systemd/system/pinkuang-index-v5.service.d/target-availability.conf')
OTHERS = ['pinkuang-product-v5', 'pinkuang-v5-purchase', 'pinkuang-v5-mining', 'pinkuang-v5-signer', 'pinkuang-v5-price']
FILES = ['server/chain-index/server.mjs', 'server/chain-index/pool-display-cache.mjs', 'server/chain-index/target-availability.mjs']
OLD_HASHES = {
    FILES[0]: 'f1d8982e0d3a48642c1fa7ad3ac89b5a9976968c32c2ed2c61ca314658cedef0',
    FILES[1]: '7e996f23356754b1889141a5f66de99ba8a380803a0af74d423c0b951b287e27',
}

def need(value, message):
    if not value:
        raise RuntimeError(message)

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def properties(unit):
    output = subprocess.check_output(['systemctl', 'show', unit,
        '--property=ActiveState,SubState,InvocationID,WorkingDirectory'], text=True)
    result = dict(line.split('=', 1) for line in output.splitlines())
    need(result.get('ActiveState') == 'active' and result.get('SubState') == 'running', unit + ' is unavailable')
    return result

def run(incoming):
    need(os.geteuid() == 0, 'Publish on the formal web host')
    summary = json.loads((incoming / 'backend-summary.json').read_text())
    head = summary['sourceHead']
    need(len(head) == 40 and all(c in '0123456789abcdef' for c in head), 'Invalid reviewed source head')
    before = properties(UNIT)
    need(before['WorkingDirectory'] == str(BASE), 'Index runtime differs from the pinned base')
    others = {name: properties(name) for name in OTHERS}
    need(not DROPIN.exists(), 'An index overlay is already installed')
    for name in FILES:
        need(sha(incoming / name) == summary['files'][name], 'Incoming file hash mismatch')
        if name in OLD_HASHES:
            need(sha(BASE / name) == OLD_HASHES[name], 'Pinned index file changed')
        else:
            need(not (BASE / name).exists(), 'New target tracker already exists in base')
    dest = BASE.parent / ('v5-target-availability-' + head[:12])
    need(not dest.exists(), 'Candidate release already exists')
    shutil.copytree(BASE, dest, symlinks=True, ignore=shutil.ignore_patterns('node_modules'))
    os.symlink(BASE / 'node_modules', dest / 'node_modules')
    for name in FILES:
        shutil.copyfile(incoming / name, dest / name)
        subprocess.run(['/usr/bin/node', '--check', str(dest / name)], check=True)
    # The formal manifest and artifact binding remain byte-identical to the base.
    for name in ['public/fresh-product-manifest.json', 'public/deployment-artifacts.json']:
        need(sha(dest / name) == sha(BASE / name), 'Formal contract binding changed')
    DROPIN.parent.mkdir(parents=True, exist_ok=True)
    dropin_written = False
    restart_requested = False
    try:
        with DROPIN.open('x') as dropin:
            dropin_written = True
            dropin.write('[Service]\nWorkingDirectory=' + str(dest) + '\n')
        subprocess.run(['systemctl', 'daemon-reload'], check=True)
        restart_requested = True
        subprocess.run(['systemctl', 'restart', UNIT], check=True)
        verified = None
        # Wait for bounded, shared background materialization; never query an RPC per HTTP visitor.
        for _ in range(36):
            try:
                with urllib.request.urlopen('https://bemine.cc.cd/bemine-v5/api/chain-index/v1/display/pools?cursor=0&limit=20', timeout=8) as response:
                    payload = json.load(response)
                need(payload['source']['factory'].lower() == '0xcfc7d864deb615be04c7f6ac62875c2092c5b1b9', 'Public Factory mismatch')
                rows = payload['data']['items']
                need(payload['data'].get('nextCursor') is None, 'Publication proof requires the complete current project page')
                need(rows and all('targetAvailability' in row for row in rows), 'Target display cache not seeded')
                funding = [row for row in rows if row.get('state', {}).get('$bemineBigInt') in ['0', '1']]
                need(all(row['targetAvailability']['status'] in ['available', 'unavailable', 'not_applicable'] for row in funding),
                     'Funding targets are not yet proven')
                verified = [{'pool': row['pool'], 'targetAvailability': row['targetAvailability']} for row in rows]
                break
            except Exception:
                time.sleep(5)
        need(verified is not None, 'New index target evidence did not become ready')
        after = properties(UNIT)
        need(after['WorkingDirectory'] == str(dest), 'Index overlay is not active')
        need(all(properties(name) == snapshot for name, snapshot in others.items()), 'Another worker changed during index publication')
        record = {'sourceHead': head, 'previousIndex': before, 'index': after,
            'runtimeDirectory': str(dest), 'unchangedWorkers': others, 'targets': verified,
            'publishedAt': int(time.time()), 'contractUpgradeApplied': False}
        (incoming / 'backend-publication.json').write_text(json.dumps(record, indent=2) + '\n')
        print(json.dumps({'indexPublished': True, 'sourceHead': head, 'targets': len(verified), 'contractUpgradeApplied': False}))
    except Exception:
        if dropin_written:
            DROPIN.unlink(missing_ok=True)
            subprocess.run(['systemctl', 'daemon-reload'], check=True)
            if restart_requested:
                subprocess.run(['systemctl', 'restart', UNIT], check=True)
        raise

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('incoming', type=Path)
    run(parser.parse_args().incoming)
