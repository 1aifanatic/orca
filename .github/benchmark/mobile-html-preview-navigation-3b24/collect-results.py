"""Read every first-attempt report and passive navigation event; no runtime launch."""
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
result = {'diagnosticEvidenceQualified': False, 'candidateCaseQualificationPassed': False,
          'productionCauseEstablished': False, 'performanceClaim': False, 'errors': []}
def read(path):
    b = path.read_bytes()
    bindings[str(path)] = sha(b)
    return json.loads(b)

try:
    m = read(payload / 'definition-manifest.json')
    selection_path = Path('mobile-navigation-browser-selection.json')
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
    selected = Counter((f"the HTML preview's sealed frame on {engine}", title) for engine in m['engines'] for title in m['selectedTitles'])
    allowed = Counter((f"the HTML preview's sealed frame on {engine}", title) for engine in m['engines'] for title in m['allOriginalTitles'])
    assert sum(selected.values()) == 12
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
        assert c['browserExecutable'] == selection['executable']
        assert c['browserVersionOutput'] == selection['stdout'].strip()
        assert not c['testsLaunchedByMaterializer'] and c['noPriorCommandDiscarded']
        args = ['exec', 'vitest', 'run', '--config', 'config/vitest.config.ts', m['testFile'],
                '--testNamePattern=' + m['testNamePattern'], '--reporter=default', '--reporter=json',
                '--reporter=./' + m['isolatedDirectory'] + '/persistence-import-reuse-benchmark-reporter.mjs',
                '--outputFile=' + m['isolatedDirectory'] + '/' + arm + '/report.json']
        assert c['commandArgs'] == args
        assert receipt['sourceUnchanged'] and receipt['normalForegroundReturnObserved']
        assert receipt['diffSha256'] == c['diffSha256'] and not receipt['newCleanupSignals']
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
            assert case['status'] in ['passed', 'failed', 'skipped', 'pending']
            if key in selected:
                assert case['status'] in ['passed', 'failed']
                cases.append({k: case[k] for k in ['title', 'fullName', 'ancestorTitles', 'status']})
            else:
                assert case['status'] in ['skipped', 'pending'], 'Only source-qualified unselected cases may be filtered'
        assert identities == allowed, 'All thirty original collected registrations must remain, including filtered skips'
        assert Counter((c['ancestorTitles'][0], c['title']) for c in cases) == selected
        assert sum(counts.values()) == report['numTotalTests']
        assert counts['passed'] == report['numPassedTests'] and counts['failed'] == report['numFailedTests']
        assert counts['skipped'] + counts['pending'] == report['numPendingTests'] and report.get('numTodoTests', 0) == 0
        assert report['success'] == (counts['failed'] == 0) == (receipt['exitCode'] == 0)
        assert receipt['exitCode'] in [0, 1] and details['reason'] == ('failed' if counts['failed'] else 'passed')
        log_bytes = (run / 'command.log').read_bytes()
        bindings[str(run / 'command.log')] = sha(log_bytes)
        log = re.sub(r'\x1b\[[0-9;]*m', '', log_bytes.decode('utf-8-sig'))
        assert not re.search(r'Unhandled Errors|Timeout terminating|failed to terminate.*worker', log, re.I)
        events = [json.loads(match.group(1)) for match in re.finditer(r'HTML_PREVIEW_NAVIGATION_EVIDENCE\s+(\{[^\r\n]*\})', log)]
        arms[arm] = {'cases': cases, 'counts': dict(counts), 'exitCode': receipt['exitCode'], 'observations': events, 'settings': details['projects']}
        if arm == 'candidate':
            assert events and len({e['nonce'] for e in events}) == len(events)
            assert set(e['engine'] for e in events) == set(m['engines'])
            assert all(e['browserVersion'] == (m['expectedBrowser'] if e['engine'] == 'chromium' else m['expectedWebKit']['browserVersion']) for e in events)
            for e in events:
                assert e['engine'] in m['engines']
                assert e['expectedNavigation'] in [None, 'main-frame', 'frame']
                for boundary in e['boundary']:
                    assert boundary['type'] in ['entered', 'resolved', 'rejected', 'frame-unavailable']
                for click in e['clicks']:
                    assert click['type'] in ['pointerdown', 'pointerup', 'click', 'click-dispatched']
                    assert isinstance(click['trusted'], bool) and isinstance(click['prevented'], bool)
                    assert click['activation'] in [False, True, None]
                assert isinstance(e['navigationRequests'], list) and isinstance(e['routes'], list)
            # Actual failed statuses and negative input evidence are observations; green input gates are separate.
            result['candidateCaseQualificationPassed'] = counts['failed'] == 0
            if result['candidateCaseQualificationPassed']:
                for e in events:
                    if e['engine'] == 'chromium':
                        assert e['requests']['cdp'] is True
                        assert e['requests']['frameBindings'] and all(b['enabled'] and b['session'] in ['parent', 'child'] for b in e['requests']['frameBindings'])
                        assert e['requests']['sessionFailures'] == []
                    else:
                        assert e['requests']['cdp'] is False
                    if e['boundary']:
                        assert e['boundary'][0]['type'] == 'entered' and e['boundary'][0]['detached'] is False
                        assert e['boundary'][-1]['type'] == 'resolved'
                foreign_clicks = [e for e in events if any(click.get('id') == 'toplink' and click.get('type') == 'click' and click.get('href', '').startswith(e['requests']['prefixes'][1]) for click in e['clicks'])]
                assert Counter(e['engine'] for e in foreign_clicks) == Counter(m['engines'])
                for e in foreign_clicks:
                    clicks = [r for r in e['clicks'] if r['id'] == 'toplink' and r['type'] == 'click']
                    assert len(clicks) == 1 and clicks[0]['trusted'] and clicks[0]['connected']
                    assert clicks[0]['target'] == '_top'
                    if e['engine'] == 'chromium': assert clicks[0]['activation'] is True
                    else: assert clicks[0]['activation'] in [None, True]
                    assert e['boundary'][-1]['type'] == 'resolved'
                    navigations = [r for r in e['navigationRequests'] if r['main'] and r['url'].startswith(e['requests']['prefixes'][1])]
                    routes = [r for r in e['routes'] if r['navigation'] and r['main'] and r['url'].startswith(e['requests']['prefixes'][1])]
                    assert len(navigations) == len(routes) == 1
                    assert navigations[0]['recording'] is True
                    assert routes[0]['decision'] == 'abort' and routes[0].get('settled') is True and 'error' not in routes[0]
    assert arms['original']['settings'] == arms['candidate']['settings']
    original_failures = [case for case in arms['original']['cases'] if case['status'] == 'failed']
    result.update(diagnosticEvidenceQualified=True, arms=arms, selectedOriginalCaseCount=12,
                  baselineReproduced=any(case['ancestorTitles'] == ["the HTML preview's sealed frame on chromium"] and case['title'] == "hands a user's tap on a link to the top frame, exactly once" for case in original_failures), originalFailures=original_failures, allFirstAttemptsRetained=True,
                  scope='Twelve original cases only; full thirty-case regression remains required before adoption')
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
    assert result['candidateCaseQualificationPassed'], 'Candidate failed; retain observation without compatibility admission'
