# Adapted from the existing eight-report qualifier; reads artifacts only.
import hashlib
import json
import os
from pathlib import Path
import re
import sys

sha = lambda value: hashlib.sha256(value).hexdigest()
plan_path = Path(__file__).with_name('payload') / 'launch-plan.json'
plan = json.loads(plan_path.read_text())
base = Path(sys.argv[1])
output = Path('watcher-native-node-result.json')
assert not output.exists(), 'Never overwrite an attempt'
result = {'qualified': False, 'sourceSha': plan['sourceHead'], 'nativeRuntimeFidelityOnly': True,
          'performanceClaim': False, 'snapshots': [], 'artifactHashes': {}, 'errors': []}
keys = ['name', 'pool', 'fsModuleCache', 'effectiveMaxWorkers', 'isolate',
        'testTimeout', 'hookTimeout', 'setups', 'execArgv']
setups = ['config/scripts/vitest-real-agent-home-write-guard.ts',
          'config/scripts/vitest-bun-node-builtins.ts',
          'config/scripts/happy-dom-offscreen-canvas.ts',
          'config/scripts/happy-dom-mutation-observer-retention.ts',
          'config/scripts/vitest-host-ports-setup.ts',
          'config/scripts/vitest-caller-identity-env-setup.ts']

def read(path):
    value = path.read_bytes()
    result['artifactHashes'][str(path)] = sha(value)
    return json.loads(value)

