"""Read preserved diagnostic evidence; never launch a process or qualify a failed case."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys

root, payload, output = map(Path, sys.argv[1:])
assert not output.exists(), 'Never overwrite a diagnostic attempt'
sha = lambda data: hashlib.sha256(data).hexdigest()
hashes = {}
result = {'diagnosticEvidenceQualified': False, 'caseQualificationPassed': False, 'errors': [], 'productionOrFixtureFixProven': False, 'performanceClaim': False}

def read(path):
    data = path.read_bytes()
    hashes[str(path)] = sha(data)
    return json.loads(data)

try:
    manifest = read(payload / 'definition-manifest.json')
    context = read(root / 'ci-context.json')
    command = read(root / 'command-result.json')
    report = read(root / 'report.json')
    details = read(root / 'report-details.json')
    assert manifest['sourceHead'] == context['sourceSha'] == command['sourceSha'] == os.environ['WRITER_DIAGNOSTIC_SOURCE_SHA']
    assert context['sourceParents'] == manifest['sourceParents']
    assert context['sourceCheckoutPolicy'] == 'Explicit CI-only core.autocrlf=false before both checkouts'
    assert context['definitionSha'] == os.environ['GITHUB_SHA']
    assert context['runId'] == os.environ['GITHUB_RUN_ID'] and context['runAttempt'] == os.environ['GITHUB_RUN_ATTEMPT']
    assert context['platform'] == 'win32' and context['arch'] == 'x64' and context['background'] == '1'
    assert context['nodeVersion'] == manifest['expectedCiPins']['node'] == '24.21.0'
    assert context['vitestVersion'] == manifest['expectedCiPins']['vitest'] == '5.0.3'
    assert context['electronVersion'] == manifest['expectedCiPins']['electron'] == '43.7.5'
    assert context['manifestSha256'] == sha((payload / 'definition-manifest.json').read_bytes())
    assert context['sourceHashes'] == manifest['sourceHashes']
    assert context['reporterSha256'] == manifest['reporterSha256'] == '2d2b20c3b06cc11c28650496a48ae525903e4fc43d4306aad5405e85f086e76e'
    assert context['targetAfterSha256'] == command['targetAfterSha256'] == manifest['targetAfterSha256']
    assert command['sourceUnchanged'] and command['normalForegroundCommandReturnObserved']
    assert not command['processTreeAbsenceClaim'] and not command['newCleanupSignals']
    assert command['diffSha256'] == context['diffSha256']
    assert context['diagnosticOnlyNeverMerge'] and not context['testsLaunchedByMaterializer']
    expected_args = ['exec', 'vitest', 'run', '--config', 'config/vitest.config.ts', *manifest['files'], '--reporter=default', '--reporter=json', '--reporter=./' + manifest['isolatedDirectory'] + '/persistence-import-reuse-benchmark-reporter.mjs', '--outputFile=' + manifest['isolatedDirectory'] + '/report.json']
    assert context['commandArgs'] == expected_args
    for name, expected in manifest['payloadSha256'].items():
        assert sha((payload / name).read_bytes()) == expected
        assert (root / name).read_bytes() == (payload / name).read_bytes()
    assert details['errors'] == []
    assert details['projects'] and all(project['name'] == 'node' and project['pool'] == 'forks' for project in details['projects'])
    assert all(project['isolate'] is True and len(project['setups']) == 6 for project in details['projects'])
    assert sorted(module['file'] for module in details['modules']) == sorted(manifest['files'])
    assert all(module['project'] == 'node' and module['pool'] == 'forks' and not module.get('diagnostic', {}).get('errors') for module in details['modules'])
    assert len(report['testResults']) == manifest['existingStockObservation']['physicalFiles'] == 60
    identities = []
    observed_files = []
    for module in report['testResults']:
        physical = [file for file in manifest['files'] if module['name'].replace('\\', '/').endswith('/' + file)]
        assert len(physical) == 1
        observed_files.append(physical[0])
        for assertion in module['assertionResults']:
            assert assertion['status'] in ['passed', 'failed', 'skipped']
            identities.append({'file': physical[0], **{key: assertion[key] for key in ['title', 'fullName', 'ancestorTitles', 'status']}})
    assert sorted(observed_files) == sorted(manifest['files'])
    assert len(identities) == report['numTotalTests'] == manifest['existingStockObservation']['testCases'] == 592
    counts = {status: sum(case['status'] == status for case in identities) for status in ['passed', 'failed', 'skipped']}
    assert counts['passed'] == report['numPassedTests'] and counts['failed'] == report['numFailedTests']
    assert counts['skipped'] == report['numPendingTests'] == manifest['existingStockObservation']['skipped'] == 53
    assert not report.get('numTodoTests', 0)
    assert details['reason'] == ('failed' if counts['failed'] else 'passed')
    assert command['exitCode'] in [0, 1]
    assert report['success'] == (counts['failed'] == 0) == (command['exitCode'] == 0)
    log = (root / 'command.log').read_bytes()
    hashes[str(root / 'command.log')] = sha(log)
    assert not re.search(rb'Unhandled Errors|Timeout terminating|failed to terminate.*worker|worker.*termination.*timed out', log, re.I)
    clean_log = re.sub(rb'\x1b\[[0-9;]*m', b'', log).decode('utf-8-sig')
    observations = [json.loads(match.group(1)) for match in re.finditer(r'PROFILE_STATE_WRITER_STALL_DIAGNOSTIC\s+(\{[^\r\n]*\})', clean_log)]
    if counts['failed']:
        assert counts['failed'] == 1 and counts['passed'] == 538
        failed = next(case for case in identities if case['status'] == 'failed')
        assert failed['file'] == manifest['existingStockObservation']['failureFile']
        assert failed['title'] == failed['fullName'] == manifest['existingStockObservation']['failureTitle']
        assert failed['ancestorTitles'] == []
        assert len(observations) == 1, 'Require the actual request-level failure capture'
        observation = observations[0]
        assert observation['timeoutMs'] == 2000 and observation['electron'] == '43.7.5'
        assert isinstance(observation['node'], str) and observation['node']
        assert observation['workerStarts'] == 1 and isinstance(observation['queuedReplies'], int)
        timeouts = [crumb['data'] for crumb in observation['writerBreadcrumbs'] if crumb['name'] == 'profile_state_writer_timeout']
        assert len(timeouts) == 1
        timeout = timeouts[0]
        for key in ['requestId', 'acknowledgedRevision', 'timeoutMs', 'elapsedMs', 'overdueMs', 'graces']:
            assert isinstance(timeout[key], int) and timeout[key] >= 0
        assert timeout['timeoutMs'] == 2000 and timeout['command'] in ['write-domains', 'close']
        assert timeout['powerState'] in ['awake', 'suspended']
        result['disposition'] = 'Actual original request timeout reproduced with failure-only observations; original case remains failed.'
        result['observedFailure'] = observation
        result['timeoutBreadcrumb'] = timeout
        result['orderingOrHostLoadCauseProven'] = False
    else:
        assert counts['passed'] == 539 and not observations
        result['disposition'] = 'All original cases passed; the old failure was not reproduced. Diagnostics are not a fix.'
        result['caseQualificationPassed'] = True
    result.update({'diagnosticEvidenceQualified': True, 'sourceHead': context['sourceSha'], 'definitionHead': context['definitionSha'], 'runId': context['runId'], 'runAttempt': context['runAttempt'], 'rawCaseIdentities': identities, 'caseCounts': counts, 'observations': observations, 'context': context, 'configAndRoutes': details, 'scope': 'One new-source isolated Windows stock60-file native workload. Same2000ms/four real stalls/all original assertions; original failed run retained, no retries/deadline changes/normalization. No full-process-tree absence or cause proof.'})
except Exception as error:
    result['errors'].append(type(error).__name__ + ': ' + str(error))
    result['artifactHashes'] = hashes
    try:
        with output.open('x') as stream: stream.write(json.dumps(result, indent=2) + '\n')
    except OSError:
        pass
    raise
result['artifactHashes'] = hashes
with output.open('x') as stream: stream.write(json.dumps(result, indent=2) + '\n')
print(json.dumps({'diagnosticEvidenceQualified': result['diagnosticEvidenceQualified'], 'caseQualificationPassed': result['caseQualificationPassed'], 'disposition': result['disposition']}))
