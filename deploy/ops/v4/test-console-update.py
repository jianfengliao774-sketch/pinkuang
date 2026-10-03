"""Offline checks for removing Gas credentials from the public v4 console."""

import runpy
import hashlib
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch


script = runpy.run_path(str(Path(__file__).with_name('update-console.remote.py')))
without_hot_wallet_credential = script['without_hot_wallet_credential']
replacement_unit = script['replacement_unit']
review_unit = script['review_unit']
empty_genesis_journals = script['empty_genesis_journals']
require_effective_unit_isolated = script['require_effective_unit_isolated']
main = script['main']
OLD = Path('/srv/pinkuang-deploy-v4/releases/v4-old')
NEW = Path('/srv/pinkuang-deploy-v4/releases/v4-new')


def reviewed_unit(*, credential=True, flags=False):
    lines = [
        '[Unit]', 'Description=BEMine v4 hardware-wallet deployment console (pre-genesis)',
        'After=network-online.target', 'Wants=network-online.target', '',
        '[Service]', 'Type=simple', 'User=pinkuang-v4', 'Group=pinkuang-v4',
        f'WorkingDirectory={OLD}', f'ExecStart=/usr/bin/node {OLD}/server/index.mjs',
        'Environment=NODE_ENV=production', 'Environment=HOST=127.0.0.1',
        'Environment=PORT=4177',
        'Environment=DEPLOYMENT_JOURNAL_ORIGIN=https://tapeout.cc.cd',
        'Environment=DEPLOYMENT_JOURNAL_DB=/var/lib/pinkuang-deploy-v4/journal.sqlite',
        'Environment=DEPLOYMENT_JOURNAL_RPC_URL=https://bsc.example/rpc',
        'Environment=BEMINE_READ_RPC_URL=https://bsc.example/rpc',
        'Environment=BEMINE_INDEX_URL=http://127.0.0.1:4184',
        'Environment=BEMINE_NOTIFICATIONS_ENABLED=0',
        script['LEGACY_GAS_WALLET_ENV'].rstrip('\n'),
        'Environment=AUTHORITY_RELAY_ENABLED=0',
    ]
    if flags:
        lines += ['Environment=BEMINE_FRESH_CONSOLE_PRE_GENESIS=1',
                  'Environment=BEMINE_FRESH_STAGE2_HOLD=1']
    if credential:
        lines += ['LoadCredential=keeper-private-key:/etc/pinkuang/keeper-v4.key']
    lines += ['UMask=0077', 'NoNewPrivileges=true', 'PrivateTmp=true',
              'ProtectHome=true', 'ProtectSystem=strict',
              'ReadWritePaths=/var/lib/pinkuang-deploy-v4',
              'Restart=on-failure', 'RestartSec=5', 'TimeoutStopSec=45', '',
              '[Install]', 'WantedBy=multi-user.target', '']
    return '\n'.join(lines)


