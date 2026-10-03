"""Offline checks for the disabled fresh-v4 pair staging gate."""

import io
import json
from pathlib import Path
import runpy
import tarfile
import tempfile
import unittest
from unittest.mock import patch

script = runpy.run_path(str(Path(__file__).with_name('stage-fresh-release-pair.remote.py')))
sha256 = script['sha256']
load_plan = script['load_plan']
archive_files = script['archive_files']
validate_pair = script['validate_pair']
stage_pair = script['stage_pair']


def example_pair():
    head = 'a' * 40
    digest = 'b' * 64
    index = b'{"kind":"fresh-v4"}\n'
    artifact = b'{"chainId":56}\n'
    frontend = {'index.html': b'<html>fresh</html>',
                'data/frontend-manifest.v4.json': b'{"chainId":56}\n'}
    names = sorted(frontend)
    content = sha256(''.join(f'{name}\0{sha256(frontend[name])}\n'
                             for name in names).encode())
    frontend_meta = {'kind': 'fresh-v4-product-static-candidate',
                     'frontendSourceHead': head, 'contentSha256': content,
                     'manifestSha256': 'c' * 64, 'activationAllowed': False,
                     'artifactDigest': digest, 'factory': 'factory',
                     'portfolioFactory': 'portfolio', 'authority': 'authority',
                     'gasWallet': 'wallet'}
    frontend['fresh-product-release.json'] = json.dumps(frontend_meta).encode()
    backend = {'public/fresh-product-manifest.json': index,
               'public/deployment-artifacts.json': artifact,
               'dist/deployment-artifacts.json': artifact,
               'server/index.mjs': b'export default true;\n'}
    backend_meta = {'kind': 'fresh-v4-product-backend-draft',
                    'sourceHead': head, 'sourceCommit': 'd' * 40,
                    'artifactDigest': digest, 'artifactSha256': sha256(artifact),
                    'indexManifestSha256': sha256(index),
                    'files': {name: {'sha256': sha256(data), 'bytes': len(data)}
                              for name, data in backend.items()}}
    backend['public/fresh-release-manifest.json'] = json.dumps(backend_meta).encode()
    pair = {'productFamily': 'fresh-v4', 'sourceHead': head,
            'frontendContentSha256': content,
            'frontendReleaseSha256': sha256(frontend['fresh-product-release.json']),
            'frontendManifestSha256': 'c' * 64,
            'frontendFileCount': len(frontend) - 1,
            'backendReleaseSha256': sha256(backend['public/fresh-release-manifest.json']),
            'backendFileCount': len(backend),
            'indexManifestSha256': sha256(index),
            'backendArtifactSourceCommit': 'd' * 40,
            'artifactDigest': digest, 'factory': 'factory',
            'portfolioFactory': 'portfolio', 'authority': 'authority',
            'gasWallet': 'wallet'}
    plan = {'schemaVersion': 1, 'kind': 'fresh-v4-bound-cutover-draft',
            'chainId': 56, 'activationAllowed': False, 'releasePair': pair,
            'runtimeRoot': '/srv/pinkuang-deploy-v4/releases/v4-pair-test',
            'productRoot': '/var/www/bemine-v4/releases/v4-pair-test',
            'runtimeEnvironment': {
                'BEMINE_FRESH_CONSOLE_PRE_GENESIS': '1',
                'BEMINE_FRESH_STAGE2_HOLD': '1',
                'AUTHORITY_RELAY_ENABLED': '0',
                'BEMINE_NOTIFICATIONS_ENABLED': '0'},
            'purchaseEnvironment': {'FRESH_PURCHASE_ENABLED': '0'}}
    return plan, frontend, backend


def make_archive(path, files, *, symlink=False):
    with tarfile.open(path, 'w:gz') as archive:
        for name, data in files.items():
            item = tarfile.TarInfo(name)
            item.size = len(data)
            archive.addfile(item, io.BytesIO(data))
        if symlink:
            item = tarfile.TarInfo('unsafe-link')
            item.type = tarfile.SYMTYPE
            item.linkname = '/etc/passwd'
            archive.addfile(item)


class StagePairTests(unittest.TestCase):
    def test_plan_and_both_archives_are_checked_before_staging(self):
        plan, front, back = example_pair()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            plan_path = root / 'plan.json'
            plan_path.write_text(json.dumps(plan))
            digest = sha256(plan_path.read_bytes())
            self.assertEqual(load_plan(plan_path, digest), plan)
            front_archive, back_archive = root / 'front.tgz', root / 'back.tgz'
            make_archive(front_archive, front)
            make_archive(back_archive, back)
            validate_pair(plan, archive_files(front_archive), archive_files(back_archive))
            with self.assertRaisesRegex(RuntimeError, 'SHA256 differs'):
                load_plan(plan_path, '0' * 64)
            plan['activationAllowed'] = True
            plan_path.write_text(json.dumps(plan))
            with self.assertRaisesRegex(RuntimeError, 'disabled'):
                load_plan(plan_path, sha256(plan_path.read_bytes()))

    def test_substituted_file_or_symlink_fails_closed(self):
        plan, front, back = example_pair()
        changed = dict(front)
        changed['index.html'] = b'<html>substituted</html>'
        with self.assertRaisesRegex(RuntimeError, 'source-bound plan'):
            validate_pair(plan, changed, back)
        with tempfile.TemporaryDirectory() as folder:
            archive = Path(folder) / 'unsafe.tgz'
            make_archive(archive, front, symlink=True)
            with self.assertRaisesRegex(RuntimeError, 'unsafe entry'):
                archive_files(archive)

    def test_staging_writes_only_new_release_trees(self):
        plan, front, back = example_pair()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            plan['runtimeRoot'] = str(root / 'backend-release')
            plan['productRoot'] = str(root / 'frontend-release')
            with patch.dict(stage_pair.__globals__, {'safe_parent': lambda _: None}):
                staged = stage_pair(plan, front, back)
            self.assertEqual(staged, [plan['runtimeRoot'], plan['productRoot']])
            self.assertEqual((root / 'backend-release/server/index.mjs').read_bytes(),
                             back['server/index.mjs'])
            self.assertEqual((root / 'frontend-release/index.html').read_bytes(),
                             front['index.html'])
            with patch.dict(stage_pair.__globals__, {'safe_parent': lambda _: None}):
                with self.assertRaises(OSError):
                    stage_pair(plan, front, back)


if __name__ == '__main__':
    unittest.main()
