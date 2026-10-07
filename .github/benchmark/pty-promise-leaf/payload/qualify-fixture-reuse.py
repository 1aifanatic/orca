import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

phase, runtime, plan_name, prefix, seed = sys.argv[1:]
assert phase in ['before', 'after'] and runtime in ['bun', 'node']
plan_path = Path(plan_name)
plan = json.loads(plan_path.read_text())
base = Path('notes/bun-migration/performance')
label = base / prefix
assert not Path(str(label) + '-source-proof.json').exists()
assert not Path(str(label) + '.json').exists()
sha = lambda value: hashlib.sha256(value).hexdigest()

def fingerprint():
    return {
        'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
        'diffSha256': sha(subprocess.check_output(['git', 'diff', '--binary', 'HEAD'])),
        'sourceHashes': {file: sha(Path(file).read_bytes()) for file in plan['sourceHashes']},
        'planSha256': sha(plan_path.read_bytes()),
        'patchSha256': sha(Path(plan['patch']).read_bytes())
    }

before = fingerprint()
assert before['head'] == plan['sourceHead']
expected = dict(plan['sourceHashes'])
targets = plan.get('patchTargets')
if targets is None:
    targets = {plan['timedFiles'][0]: {
        'beforeSha256': plan['sourceBeforeSha256'], 'afterSha256': plan['sourceAfterSha256']}}
assert isinstance(targets, dict) and targets, 'Require explicit reviewed patch targets'
for target, versions in targets.items():
    assert target in expected and set(versions) == {'beforeSha256', 'afterSha256'}
    assert versions['beforeSha256'] == expected[target], 'Target before hash differs from source guard'
    assert versions['beforeSha256'] != versions['afterSha256'], 'Only changed paths are patch targets'
    assert all(len(value) == 64 and all(char in '0123456789abcdef' for char in value)
               for value in versions.values()), 'Require exact SHA256 target guards'
    expected[target] = versions['beforeSha256'] if phase == 'before' else versions['afterSha256']
assert before['sourceHashes'] == expected, 'Qualification source differs from reviewed plan'
assert before['patchSha256'] == plan['patchSha256']
changed = sorted(subprocess.check_output(['git', 'diff', '--name-only', 'HEAD'], text=True).splitlines())
assert changed == ([] if phase == 'before' else sorted(targets)), 'Unrelated tracked changes in qualification'

def census(child):
    live_child_pid = child.pid if child is not None and child.poll() is None else None
    rows = []
    output = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,command='], text=True)
    for line in output.splitlines():
        fields = line.strip().split(None, 2)
        if len(fields) == 3:
            rows.append((int(fields[0]), int(fields[1]), fields[2]))
    parents = {pid: parent for pid, parent, command in rows}
    def owned(pid):
        visited = set()
        while live_child_pid is not None and pid > 1 and pid not in visited:
            if pid == live_child_pid:
                return True
            visited.add(pid)
            pid = parents.get(pid, 0)
        return False
    return [{'pid': pid, 'owned': owned(pid)} for pid, parent, command in rows
            if Path(command.split()[0]).name in ['node', 'bun']
            and any(token in command for token in ['vitest.mjs', 'run-vitest.mjs'])]

command = ['pnpm', 'test'] if runtime == 'bun' else ['pnpm', 'exec', 'node', 'node_modules/vitest/vitest.mjs', 'run', '--config=config/vitest.config.ts']
command += plan['files'] + ['--maxWorkers=4', '--fsModuleCache=false', '--sequence.shuffle', '--sequence.seed=' + seed,
                           '--reporter=json', '--reporter=./notes/bun-migration/performance/persistence-import-reuse-benchmark-reporter.mjs',
                           '--outputFile=' + str(label) + '.json']
env = dict(os.environ, ORCA_BACKGROUND_LAUNCH='1', ORCA_IMPORT_REUSE_DETAILS=str(label) + '-details.json')
samples = [census(None)]
if samples[0]:
    rejected = Path(str(label) + '-preflight-rejected-' + str(time.time_ns()) + '.json')
    with rejected.open('x') as stream:
        json.dump({'before': before, 'coordinators': samples[0], 'childStarted': False,
                   'reason': 'Another coordinator is active; no qualification launched'}, stream, indent=2)
    raise RuntimeError('Another coordinator is active; rejection retained in ' + str(rejected))
started = time.time()
sampling_errors = []
child = None
result = None
with Path(str(label) + '.log').open('xb') as stream:
    try:
        child = subprocess.Popen(command, stdout=stream, stderr=subprocess.STDOUT, env=env)
        while child.poll() is None:
            try:
                samples.append(census(child))
            except Exception as error:
                sampling_errors.append(str(error))
            time.sleep(5)
    except Exception as error:
        sampling_errors.append(str(error))
    finally:
        if child is not None:
            result = child.wait()
try:
    samples.append(census(child))
except Exception as error:
    sampling_errors.append(str(error))
try:
    after = fingerprint()
except Exception as error:
    after = {'error': str(error)}
proof = {'phase': phase, 'runtime': runtime, 'command': command, 'before': before, 'after': after,
         'result': result, 'seconds': time.time() - started, 'samples': samples, 'samplingErrors': sampling_errors,
         'sourceUnchanged': before == after, 'normalClose': result is not None and result >= 0,
         'externalObserved': any(not row['owned'] for sample in samples for row in sample),
         'postCloseCoordinators': samples[-1], 'scope': 'Correctness qualification only; polling overhead is not performance evidence; no signaling or cleanup.'}
Path(str(label) + '-source-proof.json').write_text(json.dumps(proof, indent=2) + '\n')
assert result == 0 and before == after and not sampling_errors
assert not proof['externalObserved'] and not samples[-1], 'Process guard failed; retained correctness evidence is not fully qualified'
print(json.dumps({'phase': phase, 'runtime': runtime, 'result': result, 'sourceUnchanged': True, 'processGuard': True}))
