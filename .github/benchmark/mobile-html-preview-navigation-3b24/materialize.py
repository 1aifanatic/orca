"""Source-bound rig materialization and completion receipts; launches no tests."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

phase, arm, *code = sys.argv[1:]
assert phase in ['before', 'after'] and arm in ['original', 'candidate']
payload = Path(__file__).resolve().parent / 'payload'
sha = lambda data: hashlib.sha256(data).hexdigest()
manifest_bytes = (payload / 'definition-manifest.json').read_bytes()
m = json.loads(manifest_bytes)
assert os.environ['GITHUB_ACTIONS'] == 'true' and os.environ['ORCA_BACKGROUND_LAUNCH'] == '1'
assert os.environ['MOBILE_NAVIGATION_SOURCE_SHA'] == m['sourceHead']
for key in ['NODE_OPTIONS', 'NODE_COMPILE_CACHE', 'NODE_DISABLE_COMPILE_CACHE', 'ORCA_VITEST_RUNTIME', 'ORCA_BALANCE_UNIT_SHARDS']:
    assert key not in os.environ, key

def git(*args):
    r = subprocess.run(['git', *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       timeout=20, env=dict(os.environ, GIT_NO_LAZY_FETCH='1', GIT_OPTIONAL_LOCKS='0'))
    return r.stdout

assert git('rev-parse', 'HEAD').decode().strip() == m['sourceHead']
assert git('config', '--get', 'core.autocrlf').decode().strip() == 'false'
assert sys.platform == 'linux' and os.uname().machine == 'x86_64'
node = subprocess.run(['node', '--version'], check=True, capture_output=True, timeout=20).stdout.decode().strip()
assert node == 'v' + m['expectedPins']['node']
for package, key in [('vitest', 'vitest'), ('playwright-core', 'playwright')]:
    assert json.loads(Path('node_modules', package, 'package.json').read_text())['version'] == m['expectedPins'][key]
for file, expected in m['installedPlaywrightOwnerHashes'].items():
    assert sha(Path(file).read_bytes()) == expected, file
webkit_owner = next(b for b in json.loads(Path('node_modules/playwright-core/browsers.json').read_text())['browsers'] if b['name'] == 'webkit')
assert webkit_owner['browserVersion'] == m['expectedWebKit']['browserVersion'] and webkit_owner['revision'] == m['expectedWebKit']['revision']
chrome = os.environ['ORCA_MOBILE_WEB_RENDER_BROWSER']
assert Path(chrome).is_absolute()
chrome_version = subprocess.run([chrome, '--version'], check=True, capture_output=True, timeout=20).stdout.decode().strip()
assert chrome_version.split()[-1] == m['expectedBrowser'], chrome_version
selection_path = Path('mobile-navigation-browser-selection.json')
selection_bytes = selection_path.read_bytes()
selection = json.loads(selection_bytes)
assert selection['accepted'] is True and selection['error'] is None and selection['exitCode'] == 0
assert selection['sourceSha'] == m['sourceHead'] and selection['definitionSha'] == os.environ['GITHUB_SHA']
assert selection['runId'] == os.environ['GITHUB_RUN_ID'] and selection['runAttempt'] == os.environ['GITHUB_RUN_ATTEMPT']
assert selection['executable'] == chrome and selection['argv'] == [chrome, '--version']
assert selection['expectedVersion'] == selection['parsedVersion'] == m['expectedBrowser']
assert selection['stdout'].strip() == chrome_version
for file, expected in m['payloadSha256'].items():
    assert sha((payload / file).read_bytes()) == expected
root = Path(m['isolatedDirectory'])
run = root / arm
wanted_after = arm == 'candidate' and (phase == 'after' or (root / 'candidate-applied.json').exists())
for file, expected in m['sourceHashes'].items():
    wanted = m['targets'][file]['afterSha256'] if wanted_after and file in m['targets'] else expected
    assert sha(Path(file).read_bytes()) == wanted, file
if phase == 'before':
    assert not run.exists(), 'Preserve every attempt exclusively'
    if arm == 'original':
        assert git('diff', '--name-only', 'HEAD') == b''
        assert not root.exists()
        root.mkdir(parents=True)
        for file in ['definition-manifest.json', *m['payloadSha256']]:
            destination = root / file
            with destination.open('xb') as f:
                f.write((payload / file).read_bytes())
    else:
        assert (root / 'original' / 'command-result.json').exists()
        assert git('diff', '--name-only', 'HEAD') == b''
        git('apply', '--check', str(root / 'shipping.patch'))
        git('apply', str(root / 'shipping.patch'))
        for file, expected in m['sourceHashes'].items():
            wanted = m['targets'][file]['afterSha256'] if file in m['targets'] else expected
            assert sha(Path(file).read_bytes()) == wanted, file
        (root / 'candidate-applied.json').write_text(json.dumps({'targets': m['targets']}) + '\n')
    expected_changed = sorted(m['targets']) if arm == 'candidate' else []
    assert sorted(git('diff', '--name-only', 'HEAD').decode().splitlines()) == expected_changed
    run.mkdir()
    command_args = ['exec', 'vitest', 'run', '--config', 'config/vitest.config.ts', m['testFile'],
                    '--testNamePattern=' + m['testNamePattern'], '--reporter=default', '--reporter=json',
                    '--reporter=./' + m['isolatedDirectory'] + '/persistence-import-reuse-benchmark-reporter.mjs',
                    '--outputFile=' + str(run / 'report.json')]
    context = {'sourceSha': m['sourceHead'], 'definitionSha': os.environ['GITHUB_SHA'],
               'runId': os.environ['GITHUB_RUN_ID'], 'runAttempt': os.environ['GITHUB_RUN_ATTEMPT'],
               'arm': arm, 'platform': 'linux', 'arch': 'x64', 'nodeVersion': node[1:],
               'browserExecutable': chrome, 'browserVersionOutput': chrome_version,
               'browserSelectionReceiptSha256': sha(selection_bytes),
               'expectedPins': m['expectedPins'], 'installedPlaywrightOwnerHashes': m['installedPlaywrightOwnerHashes'], 'manifestSha256': sha(manifest_bytes),
               'sourceHashes': m['sourceHashes'], 'targets': m['targets'], 'commandArgs': command_args,
               'diffSha256': sha(git('diff', '--binary', 'HEAD')), 'background': '1',
               'testsLaunchedByMaterializer': False, 'noPriorCommandDiscarded': True}
    (run / 'ci-context.json').write_text(json.dumps(context, indent=2) + '\n')
else:
    assert len(code) == 1 and code[0].isdigit()
    context = json.loads((run / 'ci-context.json').read_text())
    assert sha(git('diff', '--binary', 'HEAD')) == context['diffSha256']
    receipt = {'exitCode': int(code[0]), 'sourceUnchanged': True, 'normalForegroundReturnObserved': True,
               'sourceSha': m['sourceHead'], 'arm': arm, 'diffSha256': context['diffSha256'],
               'newCleanupSignals': False, 'processTreeAbsenceClaim': False}
    with (run / 'command-result.json').open('x') as f:
        json.dump(receipt, f, indent=2)
        f.write('\n')
