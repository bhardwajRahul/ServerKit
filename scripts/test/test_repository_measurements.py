"""Source counters and README snapshots must use explicit, consistent scopes."""

import importlib.util
from pathlib import Path
import unittest


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


measure = load('measure_repository', 'measure-repository.py')
readmes = load('readme_measurements', 'update-readme-measurements.py')


class MeasurementTests(unittest.TestCase):
    def test_counts_declarations_separately_from_methods(self):
        result = measure.source_counts(['''
bp = Blueprint('test', __name__)
@bp.route('/a')
@bp.route('/b', methods=['GET', 'POST', 'HEAD', 'OPTIONS'])
def handler(): pass
@bp.delete('/c')
def remove(): pass
@bp.route('/d', methods=METHODS)
def dynamic(): pass
'''])
        self.assertEqual(result['core_route_declarations'], 4)
        self.assertEqual(result['core_blueprint_declarations'], 1)
        self.assertEqual(result['explicit_method_route_pairs_excluding_head_options'], 4)
        self.assertEqual(result['route_declarations_with_dynamic_methods'], 1)

    def test_all_languages_render_the_same_snapshot_without_footprint_claims(self):
        source = {'measured_at_utc': '2026-09-05T12:00:00Z', 'core_route_declarations': 1234,
                  'core_blueprint_declarations': 99, 'bundled_app_templates': 118,
                  'backend_tests_clean_collected': 5678}
        build = {'html_linked_code': {'gzip_bytes': 800_000},
                 'all_code': {'gzip_bytes': 3_200_000}}
        blocks = readmes.blocks(source, build)
        self.assertEqual(len(blocks), 4)
        for block in blocks.values():
            self.assertIn('2026-09-05', block)
            self.assertIn('**118**', block)
            self.assertIn('**99**', block)
            self.assertNotIn('180 MB', block)
            self.assertNotIn('501 MB', block)
        self.assertIn('**5,678**', blocks['README.md'])
        self.assertIn('**5.678**', blocks['docs/README.es.md'])
        self.assertIn('**0,80 MB**', blocks['docs/README.pt.md'])
        self.assertIn('**3.20 MB**', blocks['docs/README.zh-CN.md'])

    def test_unknown_test_count_cannot_be_published_as_zero(self):
        with self.assertRaisesRegex(ValueError, 'collect-tests'):
            readmes.blocks({'measured_at_utc': '2026-09-05', 'core_route_declarations': 1,
                            'core_blueprint_declarations': 1, 'bundled_app_templates': 1,
                            'backend_tests_clean_collected': None}, {})


if __name__ == '__main__':
    unittest.main()
