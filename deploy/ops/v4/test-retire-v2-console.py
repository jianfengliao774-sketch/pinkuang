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
                 patch.object(module, 'review_runtime') as runtime:
                backup = module.apply_update(SOURCE, after)
            self.assertEqual(snippet.read_bytes(), after)
            self.assertEqual(backup.read_bytes(), SOURCE)
            runtime.assert_called_once_with(410)

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
                 patch.object(module, 'review_runtime', side_effect=RuntimeError('health probe failed')):
                with self.assertRaisesRegex(RuntimeError, 'health probe failed'):
                    module.apply_update(SOURCE, after)
            self.assertEqual(snippet.read_bytes(), SOURCE)
            self.assertEqual(commands.count(('systemctl', 'reload', 'nginx')), 2)


if __name__ == '__main__':
    unittest.main()
