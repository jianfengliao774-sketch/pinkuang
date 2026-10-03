"""Publish only the hidden-target catalog revision from the pinned linkage release.

Ship this file and publish-funding-linkage-frontend.py together. The existing
publisher still verifies the manifest, runtime identity, static hashes, process
identities and canonical routing, and rolls back failed publication.
"""
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'funding_publisher', Path(__file__).with_name('publish-funding-linkage-frontend.py'))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
publisher.RELEASE_INPUT = Path('/root/bemine-hidden-target-release-20261004')
publisher.OLD_DIR = publisher.WEB_ROOT / 'releases/formal-funding-linkage-07041f708b4a'
publisher.OLD_FRONTEND_HEAD = '07041f708b4a1e56a06ab4a15e3b443754ded7e9'
publisher.OLD_CONTENT_SHA256 = '19aa3be52fbca9af0844ab638b9600fd65e8a7ca6323b92e6f93f346cc8319e3'

if __name__ == '__main__':
    publisher.main()
