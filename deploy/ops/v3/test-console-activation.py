import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import stat
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

    def test_private_credential_is_0600_even_with_permissive_umask(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source'
            destination = Path(directory) / 'destination'
            source.write_bytes(b'dummy-test-value')
            previous = os.umask(0)
            try:
                activation.copy_private_file(source, destination)
            finally:
                os.umask(previous)
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o600)
            self.assertEqual(destination.read_bytes(), source.read_bytes())
            with self.assertRaises(FileExistsError):
                activation.copy_private_file(source, destination)


if __name__ == '__main__':
    unittest.main()
