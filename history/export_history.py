"""Free toolkit daily OHLCV exporter; exact date filtering is mandatory."""
import argparse
import contextlib
import json
import sys
from datetime import date
import pypsx_toolkit as pt

def export(symbol, start, end):
    date.fromisoformat(start)
    date.fromisoformat(end)
    with contextlib.redirect_stdout(sys.stderr):
        frame = pt.get_historical(symbol, start, end, max_workers=1)
    required = ['OPEN', 'HIGH', 'LOW', 'CLOSE', 'VOLUME']
    if not all(field in frame.columns for field in required):
        raise ValueError('Toolkit response lacks required OHLCV columns')
    rows = []
    for timestamp, record in frame.iterrows():
        session = timestamp.strftime('%Y-%m-%d')
        if start <= session <= end:
            rows.append([session] + [str(record[field]) for field in required])
    return {'headers': ['Date'] + required, 'rows': rows}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('symbol')
    parser.add_argument('start')
    parser.add_argument('end')
    args = parser.parse_args()
    try:
        print(json.dumps(export(args.symbol, args.start, args.end), allow_nan=False))
    except Exception as error:
        print(f'Historical toolkit failed: {error}', file=sys.stderr)
        sys.exit(1)
