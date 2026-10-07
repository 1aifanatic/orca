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
output = Path('http-transport-result.json')
assert not output.exists(), 'Never overwrite an attempt'
result = {'qualified': False, 'sourceSha': plan['sourceHead'], 'sourceOnlyCauseUnproved': True,
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
    assert os.environ['HTTP_SOURCE_SHA'] == plan['sourceHead']
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
        for phase in ['before', 'after']:
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
            assert len(report['testResults']) == 1
            module = report['testResults'][0]
            file = module['name'].replace('\\', '/')
            assert file == plan['files'][0] or file.endswith('/'+plan['files'][0])
            cases = sorted(module['assertionResults'], key=lambda row: json.dumps(
                {key: row[key] for key in ['fullName', 'title', 'ancestorTitles']}, sort_keys=True))
            assert len(cases) == report['numTotalTests'] == 51
            identities = [{key: row[key] for key in ['fullName', 'title', 'ancestorTitles']} for row in cases]
            assert len({json.dumps(row, sort_keys=True) for row in identities}) == 51
            failures = [row for row in cases if row['status'] != 'passed']
            if phase == 'after':
                assert not failures and source['result'] == 0 and report['success']
                assert report['numFailedTests'] == 0 and report['numPassedTests'] == 51
                assert details['reason'] == 'passed'
            else:
                assert len(failures) in [0, 1], 'Only the observed original transport failure may form a red baseline'
                if failures:
                    failure = failures[0]
                    assert failure['status'] == 'failed'
                    assert failure['ancestorTitles'] == ['Claude cancellation with an owed wake-up remote=true']
                    assert failure['title'] == 'keeps cancellation bounded unless a new prompt opens a turn: true'
                    assert 'socket connection was closed unexpectedly' in ' '.join(failure.get('failureMessages', [])), 'Different failure mechanism; retain and reject'
                    assert source['result'] == 1 and report['numFailedTests'] == 1 and report['numPassedTests'] == 50
                else:
                    assert source['result'] == 0 and report['success'] and report['numPassedTests'] == 51
            routes = [{key: row[key] for key in ['file', 'project', 'pool']} for row in details['modules']]
            assert routes == plan['expectedRoutes'][runtime]
            config = sorted([{key: project[key] for key in keys} for project in details['projects']], key=lambda row: row['name'])
            assert [row['name'] for row in config] == (['bun', 'node-measurement', 'node-runtime'] if runtime == 'bun' else ['node', 'node-measurement'])
            for project in config:
                assert project['fsModuleCache'] is False and project['isolate'] is True
                assert project['effectiveMaxWorkers'] == 4
                assert project['testTimeout'] == 30000 and project['hookTimeout'] == 60000
                assert project['setups'] == setups
                assert project['execArgv'] == ['--no-experimental-webstorage', '--expose-gc']
            result['snapshots'].append({'phase': phase, 'runtime': runtime, 'seed': seed,
                'identities': identities, 'rawStatusMap': [{key: row[key] for key in ['fullName','title','ancestorTitles','status']} for row in cases],
                'config': config, 'result': source['result'], 'baselineRedObserved': phase=='before' and bool(failures),
                'report': str(directory/f'{phase}.json')})
    assert seen == {(runtime, seed) for runtime in ['bun','node'] for seed in plan['shuffleSeeds']}
    assert all(row == input_signatures[0] for row in input_signatures)
    snapshots = result['snapshots']
    assert len(snapshots) == 8
    assert all(row['identities'] == snapshots[0]['identities'] for row in snapshots)
    for runtime in ['bun','node']:
        configs = [row['config'] for row in snapshots if row['runtime']==runtime]
        assert all(row==configs[0] for row in configs)
    result['qualified'] = True
    result['runtimeDerivedCaseCount'] = 51
    result['baselineRedObserved'] = any(row['baselineRedObserved'] for row in snapshots)
    result['baselineVerdict'] = 'observed_original_transport_failure' if result['baselineRedObserved'] else 'not_reproduced'
    result['candidateVerdict'] = 'all_original_cases_passed_in_four_isolated_attempts'
    result['connectionClosureObserved'] = False
    result['causeProven'] = False
    result['scope'] = 'Case/config/transport correctness only. Connection-close header is not a socket-close observation. No elapsed speed or absence-of-transitive-process claim.'
except Exception as error:
    result['errors'].append({'kind': type(error).__name__, 'message': str(error)})
    raise
finally:
    output.write_text(json.dumps(result, indent=2)+'\n')
print(json.dumps({'qualified': True, 'cases': 51, 'baselineRedObserved': result['baselineRedObserved'], 'causeProven': False}))
