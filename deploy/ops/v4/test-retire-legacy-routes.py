"""Offline coverage for the retired-route editor; never touches nginx or SSH."""
import importlib.util
import fcntl
import os
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


HERE = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('retire_legacy_routes', HERE / 'retire-legacy-routes.remote.py')
RETIRE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RETIRE)

SITE_SOURCE = '''server {
    location = /pinkuang-deploy { return 308 /pinkuang-deploy/; }
    location ^~ /pinkuang-deploy/ { proxy_pass http://127.0.0.1:4173/; }
    # Isolated BEMine integration test;
    location ^~ /bemine-test/ { proxy_pass http://127.0.0.1:4180/; }
    # Separate BEMine real-chain test;
    location ^~ /bemine-live-test/ { proxy_pass http://127.0.0.1:4180/; }
    # BEMine product APIs;
    location ^~ /bemine/api/ { proxy_pass http://127.0.0.1:4173/api/; }
    location / { return 404; }
}
'''
V3_SOURCE = 'location ^~ /pinkuang-deploy-v3/ { proxy_pass http://127.0.0.1:4175/; }\n'
UPGRADE_SOURCE = '''location = /pinkuang-upgrade-v2/api/rpc {
    proxy_pass http://127.0.0.1:4174/api/rpc;
}
location ^~ /pinkuang-upgrade-v2/ { root /var/www/upgrade; }
'''


