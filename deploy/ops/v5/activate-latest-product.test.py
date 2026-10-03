"""Offline validation for release transforms and private-state preservation."""
import importlib.util
from pathlib import Path
import os
import tempfile
import unittest

ROOT = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location('cutover', ROOT / 'activate-latest-product.py')
CUTOVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CUTOVER)


class CutoverTest(unittest.TestCase):
    def setUp(self):
        self.plan = {'runtime': '/srv/pinkuang-v5/releases/v5-product-reviewed',
                     'sourceHead': 'a' * 40, 'indexManifestSha256': 'b' * 64,
                     'factory': CUTOVER.NEW_FACTORY, 'authority': CUTOVER.NEW_AUTHORITY}

    def test_graph_services_bind_new_source_and_preserve_hardening(self):
        for unit in CUTOVER.UNITS:
            original = (ROOT / 'runtime' / (unit + '.service.in')).read_text()
            changed = CUTOVER.configured_unit(unit, original, self.plan)
            if unit == 'pinkuang-v5-price':
                self.assertEqual(changed, original)
                continue
            self.assertIn('WorkingDirectory=' + self.plan['runtime'], changed)
            self.assertIn('ProtectSystem=strict', changed)
            self.assertIn('NoNewPrivileges=true', changed)
            self.assertEqual([line for line in original.splitlines() if line.startswith('LoadCredential=')],
                             [line for line in changed.splitlines() if line.startswith('LoadCredential=')])
            if unit in ['pinkuang-v5-purchase', 'pinkuang-v5-mining']:
                self.assertIn('--factory ' + CUTOVER.NEW_FACTORY, changed)
                self.assertIn('--rpc ${DEPLOYMENT_JOURNAL_RPC_URL}', changed)
            if unit == 'pinkuang-v5-mining':
                self.assertIn('--authority ' + CUTOVER.NEW_AUTHORITY, changed)
            if unit in ['pinkuang-product-v5', 'pinkuang-index-v5']:
                self.assertIn(self.plan['runtime'] + '/public/fresh-product-manifest.json', changed)
                self.assertIn(self.plan['indexManifestSha256'], changed)

    def test_reference_publisher_uses_new_graph_ledger_with_shared_private_parent(self):
        original = (ROOT / 'runtime/pinkuang-v5-signer.service.in').read_text()
        changed = CUTOVER.configured_unit('pinkuang-v5-signer', original, self.plan)
        self.assertIn('SALE_REFERENCE_PUBLISHER_JOURNAL=/var/lib/pinkuang-v5-signer/authority/sale-reference-cfc7d864deb6.json', changed)
        self.assertNotIn('SALE_REFERENCE_PUBLISHER_JOURNAL=/var/lib/pinkuang-v5-signer/authority/sale-reference.json', changed)
        self.assertIn('LoadCredential=keeper-private-key:/etc/pinkuang/keeper.key', changed)
        self.assertIn('ReadWritePaths=/var/lib/pinkuang-v5-signer ', changed)

    def test_unexpected_duplicate_factory_prevents_activation(self):
        original = (ROOT / 'runtime/pinkuang-v5-purchase.service.in').read_text()
        with self.assertRaisesRegex(RuntimeError, 'factory binding'):
            CUTOVER.configured_unit('pinkuang-v5-purchase', original + '\n# --factory ' + CUTOVER.NEW_FACTORY,
                                    self.plan)

    def test_missing_manifest_pin_cannot_start_new_api(self):
        original = (ROOT / 'runtime/pinkuang-product-v5.service.in').read_text()
        original = original.replace('Environment=BEMINE_FRESH_PRODUCT_MANIFEST_SHA256=@INDEX_SHA@\n', '')
        with self.assertRaisesRegex(RuntimeError, 'environment key'):
            CUTOVER.configured_unit('pinkuang-product-v5', original, self.plan)

    def test_api_override_keeps_separate_protected_rpc_file(self):
        original = '[Service]\nWorkingDirectory=/old\nExecStart=\nExecStart=/usr/bin/node /old/server/index.mjs\nEnvironment=BEMINE_FRESH_MACHINE_SOURCE_HEAD=' + 'c' * 40 + '\nEnvironmentFile=/etc/pinkuang-v5/public-api-read.env\n'
        changed = CUTOVER.set_line(original, 'WorkingDirectory', self.plan['runtime'])
        changed = CUTOVER.require_environment(changed, 'BEMINE_FRESH_MACHINE_SOURCE_HEAD', self.plan['sourceHead'])
        self.assertIn('EnvironmentFile=/etc/pinkuang-v5/public-api-read.env', changed)
        self.assertIn('BEMINE_FRESH_MACHINE_SOURCE_HEAD=' + self.plan['sourceHead'], changed)

    def test_state_backup_and_restore_preserve_private_modes_and_ownership(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'state'
            source.mkdir(mode=0o700)
            (source / 'journal.sqlite').write_bytes(b'private financial state')
            (source / 'journal.sqlite').chmod(0o600)
            (source / 'keeper').mkdir(mode=0o700)
            (source / 'keeper/pending.json').write_text('{}')
            (source / 'keeper/pending.json').chmod(0o600)
            (source / 'keeper/reference').symlink_to('pending.json')
            if os.getuid() == 0:
                for path in [source, *source.rglob('*')]:
                    os.chown(path, 12345, 12345, follow_symlinks=False)
            CUTOVER.copy_tree(source, root / 'backup')
            CUTOVER.copy_tree(root / 'backup', root / 'restored')
            for old in [source, *source.rglob('*')]:
                restored = root / 'restored' / old.relative_to(source)
                before, after = old.lstat(), restored.lstat()
                self.assertEqual((before.st_uid, before.st_gid, before.st_mode),
                                 (after.st_uid, after.st_gid, after.st_mode))
            self.assertEqual((root / 'restored/journal.sqlite').read_bytes(), b'private financial state')
            self.assertTrue((root / 'restored/keeper/reference').is_symlink())


if __name__ == '__main__':
    unittest.main()