try:
    assert os.environ['WATCHER_SOURCE_SHA'] == plan['sourceHead']
    contexts = sorted(base.rglob('ci-context.json'))
    assert len(contexts) == 4, 'Require all four independent runtime/seed jobs'
    seen = set()
    input_signatures = []
    for context_path in contexts:
        context = read(context_path)
        runtime, seed = context['runtime'], context['seed']
        assert (runtime, seed) not in seen
        seen.add((runtime, seed))
        assert runtime in ['bun', 'node'] and seed in plan['shuffleSeeds']
        assert context['sourceSha'] == plan['sourceHead']
        assert context['definitionSha'] == os.environ['GITHUB_SHA']
        assert context['runId'] == os.environ['GITHUB_RUN_ID']
        assert context['runAttempt'] == os.environ['GITHUB_RUN_ATTEMPT']
        assert context['platform'] == 'linux' and context['arch'] == 'arm64'
        assert context['nodeVersion'] == '24.21.0' and context['bunVersion'] == '1.4.2'
        assert context['vitestVersion'] == '5.0.3' and context['bunRevision']
        assert context['launchEnvironment'] == {'ORCA_BACKGROUND_LAUNCH': '1', 'ORCA_BALANCE_UNIT_SHARDS': None, 'ORCA_VITEST_RUNTIME': None, 'NODE_COMPILE_CACHE': None, 'NODE_DISABLE_COMPILE_CACHE': None, 'NODE_OPTIONS': None}
        input_signatures.append({key: context[key] for key in ['nodeExecutable', 'nodeVersion', 'bunVersion', 'bunRevision', 'vitestVersion', 'launchEnvironment']})
        assert context['planSha256'] == sha(plan_path.read_bytes())
        directory = context_path.parent
        assert (directory/'launch-plan.json').read_bytes() == plan_path.read_bytes()
        assert sha((directory/'candidate.patch').read_bytes()) == plan['patchSha256']
        for phase in ['after']:
            source = read(directory/f'{phase}-source-proof.json')
            report = read(directory/f'{phase}.json')
            details = read(directory/f'{phase}-details.json')
            log = (directory/f'{phase}.log').read_bytes()
            result['artifactHashes'][str(directory/f'{phase}.log')] = sha(log)
            assert source['phase'] == phase and source['runtime'] == runtime
            expected = dict(plan['sourceHashes'])
            if phase == 'after':
                expected.update({f: row['afterSha256'] for f, row in plan['patchTargets'].items()})
            assert source['before'] == source['after'] and source['sourceUnchanged']
            assert source['before']['head'] == plan['sourceHead']
            assert source['before']['sourceHashes'] == expected
            assert source['before']['planSha256'] == sha(plan_path.read_bytes())
            assert source['before']['patchSha256'] == plan['patchSha256']
            assert source['normalClose'] and source['result'] in [0, 1]
            assert not source['samplingErrors'] and not source['externalObserved']
            assert not source['postCloseCoordinators']
            assert source['samples'][0] == source['samples'][-1] == []
            assert all(row['owned'] for sample in source['samples'] for row in sample)
            prefix = plan['isolatedDirectory'] + '/' + phase
            command = ['pnpm', 'test'] if runtime == 'bun' else [
                'pnpm', 'exec', 'node', 'node_modules/vitest/vitest.mjs', 'run', '--config=config/vitest.config.ts']
            command += plan['files'] + ['--maxWorkers=4', '--fsModuleCache=false', '--sequence.shuffle',
                '--sequence.seed='+str(seed), '--reporter=json',
                '--reporter=./notes/bun-migration/performance/persistence-import-reuse-benchmark-reporter.mjs',
                '--outputFile='+prefix+'.json']
            assert source['command'] == command
            assert not re.search(rb'Timeout terminating|failed to terminate.*worker|worker.*termination.*timed out|Unhandled Errors', log, re.I)
            assert not details['errors'], 'Unhandled error is never a qualifying transport baseline'
            assert details['rootFsModuleCache'] is False and details['rootIsolation'] is True
            assert details['resolvedRootMaxWorkers'] == 4
            assert len(report['testResults']) == len(plan['files']) == 8
            modules = {}
            cases = []
            for module in report['testResults']:
                path = module['name'].replace('\\', '/')
                matches = [file for file in plan['files'] if path == file or path.endswith('/'+file)]
                assert len(matches) == 1 and matches[0] not in modules
                file = matches[0]
                modules[file] = module
                assert module['status'] == 'passed'
                assert len(module['assertionResults']) == plan['caseCountDerivation'][file]
                for row in module['assertionResults']:
                    cases.append({'file': file, **{key: row[key] for key in ['fullName','title','ancestorTitles','status']}})
            assert set(modules) == set(plan['files'])
            cases.sort(key=lambda row: json.dumps(row, sort_keys=True))
            assert len(cases) == report['numTotalTests'] == 36
            identities = [{key: row[key] for key in ['file','fullName','title','ancestorTitles']} for row in cases]
            assert len({json.dumps(row, sort_keys=True) for row in identities}) == 36
            assert all(row['status'] == 'passed' for row in cases)
            assert source['result'] == 0 and report['success']
            assert report['numFailedTests'] == report['numPendingTests'] == 0
            assert report['numPassedTests'] == 36 and details['reason'] == 'passed'
            routes = [{key: row[key] for key in ['file', 'project', 'pool']} for row in details['modules']]
            assert sorted(routes, key=lambda row: row['file']) == sorted(plan['expectedRoutes'][runtime], key=lambda row: row['file'])
            config = sorted([{key: project[key] for key in keys} for project in details['projects']], key=lambda row: row['name'])
            assert [row['name'] for row in config] == (['bun', 'node-measurement', 'node-runtime'] if runtime == 'bun' else ['node', 'node-measurement'])
            for project in config:
                assert project['fsModuleCache'] is False and project['isolate'] is True
                assert project['effectiveMaxWorkers'] == 4
                assert project['testTimeout'] == 30000 and project['hookTimeout'] == 60000
                assert project['setups'] == setups
                assert project['execArgv'] == ['--no-experimental-webstorage', '--expose-gc']
            result['snapshots'].append({'phase': phase, 'runtime': runtime, 'seed': seed,
                'identities': identities, 'rawStatusMap': [{key: row[key] for key in ['file','fullName','title','ancestorTitles','status']} for row in cases],
                'config': config, 'result': source['result'], 'baselineForced': False,
                'report': str(directory/f'{phase}.json')})
    assert seen == {(runtime, seed) for runtime in ['bun','node'] for seed in plan['shuffleSeeds']}
    assert all(row == input_signatures[0] for row in input_signatures)
    snapshots = result['snapshots']
    assert len(snapshots) == 4
    assert all(row['identities'] == snapshots[0]['identities'] for row in snapshots)
    for runtime in ['bun','node']:
        configs = [row['config'] for row in snapshots if row['runtime']==runtime]
        assert all(row==configs[0] for row in configs)
    result['qualified'] = True
    result['runtimeDerivedCaseCount'] = 36
    result['baselineVerdict'] = 'prior_passing_and_failing_Bun_observations_retained_separately; no_new_before_attempt'
    result['candidateVerdict'] = 'all_original_cases_passed_in_four_isolated_after_attempts'
    result['causeProven'] = False
    result['scope'] = 'Native runtime fidelity and original case/config/process correctness only; no Bun defect or speed claim. Dedicated Node boundary assertion executes in actual Node. Pure ignore and sequencer counterexamples remain ordinary.'
except Exception as error:
    result['qualified'] = False
    result['errors'].append({'kind': type(error).__name__, 'message': str(error)})
    raise
finally:
    output.write_text(json.dumps(result, indent=2)+'\n')
print(json.dumps({'qualified': True, 'cases': 36, 'nativeRuntimeFidelityOnly': True, 'causeProven': False}))
