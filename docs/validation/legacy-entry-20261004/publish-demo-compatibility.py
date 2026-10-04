#!/usr/bin/env python3
"""CAS two strict demo aliases before the existing shared retired-site guard.

Only nginx reloads. Old real asset URLs keep the same HTTP 503 maintenance page.
Use --rollback to restore the exact previous shared snippet.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import stat
import subprocess
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('legacy_compat', HERE / 'publish-compatibility.py')
compat = importlib.util.module_from_spec(spec); spec.loader.exec_module(compat)
base = compat.base
TARGET = Path('/etc/nginx/snippets/bemine-retired-paused.conf')
OLD_SHA = '9f599d0bdc03a2df158900f2e591cfbc89853b5953ecfd01c334061391b46a58'
POSTERS = ['anime', 'finance', 'future', 'ink', 'original', 'papercraft', 'real', 'space', 'tech']
DEMO_IDS = ['16210', '8204', '15832', '16928', '8316', '17006']
VALID = [('/bemine/preview.html', 'https://bemine.cc.cd/preview.html'),
         ('/bemine/preview.html?source=tg', 'https://bemine.cc.cd/preview.html?source=tg'),
         ('/bemine/preview.html?lang=zh&source=x', 'https://bemine.cc.cd/preview.html?lang=zh&source=x')]
VALID += [(f'/bemine/share/{poster}.html?mode=demo&project={project}&source=native',
           f'https://bemine.cc.cd/share/{poster}.html?mode=demo&project={project}&source=native')
          for poster in POSTERS for project in DEMO_IDS]
PAUSED = ['/bemine/preview.html?mode=live', '/bemine/preview.html?redirect=https://evil.invalid',
          '/bemine/share/real.html?mode=live&project=0x0000000000000000000000000000000000000001',
          '/bemine/share/real.html?mode=demo&mode=live&project=16928',
          '/bemine/share/real.html?mode=demo&project=16928&mode=live',
          '/bemine/share/real.html?mode=demo&project=unknown',
          '/bemine/share/unknown.html?mode=demo&project=16928',
          '/bemine/share/real.html?mode=demo&project=16928&redirect=https://evil.invalid',
          '/bemine/api/chain-index/v1/display/graph', '/bemine/?lang=zh', '/bemine-v4/', '/bemine-full-test/']


def identities():
    snapshot, workers = compat.identities()
    # This one shared guard is the only intended file change.
    snapshot['files'].pop(str(TARGET))
    snapshot['files']['tapeout-config'] = {'sha256': base.sha(compat.CONFIG.read_bytes())}
    snapshot['files']['v5-public-alias-snippet'] = {'sha256': base.sha(compat.SNIPPET.read_bytes())}
    return snapshot, workers


def fetch(host, path):
    old = compat.fetch_redirect
    if host == 'https://tapeout.cc.cd':
        return old(path)
    request = compat.urllib.request.Request(host + path, headers={'Cache-Control': 'no-cache'})
    try:
        response = compat.urllib.request.build_opener(compat.NoRedirect()).open(request, timeout=20)
    except compat.urllib.error.HTTPError as error:
        response = error
    with response:
        return {'url': request.full_url, 'status': response.status,
                'location': response.headers.get('Location'), 'sha256': base.sha(response.read())}


def valid_proof(rollback=False):
    attempts = []
    for attempt in range(12):
        row = fetch(base.HOSTS[0], VALID[0][0]); attempts.append(row)
        if (row['status'] == 503 and row['sha256'] == base.EXPECTED_NEW if rollback else
                row['status'] == 308 and row['location'] == VALID[0][1]):
            break
        if attempt != 11:
            time.sleep(0.25)
    else:
        raise RuntimeError('Demo reload readiness failed: ' + json.dumps(attempts[-1]))
    tuples = [(host, path, target) for host in base.HOSTS for path, target in VALID]
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda item: fetch(item[0], item[1]), tuples))
        paused = list(pool.map(lambda item: fetch(*item), [(host, path) for host in base.HOSTS for path in PAUSED]))
    for row, (_, _, target) in zip(results, tuples):
        if rollback:
            ok = row['status'] == 503 and row['sha256'] == base.EXPECTED_NEW
        else:
            ok = row['status'] == 308 and row['location'] == target
        if not ok:
            raise RuntimeError('Strict demo alias failed: ' + json.dumps(row))
    if any(row['status'] != 503 or row['location'] or row['sha256'] != base.EXPECTED_NEW for row in paused):
        raise RuntimeError('Old real asset or untrusted demo path escaped the pause: ' + json.dumps(paused))
    return attempts, results, paused


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--rollback', action='store_true'); args = parser.parse_args()
    before_bytes = TARGET.read_bytes()
    old = (HERE / 'bemine-retired-paused.before.conf').read_bytes()
    new = (HERE / 'bemine-retired-paused.conf').read_bytes()
    if base.sha(old) != OLD_SHA or not new.endswith(old) or new[:-len(old)].count(b'if (') != 2:
        raise RuntimeError('Exact guard identity or two alias additions invalid')
    expected, desired = (new, old) if args.rollback else (old, new)
    if TARGET.is_symlink() or before_bytes != expected:
        raise RuntimeError('Shared retired guard CAS mismatch')
    before, workers_before = identities()
    roots_before = compat.protected_roots(before)
    if TARGET.read_bytes() != before_bytes:
        raise RuntimeError('Shared retired guard changed before switch')
    snapshot, _ = identities(); compat.business_unchanged(before, snapshot)
    mode = stat.S_IMODE(TARGET.stat().st_mode)
    base.atomic_write(TARGET, desired, mode)
    reloaded = False
    try:
        subprocess.run(['nginx', '-t'], check=True, capture_output=True, text=True)
        subprocess.run(['systemctl', 'reload', 'nginx'], check=True, capture_output=True, text=True); reloaded = True
        readiness, aliases, paused = valid_proof(args.rollback)
        roots_after = compat.protected_roots(before)
        after, workers_after = identities(); compat.business_unchanged(before, after)
        result = {'publishedAt': datetime.now(timezone.utc).isoformat(), 'rollback': args.rollback,
                  'target': str(TARGET), 'beforeSha256': base.sha(before_bytes), 'afterSha256': base.sha(desired),
                  'nginxReloaded': True, 'businessServicesRestarted': False,
                  'allProductAndUpgradeFilesUnchanged': True, 'businessServiceIdentitiesUnchanged': True,
                  'nginxMasterBefore': before['services']['nginx'], 'nginxMasterAfter': after['services']['nginx'],
                  'nginxWorkerPidsBefore': workers_before, 'nginxWorkerPidsAfter': workers_after,
                  'reloadReadinessAttempts': readiness, 'strictDemoAliases': aliases, 'stillPaused': paused,
                  'protectedPublicBefore': roots_before, 'protectedPublicAfter': roots_after}
        (HERE / ('demo-compatibility-rollback.json' if args.rollback else 'demo-compatibility-publication.json')).write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({key: value for key, value in result.items() if key not in [
            'strictDemoAliases', 'stillPaused', 'protectedPublicBefore', 'protectedPublicAfter',
            'nginxMasterBefore', 'nginxMasterAfter', 'reloadReadinessAttempts']}))
    except Exception:
        if TARGET.read_bytes() != desired:
            raise RuntimeError('Concurrent shared guard edit: automatic rollback refused')
        base.atomic_write(TARGET, before_bytes, mode)
        subprocess.run(['nginx', '-t'], check=True, capture_output=True, text=True)
        if reloaded:
            subprocess.run(['systemctl', 'reload', 'nginx'], check=True, capture_output=True, text=True)
        raise


if __name__ == '__main__':
    main()
