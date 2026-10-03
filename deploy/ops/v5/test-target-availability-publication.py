"""Offline publication checks. No SSH, systemd, public HTTP, or wallet access."""

import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).with_name('publish-target-availability.py')
SPEC = importlib.util.spec_from_file_location('target_availability_publisher', SOURCE)
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)


def digest(data):
    return hashlib.sha256(data).hexdigest()


class PublicationFixture:
    def __init__(self, root):
        self.root = root
        self.base = root / 'releases/v5-product-old'
        self.base.mkdir(parents=True)
        self.dropin = root / 'systemd/target-availability.conf'
        self.incoming = root / 'incoming'
        self.incoming.mkdir()
        self.old_hashes = {}
        for name in publisher.FILES[:2]:
            data = ('old ' + name).encode()
            self.write(self.base / name, data)
            self.old_hashes[name] = digest(data)
        for name in ('public/fresh-product-manifest.json', 'public/deployment-artifacts.json'):
            self.write(self.base / name, ('pinned ' + name).encode())
        (self.base / 'node_modules').mkdir()
        file_hashes = {}
        for name in publisher.FILES:
            data = ('reviewed ' + name).encode()
            self.write(self.incoming / name, data)
            file_hashes[name] = digest(data)
        self.summary = {'sourceHead': 'c' * 40, 'files': file_hashes}
        self.save_summary()
        self.index_directory = str(self.base)
        self.index_restart_count = 0
        self.reload_count = 0
        self.fail_first_reload = False
        self.commands = []

    @staticmethod
    def write(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def save_summary(self):
        (self.incoming / 'backend-summary.json').write_text(json.dumps(self.summary))

    def properties(self, unit):
        if unit == publisher.UNIT:
            return {'ActiveState': 'active', 'SubState': 'running',
                    'InvocationID': f'index-{self.index_restart_count}',
                    'WorkingDirectory': self.index_directory}
        return {'ActiveState': 'active', 'SubState': 'running',
                'InvocationID': 'unchanged-' + unit, 'WorkingDirectory': '/srv/other'}

    def command(self, args, **_kwargs):
        self.commands.append(tuple(args))
        if args[:2] == ['systemctl', 'daemon-reload']:
            self.reload_count += 1
            if self.fail_first_reload and self.reload_count == 1:
                raise subprocess.CalledProcessError(1, args)
        if args[:2] == ['systemctl', 'restart']:
            self.index_restart_count += 1
            self.index_directory = (self.dropin.read_text().split('WorkingDirectory=', 1)[1].strip()
                                    if self.dropin.exists() else str(self.base))
        return subprocess.CompletedProcess(args, 0)

    @staticmethod
    def response(_url, timeout=8):
        assert timeout == 8
        body = {'source': {'factory': '0xCFc7D864DeB615bE04C7f6ac62875c2092C5b1B9'},
                'data': {'items': [{'pool': '0x0000000000000000000000000000000000000001',
                                    'state': {'$bemineBigInt': '0'},
                                    'targetAvailability': {'status': 'available'}}]}}
        return io.BytesIO(json.dumps(body).encode())

    def patches(self):
        return (patch.object(publisher, 'BASE', self.base),
                patch.object(publisher, 'DROPIN', self.dropin),
                patch.object(publisher, 'OLD_HASHES', self.old_hashes),
                patch.object(publisher, 'properties', self.properties),
                patch.object(publisher.subprocess, 'run', self.command),
                patch.object(publisher.urllib.request, 'urlopen', self.response),
                patch.object(publisher.time, 'sleep', lambda _seconds: None),
                patch.object(publisher.os, 'geteuid', lambda: 0))


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.fixture = PublicationFixture(Path(self.temp.name).resolve())
        for item in self.fixture.patches():
            item.start()
            self.addCleanup(item.stop)

    def test_success_changes_only_index_working_directory_after_hashes_and_manifest(self):
        f = self.fixture
        publisher.run(f.incoming)
        destination = f.base.parent / ('v5-target-availability-' + f.summary['sourceHead'][:12])
        self.assertEqual(f.index_directory, str(destination))
        self.assertEqual(f.index_restart_count, 1)
        self.assertEqual(f.commands.count(('systemctl', 'restart', publisher.UNIT)), 1)
        self.assertFalse(any(command[:2] == ('systemctl', 'restart') and command[2] != publisher.UNIT
                             for command in f.commands))
        for name in ('public/fresh-product-manifest.json', 'public/deployment-artifacts.json'):
            self.assertEqual(publisher.sha(destination / name), publisher.sha(f.base / name))
        receipt = json.loads((f.incoming / 'backend-publication.json').read_text())
        self.assertFalse(receipt['contractUpgradeApplied'])

    def test_bad_backend_file_hash_stops_before_copy_or_restart(self):
        f = self.fixture
        f.summary['files'][publisher.FILES[0]] = '0' * 64
        f.save_summary()
        with self.assertRaisesRegex(RuntimeError, 'Incoming file hash mismatch'):
            publisher.run(f.incoming)
        self.assertEqual(f.commands, [])
        self.assertFalse(f.dropin.exists())

    def test_changed_manifest_stops_before_dropin_or_restart(self):
        f = self.fixture
        original = shutil.copytree

        def corrupt_manifest(*args, **options):
            result = original(*args, **options)
            if Path(args[0]) == f.base:
                (result / 'public/fresh-product-manifest.json').write_bytes(b'changed')
            return result

        with patch.object(publisher.shutil, 'copytree', corrupt_manifest):
            with self.assertRaisesRegex(RuntimeError, 'Formal contract binding changed'):
                publisher.run(f.incoming)
        self.assertFalse(f.dropin.exists())
        self.assertFalse(any(command[:2] == ('systemctl', 'restart') for command in f.commands))

    def test_failed_materialization_restores_absent_dropin_and_original_index(self):
        f = self.fixture
        with patch.object(publisher.urllib.request, 'urlopen', side_effect=TimeoutError('cache unavailable')):
            with self.assertRaisesRegex(RuntimeError, 'did not become ready'):
                publisher.run(f.incoming)
        self.assertFalse(f.dropin.exists())
        self.assertEqual(f.index_directory, str(f.base))
        self.assertEqual(f.index_restart_count, 2)
        self.assertFalse((f.incoming / 'backend-publication.json').exists())

    def test_existing_dropin_is_preserved_by_preflight_rejection(self):
        f = self.fixture
        f.write(f.dropin, b'[Service]\nWorkingDirectory=/some/prior/release\n')
        with self.assertRaisesRegex(RuntimeError, 'already installed'):
            publisher.run(f.incoming)
        self.assertEqual(f.dropin.read_bytes(), b'[Service]\nWorkingDirectory=/some/prior/release\n')
        self.assertEqual(f.commands, [])

    def test_first_daemon_reload_failure_restores_original_dropin_before_any_restart(self):
        f = self.fixture
        f.fail_first_reload = True
        with self.assertRaises(subprocess.CalledProcessError):
            publisher.run(f.incoming)
        self.assertFalse(f.dropin.exists(), 'A failed reload must not leave an active future overlay')
        self.assertEqual(f.index_restart_count, 0)


if __name__ == '__main__':
    unittest.main()
