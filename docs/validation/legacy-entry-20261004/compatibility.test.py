import contextlib
import importlib.util
import io
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('compatibility_publisher', HERE / 'publish-compatibility.py')
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)
VALIDATE_ALIASES = publisher.exact_aliases
SNIPPET = (HERE / 'bemine-v5-legacy-public-entry.conf').read_bytes()
OLD = b'server {\n' + publisher.ANCHOR + b'\n}\n'


class CompatibilityTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = self.root / 'nginx.conf'; self.config.write_bytes(OLD)
        self.snippet = self.root / 'installed-public.conf'
        (self.root / 'bemine-v5-legacy-public-entry.conf').write_bytes(SNIPPET)
        self.aliases = re.findall(r'^location = (\S+) \{ return 308 (\S+)\$is_args\$args; \}$', SNIPPET.decode(), re.M)
        self.snapshot = {'files': {}, 'services': {'nginx': {'MainPID': '17'}, 'business': {'MainPID': '99'}}}
        self.stack = contextlib.ExitStack()
        for name, value in [('HERE', self.root), ('CONFIG', self.config), ('SNIPPET', self.snippet), ('OLD_CONFIG_SHA', publisher.base.sha(OLD))]:
            self.stack.enter_context(patch.object(publisher, name, value))
        self.stack.enter_context(patch.object(publisher, 'exact_aliases', return_value=self.aliases))
        self.stack.enter_context(patch.object(publisher, 'identities', return_value=(self.snapshot, ['18'])))
        self.stack.enter_context(patch.object(publisher, 'protected_roots', return_value=[]))
        self.subprocess = self.stack.enter_context(patch.object(publisher.subprocess, 'run'))
        self.stack.enter_context(patch.object(publisher, 'fetch_redirect', side_effect=self.fetch))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))

    def tearDown(self):
        self.stack.close(); self.temp.cleanup()

    def fetch(self, path):
        aliases = dict(self.aliases)
        route = path.split('?', 1)[0]
        active = publisher.INCLUDE in self.config.read_bytes()
        if active and route in aliases:
            return {'url': path, 'status': 308, 'location': aliases[route] + '?lang=zh&entry=compatibility'}
        return {'url': path, 'status': 404, 'location': None}

    def run_publish(self, *args):
        with patch.object(sys, 'argv', ['publish-compatibility.py', *args]):
            publisher.main()

    def test_success_reloads_only_nginx(self):
        self.run_publish()
        self.assertEqual(self.config.read_bytes(), OLD.replace(publisher.ANCHOR, publisher.ANCHOR + publisher.INCLUDE))
        self.assertEqual(self.snippet.read_bytes(), SNIPPET)
        self.assertEqual([call.args[0] for call in self.subprocess.call_args_list], [['nginx', '-t'], ['systemctl', 'reload', 'nginx']])
        self.assertTrue((self.root / 'compatibility-publication.json').exists())

    def test_foreign_config_refuses_before_any_restart(self):
        self.config.write_bytes(b'foreign config')
        with self.assertRaisesRegex(RuntimeError, 'CAS'):
            self.run_publish()
        self.assertEqual(self.config.read_bytes(), b'foreign config')
        self.subprocess.assert_not_called()

    def test_failed_public_proof_rolls_back_config_and_created_snippet(self):
        with patch.object(publisher, 'fetch_redirect', return_value={'url': 'bad', 'status': 404, 'location': None}):
            with self.assertRaisesRegex(RuntimeError, 'redirect proof failed'):
                self.run_publish()
        self.assertEqual(self.config.read_bytes(), OLD)
        self.assertFalse(self.snippet.exists())
        self.assertEqual([call.args[0] for call in self.subprocess.call_args_list][-2:], [['nginx', '-t'], ['systemctl', 'reload', 'nginx']])

    def test_explicit_rollback_removes_only_exact_overlay(self):
        self.run_publish(); self.run_publish('--rollback')
        self.assertEqual(self.config.read_bytes(), OLD)
        self.assertFalse(self.snippet.exists())
        self.assertTrue((self.root / 'compatibility-rollback.json').exists())

    def test_public_alias_schema_rejects_untrusted_origin_and_api_routes(self):
        with patch.object(Path, 'is_file', return_value=True):
            self.assertEqual(len(VALIDATE_ALIASES(SNIPPET)), 60)
            with self.assertRaisesRegex(RuntimeError, 'fixed-origin'):
                VALIDATE_ALIASES(SNIPPET.replace(b'https://bemine.cc.cd/', b'https://evil.invalid/'))
            with self.assertRaisesRegex(RuntimeError, 'general rewrite or API proxy'):
                VALIDATE_ALIASES(SNIPPET + b'proxy_pass http://127.0.0.1/;\n')
            with self.assertRaisesRegex(RuntimeError, 'Administrative/API routes'):
                VALIDATE_ALIASES(SNIPPET.replace(b'/bemine-v5/budget-share', b'/bemine-v5/api'))


if __name__ == '__main__':
    unittest.main()
