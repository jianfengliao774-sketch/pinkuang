#!/usr/bin/env python3
"""A single mobile-review HTML overlay on the pinned active static release.

No client chunk is overwritten. The source JSX is fixed alongside this overlay.
The parent content manifest remains the original reviewed build: this overlay's
separate exact-byte evidence describes the one changed HTML file.
"""
from datetime import datetime, timezone
import argparse
import importlib.util
import json
from pathlib import Path
import stat

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('legacy_publisher', HERE / 'publish.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
TARGET = Path('/var/www/bemine-v5/current/mobile-review.html')
EXPECTED_DIR = '/var/www/bemine-v5/releases/catalog-prices-af164a6ad764'
EXPECTED_OLD = 'd14ed0f055102861ccbfe554c33bb71b82b1b740b000ad44865d72a2a277022c'
EXPECTED_NEW = '3fd2c8d8aa0b934ce37d8f4ed1dace049c1080dcb45a3f64d26ac92af656e374'
OLD_LINK = b'https://tapeout.cc.cd/bemine/#home'
NEW_LINK = b'https://bemine.cc.cd/#home'


def identity():
    result = base.invariants()
    result['files']['parent-build-record'] = {'resolved': str(TARGET.parent.resolve()),
        'sha256': base.sha((TARGET.parent / 'fresh-product-release.json').read_bytes())}
    result['files']['mobile-client-chunk'] = {
        'sha256': base.sha((TARGET.parent / '_next/static/chunks/app/mobile-review/page-45c32413c1f98231.js').read_bytes())}
    return result


def verify(expected):
    rows = []
    for suffix in ['/mobile-review', '/mobile-review.html', '/bemine-v5/mobile-review.html']:
        status, _, body = base.fetch('https://bemine.cc.cd' + suffix)
        if status != 200 or base.sha(body) != expected:
            raise RuntimeError('Mobile HTML public proof failed: ' + suffix)
        rows.append({'url': 'https://bemine.cc.cd' + suffix, 'status': status, 'sha256': base.sha(body)})
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    if str(TARGET.parent.resolve()) != EXPECTED_DIR or TARGET.is_symlink():
        raise RuntimeError('Expected active mobile page identity changed')
    old = TARGET.read_bytes()
    backup = HERE / 'mobile-review.before.html'
    if args.rollback:
        desired = backup.read_bytes()
        current_sha, desired_sha = EXPECTED_NEW, EXPECTED_OLD
    else:
        if old.count(OLD_LINK) != 1:
            raise RuntimeError('Expected one public website anchor')
        desired = old.replace(OLD_LINK, NEW_LINK)
        current_sha, desired_sha = EXPECTED_OLD, EXPECTED_NEW
    if base.sha(old) != current_sha or base.sha(desired) != desired_sha:
        raise RuntimeError('Mobile page exact-byte compare-and-swap mismatch')
    before = identity()
    verify(current_sha)
    if not args.rollback:
        if backup.exists() and backup.read_bytes() != old:
            raise RuntimeError('Original mobile backup conflicts')
        backup.write_bytes(old)
        backup.chmod(0o600)
    if TARGET.read_bytes() != old or identity() != before:
        raise RuntimeError('Protected identity changed before mobile switch')
    mode = stat.S_IMODE(TARGET.stat().st_mode)
    base.atomic_write(TARGET, desired, mode)
    try:
        routes = verify(desired_sha)
        after = identity()
        if after != before:
            raise RuntimeError('Protected identity changed during mobile overlay')
        result = {'publishedAt': datetime.now(timezone.utc).isoformat(), 'rollback': args.rollback,
            'kind': 'single-html-overlay-not-a-rebuilt-parent-release', 'target': str(TARGET),
            'oldSha256': current_sha, 'newSha256': desired_sha,
            'productHomeLiveAndUpgradeFilesUnchanged': True, 'immutableClientChunksUnchanged': True,
            'runtimeRestarted': False, 'serviceProcessesUnchanged': True, 'routes': routes,
            'protected': after}
        (HERE / ('mobile-rollback.json' if args.rollback else 'mobile-publication.json')).write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({key: value for key, value in result.items() if key not in ['routes', 'protected']}))
    except Exception:
        if base.sha(TARGET.read_bytes()) != desired_sha:
            raise RuntimeError('Mobile target changed: automatic rollback refused')
        base.atomic_write(TARGET, old, mode)
        raise


if __name__ == '__main__':
    main()
