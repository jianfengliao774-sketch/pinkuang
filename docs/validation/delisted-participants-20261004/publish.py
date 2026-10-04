"""Publish participant delisting notices and refund access as a static-only release."""
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
publisher.RELEASE_INPUT = Path('/root/bemine-delisted-participants-release-20261004')
publisher.OLD_DIR = publisher.WEB_ROOT / 'releases/formal-reward-collection-c6dfcbbcfbd1'
publisher.OLD_FRONTEND_HEAD = 'c6dfcbbcfbd1841aecc51e9a507fa1c711b6080b'
publisher.OLD_CONTENT_SHA256 = '375355afeace0b1c1b857027a15a6167d86a31a9f4bacde182f80f6b7787963a'


def current_graph_read():
    # Read the cached API only. A periodic proof refresh may briefly outlive
    # the cache TTL; wait at most nine seconds without accepting stale proof.
    for attempt in range(4):
        body, _ = publisher.request(publisher.GRAPH_URL)
        graph = json.loads(body)
        publisher.assert_runtime_identity(graph, 'product graph')
        if (graph.get('operationalReady') is True and graph.get('userExitReady') is True
                and graph.get('stale') is False):
            return graph
        refreshing_snapshot = (graph.get('readMode') == 'verified_snapshot'
                               and graph.get('stale') is True
                               and graph.get('refreshing') is True)
        publisher.require(refreshing_snapshot and attempt < 3,
                          'Current product graph is not operational and exit-ready')
        publisher.time.sleep(3)


publisher.graph_read = current_graph_read

if __name__ == '__main__':
    prior = json.loads((publisher.OLD_DIR / 'fresh-product-release.json').read_text())
    pins = json.loads((publisher.RELEASE_INPUT / 'build-summary.json').read_text())
    for name, expected in {
        'signerSourceHead': 'c1c5b3a5cf318c1464c2bc4af99c2beea2588d94',
        'machineSourceHead': publisher.RUNTIME_HEAD,
    }.items():
        if prior.get(name) != expected or pins.get(name) != expected:
            raise RuntimeError('Protected business source identity changed: ' + name)
    publisher.main()
    receipt_path = publisher.RELEASE_INPUT / 'publication.json'
    receipt = json.loads(receipt_path.read_text())
    receipt['scope'] = 'frontend-only participant delisting notices and refund access'
    publisher.write_json(receipt_path, receipt)
