"""Local-only tests for the v3 credential-removal script; no systemd or RPC."""

import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name('remove-public-gas-credential.remote.py')
spec = importlib.util.spec_from_file_location('v3_credential_cleanup', SCRIPT)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class CleanupTests(unittest.TestCase):
    def unit(self):
        return (b'[Unit]\nDescription=BEMine v3\n[Service]\n'
                b'User=pinkuang-v3\nGroup=pinkuang-v3\n'
                b'WorkingDirectory=/srv/pinkuang-deploy-v3/releases/v3-test\n'
                b'ExecStart=/usr/bin/node /srv/pinkuang-deploy-v3/releases/v3-test/server/index.mjs\n'
                b'LoadCredential=keeper-private-key:/etc/pinkuang/keeper-v3.key\n'
                b'Environment=PORT=4175\n'
                b'Environment=DEPLOYMENT_JOURNAL_DB=/var/lib/pinkuang-deploy-v3/journal.sqlite\n'
                b'Environment=AUTHORITY_RELAY_ENABLED=0\n')

    def test_removes_only_reviewed_mount(self):
        original = self.unit()
        with patch.object(module, 'EXPECTED_UNIT_SHA256', module.sha(original)):
            updated, release = module.changed_unit(original)
        self.assertEqual(release, Path('/srv/pinkuang-deploy-v3/releases/v3-test'))
        self.assertEqual(updated, original.replace(module.KEY_LINE, b''))

    def test_refuses_extra_secret_source(self):
        original = self.unit() + b'Environment=KEEPER_PRIVATE_KEY=secret\n'
        with patch.object(module, 'EXPECTED_UNIT_SHA256', module.sha(original)):
            with self.assertRaises(module.Refuse):
                module.changed_unit(original)

    def test_dry_run_never_applies(self):
        with patch.object(module, 'preflight', return_value=object()), \
             patch.object(module, 'apply') as apply, \
             patch.object(sys, 'argv', [str(SCRIPT), '--dry-run']):
            self.assertEqual(module.main(), 0)
            apply.assert_not_called()

    def test_refuses_other_installed_unit_reference(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            unit = directory / 'pinkuang-deploy-v3.service'
            unit.write_bytes(self.unit())
            (directory / 'unrelated.service').write_text(
                '[Service]\nLoadCredential=keeper-private-key:/etc/pinkuang/keeper-v4.key\n')
            with patch.multiple(module, UNIT=unit, DROPIN_ROOTS=(root,)):
                with self.assertRaises(module.Refuse):
                    module.no_other_unit_references()

    def test_allows_enabled_symlink_to_the_v3_unit_itself(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            unit = directory / 'pinkuang-deploy-v3.service'
            unit.write_bytes(self.unit())
            wants = directory / 'multi-user.target.wants'
            wants.mkdir()
            (wants / unit.name).symlink_to(unit)
            with patch.multiple(module, UNIT=unit, DROPIN_ROOTS=(root,)):
                module.no_other_unit_references()

    def test_key_copy_comparison_is_silent(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            original = directory / 'keeper.key'
            copy = directory / 'keeper-v3.key'
            original.write_bytes(b'private test bytes')
            copy.write_bytes(b'private test bytes')
            with patch.object(module, 'V2_KEY', original):
                module.copied_key_equals_original(copy)
                copy.write_bytes(b'different private test bytes')
                with self.assertRaises(module.Refuse):
                    module.copied_key_equals_original(copy)

    def test_failure_restores_v3_unit_and_both_copied_keys(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            unit = directory / 'pinkuang-deploy-v3.service'
            v2 = directory / 'keeper.key'
            v3 = directory / 'keeper-v3.key'
            v4 = directory / 'keeper-v4.key'
            backup = directory / 'backup'
            backup.mkdir()
            original = self.unit()
            updated = original.replace(module.KEY_LINE, b'')
            unit.write_bytes(original)
            v2.write_bytes(b'v2 must remain untouched')
            v3.write_bytes(b'v3 duplicate')
            v4.write_bytes(b'v4 duplicate')
            plan = module.Plan(original, updated, ('deployment', 'activation'),
                               module.fingerprint(v2), module.fingerprint(v3),
                               module.fingerprint(v4))
            running = {'v3': True}
            commands = []

            def command(*args):
                commands.append(args)
                if args[:2] == ('systemctl', 'stop'):
                    running['v3'] = False
                if args[:2] == ('systemctl', 'start'):
                    running['v3'] = True

            def active(name):
                return running['v3'] if name == module.SERVICE else True

            def stop_for_rollback(*args, **kwargs):
                running['v3'] = False
                return module.subprocess.CompletedProcess(args[0], 0)

            with patch.multiple(module, UNIT=unit, V2_KEY=v2, V3_KEY=v3, V4_KEY=v4), \
                 patch.object(module.tempfile, 'mkdtemp', return_value=str(backup)), \
                 patch.object(module, 'journal_snapshot', return_value=plan.journal), \
                 patch.object(module, 'command', side_effect=command), \
                 patch.object(module.subprocess, 'run', side_effect=stop_for_rollback), \
                 patch.object(module, 'copied_key_equals_original'), \
                 patch.object(module, 'process_without_key'), \
                 patch.object(module, 'no_other_unit_references'), \
                 patch.object(module, 'active', side_effect=active), \
                 patch.object(module, 'postcheck', side_effect=module.Refuse('Injected postcheck failure')):
                with self.assertRaises(module.Refuse):
                    module.apply(plan)

            self.assertEqual(unit.read_bytes(), original)
            self.assertEqual(v2.read_bytes(), b'v2 must remain untouched')
            self.assertEqual(v3.read_bytes(), b'v3 duplicate')
            self.assertEqual(v4.read_bytes(), b'v4 duplicate')
            self.assertTrue(running['v3'])
            self.assertFalse(backup.exists())
            self.assertNotIn(('systemctl', 'stop', module.V2_SERVICES[0]), commands)
            self.assertNotIn(('systemctl', 'stop', module.V2_SERVICES[1]), commands)

    def test_success_deletes_only_staged_duplicate_keys(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            unit = directory / 'pinkuang-deploy-v3.service'
            v2 = directory / 'keeper.key'
            v3 = directory / 'keeper-v3.key'
            v4 = directory / 'keeper-v4.key'
            backup = directory / 'backup'
            backup.mkdir()
            original = self.unit()
            updated = original.replace(module.KEY_LINE, b'')
            unit.write_bytes(original)
            v2.write_bytes(b'original key must survive')
            v3.write_bytes(b'copied key one')
            v4.write_bytes(b'copied key two')
            plan = module.Plan(original, updated, ('deployment', 'activation'),
                               module.fingerprint(v2), module.fingerprint(v3),
                               module.fingerprint(v4))
            running = {'v3': True}

            def command(*args):
                if args[:2] == ('systemctl', 'stop'):
                    running['v3'] = False
                if args[:2] == ('systemctl', 'start'):
                    running['v3'] = True

            def active(name):
                return running['v3'] if name == module.SERVICE else True

            def postcheck(_plan):
                self.assertEqual(unit.read_bytes(), updated)
                self.assertFalse(v3.exists())
                self.assertFalse(v4.exists())
                self.assertEqual(v2.read_bytes(), b'original key must survive')

            with patch.multiple(module, UNIT=unit, V2_KEY=v2, V3_KEY=v3, V4_KEY=v4), \
                 patch.object(module.tempfile, 'mkdtemp', return_value=str(backup)), \
                 patch.object(module, 'journal_snapshot', return_value=plan.journal), \
                 patch.object(module, 'command', side_effect=command), \
                 patch.object(module, 'copied_key_equals_original'), \
                 patch.object(module, 'process_without_key'), \
                 patch.object(module, 'no_other_unit_references'), \
                 patch.object(module, 'active', side_effect=active), \
                 patch.object(module, 'postcheck', side_effect=postcheck):
                module.apply(plan)

            self.assertEqual(unit.read_bytes(), updated)
            self.assertEqual(v2.read_bytes(), b'original key must survive')
            self.assertFalse(v3.exists())
            self.assertFalse(v4.exists())
            self.assertFalse(backup.exists())
            self.assertTrue(running['v3'])


if __name__ == '__main__':
    unittest.main()
