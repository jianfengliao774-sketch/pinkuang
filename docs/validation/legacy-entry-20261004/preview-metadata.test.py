import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('preview_metadata', HERE / 'publish-preview-metadata.py')
publisher = importlib.util.module_from_spec(spec); spec.loader.exec_module(publisher)
OLD = b'untouched-prefix ' + publisher.OLD_IMAGE * 4 + b' middle ' + publisher.OLD_PAGE * 2 + b' untouched-suffix'


class PreviewMetadataTest(unittest.TestCase):
    def test_dom_and_serialized_fields_change_and_every_other_byte_roundtrips(self):
        with patch.object(publisher, 'OLD_SHA', publisher.base.sha(OLD)):
            new = publisher.updated(OLD)
        self.assertEqual(new.count(publisher.NEW_IMAGE), 4)
        self.assertEqual(new.count(publisher.NEW_PAGE), 2)
        self.assertEqual(new.replace(publisher.NEW_IMAGE, publisher.OLD_IMAGE).replace(publisher.NEW_PAGE, publisher.OLD_PAGE), OLD)

    def test_foreign_or_concurrent_html_refuses(self):
        with patch.object(publisher, 'OLD_SHA', publisher.base.sha(OLD)):
            with self.assertRaisesRegex(RuntimeError, 'identity'):
                publisher.updated(OLD + b' changed')

    def test_wrong_semantic_field_count_refuses(self):
        altered = OLD.replace(publisher.OLD_IMAGE, b'other', 1)
        with patch.object(publisher, 'OLD_SHA', publisher.base.sha(altered)):
            with self.assertRaisesRegex(RuntimeError, 'metadata count'):
                publisher.updated(altered)


if __name__ == '__main__':
    unittest.main()
