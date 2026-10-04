"""Offline payload/proof/rollback checks; no SSH, HTTP, systemd or wallet calls."""

from datetime import datetime, timezone
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('invalid_targets_publisher',
    Path(__file__).with_name('publish-invalid-targets.py'))
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def summary(self, head='c' * 40):
        value = {'schemaVersion': 1, 'sourceHead': head,
                 'backend': {'files': {name: 'a' * 64 for name in publisher.BACKEND_FILES}}}
        (self.root / 'build-summary.json').write_text(json.dumps(value))
        return value

    def archive(self, entries):
        archive = self.root / 'candidate.tar.gz'
        with tarfile.open(archive, 'w:gz') as bundle:
            for name, body in entries:
                item = tarfile.TarInfo(name)
                if isinstance(body, bytes):
                    item.size = len(body)
                    bundle.addfile(item, io.BytesIO(body))
                else:
                    item.type = tarfile.SYMTYPE
                    item.linkname = body
                    bundle.addfile(item)
        files = {name: publisher.sha(body) for name, body in entries if isinstance(body, bytes)}
        pins = {'archive': {'name': archive.name, 'bytes': archive.stat().st_size,
                            'sha256': publisher.sha(archive.read_bytes())}, 'files': files}
        return archive, pins

    def test_exact_reviewed_source_and_five_overlay_files_required(self):
        expected = self.summary()
        self.assertEqual(publisher.load_summary(self.root, 'c' * 40, 'backend')[0], expected)
        with self.assertRaisesRegex(RuntimeError, 'reviewed source'):
            publisher.load_summary(self.root, 'd' * 40, 'backend')
        expected['backend']['files'].pop(publisher.BACKEND_FILES[-1])
        (self.root / 'build-summary.json').write_text(json.dumps(expected))
        with self.assertRaisesRegex(RuntimeError, 'exactly the five'):
            publisher.load_summary(self.root, 'c' * 40, 'backend')

    def test_payload_traversal_and_symlinked_parent_are_rejected(self):
        for name in ['../secret', '/secret', './index.html', 'a//b', 'a/../b', 'a\\b', '._index.html']:
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                publisher.under(self.root, name)
        (self.root / 'link').symlink_to(self.root)
        with self.assertRaisesRegex(RuntimeError, 'symlink'):
            publisher.under(self.root, 'link/index.html')

    def test_valid_archive_is_exactly_bound_and_extracts_regular_files(self):
        entries = [('index.html', b'home'), ('live.html', b'live'),
                   ('fresh-product-release.json', b'{}'), ('data/frontend-manifest.v5.json', b'{}')]
        archive, pins = self.archive(entries)
        expected = publisher.validate_archive(archive, pins)
        dest = self.root / 'staged'
        publisher.extract_archive(archive, dest, expected)
        self.assertEqual(publisher.inventory(dest), pins['files'])
        changed = dict(pins)
        changed['files'] = {**pins['files'], 'index.html': '0' * 64}
        with self.assertRaisesRegex(RuntimeError, 'inventory'):
            publisher.validate_archive(archive, changed)

    def test_archive_duplicate_symlink_and_traversal_are_rejected(self):
        for entries in [[('index.html', b'one'), ('index.html', b'two')],
                        [('link', '/etc/passwd')], [('../outside', b'unsafe')]]:
            with self.subTest(entries=entries):
                archive, pins = self.archive(entries)
                with self.assertRaises(RuntimeError):
                    publisher.validate_archive(archive, pins)

    def pool_payload(self, now=1000):
        observed = datetime.fromtimestamp(now - 5, timezone.utc).isoformat()
        valid = datetime.fromtimestamp(now + 50, timezone.utc).isoformat()
        facts = {'status': 'unavailable', 'purchaseMode': 'fixed', 'reason': 'target_listing_unavailable',
                 'listingEvidence': {'official': 'absent', 'firsto': 'absent',
                                     'observedAt': observed, 'validUntil': valid}}
        return {'source': {'factory': publisher.FACTORY, 'complete': True, 'stale': True},
                'data': {'items': [{'pool': 'pool-' + token,
                                   'params': {'circuitId': {'$bemineBigInt': token}},
                                   'targetAvailability': json.loads(json.dumps(facts))}
                                  for token in ['14281', '14277']] + [
                                      {'params': {'circuitId': {'$bemineBigInt': '9'}},
                                       'targetAvailability': {'status': 'unknown'}}], 'nextCursor': None}}

    def test_known_targets_need_fresh_two_source_absence_but_other_unknown_is_allowed(self):
        value = self.pool_payload()
        proof = publisher.pool_proof(value, now=1000)
        self.assertEqual(proof['statusCounts']['unknown'], 1)
        self.assertEqual(set(proof['targets']), publisher.KNOWN_TARGETS)
        value['data']['items'][0]['targetAvailability']['listingEvidence']['firsto'] = 'unknown'
        with self.assertRaisesRegex(RuntimeError, 'both sources'):
            publisher.pool_proof(value, now=1000)

    def test_expired_and_missing_known_target_evidence_cannot_publish(self):
        with self.assertRaisesRegex(RuntimeError, 'expired'):
            publisher.pool_proof(self.pool_payload(), now=1100)
        value = self.pool_payload()
        value['data']['items'].pop(0)
        with self.assertRaisesRegex(RuntimeError, 'records disappeared'):
            publisher.pool_proof(value, now=1000)

    def test_index_rollback_restores_exact_dropin_and_restarts_only_index(self):
        drop = self.root / 'target-availability.conf'
        dest = self.root / 'candidate-index'
        base = self.root / 'previous-index'
        previous = b'[Service]\nWorkingDirectory=' + str(base).encode() + b'\n'
        drop.write_bytes(b'[Service]\nWorkingDirectory=' + str(dest).encode() + b'\n')
        with patch.object(publisher, 'INDEX_DROPIN', drop), patch.object(publisher, 'INDEX_BASE', base), \
             patch.object(publisher.subprocess, 'run') as run, \
             patch.object(publisher, 'unit', return_value={'WorkingDirectory': str(base)}):
            publisher.restore_index(previous, dest, True)
        self.assertEqual(drop.read_bytes(), previous)
        self.assertEqual([call.args[0] for call in run.call_args_list],
                         [['systemctl', 'daemon-reload'], ['systemctl', 'restart', publisher.INDEX_UNIT]])

    def test_external_dropin_change_refuses_rollback_without_service_mutation(self):
        drop = self.root / 'target-availability.conf'
        drop.write_bytes(b'external change')
        with patch.object(publisher, 'INDEX_DROPIN', drop), \
             patch.object(publisher.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'externally'):
                publisher.restore_index(b'old', self.root / 'candidate-index', True)
        run.assert_not_called()
        self.assertEqual(drop.read_bytes(), b'external change')

    def test_static_rollback_is_atomic_and_external_change_is_not_overwritten(self):
        previous, candidate, other = [self.root / name for name in ['old', 'candidate', 'other']]
        for directory in [previous, candidate, other]:
            directory.mkdir()
        current = self.root / 'current'
        current.symlink_to(candidate)
        publisher.restore_static(current, candidate, previous, self.root / '.rollback')
        self.assertEqual(current.resolve(), previous)
        current.unlink()
        current.symlink_to(other)
        with self.assertRaisesRegex(RuntimeError, 'externally'):
            publisher.restore_static(current, candidate, previous, self.root / '.rollback')
        self.assertEqual(current.resolve(), other)

    def test_failed_atomic_write_keeps_original_and_cleans_temporary(self):
        target = self.root / 'dropin'
        target.write_bytes(b'old')
        with patch.object(publisher.os, 'replace', side_effect=OSError('replace failed')):
            with self.assertRaises(OSError):
                publisher.atomic_write(target, b'new')
        self.assertEqual(target.read_bytes(), b'old')
        self.assertEqual(list(self.root.glob('.*invalid-targets*')), [])


if __name__ == '__main__':
    unittest.main()
