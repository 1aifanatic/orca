# Reuses stock four-consumer qualification gates and the unchanged full checkpoint comparator.
import hashlib
import json
import re
import sys
import os
import subprocess
from collections import Counter
from pathlib import Path

artifact_root, payload_dir, output_path = map(Path, sys.argv[1:])
assert not output_path.exists(), 'Never overwrite consumed evidence'

def validate():
    shipping_plan_path = payload_dir / 'shipping-launch-plan.json'
    manifest_path = payload_dir / 'definition-manifest.json'
    manifest = json.loads(manifest_path.read_text())
    shipping = json.loads(shipping_plan_path.read_text())
    assert len(shipping['files']) == 4 and len(shipping['patchTargets']) == 1
    assert len(shipping['instrumentationTargets']) == 1
    assert shipping['shuffleSeeds'] == [104729, 130363]
    plan = shipping
    sha = lambda value: hashlib.sha256(value).hexdigest()
    artifacts = {}


    def read(path):
        path = Path(path)
        value = path.read_bytes()
        artifacts[str(path)] = sha(value)
        return json.loads(value)


    for plan_path in [shipping_plan_path]:
        current = read(plan_path)
        assert sha((payload_dir / Path(current['patch']).name).read_bytes()) == current['patchSha256']
        for target, versions in current['patchTargets'].items():
            assert current['sourceHashes'][target] == versions['beforeSha256']
            assert set(versions) == {'beforeSha256', 'afterSha256'}
    plans_by_hash = {sha(shipping_plan_path.read_bytes()): ('after', shipping)}
    keys = ['name', 'pool', 'fsModuleCache', 'effectiveMaxWorkers', 'isolate',
            'testTimeout', 'hookTimeout', 'setups', 'execArgv']
    expected_setups = ['config/scripts/vitest-real-agent-home-write-guard.ts',
                       'config/scripts/vitest-bun-node-builtins.ts',
                       'config/scripts/happy-dom-offscreen-canvas.ts',
                       'config/scripts/happy-dom-mutation-observer-retention.ts',
                       'config/scripts/vitest-host-ports-setup.ts',
                       'config/scripts/vitest-caller-identity-env-setup.ts']
    normalize = lambda cases: sorted(cases, key=lambda case: json.dumps(case, sort_keys=True))
    assert manifest['sourceHead'] == shipping['sourceHead'] == os.environ['WAIT_SOURCE_SHA']
    assert manifest['shuffleSeeds'] == plan['shuffleSeeds']
    assert manifest['phaseOrder'] == ['before', 'after']
    assert manifest['expectedCiPins'] == {'node': '24.21.0', 'bun': '1.4.2', 'vitest': '5.0.3'}
    pristine = {key: value for key, value in shipping['sourceHashes'].items() if not key.startswith('notes/')}
    for file, versions in shipping['instrumentationTargets'].items():
        assert pristine[file] == versions['instrumentedSha256']
        pristine[file] = versions['beforeSha256']
    assert manifest['sourceHashes'] == pristine
    assert manifest['instrumentationTargets'] == shipping['instrumentationTargets']
    for name, key in manifest['payloadToHashKey'].items():
        assert sha((payload_dir / name).read_bytes()) == manifest['payloadSha256'][key]
    assert manifest['controllerSha256'] == shipping['controllerSha256']
    assert manifest['reporterSha256'] == shipping['reporterSha256']
    for key, name in [('shippingLaunch', 'shipping-launch-plan.json'), 
                      ('shippingPatch', 'shipping.patch'),  ('sourceProof', 'source-proposal-proof.json')]:
        assert sha((payload_dir / name).read_bytes()) == manifest['payloadSha256'][key]
    read(manifest_path)
    contexts = sorted(artifact_root.rglob('ci-context.json'))
    assert len(contexts) == 4
    entries = []
    seen = set()
    input_signatures = []
    for path in contexts:
        context = read(path)
        runtime, seed = context['runtime'], context['seed']
        assert runtime in ['bun', 'node'] and seed in plan['shuffleSeeds']
        assert (runtime, seed) not in seen
        seen.add((runtime, seed))
        directory = path.parent
        assert directory.name == 'serialize-oracle-blank-predicate-' + runtime + '-' + str(seed)
        assert directory.resolve().is_relative_to(artifact_root.resolve())
        assert context['sourceSha'] == plan['sourceHead']
        assert context['definitionSha'] == os.environ['GITHUB_SHA']
        assert context['runId'] == os.environ['GITHUB_RUN_ID']
        assert context['runAttempt'] == os.environ['GITHUB_RUN_ATTEMPT']
        assert context['platform'] == 'linux' and context['arch'] == 'arm64'
        assert context['nodeVersion'] == '24.21.0' and context['bunVersion'] == '1.4.2'
        assert context['vitestVersion'] == '5.0.3' and context['bunRevision']
        assert context['controllerSha256'] == manifest['controllerSha256']
        assert context['reporterSha256'] == manifest['reporterSha256']
        assert context['definitionManifestSha256'] == sha(manifest_path.read_bytes())
        assert type(context['seed']) is int
        assert context['installedOwnerSha256'] == manifest['installedOwnerSha256']
        assert context['instrumentationTargets'] == manifest['instrumentationTargets']
        assert context['ciOnly'] is True and context['testsLaunchedByMaterializer'] is False
        assert context['launchEnvironment'] == {'ORCA_BACKGROUND_LAUNCH': '1', 'ORCA_BALANCE_UNIT_SHARDS': None, 'ORCA_VITEST_RUNTIME': None, 'NODE_COMPILE_CACHE': None, 'NODE_DISABLE_COMPILE_CACHE': None, 'NODE_OPTIONS': None}
        input_signatures.append({key: context[key] for key in ['nodeExecutable', 'nodeVersion', 'bunVersion', 'bunRevision', 'vitestVersion', 'launchEnvironment']})
        for name in ['shipping-launch-plan.json', 'shipping.patch', 'capture.patch', 'source-proposal-proof.json', 'compare-serialize-checkpoint-captures.py']:
            assert (directory / name).read_bytes() == (payload_dir / name).read_bytes()
            artifacts[str(directory / name)] = sha((directory / name).read_bytes())
        assert context['shippingPlanSha256'] == sha(shipping_plan_path.read_bytes())
        for arm in manifest['phaseOrder']:
            prefix = directory / 'runs' / (runtime + '-' + str(seed)) / arm
            logical_prefix = manifest['isolatedDirectory'] + '/runs/' + runtime + '-' + str(seed) + '/' + arm
            entries.append((runtime, seed, arm, prefix, logical_prefix))
    assert seen == {(runtime, seed) for runtime in ['bun', 'node'] for seed in plan['shuffleSeeds']}
    assert all(signature == input_signatures[0] for signature in input_signatures)
    snapshots = []
    for expected_runtime, expected_seed, expected_arm, prefix, logical_prefix in entries:
        source = read(str(prefix) + '-source-proof.json')
        report = read(str(prefix) + '.json')
        details = read(str(prefix) + '-details.json')
        runtime, phase = source['runtime'], source['phase']
        assert runtime in ['bun', 'node'] and phase in ['before', 'after']
        plan_sha = source['before']['planSha256']
        assert plan_sha in plans_by_hash
        plan_label, current_plan = plans_by_hash[plan_sha]
        arm = 'before' if phase == 'before' else plan_label
        assert arm == expected_arm and runtime == expected_runtime
        assert plan_label == 'after'
        seed = int(next(arg.split('=', 1)[1] for arg in source['command']
                        if arg.startswith('--sequence.seed=')))
        assert seed == expected_seed
        expected = dict(current_plan['sourceHashes'])
        if phase == 'after':
            expected.update({file: versions['afterSha256']
                             for file, versions in current_plan['patchTargets'].items()})
        assert source['before'] == source['after'] and source['sourceUnchanged']
        assert source['before']['head'] == plan['sourceHead']
        assert source['before']['sourceHashes'] == expected
        assert source['before']['patchSha256'] == current_plan['patchSha256']
        assert source['result'] == 0 and source['normalClose']
        capture_path = Path(str(prefix) + '-checkpoints.jsonl')
        assert source['capture']['path'] == logical_prefix + '-checkpoints.jsonl'
        assert 0 < capture_path.stat().st_size <= current_plan['captureLimitBytes']
        assert source['capture']['bytes'] == capture_path.stat().st_size
        capture_hash = hashlib.sha256()
        with capture_path.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''): capture_hash.update(block)
        assert source['capture']['sha256'] == capture_hash.hexdigest()
        artifacts[str(capture_path)] = capture_hash.hexdigest()
        assert not source['samplingErrors'] and not source['externalObserved']
        assert not source['postCloseCoordinators']
        assert source['samples'] and all(row['owned'] for sample in source['samples'] for row in sample)
        assert source['samples'][0] == [] and source['samples'][-1] == []
        command = ['pnpm', 'test'] if runtime == 'bun' else [
            'pnpm', 'exec', 'node', 'node_modules/vitest/vitest.mjs', 'run',
            '--config=config/vitest.config.ts']
        command += plan['files'] + ['--maxWorkers=4', '--fsModuleCache=false',
            '--sequence.shuffle', '--sequence.seed=' + str(seed), '--reporter=json',
            '--reporter=./notes/bun-migration/performance/persistence-import-reuse-benchmark-reporter.mjs',
            '--outputFile=' + logical_prefix + '.json']
        assert source['command'] == command, 'Qualification command/settings differ'
        log_path = Path(str(prefix) + '.log')
        log = log_path.read_bytes()
        artifacts[str(log_path)] = sha(log)
        assert not re.search(rb'Timeout terminating|failed to terminate.*worker|worker.*termination.*timed out|Unhandled Errors', log, re.I)
        assert report['success'] and not report['numFailedTests'] and not report['numFailedTestSuites']
        assert details['reason'] == 'passed' and not details['errors']
        assert details['rootFsModuleCache'] is False and details['rootIsolation'] is True
        assert details['resolvedRootMaxWorkers'] == 4
        assert len(report['testResults']) == len(plan['files']) == 4
        case_map = {}
        for module in report['testResults']:
            assert module['status'] == 'passed'
            assert module['assertionResults'], 'Every original physical module must retain cases'
            name = module['name'].replace('\\', '/')
            matches = [file for file in plan['files'] if name == file or name.endswith('/' + file)]
            assert len(matches) == 1 and matches[0] not in case_map
            case_map[matches[0]] = normalize([{key: case[key] for key in
                ['fullName', 'title', 'ancestorTitles', 'status']} for case in module['assertionResults']])
        assert sorted(case_map) == sorted(plan['files'])
        observed_count = sum(len(cases) for cases in case_map.values())
        assert observed_count == report['numTotalTests'] and observed_count > 0
        cases = [case for rows in case_map.values() for case in rows]
        states = Counter(case['status'] for case in cases)
        assert set(states) <= {'passed', 'pending', 'skipped'}
        assert states['passed'] == report['numPassedTests']
        assert states['pending'] + states['skipped'] == report['numPendingTests']
        assert not report.get('numTodoTests', 0)
        expected_skips = {
            'previously found I3 regression seeds do not regress',
            'I1/I3 against the previous serialize build: identical bytes when nothing is wider than the grid, and no checkpoint gets worse'
        }
        skipped = [(file, row) for file, rows in case_map.items() for row in rows if row['status'] != 'passed']
        assert len(skipped) == 2 and {row['title'] for file, row in skipped} == expected_skips
        assert all(file == 'src/main/daemon/serialize-grid.differential.fuzz.test.ts' and row['ancestorTitles'] == ['serialize grid round-trip fuzz'] and row['fullName'] == 'serialize grid round-trip fuzz ' + row['title'] for file, row in skipped)
        case_map = dict(sorted(case_map.items()))
        routes = [{key: module[key] for key in ['file', 'project', 'pool']} for module in details['modules']]
        assert len(routes) == len(plan['files'])
        assert sorted(routes, key=lambda row: row['file']) == sorted(plan['expectedRoutes'][runtime], key=lambda row: row['file'])
        assert all(not module.get('diagnostic', {}).get('errors') for module in details['modules'])
        config = sorted([{key: project[key] for key in keys} for project in details['projects']], key=lambda row: row['name'])
        assert [project['name'] for project in config] == (
            ['bun', 'node-measurement', 'node-runtime'] if runtime == 'bun' else ['node', 'node-measurement'])
        for project in config:
            assert project['fsModuleCache'] is False and project['isolate'] is True
            assert project['effectiveMaxWorkers'] == 4
            assert project['testTimeout'] == 30000 and project['hookTimeout'] == 60000
            assert project['setups'] == expected_setups
            assert project['execArgv'] == ['--no-experimental-webstorage', '--expose-gc']
        snapshots.append({'phase': phase, 'arm': arm, 'runtime': runtime, 'seed': seed,
                          'count': observed_count, 'reportedCount': observed_count, 'map': case_map, 'rawStates': dict(states), 'config': config,
                          'capture': str(capture_path),
                          'sourceProof': str(prefix) + '-source-proof.json',
                          'report': str(prefix) + '.json', 'details': str(prefix) + '-details.json'})

    expected_rows = {(arm, runtime, seed) for arm in ['before', 'after']
                     for runtime in ['bun', 'node'] for seed in plan['shuffleSeeds']}
    assert len({(s['arm'], s['runtime'], s['seed']) for s in snapshots}) == len(snapshots)
    assert {(s['arm'], s['runtime'], s['seed']) for s in snapshots} == expected_rows
    assert all(s['map'] == snapshots[0]['map'] and s['count'] == snapshots[0]['count'] for s in snapshots)
    for runtime in ['bun', 'node']:
        configs = [s['config'] for s in snapshots if s['runtime'] == runtime]
        assert all(config == configs[0] for config in configs)
    comparison_dir = output_path.parent / 'checkpoint-comparisons'
    comparison_dir.mkdir(exist_ok=False)
    comparisons = []
    for runtime in ['bun', 'node']:
        for seed in plan['shuffleSeeds']:
            pair = {s['arm']: s for s in snapshots if s['runtime'] == runtime and s['seed'] == seed}
            case_plan = comparison_dir / (runtime + '-' + str(seed) + '-case-plan.json')
            with case_plan.open('x') as stream:
                json.dump({'cases': pair['before']['map']['src/main/daemon/serialize-grid-transcript-replay.test.ts']}, stream)
            comparison_path = comparison_dir / (runtime + '-' + str(seed) + '-full-checkpoints.json')
            command = [sys.executable, str(payload_dir / 'compare-serialize-checkpoint-captures.py'),
                       pair['before']['capture'], pair['after']['capture'], str(comparison_path), '--case-plan', str(case_plan)]
            log_path = comparison_dir / (runtime + '-' + str(seed) + '-comparator.log')
            with log_path.open('xb') as log:
                completed = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=600)
            artifacts[str(log_path)] = sha(log_path.read_bytes())
            assert completed.returncode == 0, 'Complete unchanged comparator failed; log retained'
            comparison = read(comparison_path)
            assert comparison['transcripts'] == 112 and comparison['runs'] == 1792
            assert comparison['exactRawRowsEqual'] and not comparison['discardedFields'] and not comparison['normalizedFields']
            assert comparison['beforeCaptureSha256'] == artifacts[pair['before']['capture']]
            assert comparison['afterCaptureSha256'] == artifacts[pair['after']['capture']]
            comparisons.append({'runtime': runtime, 'seed': seed, 'command': command, 'proof': comparison})
    assert len(comparisons) == 4
    for key in ['completeCheckpoints', 'serializedStrings', 'serializedStringUtf8Bytes']:
        assert all(row['proof'][key] == comparisons[0]['proof'][key] for row in comparisons)
    result = {'qualified': True, 'sourceHead': plan['sourceHead'], 'files': plan['files'],
              'runtimeDerivedCaseCount': snapshots[0]['count'],
              'caseIdentityMapByFile': snapshots[0]['map'], 'candidateAddsNoCases': True,
              'allEightOriginalSourceCommandProcessRuntimeConfigCaseStatusMapsEqual': True,
              'contexts': [str(path) for path in contexts], 'inputSignatures': input_signatures,
              'snapshots': snapshots, 'artifactHashes': artifacts, 'fullCheckpointComparisons': comparisons,
              'semanticReviews': json.loads((payload_dir / 'source-proposal-proof.json').read_text())['semanticReviews'],
              'scope': 'Isolated CI correctness only; exact original status maps and pins verified. Complete captured fields/strings equal in every matched pair. Counts derive from actual reports; no timing gain or dedicated native cleanup claim.'}
    return result

try:
    result = validate()
except Exception as error:
    rejection = {'qualified': False, 'errors': [str(error)], 'scope': 'Rejected isolated CI correctness evidence; no performance claim.'}
    try:
        with output_path.open('x') as output:
            output.write(json.dumps(rejection, indent=2) + '\n')
    except OSError:
        pass
    raise
with output_path.open('x') as output:
    output.write(json.dumps(result, indent=2) + '\n')
print(json.dumps({'qualified': True, 'cases': result['runtimeDerivedCaseCount'], 'proof': str(output_path)}))
