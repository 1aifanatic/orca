"""Compare complete replay capture rows; no serializer outputs or scope masks are dropped."""
import argparse
import hashlib
import itertools
import json
from pathlib import Path

MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024
MAX_ROW_BYTES = 128 * 1024 * 1024
ROW_FIELDS = {'transcript', 'schedule', 'conpty', 'seed', 'inputSha256', 'run'}
CHECK_FIELDS = {'stepIndex', 'overlong', 'trailingBackgroundRows', 'outputs',
                'gridDiff', 'wrapDiff', 'clippedWideCells'}


def rows(path):
    assert path.stat().st_size <= MAX_FILE_BYTES, 'Capture exceeds explicit 4 GiB bound'
    with path.open('rb') as stream:
        while True:
            offset = stream.tell()
            raw = stream.readline(MAX_ROW_BYTES + 1)
            if not raw:
                break
            assert len(raw) <= MAX_ROW_BYTES, 'Capture row exceeds explicit 128 MiB bound'
            assert raw.endswith(b'\n'), 'Incomplete capture row'
            row = json.loads(raw)
            assert set(row) == ROW_FIELDS, 'Missing or extra complete-result field'
            assert isinstance(row['transcript'], str) and isinstance(row['schedule'], str)
            assert type(row['conpty']) is bool and type(row['seed']) is int
            assert isinstance(row['inputSha256'], str) and len(row['inputSha256']) == 64
            assert set(row['run']) == {'checks', 'sourceCrash'}
            assert row['run']['sourceCrash'] is None, 'Source parser crash disqualifies'
            key = (row['transcript'], row['schedule'], row['conpty'], row['seed'])
            prior_step = -1
            output_bytes = 0
            outputs = 0
            for check in row['run']['checks']:
                assert set(check) == CHECK_FIELDS, 'Missing or extra raw checkpoint field'
                assert type(check['stepIndex']) is int and check['stepIndex'] > prior_step
                prior_step = check['stepIndex']
                for field in ['overlong', 'trailingBackgroundRows']:
                    assert len(check[field]) == 3 and all(type(v) is bool for v in check[field])
                assert type(check['clippedWideCells']) is int and check['clippedWideCells'] >= 0
                for field in ['outputs', 'gridDiff', 'wrapDiff']:
                    assert set(check[field]) == {'new'}, 'Default serializer inventory changed'
                assert len(check['outputs']['new']) == 3
                for output in check['outputs']['new']:
                    assert isinstance(output, str)
                    output_bytes += len(output.encode('utf-8', errors='surrogatepass'))
                    outputs += 1
            assert row['run']['checks'], 'No complete checkpoints'
            yield key, offset, raw, len(row['run']['checks']), outputs, output_bytes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('before', type=Path)
    parser.add_argument('after', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--case-plan', type=Path, default=Path(
        'notes/bun-migration/performance/serialize-oracle-cell-reuse-original-cases.json'))
    args = parser.parse_args()
    assert args.before.resolve() != args.after.resolve()
    assert not args.output.exists(), 'Never overwrite a qualification result'
    plan = json.loads(args.case_plan.read_text())
    suffix = ': no I1 byte diff and no I3 regression under resize schedules'
    titles = [c['title'] for c in plan['cases']]
    assert len(titles) == len(set(titles)) == 112
    assert all(t.endswith(suffix) for t in titles)
    names = [t[:-len(suffix)] for t in titles]
    expected = set(itertools.product(names, ['none', 'shrink', 'shrink-grow', 'jitter'],
                                     [False, True], [1, 2]))
    index = {}
    before_hash = hashlib.sha256()
    counters = [0, 0, 0]
    for key, offset, raw, checkpoints, outputs, output_bytes in rows(args.before):
        assert key in expected and key not in index, f'Unexpected/duplicate before row: {key}'
        index[key] = (offset, len(raw), hashlib.sha256(raw).hexdigest())
        before_hash.update(raw)
        counters = [counters[0] + checkpoints, counters[1] + outputs,
                    counters[2] + output_bytes]
    assert set(index) == expected, 'Missing original matrix rows'
    after_hash = hashlib.sha256()
    seen = set()
    after_counters = [0, 0, 0]
    with args.before.open('rb') as original:
        for key, _, raw, checkpoints, outputs, output_bytes in rows(args.after):
            assert key in expected and key not in seen, f'Unexpected/duplicate candidate row: {key}'
            seen.add(key)
            offset, length, expected_hash = index[key]
            original.seek(offset)
            expected_raw = original.read(length)
            assert hashlib.sha256(expected_raw).hexdigest() == expected_hash, 'Capture changed during comparison'
            assert raw == expected_raw, f'Full raw checkpoint/output row differs: {key}'
            after_hash.update(raw)
            after_counters = [after_counters[0] + checkpoints, after_counters[1] + outputs,
                              after_counters[2] + output_bytes]
    assert seen == expected and after_counters == counters
    proof = {'before': str(args.before), 'after': str(args.after), 'runs': len(expected),
             'transcripts': len(names), 'completeCheckpoints': counters[0],
             'serializedStrings': counters[1], 'serializedStringUtf8Bytes': counters[2],
             'beforeCaptureSha256': before_hash.hexdigest(),
             'afterCaptureSha256': after_hash.hexdigest(),
             'casePlanSha256': hashlib.sha256(args.case_plan.read_bytes()).hexdigest(),
             'exactRawRowsEqual': True, 'discardedFields': [], 'normalizedFields': [],
             'qualificationScope': 'All 1792 keyed matrix runs; complete raw JSON row bytes, '
                                   'including every serialized string and scope/diff result. '
                                   'Only outer row arrival order may differ. No timing claim.'}
    with args.output.open('x') as stream:
        json.dump(proof, stream, indent=2)
        stream.write('\n')
    print(json.dumps({k: proof[k] for k in ['runs', 'completeCheckpoints',
                                           'serializedStrings', 'exactRawRowsEqual']}))


if __name__ == '__main__':
    main()
