import sys
import unittest
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import patch

# Export boundary tests use a stub, without network or toolkit dependencies.
sys.modules['pypsx_toolkit'] = SimpleNamespace(get_historical=None)
import export_history

class Frame:
    columns = ['OPEN', 'HIGH', 'LOW', 'CLOSE', 'VOLUME']
    def iterrows(self):
        for day in ['2026-09-24', '2026-09-25', '2026-10-02', '2026-10-05']:
            yield datetime.fromisoformat(day), dict(zip(self.columns, [10, 12, 9, 11, 123]))

class ExportTests(unittest.TestCase):
    def test_whole_month_results_are_filtered_to_requested_sessions(self):
        with patch.object(export_history.pt, 'get_historical', return_value=Frame()) as fetch:
            result = export_history.export('HBL', '2026-09-25', '2026-10-02')
        self.assertEqual([r[0] for r in result['rows']], ['2026-09-25', '2026-10-02'])
        self.assertEqual(result['rows'][0][1:], ['10', '12', '9', '11', '123'])
        fetch.assert_called_once_with('HBL', '2026-09-25', '2026-10-02', max_workers=1)

    def test_missing_high_low_cannot_be_exported(self):
        frame = Frame()
        frame.columns = ['OPEN', 'CLOSE', 'VOLUME']
        with patch.object(export_history.pt, 'get_historical', return_value=frame):
            with self.assertRaises(ValueError):
                export_history.export('HBL', '2026-09-25', '2026-10-02')

    def test_source_errors_propagate(self):
        with patch.object(export_history.pt, 'get_historical', side_effect=RuntimeError('404')):
            with self.assertRaises(RuntimeError):
                export_history.export('HBL', '2026-09-25', '2026-10-02')

if __name__ == '__main__':
    unittest.main()
