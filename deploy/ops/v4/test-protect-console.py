"""Offline tests for the v4 deployment-console nginx access boundary."""

from pathlib import Path
from contextlib import nullcontext
import hashlib
import runpy
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


tool = runpy.run_path(str(Path(__file__).with_name('protect-console.remote.py')))
protect = tool['protected_snippet']
auth = tool['AUTH']
secure_lock = tool['secure_lock']


class ConsoleAccessTests(unittest.TestCase):
    def test_lock_refuses_symlink_without_truncating_target(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            target = root / 'target'
            target.write_text('preserve me')
            (root / 'v4.lock').symlink_to(target)
            with self.assertRaises(OSError), secure_lock(root / 'v4.lock'):
                pass
            self.assertEqual(target.read_text(), 'preserve me')

    def test_protects_page_and_separate_api_location(self):
        source = ('location ^~ /pinkuang-deploy-v4/api/ {\n    proxy_pass http://127.0.0.1:4177/api/;\n}\n'
                  'location ^~ /pinkuang-deploy-v4/ {\n    proxy_pass http://127.0.0.1:4177/;\n}\n')
        result = protect(source)
        self.assertEqual(result.count(auth), 2)
        self.assertIn('location ^~ /pinkuang-deploy-v4/api/ {\n' + auth, result)
        self.assertIn('location ^~ /pinkuang-deploy-v4/ {\n' + auth, result)

    def test_protects_single_console_location(self):
        source = 'location ^~ /pinkuang-deploy-v4/ {\n    proxy_pass http://127.0.0.1:4177/;\n}\n'
        self.assertEqual(protect(source).count(auth), 1)

    def test_rejects_unknown_or_partly_protected_shape(self):
        for source in (
            'location ^~ /pinkuang-deploy-v4/api/ {\n}\n',
            'location ^~ /pinkuang-deploy-v4/ {\n}\n' * 2,
            'location ^~ /pinkuang-deploy-v4/ {\n' + auth + '}\n',
            ('location ^~ /pinkuang-deploy-v4/ {\n}\n'
             'location = /pinkuang-deploy-v4/api/journal/product-graph { return 200; }\n'),
        ):
            with self.subTest(source=source), self.assertRaises(RuntimeError):
                protect(source)

    def test_failed_nginx_reload_stops_console_without_restoring_public_route(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            snippet = root / 'v4.conf'
            snippet.write_text('location ^~ /pinkuang-deploy-v4/ {\n    proxy_pass http://127.0.0.1:4177/;\n}\n')
            before = snippet.read_bytes()
            calls = []

            def command(*args):
                calls.append(args)
                if args == ('systemctl', 'reload', 'nginx'):
                    raise RuntimeError('reload failed')

            hooks = {'SNIPPET': snippet, 'BACKUP_DIR': root / 'backup',
                     'LOCK': root / 'v4.lock', 'require_credential_file': lambda: None,
                     'secure_lock': lambda path: nullcontext(),
                     'command': command}
            args = ['protect-console.remote.py', '--current-snippet-sha256',
                    hashlib.sha256(before).hexdigest()]
            with patch.dict(tool['main'].__globals__, hooks), \
                 patch('os.geteuid', return_value=0), \
                 patch.object(sys, 'argv', args), \
                 self.assertRaisesRegex(RuntimeError, 'reload failed'):
                tool['main']()
            self.assertIn(auth, snippet.read_text())
            self.assertIn(('systemctl', 'stop', 'pinkuang-deploy-v4.service'), calls)

    def test_public_first_probe_retries_until_every_v4_route_requires_auth(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            snippet = root / 'v4.conf'
            snippet.write_text('location ^~ /pinkuang-deploy-v4/ {\n    proxy_pass http://127.0.0.1:4177/;\n}\n')
            before = snippet.read_bytes()
            calls = []
            probes = {}
            sleeps = []

            def status(path):
                if path == '/bemine-v2/':
                    return '200'
                probes[path] = probes.get(path, 0) + 1
                return '200' if probes[path] == 1 else '401'

            hooks = {'SNIPPET': snippet, 'BACKUP_DIR': root / 'backup',
                     'LOCK': root / 'v4.lock', 'require_credential_file': lambda: None,
                     'secure_lock': lambda path: nullcontext(),
                     'command': lambda *args: calls.append(args),
                     'unauthenticated_status': status,
                     'time': SimpleNamespace(sleep=sleeps.append)}
            args = ['protect-console.remote.py', '--current-snippet-sha256',
                    hashlib.sha256(before).hexdigest()]
            with patch.dict(tool['main'].__globals__, hooks), \
                 patch('os.geteuid', return_value=0), \
                 patch.object(sys, 'argv', args):
                tool['main']()
            self.assertEqual(sorted(probes.values()), [2, 2, 2])
            self.assertEqual(sleeps, [tool['PROBE_INTERVAL_SECONDS']])
            self.assertNotIn(('systemctl', 'stop', 'pinkuang-deploy-v4.service'), calls)

    def test_never_protected_route_stops_console_after_bounded_retries(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            snippet = root / 'v4.conf'
            snippet.write_text('location ^~ /pinkuang-deploy-v4/ {\n    proxy_pass http://127.0.0.1:4177/;\n}\n')
            before = snippet.read_bytes()
            calls = []
            probes = {}
            sleeps = []

            def status(path):
                probes[path] = probes.get(path, 0) + 1
                return '200' if path == '/pinkuang-deploy-v4/' else '401'

            hooks = {'SNIPPET': snippet, 'BACKUP_DIR': root / 'backup',
                     'LOCK': root / 'v4.lock', 'require_credential_file': lambda: None,
                     'secure_lock': lambda path: nullcontext(),
                     'command': lambda *args: calls.append(args),
                     'unauthenticated_status': status,
                     'time': SimpleNamespace(sleep=sleeps.append)}
            args = ['protect-console.remote.py', '--current-snippet-sha256',
                    hashlib.sha256(before).hexdigest()]
            with patch.dict(tool['main'].__globals__, hooks), \
                 patch('os.geteuid', return_value=0), \
                 patch.object(sys, 'argv', args), \
                 self.assertRaisesRegex(RuntimeError, 'did not consistently require authentication'):
                tool['main']()
            self.assertEqual(probes['/pinkuang-deploy-v4/'], tool['PROBE_ATTEMPTS'])
            self.assertEqual(len(sleeps), tool['PROBE_ATTEMPTS'] - 1)
            self.assertIn(('systemctl', 'stop', 'pinkuang-deploy-v4.service'), calls)

    def test_unrelated_v2_probe_failure_keeps_console_protected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            snippet = root / 'v4.conf'
            snippet.write_text('location ^~ /pinkuang-deploy-v4/ {\n    proxy_pass http://127.0.0.1:4177/;\n}\n')
            before = snippet.read_bytes()
            calls = []
            hooks = {'SNIPPET': snippet, 'BACKUP_DIR': root / 'backup',
                     'LOCK': root / 'v4.lock', 'require_credential_file': lambda: None,
                     'secure_lock': lambda path: nullcontext(),
                     'command': lambda *args: calls.append(args),
                     'unauthenticated_status': lambda path: '503' if path == '/bemine-v2/' else '401'}
            args = ['protect-console.remote.py', '--current-snippet-sha256',
                    hashlib.sha256(before).hexdigest()]
            with patch.dict(tool['main'].__globals__, hooks), \
                 patch('os.geteuid', return_value=0), \
                 patch.object(sys, 'argv', args), \
                 self.assertRaisesRegex(RuntimeError, 'access gate remains active'):
                tool['main']()
            self.assertIn(auth, snippet.read_text())
            self.assertNotIn(('systemctl', 'stop', 'pinkuang-deploy-v4.service'), calls)


if __name__ == '__main__':
    unittest.main()
