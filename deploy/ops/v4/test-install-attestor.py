import importlib.util
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('attestor_install', Path(__file__).with_name('install-attestor.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class FakeHost(m.Host):
    def __init__(self, root, plan):
        super().__init__(root)
        self.plan = plan; self.calls = []; self.active = {m.PUBLIC: True, m.SIGNER: False}
        self.identities = {('passwd', 'pinkuang-v4'): 'pinkuang-v4:x:987:981::/nonexistent:/usr/sbin/nologin'}
        self.proof_ok = True; self.fail_public_health = False; self.fail_protected = False
        self.health_count = 0

    def show(self, name):
        if name == m.PUBLIC:
            return {'LoadState': 'loaded', 'ActiveState': 'active' if self.active[name] else 'inactive',
                    'SubState': 'running', 'MainPID': '123', 'InvocationID': 'stable-public',
                    'FragmentPath': m.UNIT, 'DropInPaths': m.DROP_IN if self.path(m.DROP_IN).exists() else '',
                    'NeedDaemonReload': 'no', 'User': 'pinkuang-v4', 'Group': 'pinkuang-v4',
                    'WorkingDirectory': self.plan['currentPublicRelease']}
        return {'LoadState': 'loaded' if self.path(m.SIGNER_UNIT).exists() else 'not-found',
                'ActiveState': 'active' if self.active.get(name) else 'inactive',
                'DropInPaths': '', 'NeedDaemonReload': 'no', 'User': m.USER, 'Group': m.GROUP,
                'WorkingDirectory': str(self.path('/srv/pinkuang-v4-signer/releases/' + self.plan['releaseId'])),
                'PrivateNetwork': 'yes', 'RestrictAddressFamilies': 'AF_UNIX'}

    def identity(self, kind, name):
        return self.identities.get((kind, name))

    def protected(self):
        return {'pinkuang-purchase-v2.service': {'MainPID': 'CHANGED' if self.fail_protected else '374865', 'InvocationID': 'v2-original'}}

    def public_process_safe(self, *, installed):
        m.require(self.active[m.PUBLIC], 'Public process down.')
        m.require(self.path(m.DROP_IN).exists() == installed, 'Public credential state differs.')

    def health(self):
        self.health_count += 1
        if self.fail_public_health and self.path(m.DROP_IN).exists():
            raise m.Rejected('Injected HTTP failure.')
        return True

    def wait_public(self):
        m.require(self.active[m.PUBLIC], 'Injected public startup failure.')

    def run(self, argv, **kwargs):
        self.calls.append((list(argv), kwargs))
        if argv[:2] == ['npm', 'ci']:
            (kwargs['cwd'] / 'node_modules').mkdir(mode=0o755)
        elif argv[0] == 'groupadd':
            self.identities[('group', m.GROUP)] = m.GROUP + ':x:975:'
        elif argv[0] == 'useradd':
            self.identities[('passwd', m.USER)] = m.USER + ':x:976:975::/nonexistent:/usr/sbin/nologin'
        elif argv[0] == 'systemctl' and argv[1] in ('start', 'restart', 'stop'):
            self.active[argv[2]] = argv[1] != 'stop'
        elif argv[0] == 'systemd-run':
            return 0, json.dumps({'verified': self.proof_ok, 'gasWallet': m.GAS, 'relayDisabled': True})
        return 0, ''


@unittest.skipUnless(sys.platform == 'linux' and hasattr(os, 'geteuid') and os.geteuid() == 0,
                     'POSIX permissions and root-only installer tests require isolated Linux root')
class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='attestor-offline-test-')
        self.root = Path(self.temp.name)
        self.plan = {'schemaVersion': 1, 'operationId': 'attestor-test-offline',
                     'sourceCommit': 'a' * 40, 'releaseId': 'v4-attestor-test',
                     'manifestSha256': 'b' * 64, 'unitsSha256': 'c' * 64,
                     'currentUnitSha256': 'd' * 64,
                     'currentPublicRelease': '/srv/pinkuang-deploy-v4/releases/v4-test-public',
                     'deploymentAccount': '0x042B23288E2316DFb6503488292FD0Ad2F811Ae7',
                     'deploymentId': '1790727492994-0x042B23288E2316DFb6503488292FD0Ad2F811Ae7',
                     'artifactDigest': '0x' + 'f' * 64, 'stage1RecordSha256': 'e' * 64, 'stage1Revision': 51}
        self.host = FakeHost(self.root, self.plan)
        self.package = self.root / 'staging' / 'package'; self.package.mkdir(parents=True, mode=0o755)
        files = {}
        for name in m.MODULES:
            target = self.package / name; target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            data = ('// fixture ' + name + '\n').encode(); target.write_bytes(data); target.chmod(0o644)
            files[name] = {'sha256': m.sha(data), 'bytes': len(data)}
        self.manifest = {'schemaVersion': 1, 'kind': 'fresh-v4-stage2-attestor', 'chainId': 56,
                         'sourceCommit': self.plan['sourceCommit'], 'entrypoint': 'node server/authority-signer.mjs',
                         'installation': 'npm ci --omit=dev --ignore-scripts',
                         'activation': 'Attestation only; Authority relay and automatic purchase are disabled.',
                         'files': files}
        self.write_manifest()
        signer, public = m.expected_units(self.plan['releaseId'])
        self.draft_data = {'schemaVersion': 1, 'kind': 'fresh-v4-stage2-attestation-draft', 'chainId': 56,
                           'activationAllowed': False, 'signerRoot': '/srv/pinkuang-v4-signer/releases/' + self.plan['releaseId'],
                           'signerUnit': signer, 'publicDropIn': public,
                           'requiredSignerEntrypoint': 'server/authority-signer.mjs',
                           'signerReleaseRequiresIndependentPackage': True}
        self.draft = self.root / 'staging' / 'units.json'
        self.write_draft()
        unit = f'''[Unit]
Description=Offline fixture
[Service]
Type=simple
User=pinkuang-v4
Group=pinkuang-v4
WorkingDirectory={self.plan['currentPublicRelease']}
ExecStart=/usr/bin/node {self.plan['currentPublicRelease']}/server/index.mjs
Environment=HOST=127.0.0.1
Environment=PORT=4177
Environment=BEMINE_FRESH_CONSOLE_PRE_GENESIS=1
Environment=BEMINE_FRESH_STAGE2_HOLD=1
Environment=AUTHORITY_RELAY_ENABLED=0
Environment=BEMINE_EXPECTED_GAS_WALLET={m.GAS}
Environment=DEPLOYMENT_JOURNAL_ORIGIN={m.ORIGIN}
Environment=DEPLOYMENT_JOURNAL_DB={m.DB}
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/pinkuang-deploy-v4
'''.encode()
        path = self.host.path(m.UNIT); path.parent.mkdir(parents=True, mode=0o755)
        path.write_bytes(unit); path.chmod(0o644); self.plan['currentUnitSha256'] = m.sha(unit)
        key = self.host.path(m.OLD_KEY); key.parent.mkdir(parents=True, mode=0o700)
        key.write_bytes(b'ORIGINAL DUMMY KEY DO NOT READ'); key.chmod(0o600)
        self.original_key = key.read_bytes()
        db = self.host.path(m.DB); db.parent.mkdir(parents=True, mode=0o700)
        self.record = {'id': self.plan['deploymentId'], 'account': self.plan['deploymentAccount'],
                       'artifactDigest': self.plan['artifactDigest'], 'status': 'complete',
                       'kind': 'integrated-v2', 'chainId': 56, 'steps': [{'status': 'confirmed'}] * 16}
        self.plan['stage1RecordSha256'] = m.sha(m.canonical(self.record))
        with closing(sqlite3.connect(db)) as connection, connection:
            connection.execute('CREATE TABLE deployment(account TEXT, revision INTEGER, record TEXT)')
            connection.execute('INSERT INTO deployment VALUES(?,?,?)',
                               (self.plan['deploymentAccount'].lower(), 51, json.dumps(self.record)))
            for table in m.BUSINESS:
                connection.execute('CREATE TABLE "' + table + '"(record TEXT)')
        self.original_db = db.read_bytes()
        self.installer = m.Installer(self.host, self.plan, self.package, self.draft)
        self.installer.wait_signer = lambda: None

    def tearDown(self):
        self.temp.cleanup()

    def write_manifest(self):
        path = self.package / 'stage2-attestor-manifest.json'
        path.write_bytes(m.canonical(self.manifest)); path.chmod(0o644)
        self.plan['manifestSha256'] = m.sha(path.read_bytes())

    def write_draft(self):
        self.draft.write_bytes(m.canonical(self.draft_data)); self.draft.chmod(0o644)
        self.plan['unitsSha256'] = m.sha(self.draft.read_bytes())

    def test_dry_run_reads_only_and_accepts_exact_completed_stage1(self):
        before = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertTrue(self.installer.preflight()['preflight'])
        after = {p.relative_to(self.root): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after); self.assertEqual(self.host.calls, [])

    def test_hashed_manifest_supports_new_reviewed_helper_without_hardcoded_count(self):
        name = 'shared/wrapped-activation-proof.mjs'; data = b'// newly reviewed helper\n'
        (self.package / name).write_bytes(data)
        self.manifest['files'][name] = {'sha256': m.sha(data), 'bytes': len(data)}
        self.write_manifest()
        self.assertTrue(self.installer.preflight()['preflight'])

    def test_manifest_path_traversal_is_rejected_even_when_manifest_hash_is_pinned(self):
        self.manifest['files']['../secret.key'] = {'sha256': 'a'*64, 'bytes': 1}; self.write_manifest()
        with self.assertRaisesRegex(m.Rejected, 'path type'):
            self.installer.preflight()

    def test_tampered_module_and_unlisted_secret_are_rejected(self):
        path = self.package / 'server/authority-signer.mjs'; original = path.read_bytes()
        path.write_bytes(b'bad')
        with self.assertRaisesRegex(m.Rejected, 'digest'):
            self.installer.preflight()
        path.write_bytes(original); (self.package / '.env').write_text('DUMMY=not_a_key')
        with self.assertRaisesRegex(m.Rejected, 'unexpected'):
            self.installer.preflight()

    def test_symlink_and_hardlink_payloads_are_rejected(self):
        path = self.package / 'server/authority-signer.mjs'; path.unlink()
        path.symlink_to(self.package / 'server/authority-ipc.mjs')
        with self.assertRaisesRegex(m.Rejected, 'regular'):
            self.installer.preflight()
        path.unlink(); os.link(self.package / 'server/authority-ipc.mjs', path)
        with self.assertRaisesRegex(m.Rejected, 'regular'):
            self.installer.preflight()

    def test_wrong_source_commit_is_rejected(self):
        self.manifest['sourceCommit'] = 'b'*40; self.write_manifest()
        with self.assertRaisesRegex(m.Rejected, 'manifest'):
            self.installer.preflight()

    def test_unit_draft_cannot_enable_relay_or_disable_hold_even_when_hash_pinned(self):
        self.draft_data['publicDropIn'] = self.draft_data['publicDropIn'].replace('BEMINE_FRESH_STAGE2_HOLD=1','BEMINE_FRESH_STAGE2_HOLD=0')
        self.write_draft()
        with self.assertRaisesRegex(m.Rejected, 'shape'):
            self.installer.preflight()

    def test_public_unit_key_injection_rejected_even_with_new_hash(self):
        path = self.host.path(m.UNIT)
        path.write_bytes(path.read_bytes() + b'LoadCredential=keeper-private-key:/etc/pinkuang/keeper.key\n')
        self.plan['currentUnitSha256'] = m.sha(path.read_bytes())
        with self.assertRaisesRegex(m.Rejected, 'injection'):
            self.installer.preflight()

    def test_existing_dropin_rejected_without_overwrite(self):
        path = self.host.path(m.DROP_DIR) / 'other.conf'; path.parent.mkdir(); path.write_text('[Service]\n')
        with self.assertRaisesRegex(m.Rejected, 'drop-in|drop-ins'):
            self.installer.preflight()
        self.assertEqual(path.read_text(), '[Service]\n')

    def test_stage2_nonempty_or_stage1_change_rejected(self):
        with closing(sqlite3.connect(self.host.path(m.DB))) as connection, connection:
            connection.execute('INSERT INTO fresh_activation VALUES(?)', ('{}',))
        with self.assertRaisesRegex(m.Rejected, 'not empty'):
            self.installer.preflight()
        with closing(sqlite3.connect(self.host.path(m.DB))) as connection, connection:
            connection.execute('DELETE FROM fresh_activation'); connection.execute('UPDATE deployment SET revision=52')
        with self.assertRaisesRegex(m.Rejected, 'changed'):
            self.installer.preflight()

    def test_success_only_touches_new_signer_and_public_and_leaves_db_old_key_exact(self):
        result = self.installer.apply()
        self.assertTrue(result['verified']); self.assertTrue(result['stage2Held'])
        self.assertEqual(self.host.path(m.OLD_KEY).read_bytes(), self.original_key)
        self.assertEqual(self.host.path(m.DB).read_bytes(), self.original_db)
        self.assertEqual(self.host.path(m.HMAC).stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.host.path(m.HMAC).stat().st_size, 32)
        unit = self.host.path(m.SIGNER_UNIT).read_text()
        self.assertIn('PrivateNetwork=true', unit); self.assertIn('RestrictAddressFamilies=AF_UNIX', unit)
        for argv, _ in self.host.calls:
            if argv[0] == 'systemctl' and len(argv) > 2:
                self.assertIn(argv[2], {m.PUBLIC, m.SIGNER})
        probe = next(argv for argv, _ in self.host.calls if argv[0] == 'systemd-run')
        self.assertIn('--property=User=pinkuang-v4', probe)
        self.assertIn('--property=PrivateNetwork=true', probe)
        self.assertFalse(any('keeper-private-key' in arg for arg in probe))
        self.assertFalse(any('BEMINE_V2_GAS_SENDER_DRAINED=1' in arg for arg in probe))

    def test_repeated_apply_is_rejected_not_overwritten(self):
        self.installer.apply()
        with self.assertRaises(m.Rejected):
            m.Installer(self.host, self.plan, self.package, self.draft).apply()

    def test_npm_uses_distinct_empty_private_configs_and_explicit_umask(self):
        self.installer.apply()
        argv, options = next(call for call in self.host.calls if call[0][:2] == ['npm', 'ci'])
        user = Path(next(arg.split('=', 1)[1] for arg in argv if arg.startswith('--userconfig=')))
        global_config = Path(next(arg.split('=', 1)[1] for arg in argv if arg.startswith('--globalconfig=')))
        self.assertNotEqual(user, global_config)
        for path in (user, global_config):
            self.assertEqual(path.parent, self.installer.evidence)
            self.assertEqual(path.read_bytes(), b'')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.stat().st_uid, 0)
            self.assertFalse(path.is_symlink())
        self.assertEqual(options['umask'], 0o022)
        self.assertEqual(options['env']['HOME'], str(self.installer.evidence))

    def test_invalid_proof_stops_signer_without_stopping_public(self):
        self.host.proof_ok = False
        with self.assertRaisesRegex(m.Rejected, 'rolled back'):
            self.installer.apply()
        self.assertFalse(self.host.active[m.SIGNER]); self.assertTrue(self.host.active[m.PUBLIC])
        self.assertFalse(self.host.path(m.DROP_IN).exists())
        self.assertFalse(any(argv[:3] == ['systemctl', 'stop', m.PUBLIC] for argv, _ in self.host.calls))

    def test_failed_http_acceptance_rolls_back_only_new_dropin(self):
        self.host.fail_public_health = True
        with self.assertRaisesRegex(m.Rejected, 'rolled back'):
            self.installer.apply()
        self.assertFalse(self.host.path(m.DROP_IN).exists()); self.assertFalse(self.host.active[m.SIGNER])
        self.assertTrue(self.host.active[m.PUBLIC])
        self.assertEqual(self.host.path(m.DB).read_bytes(), self.original_db)
        self.assertEqual(self.host.path(m.OLD_KEY).read_bytes(), self.original_key)

    def test_wallet_write_between_preflight_and_stop_is_not_erased(self):
        original_run = self.host.run
        def changed(argv, **kwargs):
            result = original_run(argv, **kwargs)
            if argv[:3] == ['systemctl', 'stop', m.PUBLIC]:
                with closing(sqlite3.connect(self.host.path(m.DB))) as connection, connection:
                    connection.execute('UPDATE deployment SET revision=52')
            return result
        self.host.run = changed
        with self.assertRaises(m.Rejected):
            self.installer.apply()
        self.assertFalse(self.host.path(m.DROP_IN).exists()); self.assertFalse(self.host.active[m.SIGNER])
        with closing(sqlite3.connect(self.host.path(m.DB))) as connection, connection:
            self.assertEqual(connection.execute('SELECT revision FROM deployment').fetchone()[0], 52)

    def test_rollback_never_clobbers_concurrent_dropin(self):
        def hostile_acceptance():
            self.host.path(m.DROP_IN).write_text('concurrent third party')
            raise m.Rejected('Injected concurrent change.')
        self.installer.verify_installed = hostile_acceptance
        with self.assertRaisesRegex(m.Rejected, 'rollback requires review'):
            self.installer.apply()
        self.assertEqual(self.host.path(m.DROP_IN).read_text(), 'concurrent third party')
        self.assertFalse(self.host.active[m.SIGNER])

    def test_failed_probe_keeps_review_evidence_but_no_signature_or_credential(self):
        self.host.proof_ok = False
        with self.assertRaises(m.Rejected):
            self.installer.apply()
        evidence = (self.installer.evidence / 'events.json').read_text()
        self.assertIn('rollback_finished', evidence)
        self.assertNotIn('signature', evidence); self.assertNotIn('ORIGINAL DUMMY KEY', evidence)

    def test_runtime_dependencies_are_readable_but_not_writable_by_signer(self):
        modules = self.root / 'dependencies'; modules.mkdir(mode=0o700)
        file = modules / 'module.mjs'; file.write_text('export default 1'); file.chmod(0o600)
        m.secure_dependencies(modules)
        self.assertEqual(modules.stat().st_mode & 0o777, 0o755)
        self.assertEqual(file.stat().st_mode & 0o777, 0o644)
        (modules / 'escape').symlink_to(self.root / 'staging')
        with self.assertRaisesRegex(m.Rejected, 'escapes'):
            m.secure_dependencies(modules)

    def test_changed_main_unit_during_apply_does_not_restore_or_start_it(self):
        original_probe = self.installer.probe
        def changed():
            result = original_probe()
            self.host.path(m.UNIT).write_bytes(b'changed independently')
            return result
        self.installer.probe = changed
        with self.assertRaises(m.Rejected):
            self.installer.apply()
        self.assertEqual(self.host.path(m.UNIT).read_bytes(), b'changed independently')
        self.assertFalse(self.host.active[m.SIGNER])
        self.assertFalse(any(argv[:3] == ['systemctl', 'start', m.PUBLIC] for argv, _ in self.host.calls))


class PlanTests(unittest.TestCase):
    def test_probe_source_has_no_transaction_send_and_fixed_readonly_outputs(self):
        self.assertNotIn('sendTransaction', m.PROBE_JS)
        self.assertNotIn('broadcastTransaction', m.PROBE_JS)
        self.assertNotIn('console.log(proof)', m.PROBE_JS)
        self.assertIn('verifyGasSignerAttestation(challenge, proof)', m.PROBE_JS)
        self.assertIn('relayDisabled:true', m.PROBE_JS)


if __name__ == '__main__':
    unittest.main(verbosity=2)
