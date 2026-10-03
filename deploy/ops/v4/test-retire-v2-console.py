import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name('retire-v2-console.remote.py')
spec = importlib.util.spec_from_file_location('retire_v2_console', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SOURCE = (Path(__file__).parents[1] / 'v2' / 'nginx-v2.locations.conf').read_bytes()


class RetireV2ConsoleTest(unittest.TestCase):
    def test_only_console_routes_are_replaced(self):
        result = module.retired_snippet(SOURCE, hashlib.sha256(SOURCE).hexdigest())
        self.assertEqual(result, module.RETIRED_SNIPPET.encode())
        self.assertIn(b'location = /pinkuang-deploy-v2 { return 410; }', result)
        self.assertIn(b'location ^~ /pinkuang-deploy-v2/ { return 410; }', result)
        self.assertNotIn(b'proxy_pass', result)
        self.assertEqual(module.retired_snippet(result), result)

    def test_changed_or_mixed_nginx_config_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, 'reviewed bytes'):
            module.retired_snippet(SOURCE + b'\n')
        mixed = SOURCE + b'location ^~ /bemine-v2/ { return 410; }\n'
        with self.assertRaisesRegex(RuntimeError, 'not isolated'):
            module.retired_snippet(mixed, hashlib.sha256(mixed).hexdigest())
        site = '\n'.join(module.SITE_INCLUDES)
        module.review_site(site)
        with self.assertRaisesRegex(RuntimeError, 'additional'):
            module.review_site(site + '\nlocation /pinkuang-deploy-v2/ { return 410; }')
        with self.assertRaisesRegex(RuntimeError, 'exactly one'):
            module.review_site(site.replace(module.SITE_INCLUDES[0], ''))

    def make_journal(self, db: Path, *, market_record=None, deployment_status='complete',
                     result_finalized=True):
        con = sqlite3.connect(db)
        con.executescript('CREATE TABLE deployment(record TEXT);'
                          'CREATE TABLE market(record TEXT);'
                          'CREATE TABLE market_results(result TEXT);')
        con.execute('INSERT INTO deployment VALUES(?)',
                    (json.dumps({'status': deployment_status,
                                 'steps': [{'status': 'confirmed'}]}),))
        con.execute('INSERT INTO market VALUES(?)',
                    (json.dumps(market_record) if market_record else None,))
        con.execute('INSERT INTO market_results VALUES(?)',
                    (json.dumps({'status': 'confirmed', 'finalized': result_finalized}),))
        con.commit()
        con.close()

    def test_journal_review_uses_live_record_not_signing_tombstones(self):
        with tempfile.TemporaryDirectory() as folder:
            db = Path(folder) / 'journal.sqlite'
            self.make_journal(db)
            self.assertEqual(module.review_journal(db),
                             {'completedDeployments': 1, 'activeMarketIntents': 0,
                              'finalizedMarketResults': 1})

    def test_journal_review_rejects_unresolved_business(self):
        for options, message in [
            ({'market_record': {'nonce': 7}}, 'market transaction'),
            ({'deployment_status': 'sending'}, 'deployment'),
            ({'result_finalized': False}, 'market result'),
        ]:
            with self.subTest(options=options), tempfile.TemporaryDirectory() as folder:
                db = Path(folder) / 'journal.sqlite'
                self.make_journal(db, **options)
                with self.assertRaisesRegex(RuntimeError, message):
                    module.review_journal(db)

    def test_apply_changes_only_snippet_and_keeps_backup(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            snippet, backups = root / 'v2.conf', root / 'backup'
            snippet.write_bytes(SOURCE)
            after = module.retired_snippet(SOURCE, hashlib.sha256(SOURCE).hexdigest())
            with patch.object(module, 'SNIPPET', snippet), patch.object(module, 'BACKUPS', backups), \
                 patch.object(module, 'command', return_value=''), \
                 patch.object(module, 'wait_for_retired_route') as runtime:
                backup = module.apply_update(SOURCE, after)
            self.assertEqual(snippet.read_bytes(), after)
            self.assertEqual(backup.read_bytes(), SOURCE)
            runtime.assert_called_once_with()

    def test_failed_validation_restores_exact_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            snippet, backups = root / 'v2.conf', root / 'backup'
            snippet.write_bytes(SOURCE)
            after = module.retired_snippet(SOURCE, hashlib.sha256(SOURCE).hexdigest())
            def command(*args):
                if args == ('nginx', '-t') and snippet.read_bytes() == after:
                    raise RuntimeError('nginx rejected proposed config')
                return ''
            with patch.object(module, 'SNIPPET', snippet), patch.object(module, 'BACKUPS', backups), \
                 patch.object(module, 'command', side_effect=command):
                with self.assertRaisesRegex(RuntimeError, 'nginx rejected'):
                    module.apply_update(SOURCE, after)
            self.assertEqual(snippet.read_bytes(), SOURCE)

    def test_failed_post_reload_probe_restores_original_route(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            snippet, backups = root / 'v2.conf', root / 'backup'
            snippet.write_bytes(SOURCE)
            after = module.retired_snippet(SOURCE, hashlib.sha256(SOURCE).hexdigest())
            commands = []
            def command(*args):
                commands.append(args)
                return ''
            with patch.object(module, 'SNIPPET', snippet), patch.object(module, 'BACKUPS', backups), \
                 patch.object(module, 'command', side_effect=command), \
                 patch.object(module, 'wait_for_retired_route', side_effect=RuntimeError('health probe failed')):
                with self.assertRaisesRegex(RuntimeError, 'health probe failed'):
                    module.apply_update(SOURCE, after)
            self.assertEqual(snippet.read_bytes(), SOURCE)
            self.assertEqual(commands.count(('systemctl', 'reload', 'nginx')), 2)

    def test_reload_waits_only_for_old_console_worker(self):
        with patch.object(module, 'review_services_and_product') as product, \
             patch.object(module, 'bounded_probe', side_effect=[200, 410]) as console, \
             patch.object(module.time, 'sleep') as sleep:
            module.wait_for_retired_route(timeout_s=10)
        self.assertEqual(console.call_count, 2)
        self.assertEqual(product.call_count, 2)
        sleep.assert_called_once()

    def test_reload_rejects_product_error_or_other_console_status_immediately(self):
        with patch.object(module, 'review_services_and_product',
                          side_effect=RuntimeError('product returned 503')), \
             patch.object(module, 'bounded_probe') as console:
            with self.assertRaisesRegex(RuntimeError, 'product returned 503'):
                module.wait_for_retired_route()
            console.assert_not_called()
        with patch.object(module, 'review_services_and_product'), \
             patch.object(module, 'bounded_probe', return_value=503) as console, \
             patch.object(module.time, 'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError, 'returned 503'):
                module.wait_for_retired_route()
            console.assert_called_once()
            sleep.assert_not_called()

    def test_reload_wait_is_bounded_to_ten_seconds(self):
        with patch.object(module, 'review_services_and_product'), \
             patch.object(module, 'bounded_probe', return_value=200), \
             patch.object(module.time, 'monotonic', side_effect=[0, 0, 9.9, 10.01]), \
             patch.object(module.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'timed out'):
                module.wait_for_retired_route(timeout_s=10)


if __name__ == '__main__':
    unittest.main()
