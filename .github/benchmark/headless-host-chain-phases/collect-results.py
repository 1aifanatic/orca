# Reuses source/process/config gates; diagnostic status failures are preserved, never qualified.
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
    original_plan_path = payload_dir / 'original-launch-plan.json'
    manifest_path = payload_dir / 'definition-manifest.json'
    manifest = json.loads(manifest_path.read_text())
    shipping = json.loads(Path(shipping_plan_path).read_text())
    original = json.loads(Path(original_plan_path).read_text())
    assert shipping['sourceHead'] == original['sourceHead']
    assert shipping['sourceHashes'] == original['sourceHashes']
    assert shipping['files'] == original['files'] and len(shipping['files']) == 89
    assert shipping['expectedRoutes'] == original['expectedRoutes']
    assert shipping['shuffleSeeds'] == original['shuffleSeeds'] == [104729]
    assert len(original['patchTargets']) == 2 and len(shipping['patchTargets']) == 73
    for file, versions in original['patchTargets'].items():
        assert shipping['patchTargets'][file]['beforeSha256'] == versions['beforeSha256']
        if file == 'src/renderer/src/components/terminal-pane/remote-snapshot-alt-screen-host-chain.test.ts':
            assert shipping['patchTargets'][file]['afterSha256'] == versions['afterSha256']
        else:
            assert file == 'src/renderer/src/components/terminal-pane/pty-connection-test-environment.ts'
            assert shipping['patchTargets'][file]['afterSha256'] != versions['afterSha256']
    plan = shipping
    sha = lambda value: hashlib.sha256(value).hexdigest()
    artifacts = {}


    def read(path):
        path = Path(path)
        value = path.read_bytes()
        artifacts[str(path)] = sha(value)
        return json.loads(value)


    for plan_path in [shipping_plan_path, original_plan_path]:
        current = read(plan_path)
        assert sha((payload_dir / Path(current['patch']).name).read_bytes()) == current['patchSha256']
        for target, versions in current['patchTargets'].items():
            assert current['sourceHashes'][target] == versions['beforeSha256']
            assert set(versions) == {'beforeSha256', 'afterSha256'}
    plans_by_hash = {sha(Path(path).read_bytes()): (label, data) for label, path, data in
                     [('shipping', shipping_plan_path, shipping), ('original', original_plan_path, original)]}
    assert len(plans_by_hash) == 2
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
    assert manifest['phaseOrder'] == ['original', 'shipping']
    assert manifest['expectedCiPins'] == {'node': '24.21.0', 'bun': '1.4.2', 'vitest': '5.0.3'}
    assert manifest['sourceHashes'] == {key: value for key, value in shipping['sourceHashes'].items() if not key.startswith('notes/')}
    assert manifest['controllerSha256'] == shipping['controllerSha256'] == original['controllerSha256']
    assert manifest['reporterSha256'] == shipping['reporterSha256'] == original['reporterSha256']
    for key, name in [('shippingLaunch', 'shipping-launch-plan.json'), ('originalLaunch', 'original-launch-plan.json'),
                      ('shippingPatch', 'shipping.patch'), ('originalPatch', 'original.patch'), ('sourceProof', 'source-proposal-proof.json')]:
        assert sha((payload_dir / name).read_bytes()) == manifest['payloadSha256'][key]
    read(manifest_path)
    contexts = sorted(artifact_root.rglob('ci-context.json'))
    assert len(contexts) == 1
    entries = []
    seen = set()
    input_signatures = []
    for path in contexts:
        context = read(path)
        runtime, seed = context['runtime'], context['seed']
        assert runtime == 'node' and seed in plan['shuffleSeeds']
        assert (runtime, seed) not in seen
        seen.add((runtime, seed))
        directory = path.parent
        assert directory.name == 'headless-host-chain-phases-' + runtime + '-' + str(seed)
        assert directory.resolve().is_relative_to(artifact_root.resolve())
        assert context['sourceSha'] == plan['sourceHead']
        assert context['definitionSha'] == os.environ['GITHUB_SHA']
        assert context['runId'] == os.environ['GITHUB_RUN_ID']
        assert context['runAttempt'] == os.environ['GITHUB_RUN_ATTEMPT']
        assert context['platform'] == 'linux' and context['arch'] == 'arm64'
        assert context['nodeVersion'] == '24.21.0' and context['bunVersion'] == '1.4.2'
        assert context['vitestVersion'] == '5.0.3' and context['bunRevision'] == '1.4.2+744846f84'
        assert context['controllerSha256'] == manifest['controllerSha256']
        assert context['reporterSha256'] == manifest['reporterSha256']
        assert context['definitionManifestSha256'] == sha(manifest_path.read_bytes())
        assert context['installedOwnerHashes'] == manifest['installedOwnerHashes']
        assert context['ciOnly'] is True and context['testsLaunchedByMaterializer'] is False
        assert context['launchEnvironment'] == {'ORCA_BACKGROUND_LAUNCH': '1', 'ORCA_BALANCE_UNIT_SHARDS': None, 'ORCA_VITEST_RUNTIME': None, 'NODE_COMPILE_CACHE': None, 'NODE_DISABLE_COMPILE_CACHE': None, 'NODE_OPTIONS': None}
        input_signatures.append({key: context[key] for key in ['nodeExecutable', 'nodeVersion', 'bunVersion', 'bunRevision', 'vitestVersion', 'launchEnvironment']})
        for name in ['shipping-launch-plan.json', 'original-launch-plan.json', 'shipping.patch', 'original.patch', 'source-proposal-proof.json']:
            assert (directory / name).read_bytes() == (payload_dir / name).read_bytes()
            artifacts[str(directory / name)] = sha((directory / name).read_bytes())
        assert context['shippingPlanSha256'] == sha(shipping_plan_path.read_bytes())
        assert context['originalPlanSha256'] == sha(original_plan_path.read_bytes())
        for arm in manifest['phaseOrder']:
            prefix = directory / 'runs' / (runtime + '-' + str(seed)) / arm
            logical_prefix = manifest['isolatedDirectory'] + '/runs/' + runtime + '-' + str(seed) + '/' + arm
            entries.append((runtime, seed, arm, prefix, logical_prefix))
    assert seen == {(runtime, seed) for runtime in ['node'] for seed in plan['shuffleSeeds']}
    assert all(signature == input_signatures[0] for signature in input_signatures)
    snapshots = []
    for expected_runtime, expected_seed, expected_arm, prefix, logical_prefix in entries:
        source = read(str(prefix) + '-source-proof.json')
        report = read(str(prefix) + '.json')
        details = read(str(prefix) + '-details.json')
        runtime, phase = source['runtime'], source['phase']
        assert runtime == 'node' and phase == 'after'
        plan_sha = source['before']['planSha256']
        assert plan_sha in plans_by_hash
        plan_label, current_plan = plans_by_hash[plan_sha]
        arm = plan_label
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
        assert source['result'] in [0, 1] and source['normalClose']
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
        assert isinstance(report['success'], bool) and report['success'] == (source['result'] == 0)
        assert details['reason'] in ['passed', 'failed'] and not details['errors']
        assert details['reason'] == ('passed' if report['success'] else 'failed')
        assert details['rootFsModuleCache'] is False and details['rootIsolation'] is True
        assert details['resolvedRootMaxWorkers'] == 4
        assert len(report['testResults']) == len(plan['files'])
        case_map = {}
        for module in report['testResults']:
            assert module['status'] in ['passed', 'failed']
            name = module['name'].replace('\\', '/')
            matches = [file for file in plan['files'] if name == file or name.endswith('/' + file)]
            assert len(matches) == 1 and matches[0] not in case_map
            case_map[matches[0]] = normalize([{key: case[key] for key in
                ['fullName', 'title', 'ancestorTitles', 'status']} for case in module['assertionResults']])
        assert sorted(case_map) == sorted(plan['files'])
        raw_count = sum(len(cases) for cases in case_map.values())
        assert raw_count == report['numTotalTests']
        all_cases = [case for cases in case_map.values() for case in cases]
        assert all(case['status'] in ['passed', 'failed'] for case in all_cases)
        assert sum(case['status'] == 'passed' for case in all_cases) == report['numPassedTests'] > 0
        assert sum(case['status'] in ['pending', 'skipped'] for case in all_cases) == report.get('numPendingTests', 0)
        assert sum(case['status'] == 'failed' for case in all_cases) == report['numFailedTests']
        assert report['success'] == (report['numFailedTests'] == 0)
        assert not report.get('numTodoTests', 0)
        assert report['numTotalTestSuites'] == report['numPassedTestSuites'] + report['numFailedTestSuites'] + report['numPendingTestSuites']
        assert all(case_map.values()), 'Every source file registers original cases'
        observed_count = sum(len(cases) for cases in case_map.values())
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
        events = read(str(prefix) + '-phase-events.json')
        assert events['reason'] == details['reason']
        assert isinstance(events['logs'], list) and len(events['cases']) == raw_count
        assert all(isinstance(row['id'], str) and isinstance(row['file'], str) and row['file'] in plan['files'] and isinstance(row['logs'], list) for row in events['cases'])
        assert len({row['id'] for row in events['cases']}) == raw_count
        public_cases = normalize([{'file': row['file'], 'name': row['name'], 'fullName': row['fullName'], 'state': row['result']['state']} for row in events['cases']])
        raw_public_cases = normalize([{'file': file, 'name': case['title'], 'fullName': ' > '.join(case['ancestorTitles'] + [case['title']]), 'state': case['status']} for file, cases in case_map.items() for case in cases])
        assert public_cases == raw_public_cases, 'Public TestCase identity/status differs from raw assertions'
        cases_by_id = {row['id']: row for row in events['cases']}
        for log in events['logs']:
            task_id = log.get('taskId')
            if task_id in cases_by_id:
                assert log in cases_by_id[task_id]['logs'], 'Case-owned console log must belong to the same public TestCase'
        for row in events['cases']:
            for log in row['logs']:
                if log.get('taskId') in cases_by_id:
                    assert log['taskId'] == row['id'] and log in events['logs']
        # Other task IDs can identify a module/hook; retain them without inferred case ownership.
        assert sorted(row['file'] for row in events['cases']) == sorted(file for file, cases in case_map.items() for _ in cases)
        texts = [row['content'] for row in events['logs']]
        assert all(isinstance(row['time'], (int, float)) and isinstance(row['content'], str) and row['type'] in ['stdout', 'stderr'] for row in events['logs'])
        markers = []
        for log in events['logs']:
            for token in ['[orca-headless-host-chain-phase]', '[orca-headless-installer-phase]']:
                if token not in log['content']: continue
                marker, _ = json.JSONDecoder().raw_decode(log['content'].split(token, 1)[1].lstrip())
                assert isinstance(marker['phase'], str) and isinstance(marker['workerPid'], int) and marker['workerPid'] > 0
                assert isinstance(marker['at'], (int, float)) and isinstance(marker['fakeTimers'], bool)
                markers.append({'marker': marker, 'taskId': log.get('taskId'), 'rawLog': log})
        assert markers, 'Missing passive markers rejects observation'
        assert any(row['marker']['phase'] == 'runtime-import:start' for row in markers)
        assert any(row['marker']['phase'] == 'beforeEach:returned-without-awaiting-installer' for row in markers)
        assert any(row['marker']['phase'] == 'reset-bridge-import:start' for row in markers)
        # End markers can be absent on a real timeout; preserve that unfinished phase.
        snapshots.append({'phase': phase, 'arm': arm, 'runtime': runtime, 'seed': seed,
                          'count': observed_count, 'reportedCount': raw_count, 'map': case_map, 'config': config,
                          'sourceProof': str(prefix) + '-source-proof.json',
                          'report': str(prefix) + '.json', 'details': str(prefix) + '-details.json', 'phaseEvents': str(prefix) + '-phase-events.json', 'markers': markers, 'rawSucceeded': report['success'], 'failedCases': report['numFailedTests'], 'hierarchicalSuiteTotals': {key: report[key] for key in ['numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numPendingTestSuites']}})

    assert len(snapshots) == 2 and {s['arm'] for s in snapshots} == {'original', 'shipping'}
    identity = lambda case: {key: value for key, value in case.items() if key != 'status'}
    expected_cases = normalize([identity(case) for case in manifest['originalRawCaseMap']])
    assert len(expected_cases) == 935
    for snapshot in snapshots:
        actual_cases = normalize([{'file': file, **identity(case)} for file, cases in snapshot['map'].items() for case in cases])
        assert actual_cases == expected_cases and snapshot['count'] == 935
    assert snapshots[0]['config'] == snapshots[1]['config']
    result = {'qualified': False, 'observationComplete': True, 'performanceQualified': False,
              'shippingCompatibilityAdmitted': False, 'timingAdmitted': False,
              'sourceHead': plan['sourceHead'], 'files': plan['files'],
              'runtimeDerivedCaseCount': 935, 'snapshots': snapshots,
              'contexts': [str(path) for path in contexts], 'artifactHashes': artifacts,
              'scope': 'Passive diagnostic only. Both raw status maps retained; failed statuses are observations, never compatibility admission. Instrumented success does not repair prior shipping failure. Hook logs without a task association stay unassigned; no cross-worker clock ordering or causal claim.'}

    return result

try:
    result = validate()
except Exception as error:
    rejection = {'qualified': False, 'errors': [str(error)], 'observationComplete': False, 'scope': 'Rejected passive diagnostic evidence; raw statuses retained and no performance claim.'}
    try:
        with output_path.open('x') as output:
            output.write(json.dumps(rejection, indent=2) + '\n')
    except OSError:
        pass
    raise
with output_path.open('x') as output:
    output.write(json.dumps(result, indent=2) + '\n')
print(json.dumps({'qualified': False, 'observationComplete': True, 'cases': result['runtimeDerivedCaseCount'], 'proof': str(output_path)}))
