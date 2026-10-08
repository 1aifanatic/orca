"""Verify preserved native observations after the existing stock collector passes."""
from collections import Counter
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

payload, directory, stock_path, output_path = map(Path, sys.argv[1:])
assert not output_path.exists()
sha = lambda data: hashlib.sha256(data).hexdigest()


def validate():
    manifest_bytes = (payload / 'definition-manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    assert (directory / 'definition-manifest.json').read_bytes() == manifest_bytes
    context = json.loads((directory / 'single-host-ci-context.json').read_text())
    assert context['sourceSha'] == manifest['sourceHead'] == os.environ['WAIT_SOURCE_SHA']
    assert context['definitionSha'] == os.environ['GITHUB_SHA']
    assert context['runId'] == os.environ['GITHUB_RUN_ID'] and context['runAttempt'] == os.environ['GITHUB_RUN_ATTEMPT']
    assert context['platform'] == 'linux' and context['arch'] == 'arm64'
    assert context['definitionManifestSha256'] == sha(manifest_bytes)
    assert context['bunVersion'] == '1.4.2' and context['nodeVersion'] == '24.21.0' and context['vitestVersion'] == '5.0.3'
    assert context['bunRevision'] == manifest['expectedBunRevision']
    assert context['installedOwnerHashes'] == manifest['installedOwnerHashes']
    stock = json.loads(stock_path.read_bytes())
    assert stock['qualified'] and stock['sourceHead'] == manifest['sourceHead']
    parser_spec = importlib.util.spec_from_file_location('native_junit', payload / 'parse-native-junit.py')
    parser = importlib.util.module_from_spec(parser_spec)
    parser_spec.loader.exec_module(parser)
    golden = parser.stock_multiset(stock['caseIdentityMapByFile'], manifest['pureFiles'])
    hashes = {}
    snapshots = []
    isolated = []
    for entry in manifest['nativeCommands']:
        label = entry['label']
        prefix = directory / 'native' / label
        files = {kind: Path(str(prefix) + suffix) for kind, suffix in [('before', '-before.json'), ('after', '-after.json'), ('log', '.log')]}
        for path in files.values():
            hashes[str(path)] = sha(path.read_bytes())
        before = json.loads(files['before'].read_bytes())
        after = json.loads(files['after'].read_bytes())
        assert before['entry'] == after['entry'] == entry
        assert before['head'] == after['head'] == manifest['sourceHead']
        assert before['planSha256'] == after['planSha256'] == sha(manifest_bytes)
        assert before['source'] == after['source'] and before['diffSha256'] == after['diffSha256']
        expected = dict(manifest['sourceHashes'])
        if entry['phase'] == 'after':
            plan = json.loads((payload / 'shipping-launch-plan.json').read_text())
            expected.update({file: versions['afterSha256'] for file, versions in plan['patchTargets'].items()})
        assert before['source'] == expected
        assert before['installedOwnerHashes'] == after['installedOwnerHashes'] == manifest['installedOwnerHashes']
        assert before['argv'][0] == context['bunExecutable']
        assert before['bunExecutableSha256'] == after['bunExecutableSha256'] == context['bunExecutableSha256']
        assert before['argv'] == after['argv'] and before['argv'][1:] == entry['argv']
        assert before['nodeExecutable'] == after['nodeExecutable'] == stock['inputSignatures'][0]['nodeExecutable']
        assert before['nodeVersion'] == after['nodeVersion'] == '24.21.0'
        assert before['coordinators'] == after['coordinators'] == []
        assert not after['newUserdataLeftAfterExit'], 'Native teardown left an owned userdata directory'
        assert 0 <= after['exitCode'] < 128
        assert after['elapsedSeconds'] > 0
        log = files['log'].read_text()
        markers = []
        for match in re.finditer(r'ORCA_NATIVE_SENTINEL (\{[^\n]*\})', log):
            markers.append(json.loads(match.group(1)))
        assert not re.search(r'failed to terminate.*worker|worker.*termination.*timed out|Timeout terminating', log, re.I)
        mode = entry['expectation']
        xml_path = Path(str(prefix) + '.xml')
        rows = None
        if xml_path.exists():
            xml = xml_path.read_bytes()
            hashes[str(xml_path)] = sha(xml)
            if xml and mode != 'preload-rejection':
                rows = parser.parse_junit(xml)
        if mode != 'preload-rejection':
            assert rows, 'Framework observations require exact registered fixture cases'
            assert set(row['file'] for row in rows) == set(entry['files'])
            expected_fixtures = [case for file in entry['files']
                                 for case in manifest['nativeFixtureCaseIdentitiesByFile'].get(file, [])]
            fixture_files = set(manifest['nativeFixtureCaseIdentitiesByFile'])
            identity = lambda row: (row['file'], row['title'], tuple(row['ancestorTitles']), row['fullName'])
            assert Counter(identity(row) for row in rows if row['file'] in fixture_files) == Counter(identity(row) for row in expected_fixtures), 'Diagnostic fixture callback enrollment differs'
        if mode.startswith('green'):
            assert after['exitCode'] == 0 and rows
            assert all(row['status'] == 'passed' for row in rows)
            assert set(row['file'] for row in rows) == set(entry['files'])
            assert not re.search(r'\bUnhandled\b|\b[1-9][0-9]* errors?\b|::error', log, re.I)
            if mode == 'green-pure':
                assert parser.native_multiset(rows, manifest['pureFiles']) == golden
            if mode in ['green-pure', 'green-isolation']:
                fresh = [row for row in markers if row['kind'] == 'fresh-file']
                expected_files = [file for file in entry['files'] if '/host-isolation-' in file]
                assert Counter(row['file'] for row in fresh) == Counter(expected_files)
                assert len({row['nonce'] for row in fresh}) == len(fresh)
                assert len({row['moduleOwnerNonce'] for row in fresh}) == len(fresh)
                assert all(row['inheritedModuleFileCount'] == 0 for row in fresh)
                assert len({row['userData'] for row in fresh}) == len(fresh)
                assert all(row['inheritedAbsent'] is True and row['execPath'] == before['nodeExecutable'] and row['bunVersion'] == '1.4.2' and isinstance(row['pid'], int) and row['pid'] > 0 for row in fresh)
                if mode == 'green-isolation':
                    assert len({row['pid'] for row in fresh}) == 1
                    assert len([row for row in markers if row['kind'] == 'fs-publication' and row['passed'] is True]) == 1
                    isolated = fresh
            if mode == 'green-hook':
                hook = [row for row in markers if row['kind'] == 'hook-budget']
                assert len(hook) == 1 and 30000 <= hook[0]['elapsed'] < 60000
        else:
            assert after['exitCode'] == 1
            if mode == 'preload-rejection':
                assert re.search(r'vi\.doMock.*(?:not a function|is not)', log)
            elif mode == 'guard-rejection':
                assert 'real-agent-home guard' in log and rows
                refusal = [row for row in markers if row['kind'] == 'swallowed-refusal']
                assert len(refusal) == 1 and refusal[0]['caught'] is True
            elif mode == 'hook-rejection':
                assert 'ORCA_NATIVE_HOOK_FAILURE_SENTINEL' in log
                assert 'ORCA_NATIVE_HOOK_BODY_UNEXPECTED' not in log
                assert rows and len(rows) == 1 and rows[0]['status'] == 'failed'
            elif mode == 'unhandled-rejection':
                assert 'ORCA_NATIVE_UNHANDLED_FAILURE_SENTINEL' in log
                assert 'ORCA_NATIVE_UNHANDLED_BODY_ENTERED' in log
                assert rows and len(rows) == 1
            elif mode == 'timeout-rejection':
                assert 'ORCA_NATIVE_TIMEOUT_BODY_ENTERED' in log
                assert re.search(r'timed out after 30000ms', log)
                assert rows and len(rows) == 1 and rows[0]['status'] == 'failed'
                assert after['elapsedSeconds'] >= 29.9
            else:
                raise AssertionError('Unknown native rejection classification')
        snapshots.append({'label': label, 'expectedObservation': mode, 'exitCode': after['exitCode'], 'map': rows, 'markers': markers, 'elapsedSeconds': after['elapsedSeconds']})
    assert len(snapshots) == 9 and len(isolated) == 2
    return {'qualified': True, 'compatibilityOnly': True, 'sourceHead': manifest['sourceHead'],
            'originalPureRuntimeCaseCount': sum(golden.values()), 'stockEightAttemptsQualified': True,
            'nativeNineObservations': snapshots, 'artifactHashes': hashes,
            'originalPreloadFailureIsNotPerformanceBaseline': True, 'performanceAdmission': False,
            'scope': 'Linux ARM tiny-cohort compatibility/safety observations only; no global native adoption, whole-CI saving or capacity effect measured.'}


try:
    result = validate()
except Exception as error:
    try:
        with output_path.open('x') as stream:
            stream.write(json.dumps({'qualified': False, 'error': str(error), 'performanceAdmission': False}, indent=2) + '\n')
    except OSError:
        pass
    raise
with output_path.open('x') as stream:
    stream.write(json.dumps(result, indent=2) + '\n')