class ConsoleCredentialTests(unittest.TestCase):
    def test_activation_helper_is_pinned_before_execution(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(__file__).with_name('update-console.remote.py')
            helper = Path(__file__).with_name('activate-console.remote.py')
            copy = Path(folder) / source.name
            sibling = Path(folder) / helper.name
            copy.write_bytes(source.read_bytes())
            sibling.write_bytes(helper.read_bytes() + b'\n# unexpected edit\n')
            with self.assertRaisesRegex(RuntimeError, 'differs from the reviewed source'):
                runpy.run_path(str(copy))

    def test_reviewed_legacy_key_is_removed(self):
        old = ('[Service]\n'
               'LoadCredential=keeper-private-key:/etc/pinkuang/keeper-v4.key\n'
               'Environment=BEMINE_EXPECTED_GAS_WALLET=0xA285d1933e32b5990625aC1F5BEa205Cf2606619\n')
        new = without_hot_wallet_credential(old)
        self.assertNotIn('LoadCredential=', new)
        self.assertIn('BEMINE_EXPECTED_GAS_WALLET=', new)

    def test_new_unit_without_credentials_is_idempotent(self):
        new = '[Service]\nEnvironment=AUTHORITY_RELAY_ENABLED=0\n'
        self.assertEqual(without_hot_wallet_credential(new), new)

    def test_unreviewed_credentials_are_rejected(self):
        for directive in ('LoadCredential=other:/tmp/key',
                          'LoadCredentialEncrypted=keeper-private-key:/tmp/key',
                          'SetCredential=keeper-private-key:secret'):
            with self.subTest(directive=directive):
                with self.assertRaisesRegex(RuntimeError, 'unexpected credential'):
                    without_hot_wallet_credential('[Service]\n' + directive + '\n')

    def test_replacement_removes_key_and_keeps_reviewed_public_address_and_holds(self):
        updated = replacement_unit(reviewed_unit(flags=False), OLD, NEW)
        self.assertNotIn('LoadCredential=', updated)
        self.assertEqual(updated.count(script['LEGACY_GAS_WALLET_ENV']), 1)
        self.assertIn(f'WorkingDirectory={NEW}\n', updated)
        self.assertIn(f'ExecStart=/usr/bin/node {NEW}/server/index.mjs\n', updated)
        self.assertEqual(updated.count('Environment=BEMINE_FRESH_CONSOLE_PRE_GENESIS=1\n'), 1)
        self.assertEqual(updated.count('Environment=BEMINE_FRESH_STAGE2_HOLD=1\n'), 1)
        review_unit(updated, NEW, expect_credential=False, require_flags=True)

    def test_replacement_rejects_unknown_directives_and_safety_overrides(self):
        original = reviewed_unit(flags=True)
        unsafe = (
            original.replace('UMask=0077', 'EnvironmentFile=/etc/pinkuang/private.env\nUMask=0077'),
            original.replace('UMask=0077', 'PassEnvironment=KEEPER_PRIVATE_KEY\nUMask=0077'),
            original.replace('UMask=0077', 'ExecStartPre=/bin/true\nUMask=0077'),
            original.replace('UMask=0077', 'SetCredential=key:secret\nUMask=0077'),
            original.replace('UMask=0077', 'Environment=AUTHORITY_RELAY_SOCKET=/run/key\nUMask=0077'),
            original.replace('Environment=AUTHORITY_RELAY_ENABLED=0',
                             'Environment=AUTHORITY_RELAY_ENABLED=0\nEnvironment=AUTHORITY_RELAY_ENABLED=1'),
            original.replace('Environment=BEMINE_FRESH_STAGE2_HOLD=1',
                             'Environment=BEMINE_FRESH_STAGE2_HOLD=0'),
        )
        for unit in unsafe:
            with self.subTest(unit=unit[-120:]), self.assertRaises(RuntimeError):
                replacement_unit(unit, OLD, NEW)

    def test_replacement_accepts_key_already_absent(self):
        updated = replacement_unit(reviewed_unit(credential=False, flags=True), OLD, NEW)
        self.assertNotIn('LoadCredential=', updated)
        self.assertEqual(updated.count(script['LEGACY_GAS_WALLET_ENV']), 1)

    def test_replacement_accepts_console_without_old_gas_address(self):
        old = reviewed_unit(credential=False, flags=True).replace(script['LEGACY_GAS_WALLET_ENV'], '')
        updated = replacement_unit(old, OLD, NEW)
        self.assertEqual(updated.count(script['LEGACY_GAS_WALLET_ENV']), 1)
        review_unit(updated, NEW, expect_credential=False, require_flags=True)

    def test_replacement_rejects_unreviewed_gas_wallet_address(self):
        old = reviewed_unit(credential=False, flags=True)
        changed = old.replace('0xA285d1933e32b5990625aC1F5BEa205Cf2606619',
                              '0x1111111111111111111111111111111111111111')
        with self.assertRaisesRegex(RuntimeError, 'unreviewed Gas wallet'):
            replacement_unit(changed, OLD, NEW)


class EmptyJournalTests(unittest.TestCase):
    def test_every_durable_business_table_must_be_empty(self):
        tables = script['BUSINESS_TABLES']
        self.assertEqual(set(tables), {
            'deployment', 'fresh_activation', 'deployment_archives', 'market',
            'market_abandoned', 'market_signing', 'market_results', 'budget_queues', 'quotes',
        })
        with tempfile.TemporaryDirectory() as folder:
            database = Path(folder) / 'journal.sqlite'
            with sqlite3.connect(database) as db:
                for table in tables:
                    db.execute(f'CREATE TABLE "{table}" (value INTEGER)')
            with patch.dict(empty_genesis_journals.__globals__, {'DB': database}):
                empty_genesis_journals()
                for table in tables:
                    with sqlite3.connect(database) as db:
                        db.execute(f'INSERT INTO "{table}" VALUES (1)')
                    with self.subTest(table=table), self.assertRaisesRegex(RuntimeError, table):
                        empty_genesis_journals()
                    with sqlite3.connect(database) as db:
                        db.execute(f'DELETE FROM "{table}"')


class EffectiveUnitTests(unittest.TestCase):
    def test_dropins_or_pending_reload_are_rejected(self):
        values = {'FragmentPath': str(script['UNIT']), 'NeedDaemonReload': 'no',
                  'DropInPaths': ''}
        def show(args, **_):
            return values[args[2].split('=', 1)[1]] + '\n'
        with tempfile.TemporaryDirectory() as folder:
            with patch.dict(require_effective_unit_isolated.__globals__,
                            {'SYSTEMD_DROPIN_ROOTS': (folder,)}), \
                 patch('subprocess.check_output', side_effect=show):
                require_effective_unit_isolated()
                values['NeedDaemonReload'] = 'yes'
                with self.assertRaisesRegex(RuntimeError, 'needs a reload'):
                    require_effective_unit_isolated()
                values['NeedDaemonReload'] = 'no'
                values['DropInPaths'] = '/run/systemd/system/pinkuang-deploy-v4.service.d/x.conf'
                with self.assertRaisesRegex(RuntimeError, 'effective drop-in'):
                    require_effective_unit_isolated()
                values['DropInPaths'] = ''
                dropins = Path(folder) / 'pinkuang-deploy-v4.service.d'
                dropins.mkdir()
                (dropins / 'x.conf').write_text('[Service]\nEnvironment=KEEPER_PRIVATE_KEY=bad\n')
                with self.assertRaisesRegex(RuntimeError, 'on-disk drop-in'):
                    require_effective_unit_isolated()
                (dropins / 'x.conf').unlink()
                generic = Path(folder) / 'service.d'
                generic.mkdir()
                (generic / 'all.conf').write_text('[Service]\nPassEnvironment=KEEPER_PRIVATE_KEY\n')
                with self.assertRaisesRegex(RuntimeError, 'on-disk drop-in'):
                    require_effective_unit_isolated()


class UpdateOrderTests(unittest.TestCase):
    def staging(self, folder, unit):
        root = Path(folder)
        releases = root / 'releases'
        old = releases / 'v4-old'
        old.mkdir(parents=True)
        current = root / 'pinkuang-deploy-v4.service'
        current.write_text(unit.replace(str(OLD), str(old)))
        archive = root / 'v4-new.tar.gz'
        archive.write_bytes(b'offline-test-archive')
        digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        args = ['update-console.remote.py', '--archive', str(archive),
                '--archive-sha256', digest(archive), '--release-id', 'v4-new',
                '--current-release-id', 'v4-old', '--current-unit-sha256', digest(current)]
        return current, releases, args

    def test_dry_run_validates_complete_replacement_without_staging(self):
        with tempfile.TemporaryDirectory() as folder:
            current, releases, args = self.staging(folder, reviewed_unit())
            snippet = Path(folder) / 'pinkuang-deploy-v4.conf'
            snippet.write_text('location ^~ /pinkuang-deploy-v4/ {\n'
                               '    auth_basic "BEMine deployment";\n'
                               '    auth_basic_user_file /etc/nginx/pinkuang-deploy-v4.htpasswd;\n}\n')
            hooks = {'UNIT': current, 'RELEASES': releases,
                     'SNIPPET': snippet, 'require_console_auth_file': lambda: None,
                     'require_effective_unit_isolated': lambda: None,
                     'empty_genesis_journals': lambda: None,
                     'validate_archive': lambda _: None,
                     'extract_archive': lambda *_: self.fail('dry-run extracted the release')}
            with patch.dict(main.__globals__, hooks), \
                 patch('os.geteuid', return_value=0), \
                 patch('subprocess.check_output', return_value='active\n'), \
                 patch.object(sys, 'argv', args + ['--dry-run']):
                main()
                self.assertFalse((releases / 'v4-new').exists())
                current.write_text(current.read_text().replace('UMask=0077',
                    'EnvironmentFile=/etc/pinkuang/private.env\nUMask=0077'))
                args[-1] = hashlib.sha256(current.read_bytes()).hexdigest()
                with patch.object(sys, 'argv', args + ['--dry-run']), \
                     self.assertRaisesRegex(RuntimeError, 'unexpected directive'):
                    main()
                self.assertFalse((releases / 'v4-new').exists())

    def test_journals_are_rechecked_after_service_stops(self):
        with tempfile.TemporaryDirectory() as folder:
            current, releases, args = self.staging(folder, reviewed_unit())
            snippet = Path(folder) / 'pinkuang-deploy-v4.conf'
            snippet.write_text('location ^~ /pinkuang-deploy-v4/ {\n'
                               '    auth_basic "BEMine deployment";\n'
                               '    auth_basic_user_file /etc/nginx/pinkuang-deploy-v4.htpasswd;\n}\n')
            counts, commands = [], []
            def journals():
                counts.append(1)
                if len(counts) == 3:
                    raise RuntimeError('deployment journal acquired a row')
            hooks = {'UNIT': current, 'RELEASES': releases,
                     'SNIPPET': snippet, 'require_console_auth_file': lambda: None,
                     'require_effective_unit_isolated': lambda: None,
                     'empty_genesis_journals': journals,
                     'validate_archive': lambda _: None,
                     'extract_archive': lambda _, target: target.mkdir(),
                     'command': lambda value, **_: commands.append(value),
                     'write_atomic': lambda *_: self.fail('unit changed after journal race')}
            with patch.dict(main.__globals__, hooks), \
                 patch('os.geteuid', return_value=0), \
                 patch('subprocess.check_output', return_value='active\n'), \
                 patch.object(sys, 'argv', args), \
                 self.assertRaisesRegex(RuntimeError, 'acquired a row'):
                main()
            self.assertEqual(len(counts), 3)
            self.assertEqual(commands, [
                ['npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
                ['systemctl', 'stop', 'pinkuang-deploy-v4.service'],
                ['systemctl', 'stop', 'pinkuang-deploy-v4.service'],
                ['systemctl', 'daemon-reload'],
                ['systemctl', 'start', 'pinkuang-deploy-v4.service'],
            ])

    def test_stop_error_after_process_exit_still_restarts_original_console(self):
        with tempfile.TemporaryDirectory() as folder:
            current, releases, args = self.staging(folder, reviewed_unit(credential=False, flags=True))
            original = current.read_bytes()
            snippet = Path(folder) / 'pinkuang-deploy-v4.conf'
            snippet.write_text('location ^~ /pinkuang-deploy-v4/ {\n'
                               '    auth_basic "BEMine deployment";\n'
                               '    auth_basic_user_file /etc/nginx/pinkuang-deploy-v4.htpasswd;\n}\n')
            commands = []
            stop_count = 0

            def command(value, **_):
                nonlocal stop_count
                commands.append(value)
                if value[:2] == ['systemctl', 'stop']:
                    stop_count += 1
                    if stop_count == 1:
                        raise RuntimeError('systemctl reported an error after the process stopped')

            hooks = {'UNIT': current, 'RELEASES': releases,
                     'SNIPPET': snippet, 'require_console_auth_file': lambda: None,
                     'require_effective_unit_isolated': lambda: None,
                     'empty_genesis_journals': lambda: None,
                     'validate_archive': lambda _: None,
                     'extract_archive': lambda _, target: target.mkdir(),
                     'command': command}
            with patch.dict(main.__globals__, hooks), \
                 patch('os.geteuid', return_value=0), \
                 patch('subprocess.check_output', return_value='active\n'), \
                 patch.object(sys, 'argv', args), \
                 self.assertRaisesRegex(RuntimeError, 'after the process stopped'):
                main()
            self.assertEqual(current.read_bytes(), original)
            self.assertEqual(commands[-3:], [
                ['systemctl', 'stop', 'pinkuang-deploy-v4.service'],
                ['systemctl', 'daemon-reload'],
                ['systemctl', 'start', 'pinkuang-deploy-v4.service'],
            ])


if __name__ == '__main__':
    unittest.main()
