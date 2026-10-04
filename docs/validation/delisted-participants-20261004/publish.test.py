"""Offline cached-graph tests; no HTTP, secrets, wallet or service writes."""
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('participant_publish', Path(__file__).with_name('publish.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CachedGraphTests(unittest.TestCase):
    def graph(self, **updates):
        return dict(factory=module.publisher.FACTORY, artifactDigest=module.publisher.ARTIFACT,
                    stale=False, operationalReady=True, userExitReady=True, readMode='current',
                    refreshing=False) | updates

    def request(self, graph):
        return json.dumps(graph).encode(), {}

    def test_current_is_accepted_once(self):
        graph = self.graph()
        with patch.object(module.publisher, 'request', return_value=self.request(graph)) as read:
            self.assertEqual(module.current_graph_read(), graph)
            read.assert_called_once_with(module.publisher.GRAPH_URL)

    def test_same_identity_refresh_must_finish_before_acceptance(self):
        old = self.graph(stale=True, operationalReady=False, userExitReady=False,
                         readMode='verified_snapshot', refreshing=True)
        current = self.graph()
        with patch.object(module.publisher, 'request', side_effect=[self.request(old), self.request(current)]) as read, \
                patch.object(module.publisher.time, 'sleep') as sleep:
            self.assertEqual(module.current_graph_read(), current)
            self.assertEqual(read.call_count, 2)
            sleep.assert_called_once_with(3)

    def test_stale_is_bounded_and_never_accepted(self):
        old = self.graph(stale=True, operationalReady=False, userExitReady=False,
                         readMode='verified_snapshot', refreshing=True)
        with patch.object(module.publisher, 'request', return_value=self.request(old)) as read, \
                patch.object(module.publisher.time, 'sleep') as sleep:
            with self.assertRaisesRegex(RuntimeError, 'not operational'):
                module.current_graph_read()
            self.assertEqual(read.call_count, 4)
            self.assertEqual(sleep.call_count, 3)

    def test_unknown_and_changed_identity_are_not_retryable(self):
        for graph in [self.graph(stale=True, operationalReady=False, userExitReady=False),
                      self.graph(factory='0x'+'ff'*20, stale=True, readMode='verified_snapshot', refreshing=True),
                      self.graph(artifactDigest='0x'+'ff'*32)]:
            with self.subTest(graph=graph), \
                    patch.object(module.publisher, 'request', return_value=self.request(graph)) as read, \
                    patch.object(module.publisher.time, 'sleep') as sleep:
                with self.assertRaises(RuntimeError):
                    module.current_graph_read()
                self.assertEqual(read.call_count, 1)
                sleep.assert_not_called()

    def test_http_error_is_not_retryable(self):
        with patch.object(module.publisher, 'request', side_effect=OSError('HTTP unavailable')) as read, \
                patch.object(module.publisher.time, 'sleep') as sleep:
            with self.assertRaises(OSError):
                module.current_graph_read()
            self.assertEqual(read.call_count, 1)
            sleep.assert_not_called()


if __name__ == '__main__':
    unittest.main()
