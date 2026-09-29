import importlib.machinery
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


HERE = Path(__file__).parent
RETIRE = importlib.machinery.SourceFileLoader(
    'retire_upgrade_v2_page', str(HERE / 'retire-upgrade-v2-page.remote.py')
).load_module()
LEGACY = importlib.machinery.SourceFileLoader(
    'legacy_route_retirement', str(HERE / 'retire-legacy-routes.remote.py')
).load_module()
REVIEWED = LEGACY.retired_upgrade_rpc(
    (HERE.parent / 'v2/nginx-upgrade-v2.locations.conf').read_text()
).encode()
SITE = '\n'.join(RETIRE.SITE_INCLUDES) + '\n'


class RetireUpgradeV2PageTests(unittest.TestCase):
    def test_reviewed_preimage_retires_only_old_upgrade_page(self):
        result = RETIRE.planned_bytes(REVIEWED)
        self.assertEqual(result, RETIRE.RETIRED)
        self.assertIn(b'location ^~ /pinkuang-upgrade-v2/ { return 410; }', result)
        self.assertNotIn(b'/bemine-v2/', result)
        self.assertNotIn(b'/pinkuang-deploy-v4/', result)
        self.assertEqual(RETIRE.planned_bytes(result), result)

    def test_changed_snippet_or_missing_active_site_include_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'differs from the reviewed version'):
            RETIRE.planned_bytes(REVIEWED.replace(b'no-store', b'max-age=3600'))
        for include in RETIRE.SITE_INCLUDES:
            with self.assertRaisesRegex(RuntimeError, 'unexpected nginx site include'):
                RETIRE.review_site(SITE.replace(include, ''))
        RETIRE.review_site(SITE)

    def test_async_reload_retries_only_the_old_static_page(self):
        page_results = iter([200, 200, 410])
        requests = []

        def observed(path):
            requests.append(path)
            if path == '/pinkuang-upgrade-v2/':
                return next(page_results)
            if path == '/pinkuang-deploy-v4/':
                return 401
            return 410 if path.endswith('/api/rpc') else 200

        with patch.object(RETIRE, 'probe', side_effect=observed), patch.object(RETIRE.time, 'sleep'):
            RETIRE.verify_routes(410)
        self.assertEqual(requests.count('/pinkuang-upgrade-v2/'), 3)
        self.assertEqual(requests.count('/bemine-v2/'), 3)
        self.assertEqual(requests.count('/pinkuang-deploy-v4/'), 3)

    def test_active_route_failure_aborts_without_retry(self):
        page_calls = 0
        v4_calls = 0

        def observed(path):
            nonlocal page_calls, v4_calls
            if path == '/pinkuang-upgrade-v2/':
                page_calls += 1
                return 200
            if path == '/pinkuang-deploy-v4/':
                v4_calls += 1
                return 401 if v4_calls == 1 else 503
            return 410 if path.endswith('/api/rpc') else 200

        with patch.object(RETIRE, 'probe', side_effect=observed), patch.object(RETIRE.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, '/pinkuang-deploy-v4/ returned 503'):
                RETIRE.verify_routes(410)
        self.assertEqual(page_calls, 1)

    def fixture(self, directory):
        root = Path(directory)
        site = root / 'site.conf'
        site.write_text(SITE)
        snippet = root / 'upgrade.conf'
        snippet.write_bytes(REVIEWED)
        return site, snippet

    def test_apply_replaces_exact_snippet_and_keeps_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            site, snippet = self.fixture(directory)
            with (patch.object(RETIRE, 'SITE', site), patch.object(RETIRE, 'SNIPPET', snippet),
                  patch.object(RETIRE, 'BACKUPS', Path(directory)),
                  patch.object(RETIRE, 'command') as command,
                  patch.object(RETIRE, 'verify_routes') as verify,
                  patch.object(sys, 'argv', ['retire', '--apply'])):
                RETIRE.main()
            self.assertEqual(snippet.read_bytes(), RETIRE.RETIRED)
            self.assertEqual(len(list(Path(directory).glob('upgrade.conf.bak-*'))), 1)
            self.assertEqual(list(Path(directory).glob('upgrade.conf.bak-*'))[0].read_bytes(), REVIEWED)
            self.assertEqual([call.args[0] for call in verify.call_args_list], [200, 410])
            self.assertEqual(command.call_count, 2)

    def test_failed_postcheck_restores_reviewed_snippet(self):
        with tempfile.TemporaryDirectory() as directory:
            site, snippet = self.fixture(directory)
            with (patch.object(RETIRE, 'SITE', site), patch.object(RETIRE, 'SNIPPET', snippet),
                  patch.object(RETIRE, 'BACKUPS', Path(directory)),
                  patch.object(RETIRE, 'command') as command,
                  patch.object(RETIRE, 'verify_routes', side_effect=[None, RuntimeError('postcheck'), None]) as verify,
                  patch.object(sys, 'argv', ['retire', '--apply'])):
                with self.assertRaisesRegex(RuntimeError, 'postcheck'):
                    RETIRE.main()
            self.assertEqual(snippet.read_bytes(), REVIEWED)
            self.assertEqual([call.args[0] for call in verify.call_args_list], [200, 410, 200])
            self.assertEqual(command.call_count, 4)


if __name__ == '__main__':
    unittest.main()
