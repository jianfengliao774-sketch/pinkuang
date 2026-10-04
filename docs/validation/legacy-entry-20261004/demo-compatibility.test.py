import importlib.util
from pathlib import Path
import re
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('demo_compat', HERE / 'publish-demo-compatibility.py')
publisher = importlib.util.module_from_spec(spec); spec.loader.exec_module(publisher)
NEW = (HERE / 'bemine-retired-paused.conf').read_text()
OLD = (HERE / 'bemine-retired-paused.before.conf').read_bytes()
RULES = re.findall(r'^if \(\$request_uri ~ "([^"]+)"\) \{ return 308 (\S+); \}$', NEW, re.M)


def destination(path):
    for pattern, target in RULES:
        match = re.search(pattern, path)
        if match:
            args = '?' + path.split('?', 1)[1] if '?' in path else ''
            result = target.replace('$is_args$args', args)
            if '$1' in result:
                result = result.replace('$1', match.group(1))
            return result


class DemoCompatibilityTest(unittest.TestCase):
    def test_exact_original_guard_is_preserved(self):
        self.assertEqual(publisher.base.sha(OLD), publisher.OLD_SHA)
        self.assertTrue(NEW.encode().endswith(OLD))
        self.assertEqual(len(RULES), 2)

    def test_every_current_generated_demo_url_has_fixed_origin(self):
        for path, target in publisher.VALID:
            self.assertEqual(destination(path), target, path)
            self.assertTrue(target.startswith('https://bemine.cc.cd/'))

    def test_live_unknown_duplicate_mode_and_api_remain_paused(self):
        for path in publisher.PAUSED:
            self.assertIsNone(destination(path), path)

    def test_cross_origin_query_injections_are_never_redirected(self):
        for path in ['/bemine/share/real.html?mode=demo&project=16928&source=https://evil.invalid',
                     '/bemine/share/real.html?mode=demo&project=16928&project=8204',
                     '/bemine/share/real.html?mode=demo&project=16928%26mode=live',
                     '/bemine/preview.html?source=tg&mode=live']:
            self.assertIsNone(destination(path))

    def test_worker_readiness_accepts_stale_response_then_confirmed_alias(self):
        rows = [{'status': 503, 'sha256': publisher.base.EXPECTED_NEW},
                {'status': 308, 'location': publisher.VALID[0][1]}]
        def fetch(host, path):
            if path == publisher.VALID[0][0] and host == publisher.base.HOSTS[0] and rows:
                return rows.pop(0)
            valid = dict(publisher.VALID)
            return {'status': 308, 'location': valid[path]} if path in valid else {
                'status': 503, 'location': None, 'sha256': publisher.base.EXPECTED_NEW}
        with patch.object(publisher, 'fetch', side_effect=fetch), patch.object(publisher.time, 'sleep') as sleep:
            readiness, valid, paused = publisher.valid_proof()
        self.assertEqual(len(readiness), 2)
        self.assertEqual(len(valid), 114)
        self.assertEqual(len(paused), 24)
        sleep.assert_called_once_with(0.25)


if __name__ == '__main__':
    unittest.main()
