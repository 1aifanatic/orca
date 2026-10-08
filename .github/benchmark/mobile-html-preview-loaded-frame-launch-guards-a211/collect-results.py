"""Validate both full thirty-case first-attempt reports; no runtime launch."""
from collections import Counter
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys

root, payload, output = map(Path, sys.argv[1:])
assert not output.exists()
sha = lambda value: hashlib.sha256(value).hexdigest()
bindings = {}
result = {'fullThirtyCaseQualificationPassed': False, 'candidateCaseQualificationPassed': False,
          'productionCauseEstablished': False, 'performanceClaim': False, 'errors': []}
def read(path):
    b = path.read_bytes()
    bindings[str(path)] = sha(b)
    return json.loads(b)

try:
    m = read(payload / 'definition-manifest.json')
    selection_path = Path('mobile-loaded-frame-browser-selection.json')
    selection = read(selection_path)
    result['browserSelection'] = selection
    assert selection['accepted'] is True and selection['error'] is None and selection['exitCode'] == 0
    assert selection['sourceSha'] == m['sourceHead'] == os.environ['MOBILE_NAVIGATION_SOURCE_SHA']
    assert selection['definitionSha'] == os.environ['GITHUB_SHA']
    assert selection['runId'] == os.environ['GITHUB_RUN_ID'] and selection['runAttempt'] == os.environ['GITHUB_RUN_ATTEMPT']
    assert selection['expectedVersion'] == selection['parsedVersion'] == m['expectedBrowser']
    assert Path(selection['executable']).is_absolute()
    assert selection['argv'] == [selection['executable'], '--version']
    assert base64.b64decode(selection['stdoutBase64'], validate=True).decode('utf-8', errors='replace') == selection['stdout']
    assert base64.b64decode(selection['stderrBase64'], validate=True).decode('utf-8', errors='replace') == selection['stderr']
    assert selection['stdout'].strip().split()[-1] == m['expectedBrowser']
    assert (root / 'definition-manifest.json').read_bytes() == (payload / 'definition-manifest.json').read_bytes()
    for file, expected in m['payloadSha256'].items():
        assert sha((payload / file).read_bytes()) == expected
        assert (root / file).read_bytes() == (payload / file).read_bytes()
    allowed = Counter((f"the HTML preview's sealed frame on {engine}", title) for engine in m['engines'] for title in m['allOriginalTitles'])
    assert sum(allowed.values()) == 30 and len(m['allOriginalTitles']) == 15 and m['engines'] == ['chromium', 'webkit']
    webkit_selection = read(Path('mobile-loaded-frame-webkit-selection.json'))
    assert webkit_selection['argv'] == m['setupProbeCommandArgs'] and webkit_selection['environmentKeysAbsent'] == m['forbiddenBrowserEnvironmentKeys']
    assert webkit_selection['wallSeconds'] > 0 and webkit_selection['startedAt'] <= webkit_selection['completedAt']
    assert webkit_selection['accepted'] is True and webkit_selection['closed'] is True and webkit_selection['error'] is None
    assert webkit_selection['sourceSha'] == m['sourceHead'] and webkit_selection['definitionSha'] == os.environ['GITHUB_SHA']
    assert webkit_selection['runId'] == os.environ['GITHUB_RUN_ID'] and webkit_selection['runAttempt'] == os.environ['GITHUB_RUN_ATTEMPT']
    assert webkit_selection['engine'] == 'webkit' and webkit_selection['browserVersion'] == webkit_selection['expectedVersion'] == m['expectedWebKit']['browserVersion']
    assert webkit_selection['revision'] == m['expectedWebKit']['revision'] and Path(webkit_selection['executable']).is_absolute()
    result['webkitSetupSelection'] = webkit_selection
    arms = {}
    result['arms'] = arms
    for arm in ['original', 'candidate']:
        run = root / arm
        c, receipt, report, details = [read(run / name) for name in ['ci-context.json', 'command-result.json', 'report.json', 'report-details.json']]
        assert c['sourceSha'] == receipt['sourceSha'] == m['sourceHead'] == os.environ['MOBILE_NAVIGATION_SOURCE_SHA']
        assert c['definitionSha'] == os.environ['GITHUB_SHA']
        assert c['runId'] == os.environ['GITHUB_RUN_ID'] and c['runAttempt'] == os.environ['GITHUB_RUN_ATTEMPT']
        assert c['arm'] == receipt['arm'] == arm and c['platform'] == 'linux' and c['arch'] == 'x64'
        assert c['sourceHashes'] == m['sourceHashes'] and c['targets'] == m['targets']
        assert c['manifestSha256'] == sha((payload / 'definition-manifest.json').read_bytes())
        assert c['installedPlaywrightOwnerHashes'] == m['installedPlaywrightOwnerHashes']
        assert c['nodeVersion'] == '24.21.0' and c['expectedPins'] == m['expectedPins']
        assert c['browserVersionOutput'].split()[-1] == m['expectedBrowser'] and c['background'] == '1'
        assert c['browserSelectionReceiptSha256'] == bindings[str(selection_path)]
        assert c['webkitSelectionReceiptSha256'] == bindings['mobile-loaded-frame-webkit-selection.json']
        assert c['webkitSetupSelection'] == webkit_selection and c['browserEnvironmentKeysAbsent'] == m['forbiddenBrowserEnvironmentKeys']
        assert c['browserExecutable'] == selection['executable']
        assert c['browserVersionOutput'] == selection['stdout'].strip()
        assert not c['testsLaunchedByMaterializer'] and c['noPriorCommandDiscarded']
        args = ['exec', 'vitest', 'run', '--config', 'config/vitest.config.ts', m['testFile'],
                '--reporter=default', '--reporter=json',
                '--reporter=./' + m['isolatedDirectory'] + '/persistence-import-reuse-benchmark-reporter.mjs',
                '--outputFile=' + m['isolatedDirectory'] + '/' + arm + '/report.json']
        assert c['commandArgs'] == args
        assert receipt['sourceUnchanged'] and receipt['normalForegroundReturnObserved']
        assert receipt['diffSha256'] == c['diffSha256'] and not receipt['newCleanupSignals'] and receipt['processTreeAbsenceClaim'] is False
        assert details['errors'] == []
        assert [(p['name'], p['pool']) for p in details['projects']] == [('node', 'forks'), ('node-measurement', 'forks')]
        assert details['rootFsModuleCache'] is True and details['rootIsolation'] is True
        assert all(p['isolate'] is True and p['fsModuleCache'] is True and p['testTimeout'] == 30000 and p['hookTimeout'] == 60000 and p['execArgv'] == ['--no-experimental-webstorage', '--expose-gc'] and p['setups'] == [
            'config/scripts/vitest-real-agent-home-write-guard.ts', 'config/scripts/vitest-bun-node-builtins.ts',
            'config/scripts/happy-dom-offscreen-canvas.ts', 'config/scripts/happy-dom-mutation-observer-retention.ts',
            'config/scripts/vitest-host-ports-setup.ts', 'config/scripts/vitest-caller-identity-env-setup.ts'] for p in details['projects'])
        assert len(details['modules']) == len(report['testResults']) == 1
        module = details['modules'][0]
        assert module['file'] == m['testFile'] and module['project'] == 'node' and module['pool'] == 'forks'
        assert not module.get('diagnostic', {}).get('errors')
        raw = report['testResults'][0]
        assert raw['name'].replace('\\', '/').endswith('/' + m['testFile'])
        cases, identities, counts = [], Counter(), Counter()
        for case in raw['assertionResults']:
            assert len(case['ancestorTitles']) == 1
            key = (case['ancestorTitles'][0], case['title'])
            assert key in allowed and case['fullName'] == ' '.join([*case['ancestorTitles'], case['title']])
            identities[key] += 1
            counts[case['status']] += 1
            assert case['status'] in ['passed', 'failed'], 'No filtered, pending, skipped or todo cases in the full suite'
            cases.append({k: case[k] for k in ['title', 'fullName', 'ancestorTitles', 'status']})
        assert identities == allowed, 'All thirty original registrations must execute in both engines'
        assert len(cases) == 30 and Counter((c['ancestorTitles'][0], c['title']) for c in cases) == allowed
        assert sum(counts.values()) == report['numTotalTests']
        assert counts['passed'] == report['numPassedTests'] and counts['failed'] == report['numFailedTests']
        assert counts['skipped'] + counts['pending'] == report['numPendingTests'] and report.get('numTodoTests', 0) == 0
        assert raw['status'] == ('failed' if counts['failed'] else 'passed')
        assert report['success'] == (counts['failed'] == 0) == (receipt['exitCode'] == 0)
        assert receipt['exitCode'] in [0, 1] and details['reason'] == ('failed' if counts['failed'] else 'passed')
        log_bytes = (run / 'command.log').read_bytes()
        bindings[str(run / 'command.log')] = sha(log_bytes)
        log = re.sub(r'\x1b\[[0-9;]*m', '', log_bytes.decode('utf-8-sig'))
        assert not re.search(r'Unhandled Errors|Timeout terminating|failed to terminate.*worker', log, re.I)
        arms[arm] = {'cases': cases, 'counts': dict(counts), 'exitCode': receipt['exitCode'], 'settings': details['projects']}
        if arm == 'candidate': result['candidateCaseQualificationPassed'] = counts['failed'] == 0
    assert arms['original']['settings'] == arms['candidate']['settings']
    original_failures = [case for case in arms['original']['cases'] if case['status'] == 'failed']
    result.update(fullThirtyCaseQualificationPassed=all(a['counts'].get('failed', 0) == 0 for a in arms.values()),
                  originalCaseCount=30, originalFailures=original_failures,
                  baselineReproduced=any(case['ancestorTitles'] == ["the HTML preview's sealed frame on chromium"] and case['title'] == "hands a user's tap on a link to the top frame, exactly once" for case in original_failures),
                  allFirstAttemptsRetained=True, runtimeObservationComplete=True,
                  scope='Two full thirty-case first attempts; boundary-only fixture compatibility; no repair cause or performance claim')
except BaseException as error:
    result['errors'].append({'type': type(error).__name__, 'message': str(error)})
    result['rawBindings'] = bindings
    try:
        with output.open('x') as f:
            json.dump(result, f, indent=2); f.write('\n')
    except OSError:
        pass
    raise
else:
    result['rawBindings'] = bindings
    with output.open('x') as f:
        json.dump(result, f, indent=2); f.write('\n')
    assert result['fullThirtyCaseQualificationPassed'], 'At least one full attempt failed; retain every raw status without compatibility admission'
