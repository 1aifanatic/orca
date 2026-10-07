# Adapted from the accepted inline-clock eight-report validator; no subprocesses.
import hashlib
import json
import re
import sys
from pathlib import Path

import os

try:
    base = Path('notes/bun-migration/performance').resolve()
    artifact_root = Path(sys.argv[1]).resolve()
    payload = Path(__file__).with_name('payload')
    plan_path = payload / 'launch-plan.json'
    output_path = Path('zod-broad-result.json')
    assert not output_path.exists()
    contexts = {}
    prefixes = []
    for runtime in ['bun', 'node']:
        for seed in [104729, 130363]:
            directory = artifact_root / f'zod-broad-{runtime}-{seed}'
            context_path = directory / 'runs' / f'{runtime}-{seed}' / 'ci-context.json'
            context = json.loads(context_path.read_text())
            assert context['runtime'] == runtime and context['seed'] == seed
            assert context['sourceSha'] == os.environ['ZOD_SOURCE_SHA']
            assert context['definitionSha'] == os.environ['GITHUB_SHA']
            assert context['runId'] == os.environ['GITHUB_RUN_ID']
            assert context['runAttempt'] == os.environ['GITHUB_RUN_ATTEMPT']
            assert context['platform'] == 'linux' and context['arch'] == 'arm64'
            assert context['nodeVersion'] == '24.21.0' and context['bunVersion'] == '1.4.2'
            assert context['vitestVersion'] == '5.0.3'
            assert context['ciOnly'] and not context['materializerLaunchedTests']
            assert Path(context['checkoutRoot']).is_absolute()
            for phase in ['before', 'after']:
                prefix = directory / 'runs' / f'{runtime}-{seed}' / phase
                contexts[str(prefix)] = (context, directory, context_path)
                prefixes.append(prefix)
    sha = lambda value: hashlib.sha256(value).hexdigest()
    artifacts = {}


    def read(path):
        path = Path(path)
        assert path.resolve().is_relative_to(artifact_root) or path.resolve().is_relative_to(payload.resolve())
        content = path.read_bytes()
        artifacts[str(path)] = sha(content)
        return json.loads(content)


    plan = read(plan_path)
    assert plan['configurationOnly'] is True and plan['patchTargets'] == {}
    assert plan['runtimeManifestPending'] is True and plan['caseCount'] is None
    assert plan['sourceCommitPending'] is False
    assert plan['expectedQualifiedCaseCount'] == 1669
    expected_skips = [{'file': 'src/main/runtime/orca-runtime.test.ts',
        'fullName': 'OrcaRuntimeService lists drive roots for a server-root browse',
        'title': 'lists drive roots for a server-root browse',
        'ancestorTitles': ['OrcaRuntimeService'], 'status': 'skipped'}]
    assert plan['sourceQualifiedOriginalSkippedCases'] == expected_skips
    assert len(plan['files']) == 22 and len(plan['timedFiles']) == 12
    assert plan['files'][:12] == plan['timedFiles']
    binding_file = plan['files'][-1]
    binding_title = 'keeps the public Zod entries bound to the same schema and configuration owners'
    assert binding_file.endswith('/zod-public-binding.fixture.test.ts')
    routes_path = payload / 'named-registry-source-routes.json'
    route_proof = read(routes_path)
    assert route_proof['sourceHead'] == plan['sourceHead']
    for file, digest in route_proof['sourceRegistryGuardHashes'].items():
        assert plan['sourceHashes'][file] == digest
    route_rows = route_proof['originalRoutes'] + [route_proof['bindingFixtureRoute']]
    expected_routes = {}
    for runtime in ['bun', 'node']:
        selected = [row for row in route_rows if row['file'] in plan['files']]
        assert len(selected) == 22
        expected_routes[runtime] = sorted([
            {'file': row['file'], **row[runtime + 'Coordinator']} for row in selected
        ], key=lambda row: row['file'])
    assert sum(row['project'] == 'node-runtime' and row['pool'] == 'node-runtime'
               for row in expected_routes['bun']) == 3
    assert sum(row['project'] == 'bun' and row['pool'] == 'forks'
               for row in expected_routes['bun']) == 19
    assert all(row['project'] == 'node' and row['pool'] == 'forks'
               for row in expected_routes['node'])
    assert set(plan['configurationByPhase']) == {'before', 'after'}
    for phase, arm in plan['configurationByPhase'].items():
        assert arm['sha256'] == plan['configurationSourceHashes'][arm['path']]
    manifest = read(payload / 'definition-manifest.json')
    assert manifest['sourceHead'] == plan['sourceHead']
    for name, digest in manifest['payloadSha256'].items():
        assert sha((payload / name).read_bytes()) == digest
        artifacts[str(payload / name)] = digest
    for file, digest in plan['configurationSourceHashes'].items():
        copied = payload / manifest['destinationToPayload'][file]
        assert sha(copied.read_bytes()) == digest
    setups = ['config/scripts/vitest-real-agent-home-write-guard.ts',
              'config/scripts/vitest-bun-node-builtins.ts',
              'config/scripts/happy-dom-offscreen-canvas.ts',
              'config/scripts/happy-dom-mutation-observer-retention.ts',
              'config/scripts/vitest-host-ports-setup.ts',
              'config/scripts/vitest-caller-identity-env-setup.ts']
    keys = ['name', 'pool', 'fsModuleCache', 'effectiveMaxWorkers', 'isolate',
            'testTimeout', 'hookTimeout', 'setups', 'execArgv']
    snapshots = []
    roots = {'before': set(), 'after': set()}
    for prefix in prefixes:
        context, directory, context_path = contexts[str(prefix)]
        artifacts[str(context_path)] = sha(context_path.read_bytes())
        assert context['planSha256'] == sha(plan_path.read_bytes())
        assert context['controllerSha256'] == plan['controllerCandidateSha256']
        for destination, name in manifest['destinationToPayload'].items():
            if destination.startswith(manifest['epochPath'] + '/'):
                copied = directory / destination.removeprefix(manifest['epochPath'] + '/')
                assert sha(copied.read_bytes()) == manifest['payloadSha256'][name]
        source = read(str(prefix) + '-source-proof.json')
        report = read(str(prefix) + '.json')
        details = read(str(prefix) + '-details.json')
        phase, runtime = source['phase'], source['runtime']
        assert phase in roots and runtime in ['bun', 'node']
        seed_args = [arg for arg in source['command'] if arg.startswith('--sequence.seed=')]
        assert len(seed_args) == 1
        seed = int(seed_args[0].split('=', 1)[1])
        assert seed in [104729, 130363]
        assert source['sourceUnchanged'] and source['before'] == source['after']
        fingerprint = source['before']
        assert fingerprint['head'] == plan['sourceHead']
        assert fingerprint['sourceHashes'] == plan['sourceHashes']
        assert fingerprint['diffSha256'] == sha(b'')
        assert fingerprint['patchSha256'] is None
        assert fingerprint['planSha256'] == context['planSha256']
        config_inputs = fingerprint['configurationInputs']
        assert config_inputs['armConfig'] == plan['configurationByPhase'][phase]
        assert config_inputs['sourceHashes'] == plan['configurationSourceHashes']
        assert config_inputs['controllerSha256'] == plan['controllerCandidateSha256']
        assert config_inputs['nativeCompileCacheAbsent'] is True
        raw_root = config_inputs['optimizerCacheRoot']
        cache_root = Path(raw_root)
        assert cache_root.is_absolute()
        expected_root = Path(context['checkoutRoot']) / plan['ownedCacheRootPrefix'] / f"{runtime}-{seed}" / (phase + '-cache')
        assert cache_root == expected_root and raw_root == context[phase + 'CacheRoot']
        roots[phase].add(cache_root)
        assert source['result'] == 0 and source['normalClose']
        assert not source['samplingErrors'] and not source['externalObserved']
        assert not source['postCloseCoordinators']
        assert source['samples'] and source['samples'][0] == [] and source['samples'][-1] == []
        assert all(row['owned'] for sample in source['samples'] for row in sample)
        launcher = 'config/scripts/run-vitest.mjs' if runtime == 'bun' else 'node_modules/vitest/vitest.mjs'
        command = ['pnpm', 'exec', 'node', launcher, 'run',
                   '--config=' + plan['configurationByPhase'][phase]['path']]
        command += plan['files'] + ['--maxWorkers=4', '--fsModuleCache=false',
            '--sequence.shuffle', '--sequence.seed=' + str(seed), '--reporter=json',
            '--reporter=./notes/bun-migration/performance/persistence-import-reuse-benchmark-reporter.mjs',
            '--outputFile=' + context[phase + 'Prefix'] + '.json']
        assert source['command'] == command
        log_path = Path(str(prefix) + '.log')
        log = log_path.read_bytes()
        artifacts[str(log_path)] = sha(log)
        assert not re.search(rb'Timeout terminating|failed to terminate.*worker|worker.*termination.*timed out|Unhandled Errors', log, re.I)
        assert report['success'] and not report['numFailedTests'] and not report['numFailedTestSuites']
        assert details['reason'] == 'passed' and not details['errors']
        assert details['rootFsModuleCache'] is False and details['rootIsolation'] is True
        assert details['resolvedRootMaxWorkers'] == 4
        case_map = {}
        for module in report['testResults']:
            name = module['name'].replace('\\', '/')
            matches = [file for file in plan['files'] if name == file or name.endswith('/' + file)]
            assert len(matches) == 1 and matches[0] not in case_map
            rows = [{key: case[key] for key in ['fullName', 'title', 'ancestorTitles', 'status']}
                    for case in module['assertionResults']]
            assert len({json.dumps(row, sort_keys=True) for row in rows}) == len(rows)
            case_map[matches[0]] = sorted(rows, key=lambda row: json.dumps(row, sort_keys=True))
        assert set(case_map) == set(plan['files'])
        assert case_map[binding_file] == [{'fullName': binding_title, 'title': binding_title,
                                          'ancestorTitles': [], 'status': 'passed'}]
        count = sum(len(rows) for rows in case_map.values())
        assert count == report['numTotalTests'] == plan['expectedQualifiedCaseCount']
        assert report['numPassedTests'] == count - 1
        assert report['numPendingTests'] == 1
        assert report['numTodoTests'] == 0
        nonpassed = [{'file': file, **row} for file, rows in case_map.items() for row in rows if row['status'] != 'passed']
        assert nonpassed == expected_skips, 'Only the exact source-qualified Windows-only skipped identity is allowed'
        routes = sorted([{key: module[key] for key in ['file', 'project', 'pool']}
                         for module in details['modules']], key=lambda row: row['file'])
        assert routes == expected_routes[runtime]
        assert all(not module.get('diagnostic', {}).get('errors') for module in details['modules'])
        config = sorted([{key: project[key] for key in keys} for project in details['projects']], key=lambda row: row['name'])
        assert [row['name'] for row in config] == (
            ['bun', 'node-measurement', 'node-runtime'] if runtime == 'bun' else ['node', 'node-measurement'])
        for row in config:
            assert row['fsModuleCache'] is False and row['isolate'] is True
            assert row['effectiveMaxWorkers'] == 4
            assert row['testTimeout'] == 30000 and row['hookTimeout'] == 60000
            assert row['setups'] == setups and row['execArgv'] == ['--no-experimental-webstorage', '--expose-gc']
        ordinary = next(row for row in config if row['name'] == runtime)
        assert ordinary['pool'] == 'forks'
        snapshots.append({'phase': phase, 'runtime': runtime, 'seed': seed,
                          'map': case_map, 'count': count, 'config': config,
                          'cacheRoot': raw_root, 'reportPrefix': str(prefix)})
    assert {(row['phase'], row['runtime'], row['seed']) for row in snapshots} == {
        (phase, runtime, seed) for phase in roots for runtime in ['bun', 'node']
        for seed in [104729, 130363]}
    assert len(snapshots) == 8
    assert all(row['map'] == snapshots[0]['map'] and row['count'] == snapshots[0]['count'] for row in snapshots)
    for runtime in ['bun', 'node']:
        configs = [row['config'] for row in snapshots if row['runtime'] == runtime]
        assert all(row == configs[0] for row in configs)
    for before in roots['before']:
        for after in roots['after']:
            assert not before.is_relative_to(after) and not after.is_relative_to(before), 'Arm cache roots overlap'
    artifacts[str(Path(__file__))] = sha(Path(__file__).read_bytes())
    result = {'broadCompatibilityQualified': True, 'sourceHead': plan['sourceHead'],
              'runtimeDerivedCaseCount': snapshots[0]['count'],
              'originalTwentyOneSuiteCaseCount': sum(len(snapshots[0]['map'][file]) for file in plan['files'][:-1]),
              'caseIdentityMapByFile': snapshots[0]['map'], 'snapshots': snapshots,
              'armCacheRootsDisjoint': True, 'artifactHashes': artifacts,
              'optimizedWorkerUseProven': False, 'coldCacheAbsenceProven': False,
              'performanceQualified': False, 'broadCiQualificationPending': False,
              'scope': 'Isolated21-suite compatibility plus binding only. Exact raw names/statuses/routes retained; worker-entry use and performance remain separate gates. Fresh-cache absence is guarded by materializer and workflow, not inferred from reporter.'}
    with output_path.open('x') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
    print(json.dumps({'broadCompatibilityQualified': True, 'cases': result['runtimeDerivedCaseCount'],
                      'output': str(output_path), 'optimizedWorkerUseProven': False}))
except Exception as error:
    rejection = {'broadCompatibilityQualified': False,
                 'errorType': type(error).__name__, 'error': str(error),
                 'artifactHashes': globals().get('artifacts', {}),
                 'performanceQualified': False,
                 'scope': 'Rejected or incomplete compatibility evidence; raw artifacts remain retained. Original failure is re-raised.'}
    try:
        with Path('zod-broad-result.json').open('x') as stream:
            json.dump(rejection, stream, indent=2)
            stream.write('\n')
    except OSError:
        pass
    raise
