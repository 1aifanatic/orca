import hashlib
import json
from pathlib import Path

base = Path('notes/bun-migration/performance')
epoch = Path(__file__).parent
plan_path = epoch / 'measurement-plan.json'
output = epoch / 'timing-result.json'
artifacts = {}


def read(path):
    path = Path(path)
    content = path.read_bytes()
    artifacts[str(path)] = hashlib.sha256(content).hexdigest()
    return json.loads(content)


try:
    assert not output.exists()
    plan = read(plan_path)
    assert plan['compatibilityAdmission'] is not None
    admission = read(plan['compatibilityAdmission']['path'])
    assert artifacts[plan['compatibilityAdmission']['path']] == plan['compatibilityAdmission']['sha256']
    assert admission['broadCompatibilityQualified'] and admission['sourceHead'] == plan['sourceHead']
    assert len(admission['snapshots']) == 8
    assert plan['stateBoundaryAdmission'] is not None
    state_boundary = read(plan['stateBoundaryAdmission']['path'])
    assert artifacts[plan['stateBoundaryAdmission']['path']] == plan['stateBoundaryAdmission']['sha256']
    assert state_boundary['sourceHead'] == plan['sourceHead'] and state_boundary['reviewedForTimingAdmission']
    assert plan['configurationOnly'] and plan['fsModuleCache'] is False
    assert plan['commandOrder'] == [
        ['before', 'cold'], ['after', 'cold'], ['before', '0'], ['after', '0'],
        ['after', '1'], ['before', '1'], ['before', '2'], ['after', '2']]
    rows = []
    expected = plan['caseIdentityMapByFile']
    for phase, round_number in plan['commandOrder']:
        prefix = base / f"{plan['label']}-{phase}-{round_number}"
        row = read(str(prefix) + '-summary.json')
        report = read(str(prefix) + '.json')
        details = read(str(prefix) + '-details.json')
        log_path = Path(str(prefix) + '.log')
        artifacts[str(log_path)] = hashlib.sha256(log_path.read_bytes()).hexdigest()
        assert row['phase'] == phase and str(row['round']) == round_number
        assert row['performanceQualified'] and row['qualified'] and row['noiseGuardAvailable']
        assert row['result'] == {'code': 0, 'signal': None}
        assert not row['launchError'] and not row['external'] and not row['lifecycleError']
        assert not row['lingeringCoordinators']
        assert row['sourceUnchanged'] and row['before'] == row['after']
        assert row['before']['head'] == plan['sourceHead']
        assert row['before']['diffSha256'] == hashlib.sha256(b'').hexdigest()
        assert row['casePlanSha256'] == artifacts[str(plan_path)]
        assert row['configurationOnly'] and row['exactProjectsPreserved']
        assert report['success'] and report['numTotalTests'] == plan['caseCount']
        assert report['numFailedTests'] == 0 and report['numFailedTestSuites'] == 0
        assert details['reason'] == 'passed' and not details['errors']
        assert details['rootFsModuleCache'] is False and details['rootIsolation'] is True
        assert details['resolvedRootMaxWorkers'] == 4
        assert sorted(details['projects'], key=lambda x: x['name']) == plan['expectedProjects']
        actual = {}
        for module in report['testResults']:
            files = [file for file in plan['files'] if module['name'].replace('\\', '/').endswith('/' + file)]
            assert len(files) == 1 and files[0] not in actual
            actual[files[0]] = sorted([
                {key: case[key] for key in ['fullName', 'title', 'ancestorTitles', 'status']}
                for case in module['assertionResults']], key=lambda x: json.dumps(x, sort_keys=True))
        assert actual == expected
        skipped = [{'file': file, **case} for file, cases in actual.items() for case in cases
                   if case['status'] in ['skipped', 'pending']]
        assert skipped == plan['sourceQualifiedOriginalSkippedCases']
        assert sum(map(len, actual.values())) == report['numTotalTests']
        assert all(case['status'] in ['passed', 'skipped', 'pending'] for cases in actual.values() for case in cases)
        routes = sorted([{key: module[key] for key in ['file', 'project', 'pool']}
                         for module in details['modules']], key=lambda x: x['file'])
        assert routes == plan['expectedModuleRoutes']
        assert row['cacheOff'] and row['setupPreserved'] and row['workerCapPreserved']
        assert row['routePreserved'] and row['isolationPreserved'] and row['filesEqual'] and row['caseParity']
        rows.append(row)
    assert all(row['host'] == rows[0]['host'] for row in rows)
    assert rows[0]['host']['platform'] == 'linux' and rows[0]['host']['arch'] == 'arm64'
    cold = {row['phase']: row for row in rows[:2]}
    assert cold['before']['cacheBefore'] is None and cold['after']['cacheBefore'] is None
    assert cold['before']['optimizerCache'] != cold['after']['optimizerCache']
    assert any(file['path'].endswith('_metadata.json') for file in cold['after']['cacheAfter'])
    for row in rows[2:]:
        assert row['optimizerCache'] == cold[row['phase']]['optimizerCache']
        if row['phase'] == 'after':
            assert row['cacheBefore'] == cold['after']['cacheAfter']
            assert row['cacheAfter'] == cold['after']['cacheAfter']
    pairs = []
    for number in range(3):
        pair = {row['phase']: row for row in rows[2:] if row['round'] == number}
        assert set(pair) == {'before', 'after'}
        pairs.append({'pair': number, 'beforeSeconds': pair['before']['seconds'],
                      'afterSeconds': pair['after']['seconds']})
    before_mean = sum(pair['beforeSeconds'] for pair in pairs) / 3
    after_mean = sum(pair['afterSeconds'] for pair in pairs) / 3
    result = {'performanceQualified': True, 'sourceHead': plan['sourceHead'],
              'originalCases': plan['caseCount'], 'physicalFiles': len(plan['files']),
              'coldCompleteCommandSeconds': {phase: row['seconds'] for phase, row in cold.items()},
              'warmAlternatingPairs': pairs, 'warmBeforeMeanSeconds': before_mean,
              'warmAfterMeanSeconds': after_mean, 'warmReductionPercent': (1 - after_mean / before_mean) * 100,
              'coldCostIncludedSeparately': True, 'allQualifiedSamplesRetained': True,
              'fsModuleCache': False, 'stockFsModuleCacheTrueQualificationPending': True,
              'fullSuiteQualified': False, 'artifactHashes': artifacts,
              'scope': 'Twelve original consumer suites only; cold build cost and warm paired results remain separate.'}
    with output.open('x') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
except Exception as error:
    rejection = {'performanceQualified': False, 'errorType': type(error).__name__,
                 'error': str(error), 'artifactHashes': artifacts,
                 'scope': 'Rejected/incomplete draft timing; raw outcomes retained, no retries or exclusions.'}
    try:
        if not output.exists():
            with output.open('x') as stream:
                json.dump(rejection, stream, indent=2)
                stream.write('\n')
    except OSError:
        pass
    raise
