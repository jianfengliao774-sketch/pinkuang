"""Publish the rewards display revision using the verified static-only publisher.

The unchanged shared publisher checks the current release, complete archive,
formal manifest, current graph, service identities, immutable chunk retention,
canonical routing and public content. Failed publication rolls back the symlink.
Upload the pinned shared publisher beside this file as static-publisher.py.
"""
import hashlib
import importlib.util
import json
from pathlib import Path

BASE_HASH = '4e5804eb19f63564e89d2190ee055c196b2a8da067ad1b2f20618fb73e7372b6'
base = Path(__file__).parent.parent / 'reward-collection-20261004/publish.py'
if not base.is_file():
    base = Path(__file__).with_name('static-publisher.py')
if hashlib.sha256(base.read_bytes()).hexdigest() != BASE_HASH:
    raise RuntimeError('Static publisher differs from the reviewed source')
spec = importlib.util.spec_from_file_location('static_publisher', base)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
publisher.RELEASE_INPUT = Path('/root/bemine-uncollected-rewards-release-20261004')
publisher.OLD_DIR = publisher.WEB_ROOT / 'releases/formal-failed-create-c1c5b3a5cf31'
publisher.OLD_FRONTEND_HEAD = 'c1c5b3a5cf318c1464c2bc4af99c2beea2588d94'
publisher.OLD_CONTENT_SHA256 = 'eb3c44cace88673aa5a389e6b00b332ba0f63eb6ed0f47925f326eba13e42b3a'

if __name__ == '__main__':
    prior = json.loads((publisher.OLD_DIR / 'fresh-product-release.json').read_text())
    pins = json.loads((publisher.RELEASE_INPUT / 'build-summary.json').read_text())
    for name, expected in {
        'signerSourceHead': publisher.OLD_FRONTEND_HEAD,
        'machineSourceHead': publisher.RUNTIME_HEAD,
    }.items():
        if prior.get(name) != expected or pins.get(name) != expected:
            raise RuntimeError('Protected business source identity changed: ' + name)
    publisher.main()
    receipt_path = publisher.RELEASE_INPUT / 'publication.json'
    receipt = json.loads(receipt_path.read_text())
    receipt['scope'] = 'frontend-only loaded single-pool uncollected BEM display'
    publisher.write_json(receipt_path, receipt)