class TransformTests(unittest.TestCase):
    def test_active_v4_console_is_password_protected(self):
        def protected(path):
            return 401 if path == '/pinkuang-deploy-v4/' else 200
        with patch.object(RETIRE, 'probe', side_effect=protected):
            RETIRE.active_routes()
        with patch.object(RETIRE, 'probe', return_value=200):
            with self.assertRaisesRegex(RuntimeError, '/pinkuang-deploy-v4/ returned 200'):
                RETIRE.active_routes()

    def test_reviewed_shapes_are_idempotent(self):
        site = RETIRE.retired_site(SITE_SOURCE)
        self.assertEqual(RETIRE.retired_site(site), site)
        self.assertIn('location ^~ /bemine/api/ { return 410; }', site)
        self.assertIn('location ^~ /bemine/ { return 302 /bemine-v2/$is_args$args; }', site)
        self.assertEqual(RETIRE.retired_v3(V3_SOURCE), RETIRE.RETIRED_V3)
        self.assertEqual(RETIRE.retired_v3(RETIRE.RETIRED_V3), RETIRE.RETIRED_V3)
        rpc = RETIRE.retired_upgrade_rpc(UPGRADE_SOURCE)
        self.assertEqual(RETIRE.retired_upgrade_rpc(rpc), rpc)
        self.assertEqual(RETIRE.retired_upgrade_rpc(RETIRE.RETIRED_UPGRADE_PAGE), RETIRE.RETIRED_UPGRADE_PAGE)

    def test_unknown_or_partial_shapes_are_refused(self):
        with self.assertRaises(ValueError):
            RETIRE.retired_site(SITE_SOURCE.replace('    # Separate BEMine real-chain test;', '    # unknown;'))
        with self.assertRaises(ValueError):
            RETIRE.retired_v3(RETIRE.RETIRED_V3 + 'location /unexpected { return 200; }\n')
        with self.assertRaises(ValueError):
            RETIRE.retired_upgrade_rpc('location = /pinkuang-upgrade-v2/api/rpc { return 410; }\n')

    def test_missing_or_mismatched_sha_pins_refuse_apply_before_any_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            paths = [root / name for name in ('site.conf', 'v3.conf', 'upgrade.conf')]
            bodies = [SITE_SOURCE, V3_SOURCE, UPGRADE_SOURCE]
            for path, body in zip(paths, bodies):
                path.write_text(body)
            args = types.SimpleNamespace(apply=True, expected_site_sha256=None,
                                         expected_v3_sha256=None, expected_upgrade_sha256=None)
            with patch.multiple(RETIRE, SITE=paths[0], V3=paths[1], UPGRADE=paths[2], PATHS=tuple(paths)), \
                 patch.object(RETIRE, 'apply_changes') as apply, patch('builtins.print'):
                with self.assertRaisesRegex(RuntimeError, 'requires reviewed SHA-256'):
                    RETIRE.run(args)
                args.expected_site_sha256 = '0' * 64
                args.expected_v3_sha256 = RETIRE.digest(paths[1].read_bytes())
                args.expected_upgrade_sha256 = RETIRE.digest(paths[2].read_bytes())
                with self.assertRaisesRegex(RuntimeError, 'preimage differs'):
                    RETIRE.run(args)
                apply.assert_not_called()
                args.expected_site_sha256 = RETIRE.digest(paths[0].read_bytes())
                RETIRE.run(args)
                apply.assert_called_once()

    def test_apply_requires_root_before_opening_lock(self):
        with patch.object(sys, 'argv', ['retire-legacy-routes.remote.py', '--apply']), \
             patch.object(RETIRE.os, 'geteuid', return_value=1000), \
             patch.object(RETIRE.os, 'open') as open_file:
            with self.assertRaisesRegex(RuntimeError, 'requires root'):
                RETIRE.main()
            open_file.assert_not_called()

    def test_second_apply_cannot_run_while_lock_is_held(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = pathlib.Path(directory) / 'retire.lock'
            fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                metadata = types.SimpleNamespace(st_mode=RETIRE.stat.S_IFREG | 0o600,
                                                 st_uid=0, st_nlink=1)
                with patch.object(sys, 'argv', ['retire-legacy-routes.remote.py', '--apply']), \
                     patch.object(RETIRE, 'LOCK', lock), \
                     patch.object(RETIRE.os, 'geteuid', return_value=0), \
                     patch.object(RETIRE.os, 'fstat', return_value=metadata), \
                     patch.object(RETIRE, 'run') as run:
                    with self.assertRaisesRegex(RuntimeError, 'holds the lock'):
                        RETIRE.main()
                    run.assert_not_called()
            finally:
                os.close(fd)


class ApplyTests(unittest.TestCase):
    def test_temp_name_collision_is_refused_without_deleting_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'site.conf'
            path.write_bytes(b'old')
            temp = pathlib.Path(directory) / 'site.conf.new-fixed'
            temp.write_bytes(b'other operator')
            with self.assertRaises(FileExistsError):
                RETIRE.write_atomically(path, b'new', 0o644, 'fixed')
            self.assertEqual(path.read_bytes(), b'old')
            self.assertEqual(temp.read_bytes(), b'other operator')

    def test_reload_probe_allows_only_previous_codes_and_keeps_v4_protected(self):
        previous = {path: 200 for path in RETIRE.RETIRED_ROUTES}
        state = {'round': 0}
        last = list(RETIRE.RETIRED_ROUTES)[-1]
        def observed(path):
            if path in RETIRE.ACTIVE_ROUTES:
                return RETIRE.ACTIVE_ROUTES[path]
            result = previous[path] if state['round'] == 0 else RETIRE.RETIRED_ROUTES[path]
            if path == last:
                state['round'] += 1
            return result
        with patch.object(RETIRE, 'probe', side_effect=observed), patch.object(RETIRE.time, 'sleep'):
            RETIRE.verify_retired_routes(previous)
        self.assertEqual(state['round'], 2)
        def bad(path):
            return RETIRE.ACTIVE_ROUTES[path] if path in RETIRE.ACTIVE_ROUTES else 503
        with patch.object(RETIRE, 'probe', side_effect=bad):
            with self.assertRaisesRegex(RuntimeError, 'unexpected status 503'):
                RETIRE.verify_retired_routes(previous)

    def test_reload_failure_restores_all_bytes_and_reloads_restored_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            first, second = root / 'site.conf', root / 'v3.conf'
            first.write_bytes(b'old site')
            second.write_bytes(b'old v3')
            changes = {first: (b'old site', b'new site'), second: (b'old v3', b'new v3')}
            calls = []

            def command(*args):
                calls.append(args)
                if args == ('systemctl', 'reload', 'nginx') and calls.count(args) == 1:
                    raise RuntimeError('reload failed after applying candidate')

            with patch.object(RETIRE, 'BACKUPS', root / 'private-backups'), \
                 patch.object(RETIRE, 'previous_routes', return_value={}), \
                 patch.object(RETIRE, 'command', side_effect=command), \
                 patch.object(RETIRE, 'active_routes') as active:
                with self.assertRaisesRegex(RuntimeError, 'reload failed'):
                    RETIRE.apply_changes(changes, {first: b'old site', second: b'old v3'})
                self.assertEqual(first.read_bytes(), b'old site')
                self.assertEqual(second.read_bytes(), b'old v3')
                self.assertEqual(calls.count(('nginx', '-t')), 2)
                self.assertEqual(calls.count(('systemctl', 'reload', 'nginx')), 2)
                active.assert_called_once()
                self.assertFalse(list(root.glob('*.new-*')))
                backups = list((root / 'private-backups').glob('*.bak-*'))
                self.assertEqual(len(backups), 2)
                self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in backups))
                self.assertEqual((root / 'private-backups').stat().st_mode & 0o777, 0o700)

    def test_post_reload_probe_failure_also_restores_and_reloads(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            path = root / 'site.conf'
            path.write_bytes(b'old')
            calls = []
            with patch.object(RETIRE, 'BACKUPS', root / 'private-backups'), \
                 patch.object(RETIRE, 'previous_routes', return_value={}), \
                 patch.object(RETIRE, 'verify_retired_routes', side_effect=RuntimeError('bad probe')), \
                 patch.object(RETIRE, 'active_routes'), \
                 patch.object(RETIRE, 'command', side_effect=lambda *args: calls.append(args)):
                with self.assertRaisesRegex(RuntimeError, 'bad probe'):
                    RETIRE.apply_changes({path: (b'old', b'new')}, {path: b'old'})
            self.assertEqual(path.read_bytes(), b'old')
            self.assertEqual(calls.count(('systemctl', 'reload', 'nginx')), 2)

    def test_active_site_failure_aborts_without_backups_or_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            path = root / 'site.conf'
            path.write_bytes(b'old')
            with patch.object(RETIRE, 'BACKUPS', root / 'private-backups'), \
                 patch.object(RETIRE, 'previous_routes', side_effect=RuntimeError('v2 down')):
                with self.assertRaisesRegex(RuntimeError, 'v2 down'):
                    RETIRE.apply_changes({path: (b'old', b'new')}, {path: b'old'})
            self.assertEqual(path.read_bytes(), b'old')
            self.assertFalse((root / 'private-backups').exists())


if __name__ == '__main__':
    unittest.main()
