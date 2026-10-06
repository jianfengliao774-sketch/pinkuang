import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('legacy_publisher', HERE / 'publish.py')
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
OLD = (HERE / 'bemine-paused.before.html').read_bytes()
NEW = (HERE / 'bemine-paused.html').read_bytes()


class PublisherTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.target = self.root / 'served.html'
        self.target.write_bytes(OLD)
        (self.root / 'bemine-paused.html').write_bytes(NEW)
        self.snapshot = {'files': {'product': {'sha256': 'untouched'}}, 'services': {'example': {'MainPID': '123'}}}
        self.stack = contextlib.ExitStack()
        self.stack.enter_context(patch.object(publisher, 'TARGET', self.target))
        self.stack.enter_context(patch.object(publisher, '__file__', str(self.root / 'publish.py')))
        self.stack.enter_context(patch.object(publisher, 'verify_page', return_value=[]))
        self.stack.enter_context(patch.object(publisher, 'invariants', return_value=self.snapshot))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))

    def tearDown(self):
        self.stack.close()
        self.temp.cleanup()

    def run_publish(self, *args):
        with patch.object(sys, 'argv', ['publish.py', *args]):
            publisher.main()

    def test_success_backs_up_exact_old_bytes(self):
        self.run_publish()
        self.assertEqual(self.target.read_bytes(), NEW)
        self.assertEqual((self.root / 'bemine-paused.before.html').read_bytes(), OLD)
        self.assertTrue((self.root / 'publication.json').exists())

    def test_wrong_before_hash_refuses_to_touch_target(self):
        self.target.write_bytes(b'foreign edit')
        with self.assertRaisesRegex(RuntimeError, 'compare-and-swap mismatch'):
            self.run_publish()
        self.assertEqual(self.target.read_bytes(), b'foreign edit')

    def test_changed_protected_identity_refuses_switch(self):
        with patch.object(publisher, 'invariants', side_effect=[self.snapshot, {'different': True}]):
            with self.assertRaisesRegex(RuntimeError, 'identity changed before switch'):
                self.run_publish()
        self.assertEqual(self.target.read_bytes(), OLD)

    def test_failed_public_proof_rolls_back_only_html(self):
        with patch.object(publisher, 'verify_page', side_effect=[[], RuntimeError('public proof failed')]):
            with self.assertRaisesRegex(RuntimeError, 'public proof failed'):
                self.run_publish()
        self.assertEqual(self.target.read_bytes(), OLD)
        self.assertFalse((self.root / 'publication.json').exists())

    def test_explicit_rollback_requires_current_new_hash(self):
        self.run_publish()
        self.run_publish('--rollback')
        self.assertEqual(self.target.read_bytes(), OLD)
        self.assertTrue((self.root / 'rollback.json').exists())
        self.target.write_bytes(b'foreign edit')
        with self.assertRaisesRegex(RuntimeError, 'compare-and-swap mismatch'):
            self.run_publish('--rollback')
        self.assertEqual(self.target.read_bytes(), b'foreign edit')


if __name__ == '__main__':
    unittest.main()
