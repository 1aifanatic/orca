"""Validate preserved workload and raw CPU sampling; never qualify performance."""
import hashlib
import json
import math
import os
import re
import sys
from collections import Counter
from pathlib import Path

artifact_root, payload_root, output_path = map(Path, sys.argv[1:])
assert not output_path.exists(), 'Never overwrite an observation'
sha = lambda value: hashlib.sha256(value).hexdigest()


def validate():
    hashes = {}

    def read(path):
        data = path.read_bytes()
        hashes[str(path)] = sha(data)
        return json.loads(data)

    trusted = read(payload_root / 'measurement-plan.json')
    plans = list(artifact_root.rglob('measurement-plan.json'))
    assert len(plans) == 1
    plan = read(plans[0])
    context = plan.pop('ciScope')
    assert plan == trusted, 'Materialized plan must match the reviewed definition'
    assert context == {
        'runId': os.environ['GITHUB_RUN_ID'],
        'runAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
        'definitionSha': os.environ['GITHUB_SHA'],
        'actualSourceSha': os.environ['BENCH_SOURCE_SHA'],
        'isolatedRunner': 'ubuntu-24.04-arm',
        'requestedWorkers': 4, 'shards': 1,
        'purpose': 'observational CPU sampling only; no timing claim'
    }
    assert plan['sourceSha'] == context['actualSourceSha']
    baseline_path = payload_root / 'unprofiled-case-proof.json'
    assert sha(baseline_path.read_bytes()) == plan['caseCountProvenance']['proofSha256']
    baseline = read(baseline_path)
    assert baseline['sourceFileSha256'] == plan['expectedTargetSha256']
    assert baseline['caseCount'] == 112 and baseline['rawCaseMultisetIdenticalAllThreeRounds']
    manifest = read(plans[0].parent / 'current-main-manifest.json')
    assert manifest == read(payload_root / 'current-main-manifest.json')
    assert manifest['files'] == [plan['expectedTargetFile']]
    assert len(manifest['fullFiles']) == plan['fullDiscoveryPhysicalFiles']
    summary_paths = list(artifact_root.rglob('*-summary.json'))
    assert len(summary_paths) == 1
    summary_path = summary_paths[0]
    summary = read(summary_path)
    prefix = str(summary_path)[:-len('-summary.json')]
    report = read(Path(prefix + '.json'))
    details = read(Path(prefix + '-details.json'))
    log = Path(prefix + '.log').read_bytes()
    hashes[prefix + '.log'] = sha(log)
    assert summary['ciScope'] == context
    assert summary['observationalQualified'] is True
    assert summary['qualified'] is True
    assert summary['result'] == {'code': 0, 'signal': None}
    expected_label = summary['sourceRoot'] + '/notes/bun-migration/performance/' + plan['label'] + '-shard-1-four-0'
    assert summary['command'] == ['pnpm', 'test', '--shard=1/1', '--fsModuleCachePath=' + summary['sourceRoot'] + '/' + plan['cacheDirectory'] + '/shard-1/four', '--maxWorkers=4', '--reporter=default', '--reporter=json', '--reporter=./notes/bun-migration/performance/persistence-import-reuse-benchmark-reporter.mjs', '--outputFile=' + expected_label + '.json']
    assert summary.get('launchError') is None
    assert summary['before'] == summary['after']
    assert summary['before']['head'] == plan['sourceSha']
    assert summary['before']['installedOwnerHashes'] == plan['installedOwnerHashes']
    assert summary['before']['reporterSha256'] == plan['payloadSha256']['persistence-import-reuse-benchmark-reporter.mjs']
    assert summary['before']['diffSha256'] == sha(b'')
    assert summary['before']['harnessSha256'] == plan['payloadSha256']['benchmark-matched-shard.mjs']
    materialized_plan_bytes = plans[0].read_bytes()
    assert summary['before']['planSha256'] == sha(materialized_plan_bytes)
    assert summary['casePlanSha256'] == sha(materialized_plan_bytes)
    for key in ['caseParity', 'assignmentParity', 'projectSignatureParity', 'filesEqual',
                'cacheEnabled', 'setupPreserved', 'caseCountsPreserved', 'routePreserved',
                'isolationPreserved', 'workerCapPreserved', 'sourceUnchanged', 'noiseGuardAvailable']:
        assert summary[key] is True, key
    assert summary['normalizationError'] is None
    assert not summary['external'] and not summary['lifecycleError']
    assert not summary['lingeringCoordinators']
    assert summary['samples'] and all(not sample.get('error') for sample in summary['samples'])
    assert all(sample['noiseGuardAvailable'] for sample in summary['samples'])
    assert all(row['owned'] for sample in summary['samples'] for row in sample['coordinators'])
    assert summary['samples'][0]['coordinators'] == summary['samples'][-1]['coordinators'] == []
    assert not re.search(rb'Timeout terminating|failed to terminate.*worker|worker.*termination.*timed out|Unhandled Errors', log, re.I)
    host = summary['host']
    assert host['platform'] == 'linux' and host['arch'] == 'arm64'
    assert host['nodeVersion'] == plan['nodeVersion'] == '24.21.0'
    assert host['vitestVersion'] == plan['vitestVersion'] == '5.0.3'
    assert host['bunRevision'].startswith(plan['bunVersion'] + '+')
    assert report['success'] and report['numTotalTests'] == report['numPassedTests'] == 112
    assert report['numFailedTests'] == report['numPendingTests'] == 0
    assert not report.get('numTodoTests', 0)
    assert not report['numFailedTestSuites']
    assert len(report['testResults']) == 1
    module = report['testResults'][0]
    assert module['status'] == 'passed'
    target = plan['expectedTargetFile']
    assert module['name'].replace('\\', '/').endswith('/' + target)
    raw = [{**{key: case[key] for key in ['fullName', 'title', 'ancestorTitles', 'status']},
            'file': target} for case in module['assertionResults']]
    normalize = lambda rows: sorted(rows, key=lambda row: json.dumps(row, sort_keys=True))
    assert normalize(raw) == normalize(plan['expectedRawCaseIdentities'])
    assert normalize(summary['rawIdentities']) == normalize(raw)
    assert normalize(summary['identities']) == normalize(raw)
    assert details['reason'] == 'passed' and not details['errors']
    assert details['rootFsModuleCache'] is True and details['rootIsolation'] is True
    assert details['resolvedRootMaxWorkers'] == 4
    assert len(details['modules']) == 1
    route = details['modules'][0]
    assert {key: route[key] for key in ['file', 'project', 'pool']} == {'file': target, 'project': 'bun', 'pool': 'forks'}
    assert not route.get('diagnostic', {}).get('errors')
    assert sorted(project['name'] for project in details['projects']) == ['bun', 'node-measurement', 'node-runtime']
    for project in details['projects']:
        assert project['fsModuleCache'] is True and project['isolate'] is True
        assert project['effectiveMaxWorkers'] == 4
        assert project['setups'] == plan['expectedSetups']
        assert project['execArgv'] == plan['expectedExecArgv']
        assert project['testTimeout'] == 30000 and project['hookTimeout'] == 60000
    expected_profile_directory = summary['sourceRoot'] + '/' + plan['profileDirectory']
    assert summary['cpuProfileEnvironment'] == {'BUN_CPU_PROFILE': '1', 'BUN_CPU_PROFILE_DIR': expected_profile_directory}
    profile_root = plans[0].parent / 'owned-cpu-profiles'
    assert profile_root.is_dir() and not profile_root.is_symlink()
    profiles = sorted(profile_root.rglob('*.cpuprofile'))
    assert profiles, 'No CPU profiles were preserved'
    raw_inventory = []
    for file in sorted(profile_root.rglob('*')):
        assert not file.is_symlink(), 'Owned profiles may not follow symlinks'
        if file.is_file():
            data = file.read_bytes()
            raw_inventory.append({'path': str(file), 'bytes': len(data), 'sha256': sha(data)})
    observations = []
    target_sample_count = 0
    for file in profiles:
        profile = read(file)
        nodes, samples, deltas = profile['nodes'], profile['samples'], profile['timeDeltas']
        assert isinstance(nodes, list) and isinstance(samples, list) and isinstance(deltas, list)
        assert nodes and len(samples) == len(deltas)
        ids = [node['id'] for node in nodes]
        assert all(isinstance(value, int) and not isinstance(value, bool) for value in ids)
        assert len(ids) == len(set(ids))
        by_id = {node['id']: node for node in nodes}
        assert all(value in by_id for value in samples)
        assert all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 for value in deltas)
        assert math.isfinite(profile['startTime']) and math.isfinite(profile['endTime'])
        assert profile['endTime'] >= profile['startTime']
        parents = {}
        for node in nodes:
            for child in node.get('children', []):
                assert child in by_id and child not in parents
                parents[child] = node['id']
        target_ids = {node['id'] for node in nodes if target in node['callFrame'].get('url', '').replace('\\', '/')}
        target_samples = 0
        for sample in samples:
            seen = set()
            current = sample
            while current is not None:
                assert current not in seen, 'CPU profile call tree has a cycle'
                seen.add(current)
                if current in target_ids:
                    target_samples += 1
                    break
                current = parents.get(current)
        target_sample_count += target_samples
        counts = Counter(samples)
        observations.append({
            'path': str(file), 'sha256': hashes[str(file)], 'sampleCount': len(samples),
            'targetFrameIds': sorted(target_ids), 'samplesWithTargetInStack': target_samples,
            'rawDeltaMaximumMicroseconds': max(deltas),
            'rawGapsOver5000Microseconds': sum(delta > 5000 for delta in deltas),
            'rawDeltaSumMicroseconds': sum(deltas),
            'unweightedTopNodes': [{'nodeId': node_id, 'sampleHits': count,
                                   'callFrame': by_id[node_id]['callFrame']}
                                  for node_id, count in counts.most_common(40)]
        })
    assert target_sample_count > 0, 'Coordinator-only profiles do not establish replay attribution'
    return {'observationComplete': True, 'performanceQualified': False, 'qualified': False,
            'sourceHead': plan['sourceSha'], 'definitionSha': context['definitionSha'],
            'caseCount': 112, 'originalRawCaseMap': normalize(raw), 'route': route,
            'targetSamplesAcrossProfiles': target_sample_count,
            'rawProfileInventory': raw_inventory, 'profiles': observations,
            'artifactHashes': hashes,
            'interpretation': 'Unweighted sample-hit descriptions only. All raw samples/timeDeltas retained. Bun1.4.2 issue44077 can charge idle gaps to JavaScript frames; neither deltas nor hits establish exclusive CPU or wall savings.',
            'scope': 'One unchanged replay-file CPU diagnostic; no optimization, benchmark, full-suite or adoption claim.'}


try:
    result = validate()
except Exception as error:
    try:
        with output_path.open('x') as stream:
            stream.write(json.dumps({'observationComplete': False, 'qualified': False,
                                     'performanceQualified': False, 'error': str(error)}, indent=2) + '\n')
    except OSError:
        pass
    raise
with output_path.open('x') as stream:
    stream.write(json.dumps(result, indent=2) + '\n')
