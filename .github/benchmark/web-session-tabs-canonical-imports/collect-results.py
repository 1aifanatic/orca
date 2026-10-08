# Reuses original-map qualification gates; test-only canonical specifiers add no case identities.
import hashlib
import json
import re
import sys
import os
from pathlib import Path

artifact_root, payload_dir, output_path = map(Path, sys.argv[1:])
assert not output_path.exists(), 'Never overwrite consumed evidence'

def validate():
    shipping_plan_path = payload_dir / 'shipping-launch-plan.json'
    manifest_path = payload_dir / 'definition-manifest.json'
    manifest = json.loads(manifest_path.read_text())
    shipping = json.loads(shipping_plan_path.read_text())
    assert len(shipping['files']) == 62
    assert shipping['shuffleSeeds'] == [104729, 130363]
    assert len(shipping['patchTargets']) == 48
    assert shipping['caseCount'] is None and shipping['runtimeManifestPending'] is True
    assert shipping['timedFiles'] == [], 'Correctness only; no timing workload in this definition'
    plan = shipping
    sha = lambda value: hashlib.sha256(value).hexdigest()
    artifacts = {}

    def read(path):
        value = Path(path).read_bytes()
        artifacts[str(path)] = sha(value)
        return json.loads(value)

    read(shipping_plan_path)
    assert sha((payload_dir / Path(plan['patch']).name).read_bytes()) == plan['patchSha256']
    for target, versions in plan['patchTargets'].items():
        assert plan['sourceHashes'][target] == versions['beforeSha256']
        assert set(versions) == {'beforeSha256', 'afterSha256'}
    shipping_plan_sha = sha(shipping_plan_path.read_bytes())
    keys = ['name', 'pool', 'fsModuleCache', 'effectiveMaxWorkers', 'isolate',
            'testTimeout', 'hookTimeout', 'setups', 'execArgv']
    expected_setups = ['config/scripts/vitest-real-agent-home-write-guard.ts',
                       'config/scripts/vitest-bun-node-builtins.ts',
                       'config/scripts/happy-dom-offscreen-canvas.ts',
                       'config/scripts/happy-dom-mutation-observer-retention.ts',
                       'config/scripts/vitest-host-ports-setup.ts',
                       'config/scripts/vitest-caller-identity-env-setup.ts']
    normalize = lambda cases: sorted(cases, key=lambda case: json.dumps(case, sort_keys=True))
    assert manifest['sourceHead'] == shipping['sourceHead'] == os.environ['WEB_TABS_SOURCE_SHA']
    assert manifest['shuffleSeeds'] == plan['shuffleSeeds']
    assert manifest['phaseOrder'] == ['before', 'after']
    assert manifest['expectedCiPins'] == {'node': '24.21.0', 'bun': '1.4.2', 'vitest': '5.0.3'}
    assert manifest['sourceHashes'] == {key: value for key, value in shipping['sourceHashes'].items() if not key.startswith('notes/')}
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
        assert directory.name == 'web-session-tabs-canonical-imports-' + runtime + '-' + str(seed)
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
        assert context['ciOnly'] is True and context['testsLaunchedByMaterializer'] is False
        assert context['launchEnvironment'] == {'ORCA_BACKGROUND_LAUNCH': '1', 'ORCA_BALANCE_UNIT_SHARDS': None, 'ORCA_VITEST_RUNTIME': None, 'NODE_COMPILE_CACHE': None, 'NODE_DISABLE_COMPILE_CACHE': None, 'NODE_OPTIONS': None}
        input_signatures.append({key: context[key] for key in ['nodeExecutable', 'nodeVersion', 'bunVersion', 'bunRevision', 'vitestVersion', 'launchEnvironment']})
        for name in ['shipping-launch-plan.json', 'shipping.patch', 'source-proposal-proof.json']:
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
        assert plan_sha == shipping_plan_sha
        current_plan = plan
        arm = phase
        assert arm == expected_arm and runtime == expected_runtime
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
        assert len(report['testResults']) == len(plan['files'])
        case_map = {}
        for module in report['testResults']:
            assert module['status'] == 'passed'
            assert module['assertionResults'], 'Every original physical module registers cases'
            name = module['name'].replace('\\', '/')
            matches = [file for file in plan['files'] if name == file or name.endswith('/' + file)]
            assert len(matches) == 1 and matches[0] not in case_map
            case_map[matches[0]] = normalize([{key: case[key] for key in
                ['fullName', 'title', 'ancestorTitles', 'status']} for case in module['assertionResults']])
        assert sorted(case_map) == sorted(plan['files'])
        observed_count = sum(len(cases) for cases in case_map.values())
        assert observed_count == report['numTotalTests'] == report['numPassedTests']
        assert observed_count > 0, 'Case count derives from the first original report, not AST'
        assert not report.get('numPendingTests', 0) and not report.get('numTodoTests', 0)
        assert all(case['status'] == 'passed' for cases in case_map.values() for case in cases)
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
                          'count': observed_count, 'reportedCount': observed_count, 'map': case_map, 'config': config,
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
    result = {'qualified': True, 'sourceHead': plan['sourceHead'], 'files': plan['files'],
              'runtimeDerivedCaseCount': snapshots[0]['count'],
              'caseIdentityMapByFile': snapshots[0]['map'], 'candidateAddsNoCases': True,
              'allEightOriginalCandidateSourceCommandProcessRuntimeConfigCaseStatusMapsEqual': True,
              'contexts': [str(path) for path in contexts], 'inputSignatures': input_signatures,
              'snapshots': snapshots, 'artifactHashes': artifacts,
              'scope': 'Isolated CI correctness only; pins/context verified. No timing, locally safe native execution or full-suite claim.'}
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
