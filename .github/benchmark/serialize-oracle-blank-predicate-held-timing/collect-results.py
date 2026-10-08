# Reuses preserved raw case/config/source/census gates; launches no processes.
import hashlib
import json
import math
import os
from pathlib import Path
import re
import statistics
import sys

root, payload, output = map(Path, sys.argv[1:])
assert not output.exists(), 'Never overwrite an attempted measurement'
sha = lambda value: hashlib.sha256(value).hexdigest()
artifacts = {}

def read(path):
    data = path.read_bytes()
    artifacts[str(path)] = sha(data)
    return json.loads(data)

result = {'qualified': False, 'errors': [], 'performanceClaim': False, 'samples': []}
try:
    manifest = read(payload / 'definition-manifest.json')
    plan = read(payload / 'measurement-plan.json')
    assert manifest['runtimeQualificationPending'] is False, 'Actual eight-report correctness admission required'
    runtime = root / Path(manifest['isolatedDirectory']).name
    context = read(runtime / 'ci-context.json')
    assert context['sourceSha'] == manifest['sourceHead'] == os.environ['WAIT_TIMING_SOURCE_SHA']
    assert context['definitionSha'] == os.environ['GITHUB_SHA']
    assert context['runId'] == os.environ['GITHUB_RUN_ID'] and context['runAttempt'] == os.environ['GITHUB_RUN_ATTEMPT']
    assert context['repositoryRoot'] == str(Path.cwd())
    assert context['platform'] == 'linux' and context['arch'] == 'arm64' and context['logicalCpus'] == 4
    assert context['nodeVersion'] == '24.21.0' and context['bunVersion'] == '1.4.2' and context['bunRevision'] == '1.4.2+744846f84' and context['vitestVersion'] == '5.0.3'
    assert context['driverSha256'] == manifest['controllerSha256'] == '3260581eb3bf48b84712da5172c2695f5fd110be1cc37e68c1a41d18176e4626'
    assert context['reporterSha256'] == manifest['reporterSha256'] == '2d2b20c3b06cc11c28650496a48ae525903e4fc43d4306aad5405e85f086e76e'
    assert context['definitionManifestSha256'] == sha((payload / 'definition-manifest.json').read_bytes())
    assert context['planSha256'] == sha((payload / 'measurement-plan.json').read_bytes())
    assert context['qualificationRun'] == manifest['actualQualificationRun']
    assert manifest['actualQualificationRun'] is not None
    assert context['ciOnly'] is True and context['testsLaunchedByMaterializer'] is False
    assert context['launchEnvironment']['ORCA_BACKGROUND_LAUNCH'] == '1'
    assert all(value is None for key, value in context['launchEnvironment'].items() if key != 'ORCA_BACKGROUND_LAUNCH')
    for name, expected in manifest['payloadSha256'].items():
        assert sha((payload / name).read_bytes()) == expected
        if name not in ['benchmark-persistence-import-reuse.mjs', 'persistence-import-reuse-benchmark-reporter.mjs']:
            assert (runtime / name).read_bytes() == (payload / name).read_bytes()
    admission = read(payload / 'actual-ci-runtime-result.json')
    terminal = read(payload / 'terminal-ci-proof.json')
    independent = read(payload / 'independent-runtime-proof.json')
    assert admission['qualified'] and independent['qualifiedCorrectness']
    root_admission = read(payload / 'root-runtime-proof.json')
    peer_admission = read(payload / 'peer-runtime-proof.json')
    assert root_admission['qualified'] and peer_admission['correctnessQualified']
    for raw in [root_admission, peer_admission]:
        assert raw['runId'] == manifest['actualQualificationRun']
        assert raw['definitionSha'] == manifest['actualQualificationDefinition']
    assert root_admission['sourceSha'] == peer_admission['sourceHead'] == manifest['sourceHead']
    assert terminal['peerFullRawByteReplaySha256'] == sha((payload / 'peer-runtime-proof.json').read_bytes())
    assert len(admission['snapshots']) == independent['attempts'] == 8
    assert admission['sourceHead'] == independent['sourceHead'] == manifest['sourceHead']
    assert terminal['runtimeCorrectnessQualified'] and terminal['eachCommandOriginalCases'] == plan['caseCount'] and terminal['eachCommandOriginalCasesPassed'] == 128 and terminal['eachCommandOriginalCasesSkipped'] == 2
    assert terminal['runId'] == manifest['actualQualificationRun'] and terminal['definitionHead'] == manifest['actualQualificationDefinition']
    assert terminal['terminalConclusion'] == 'success' and terminal['allFiveJobsSuccess']
    assert terminal['actualCiCollectorSha256'] == sha((payload / 'actual-ci-runtime-result.json').read_bytes())
    assert plan['caseIdentityMapByFile'] == admission['caseIdentityMapByFile']
    assert independent['rawStatesPerAttempt'] == {'passed':128,'skipped':2}
    assert terminal['rootFullRawByteReplaySha256'] == sha((payload / 'root-runtime-proof.json').read_bytes())
    assert terminal['independentRawReplaySha256'] == sha((payload / 'independent-runtime-proof.json').read_bytes())
    assert plan['caseCount'] == admission['runtimeDerivedCaseCount'] == independent['casesPerAttempt'] == plan['caseCount']
    expected_cases = sorted([{'file': file, **case} for file, cases in plan['caseIdentityMapByFile'].items() for case in cases], key=lambda row: json.dumps(row, sort_keys=True))
    keys = ['name', 'pool', 'fsModuleCache', 'effectiveMaxWorkers', 'isolate', 'testTimeout', 'hookTimeout', 'setups', 'execArgv']
    expected_config = [{**project, 'fsModuleCache': True} for project in next(row['config'] for row in admission['snapshots'] if row['runtime'] == 'bun')]
    assert plan['fsModuleCache'] is True and plan['driverChanges'] is True
    assert all(value is None for value in context['absentSerializerEnvironment'].values())
    assert set(context['absentSerializerEnvironment']) == set(manifest['absentSerializerEnvironment'])
    expected_routes = plan['expectedModuleRoutes']
    empty_sha = sha(b'')
    freeze = read(root / (plan['label'] + '-benchmark-freeze.json'))
    signature = None
    for phase, round_index in plan['schedule']:
        prefix = root / (plan['label'] + '-' + phase + '-' + str(round_index))
        row = read(Path(str(prefix) + '-summary.json'))
        report = read(Path(str(prefix) + '.json'))
        details = read(Path(str(prefix) + '-details.json'))
        log_path = Path(str(prefix) + '.log')
        log = log_path.read_bytes(); artifacts[str(log_path)] = sha(log)
        assert row['phase'] == phase and row['round'] == round_index
        expected_argv = ['pnpm','test',*plan['files'],'--fsModuleCache=true','--maxWorkers=4','--reporter=json','--reporter=./notes/bun-migration/performance/persistence-import-reuse-benchmark-reporter.mjs','--outputFile='+str(Path(context['repositoryRoot'])/'notes/bun-migration/performance'/(plan['label']+'-'+phase+'-'+str(round_index)+'.json'))]
        assert row['command'] == expected_argv
        assert row['cacheEnabled'] is True
        assert row['qualified'] and row['performanceQualified']
        assert row['result'] == {'code': 0, 'signal': None} and not row.get('launchError')
        assert not row['external'] and not row['lifecycleError'] and not row['lingeringCoordinators']
        assert row['noiseGuardAvailable'] and row['samples'][0]['coordinators'] == row['samples'][-1]['coordinators'] == []
        assert all(not sample.get('error') and sample['noiseGuardAvailable'] and all(p['owned'] for p in sample['coordinators']) for sample in row['samples'])
        assert row['before'] == row['after'] and row['sourceUnchanged']
        fingerprint = row['before']
        assert fingerprint['head'] == plan['sourceHead'] and fingerprint['unrelatedDiffSha256'] == empty_sha
        assert fingerprint['configSha256'] == plan['sourceBeforeSha256']['config/vitest.config.ts']
        assert fingerprint['reporterSha256'] == manifest['reporterSha256'] and fingerprint['harnessSha256'] == manifest['controllerSha256']
        assert fingerprint['planSha256'] == context['planSha256'] == row['casePlanSha256']
        assert row['patchSha256'] == plan['patchSha256']
        if phase == 'before': assert fingerprint['diffSha256'] == empty_sha
        else: assert fingerprint['diffSha256'] != empty_sha
        common = {key: fingerprint[key] for key in ['unrelatedDiffSha256', 'configSha256', 'reporterSha256', 'planSha256', 'harnessSha256']}
        assert freeze == {'expectedHead': plan['sourceHead'], **common}
        if signature is None: signature = common
        else: assert signature == common
        assert report['success'] and report['numTotalTests'] == plan['caseCount']
        assert report['numPassedTests'] == 128
        assert report['numFailedTests'] == 0 and report['numPendingTests'] == 2 and not report.get('numTodoTests', 0)
        assert len(report['testResults']) == len(plan['files']) == 4
        cases = []
        seen_modules = set()
        for module in report['testResults']:
            assert module['status'] == 'passed'
            matches = [file for file in plan['files'] if module['name'].replace('\\', '/').endswith('/' + file)]
            assert len(matches) == 1 and matches[0] not in seen_modules
            seen_modules.add(matches[0])
            assert module['assertionResults'], 'Every selected physical module must retain cases'
            for case in module['assertionResults']:
                cases.append({'file': matches[0], **{key: case[key] for key in ['fullName', 'title', 'ancestorTitles', 'status']}})
        assert seen_modules == set(plan['files'])
        cases.sort(key=lambda case: json.dumps(case, sort_keys=True))
        assert cases == expected_cases
        assert sorted(row['identities'], key=lambda case: json.dumps(case, sort_keys=True)) == cases
        assert details == row['details'] and details['reason'] == 'passed' and not details['errors']
        assert details['rootFsModuleCache'] is True and details['rootIsolation'] is True and details['resolvedRootMaxWorkers'] == 4
        config = sorted([{key: project[key] for key in keys} for project in details['projects']], key=lambda project: project['name'])
        assert config == expected_config
        routes = [{key: module[key] for key in ['file', 'project', 'pool']} for module in details['modules']]
        assert sorted(routes, key=lambda row: row['file']) == sorted(expected_routes, key=lambda row: row['file'])
        assert all(not module.get('diagnostic', {}).get('errors') for module in details['modules'])
        assert not re.search(rb'Timeout terminating|failed to terminate.*worker|worker.*termination.*timed out|Unhandled Errors', log, re.I)
        assert math.isfinite(row['seconds']) and row['seconds'] > 0
        result['samples'].append({'phase': phase, 'round': round_index, 'seconds': row['seconds'], 'summarySha256': artifacts[str(prefix) + '-summary.json']})
    assert len(result['samples']) == 6
    pairs = []
    for round_index in range(3):
        before = next(row['seconds'] for row in result['samples'] if row['phase'] == 'before' and row['round'] == round_index)
        after = next(row['seconds'] for row in result['samples'] if row['phase'] == 'after' and row['round'] == round_index)
        pairs.append({'round': round_index, 'beforeSeconds': before, 'afterSeconds': after, 'reductionPercent': (1 - after / before) * 100})
    before_mean = statistics.mean(row['beforeSeconds'] for row in pairs)
    after_mean = statistics.mean(row['afterSeconds'] for row in pairs)
    result.update({'sourceHead': plan['sourceHead'], 'sourceCases': plan['caseCount'], 'passedCases': 128, 'stockSkippedCases': 2, 'pairs': pairs, 'beforeMeanSeconds': before_mean, 'afterMeanSeconds': after_mean, 'reductionPercent': (1 - after_mean / before_mean) * 100, 'speedupRatio': before_mean / after_mean, 'firstCommandsRetained': True, 'independentlyColdOsHosts': False, 'independentlyColdArms': False, 'countedOrder': plan['schedule'], 'allSixAttemptsRetained': True, 'scope': 'Three whole-pnpm pairs on one held ARM4, shipping fs cache true. First commands included; preceding counted commands can warm shared Bun transpiler/runtime and OS caches despite Vitest shipping fs cache true; no warmup/audit/normalization/discards. This four-consumer cohort does not establish a full-suite speedup or fleet latency.'})
    result['qualified'] = True
except Exception as error:
    result['qualified'] = False
    result['errors'].append(type(error).__name__ + ': ' + str(error))
    result['artifactHashes'] = artifacts
    try:
        with output.open('x') as stream: stream.write(json.dumps(result, indent=2) + '\n')
    except OSError:
        pass
    raise
result['artifactHashes'] = artifacts
with output.open('x') as stream: stream.write(json.dumps(result, indent=2) + '\n')
print(json.dumps({'qualified': True, 'beforeMeanSeconds': result['beforeMeanSeconds'], 'afterMeanSeconds': result['afterMeanSeconds'], 'reductionPercent': result['reductionPercent']}))
