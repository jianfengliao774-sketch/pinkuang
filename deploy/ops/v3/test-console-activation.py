import importlib.util
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest


SCRIPT = Path(__file__).with_name('activate-console.remote.py')
spec = importlib.util.spec_from_file_location('v3_console_activation', SCRIPT)
activation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(activation)


def archive(path, entries):
    with tarfile.open(path, 'w:gz') as output:
        for name, content in entries:
            item = tarfile.TarInfo(name)
            item.size = len(content)
            output.addfile(item, io.BytesIO(content))


def valid_entries():
    entries = [(name, b'same' if name.endswith('deployment-artifacts.json') else b'x')
               for name in sorted(activation.REQUIRED - {'public/fresh-release-manifest.json'})]
    files = {name: {'sha256': hashlib.sha256(content).hexdigest(), 'bytes': len(content)}
             for name, content in entries}
    manifest = {'kind': 'fresh-console-pre-genesis', 'chainId': 56,
                'entrypoint': 'node server/index.mjs',
                'artifactSha256': files['public/deployment-artifacts.json']['sha256'],
                'files': files}
    entries.append(('public/fresh-release-manifest.json', json.dumps(manifest).encode()))
    return entries


class ConsoleArchiveTests(unittest.TestCase):
    def test_exact_runtime_entries_extract_without_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            entries = valid_entries()
            archive(root / 'release.tar.gz', entries)
            activation.validate_archive(root / 'release.tar.gz')
            activation.extract_archive(root / 'release.tar.gz', root / 'release')
            self.assertEqual((root / 'release/dist/deployment-artifacts.json').read_bytes(), b'same')

    def test_archive_rejects_escape_and_hidden_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'release.tar.gz'
            for bad in ('../escape', '/absolute', 'server/.env', 'other/extra'):
                archive(path, valid_entries() + [(bad, b'bad')])
                with self.assertRaisesRegex(RuntimeError, 'unsafe'):
                    activation.validate_archive(path)

    def test_archive_rejects_duplicate_and_missing_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'release.tar.gz'
            archive(path, [(name, content) for name, content in valid_entries()
                           if name != 'server/index.mjs'])
            with self.assertRaisesRegex(RuntimeError, 'lacks'):
                activation.validate_archive(path)
            archive(path, valid_entries() + [('dist/index.html', b'y')])
            with self.assertRaisesRegex(RuntimeError, 'duplicate'):
                activation.validate_archive(path)

    def test_archive_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'release.tar.gz'
            with tarfile.open(path, 'w:gz') as output:
                for name, content in valid_entries():
                    item = tarfile.TarInfo(name)
                    item.size = len(content)
                    output.addfile(item, io.BytesIO(content))
                link = tarfile.TarInfo('server/alias')
                link.type = tarfile.SYMTYPE
                link.linkname = '/etc/passwd'
                output.addfile(link)
            with self.assertRaisesRegex(RuntimeError, 'unsafe'):
                activation.validate_archive(path)

    def test_archive_rejects_legacy_upgrade_page_and_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'release.tar.gz'
            for exposed in ('dist/upgrade.html', 'dist/assets/upgrade-fingerprint.js',
                            'dist/upgrade-genesis/genesis-record.json'):
                archive(path, valid_entries() + [(exposed, b'x')])
                with self.assertRaisesRegex(RuntimeError, 'upgrade page or asset'):
                    activation.validate_archive(path)

    def test_archive_rejects_unmanifested_file_and_checksum_change(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'release.tar.gz'
            archive(path, valid_entries() + [('server/surprise.mjs', b'x')])
            with self.assertRaisesRegex(RuntimeError, 'manifest file list'):
                activation.validate_archive(path)
            entries = [(name, b'changed' if name == 'server/index.mjs' else content)
                       for name, content in valid_entries()]
            archive(path, entries)
            with self.assertRaisesRegex(RuntimeError, 'checksum'):
                activation.validate_archive(path)

    def test_public_console_unit_only_receives_gas_address(self):
        unit = activation.build_public_console_unit(
            Path('/srv/pinkuang-deploy-v3/releases/v3-reviewed'),
            'https://bsc-dataseed.bnbchain.org',
        )
        self.assertIn(f'Environment=BEMINE_EXPECTED_GAS_WALLET={activation.GAS_WALLET}\n', unit)
        self.assertIn('Environment=AUTHORITY_RELAY_ENABLED=0\n', unit)
        for forbidden in ('LoadCredential=', 'KEEPER_PRIVATE_KEY', 'keeper-v3.key'):
            self.assertNotIn(forbidden, unit)

    def test_public_console_rejects_credential_in_process_environment(self):
        activation.require_public_process_environment([
            b'BEMINE_EXPECTED_GAS_WALLET=0x1234', b'NODE_ENV=production',
        ])
        for variable in (b'CREDENTIALS_DIRECTORY=/run/credentials/v3', b'KEEPER_PRIVATE_KEY=secret'):
            with self.assertRaisesRegex(RuntimeError, 'private-key source'):
                activation.require_public_process_environment([variable])


if __name__ == '__main__':
    unittest.main()
