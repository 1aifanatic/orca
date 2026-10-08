"""Snapshot a direct workflow CLI attempt; this adapter never launches a test."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

phase, label = sys.argv[1:]
assert phase in ['before', 'after']
directory = Path('notes/bun-migration/performance/bun-native-five-pure-guard-ci-0bd619-explicit-files')
manifest = json.loads((directory / 'definition-manifest.json').read_text())
entries = [row for row in manifest['nativeCommands'] if row['label'] == label]
assert len(entries) == 1
entry = entries[0]
sha = lambda value: hashlib.sha256(value).hexdigest()
expected = dict(manifest['sourceHashes'])
if entry['phase'] == 'after':
    plan = json.loads((directory / 'shipping-launch-plan.json').read_text())
    expected.update({file: versions['afterSha256'] for file, versions in plan['patchTargets'].items()})
source = {file: sha(Path(file).read_bytes()) for file in expected}
for name, key in manifest['payloadToHashKey'].items():
    destination = next(path for path, owned in manifest['destinationToPayload'].items() if owned == name)
    assert sha(Path(destination).read_bytes()) == manifest['payloadSha256'][key]
assert source == expected
installed_owners = {file: sha(Path(file).read_bytes()) for file in manifest['installedOwnerHashes']}
assert installed_owners == manifest['installedOwnerHashes']
for file, digest in manifest['nativeFixtures'].items():
    assert sha((directory / 'fixtures' / file).read_bytes()) == digest
assert os.environ['ORCA_BACKGROUND_LAUNCH'] == '1'
assert os.environ['ORCA_TEST_NODE_EXECUTABLE']
assert os.environ['ORCA_TEST_NODE_VERSION'] == '24.21.0'
for name in ['NODE_OPTIONS', 'BUN_OPTIONS', 'BUN_INSPECT_PRELOAD', 'ORCA_VITEST_RUNTIME', 'ORCA_BALANCE_UNIT_SHARDS']:
    assert os.environ.get(name) is None
assert not [name for name in os.environ if name.startswith('BUN_TEST_')]
git_environment = dict(os.environ, GIT_NO_LAZY_FETCH='1', GIT_OPTIONAL_LOCKS='0')
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True, timeout=20, env=git_environment).strip()
assert head == manifest['sourceHead']
changed = sorted(subprocess.check_output(['git', 'diff', '--name-only', 'HEAD'], text=True, timeout=20, env=git_environment).splitlines())
plan = json.loads((directory / 'shipping-launch-plan.json').read_text())
assert changed == ([] if entry['phase'] == 'before' else sorted(plan['patchTargets']))
diff_sha = sha(subprocess.check_output(['git', 'diff', '--binary', 'HEAD'], timeout=20, env=git_environment))
processes = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,command='], text=True, timeout=20)
coordinators = [line for line in processes.splitlines()
                if ('vitest.mjs' in line or 'run-vitest.mjs' in line or '--test-worker' in line or 'bun test ' in line)
                and Path(line.strip().split(None, 2)[-1].split()[0]).name in ['node', 'bun']]
assert not coordinators, 'Previous coordinator/worker still active'
path = directory / 'native' / (label + '-before.json')
record = {'source': source, 'installedOwnerHashes': installed_owners, 'head': head, 'diffSha256': diff_sha, 'planSha256': sha((directory / 'definition-manifest.json').read_bytes()),
          'entry': entry, 'argv': [os.environ['NATIVE_BUN_EXECUTABLE'], *entry['argv']],
          'bunExecutableSha256': sha(Path(os.environ['NATIVE_BUN_EXECUTABLE']).read_bytes()),
          'nodeExecutable': os.environ['ORCA_TEST_NODE_EXECUTABLE'],
          'nodeVersion': os.environ['ORCA_TEST_NODE_VERSION'],
          'coordinators': coordinators, 'processCensusRaw': processes,
          'createdUserdataInventory': sorted(str(p) for p in Path(tempfile.gettempdir()).glob('orca-vitest-userdata-*')),
          'timeNs': time.time_ns(), 'sourcePhase': entry['phase']}
if phase == 'before':
    with path.open('x') as stream:
        stream.write(json.dumps(record, indent=2) + '\n')
else:
    before = json.loads(path.read_text())
    assert {key: before[key] for key in ['source', 'installedOwnerHashes', 'head', 'diffSha256', 'planSha256', 'entry', 'argv', 'nodeExecutable', 'nodeVersion', 'sourcePhase', 'bunExecutableSha256']} == {key: record[key] for key in ['source', 'installedOwnerHashes', 'head', 'diffSha256', 'planSha256', 'entry', 'argv', 'nodeExecutable', 'nodeVersion', 'sourcePhase', 'bunExecutableSha256']}
    record['exitCode'] = int(os.environ['NATIVE_EXIT_CODE'])
    assert 0 <= record['exitCode'] < 128, 'Signal termination is not an expected probe failure'
    record['elapsedSeconds'] = (record['timeNs'] - before['timeNs']) / 1_000_000_000
    record['newUserdataLeftAfterExit'] = sorted(set(record['createdUserdataInventory']) - set(before['createdUserdataInventory']))
    with (directory / 'native' / (label + '-after.json')).open('x') as stream:
        stream.write(json.dumps(record, indent=2) + '\n')
