#!/usr/bin/env python3
"""One public preview HTML metadata overlay; preserve serialized hydration data.

No nginx/service restart, JS edits, chain requests or complete product rebuild.
--rollback restores only the exact original preview HTML.
"""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import stat
import urllib.request

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('legacy_compat', HERE / 'publish-compatibility.py')
compat = importlib.util.module_from_spec(spec); spec.loader.exec_module(compat)
base = compat.base
TARGET = Path('/var/www/bemine-v5/current/preview.html')
OLD_SHA = '9eb9c244985208f4711918915488de74e4ebdcab2571833575f849234b6bac24'
OLD_IMAGE = b'https://tapeout.cc.cd/bemine/images/bemine-share-v10.jpg'
NEW_IMAGE = b'https://bemine.cc.cd/bemine-v5/images/bemine-share-v10.jpg'
OLD_PAGE = b'https://tapeout.cc.cd/bemine/preview.html'
NEW_PAGE = b'https://bemine.cc.cd/preview.html'


def updated(old):
    # Two semantic image fields and one page field each occur in DOM and flight.
    if base.sha(old) != OLD_SHA or old.count(OLD_IMAGE) != 4 or old.count(OLD_PAGE) != 2:
        raise RuntimeError('Preview exact-byte identity or metadata count mismatch')
    if NEW_IMAGE in old or NEW_PAGE in old:
        raise RuntimeError('Canonical metadata already present; mixed source refused')
    new = old.replace(OLD_IMAGE, NEW_IMAGE).replace(OLD_PAGE, NEW_PAGE)
    if new.replace(NEW_IMAGE, OLD_IMAGE).replace(NEW_PAGE, OLD_PAGE) != old:
        raise RuntimeError('Metadata replacement changed an unrelated HTML byte')
    return new


def identities():
    snapshot, _ = compat.identities()
    snapshot['files']['current-product-all-files']['files'].pop('preview.html')
    # No nginx configuration should change during this metadata-only switch.
    for path in [compat.CONFIG, compat.SNIPPET]:
        snapshot['files'][str(path)] = {'sha256': base.sha(path.read_bytes())}
    return snapshot


def validate_public(expected):
    checks = []
    for url in ['https://bemine.cc.cd/preview.html', 'https://bemine.cc.cd/bemine-v5/preview.html']:
        status, _, body = base.fetch(url)
        if status != 200 or base.sha(body) != base.sha(expected):
            raise RuntimeError('Public preview metadata byte proof failed: ' + url)
        checks.append({'url': url, 'status': status, 'sha256': base.sha(body)})
    image = NEW_IMAGE.decode()
    request = urllib.request.Request(image, method='HEAD', headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=20) as response:
        if response.status != 200 or response.headers.get('Content-Type') != 'image/jpeg':
            raise RuntimeError('Canonical preview image unavailable')
        checks.append({'url': image, 'method': 'HEAD', 'status': response.status,
                       'contentType': response.headers.get('Content-Type'),
                       'contentLength': response.headers.get('Content-Length')})
    return checks


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--rollback', action='store_true'); args = parser.parse_args()
    backup = HERE / 'preview-metadata.before.html'
    current = TARGET.read_bytes()
    if TARGET.is_symlink():
        raise RuntimeError('Preview target must be expected regular HTML file')
    if args.rollback:
        old = backup.read_bytes(); new = updated(old)
        expected, desired = new, old
    else:
        old = current; new = updated(old)
        expected, desired = old, new
        if backup.exists() and backup.read_bytes() != old:
            raise RuntimeError('Preview protected backup conflicts')
        backup.write_bytes(old); backup.chmod(0o600)
    if current != expected:
        raise RuntimeError('Preview exact-byte CAS refused')
    before = identities()
    roots_before = compat.protected_roots(before)
    if TARGET.read_bytes() != current or identities() != before:
        raise RuntimeError('Preview/protected identities changed before switch')
    mode = stat.S_IMODE(TARGET.stat().st_mode)
    base.atomic_write(TARGET, desired, mode)
    try:
        public = validate_public(desired)
        roots_after = compat.protected_roots(before)
        after = identities()
        if after != before:
            raise RuntimeError('Unrelated public bytes or service identities changed')
        result = {'publishedAt': datetime.now(timezone.utc).isoformat(), 'rollback': args.rollback,
                  'target': str(TARGET), 'beforeSha256': base.sha(current), 'afterSha256': base.sha(desired),
                  'semanticMetadataFieldsChanged': 3, 'htmlDomAndSerializedImageReferences': 4,
                  'htmlDomAndSerializedPageReferences': 2, 'otherProductAndUpgradeFilesUnchanged': True,
                  'serviceIdentitiesUnchanged': True, 'nginxReloaded': False, 'runtimeRestarted': False,
                  'productRebuilt': False, 'artifactDigestMarkerRecalculated': False,
                  'public': public, 'protectedPublicBefore': roots_before, 'protectedPublicAfter': roots_after}
        (HERE / ('preview-metadata-rollback.json' if args.rollback else 'preview-metadata-publication.json')).write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps({key: value for key, value in result.items() if key not in [
            'public', 'protectedPublicBefore', 'protectedPublicAfter']}))
    except Exception:
        if TARGET.read_bytes() != desired:
            raise RuntimeError('Concurrent preview edit: automatic rollback refused')
        base.atomic_write(TARGET, current, mode)
        raise


if __name__ == '__main__':
    main()
