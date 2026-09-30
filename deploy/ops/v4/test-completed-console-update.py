import importlib.util
from contextlib import closing
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('completed_console_update',
    Path(__file__).with_name('update-completed-console.remote.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CompletedConsoleUpdateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.before_db = module.DB
        module.DB = Path(self.directory.name) / 'journal.sqlite'
        self.record = {'id': 'reviewed-deployment', 'status': 'complete',
            'artifactDigest': '0x' + 'ab' * 32,
            'steps': [{'status': 'confirmed'} for _ in range(16)]}
        with closing(sqlite3.connect(module.DB)) as db, db:
            db.execute('CREATE TABLE deployment (account TEXT, revision INTEGER, record TEXT)')
            db.execute('INSERT INTO deployment VALUES (?,?,?)', ('0x123', 51, json.dumps(self.record)))
            for table in module.TABLES:
                db.execute(f'CREATE TABLE "{table}" (record TEXT)')
        self.plan = {'account': '0x123', 'deploymentId': self.record['id'],
            'artifactDigest': self.record['artifactDigest'],
            'journalSha256': module.sha(module.canonical({'account': '0x123', 'revision': 51, 'record': self.record}))}

    def tearDown(self):
        module.DB = self.before_db
        self.directory.cleanup()

    def test_completed_stage1_is_read_only(self):
        before = module.DB.read_bytes()
        self.assertEqual(module.journal_snapshot(self.plan), self.plan['journalSha256'])
        self.assertEqual(before, module.DB.read_bytes())

    def test_console_update_preserves_an_already_released_hold(self):
        credentials = self.directory.name + '/credentials'
        Path(credentials).mkdir()
        (Path(credentials) / 'authority-ipc-hmac').write_text('fixture')
        root = Path('/reviewed-release')
        dropin = module.DROPINS / '20-stage2-attestation.conf'
        state = {'ActiveState': 'active', 'WorkingDirectory': str(root),
                 'FragmentPath': str(module.UNIT), 'NeedDaemonReload': 'no',
                 'DropInPaths': str(dropin), 'MainPID': '42'}
        env = {**module.FLAGS, 'BEMINE_FRESH_STAGE2_HOLD': '0',
               'CREDENTIALS_DIRECTORY': credentials}
        with patch.object(module, 'service_state', return_value=state), \
             patch.object(module, 'verify_dropin', return_value=dropin), \
             patch.object(module, 'environment', return_value=env):
            module.verify_process({'expectedStage2Hold': '0'}, root)
            with self.assertRaisesRegex(RuntimeError, 'reviewed hold'):
                module.verify_process({'expectedStage2Hold': '1'}, root)
            env['AUTHORITY_RELAY_ENABLED'] = '1'
            with self.assertRaisesRegex(RuntimeError, 'disabled relay'):
                module.verify_process({'expectedStage2Hold': '0'}, root)

    def test_inflight_activation_blocks_runtime_switch(self):
        with closing(sqlite3.connect(module.DB)) as db, db:
            db.execute('INSERT INTO fresh_activation VALUES (?)', ('pending',))
        with self.assertRaisesRegex(RuntimeError, 'no longer empty'):
            module.journal_snapshot(self.plan)

    def test_changed_stage1_revision_requires_new_review(self):
        with closing(sqlite3.connect(module.DB)) as db, db:
            db.execute('UPDATE deployment SET revision=52')
        with self.assertRaisesRegex(RuntimeError, 'record changed'):
            module.journal_snapshot(self.plan)

    def test_partial_or_wrong_artifact_cannot_be_reused(self):
        for field, value in [('status', 'paused'), ('artifactDigest', '0x' + 'cd' * 32)]:
            changed = dict(self.record, **{field: value})
            with closing(sqlite3.connect(module.DB)) as db, db:
                db.execute('UPDATE deployment SET record=?', (json.dumps(changed),))
            with self.assertRaisesRegex(RuntimeError, 'completion differs'):
                module.journal_snapshot(self.plan)

    def test_only_two_reviewed_service_paths_change(self):
        old, new = '/srv/pinkuang-deploy-v4/releases/v4-old', '/srv/pinkuang-deploy-v4/releases/v4-new'
        original = f'[Service]\nWorkingDirectory={old}\nExecStart=/usr/bin/node {old}/server/index.mjs\nEnvironment=BEMINE_FRESH_STAGE2_HOLD=1\n'
        result = module.replacement_unit(original, old, new)
        self.assertEqual(result.replace(new, old), original)
        self.assertIn('BEMINE_FRESH_STAGE2_HOLD=1', result)
        with self.assertRaisesRegex(RuntimeError, 'ambiguous'):
            module.replacement_unit(original + f'WorkingDirectory={old}\n', old, new)


if __name__ == '__main__':
    unittest.main()
