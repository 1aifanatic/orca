"""One source-pinned checker-count trial; no tests or configurable runner."""
import hashlib, json, math, os, pathlib, re, subprocess, sys, time, traceback
from collections import Counter

payload = pathlib.Path(sys.argv[1]).resolve()
evidence = pathlib.Path(sys.argv[2]).resolve()
assert len(sys.argv) == 3 and not evidence.exists()
evidence.mkdir()
manifest = json.loads((payload / 'manifest.json').read_text())
root = pathlib.Path.cwd().resolve()
sha = lambda data: hashlib.sha256(data).hexdigest()
write = lambda path, value: path.write_text(json.dumps(value, indent=2) + '\n') if not path.exists() else (_ for _ in ()).throw(AssertionError('No overwrite'))
run = lambda args: subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=20)
source = manifest['sourceHead']
assert run(['git','rev-parse','HEAD']).stdout.decode().strip() == source
assert run(['git','diff','--binary','HEAD']).stdout == b''
assert run(['git','status','--porcelain=v1','--untracked-files=no']).stdout == b''
for name, expected in manifest['sourceHashes'].items():
    assert sha((root / name).read_bytes()) == expected, name
for name in manifest['sourceAbsentPaths']: assert not (root/name).exists(), name
for name, expected in manifest['payloadHashes'].items():
    assert sha((payload / name).read_bytes()) == expected, name
assert json.loads((root/'node_modules/typescript/package.json').read_text())['version'] == '7.0.2'
assert json.loads((root/'node_modules/typescript-api/package.json').read_text())['version'] == '6.0.3'
configs = manifest['configs']
cache_names = manifest['buildinfoNames']
assert sorted(p.name for p in (root/'config').glob('*.tsbuildinfo')) == [], 'No hidden pre-timing seed'
negative = root / manifest['negativeFixture']
assert not negative.exists()
node_context = r"import {totalmem,availableParallelism} from 'node:os'; import {TYPECHECK_PROJECTS,admissibleHeapGib,planTypecheckBatches} from './config/scripts/run-typecheck-projects-in-parallel.mjs'; console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,parallelism:availableParallelism(),memory:totalmem(),projects:TYPECHECK_PROJECTS,batches:planTypecheckBatches(TYPECHECK_PROJECTS,{budgetGib:admissibleHeapGib(totalmem()),parallelism:availableParallelism()})}))"
context = json.loads(run(['node','--input-type=module','-e',node_context]).stdout)
assert context['node'] == 'v24.21.0' and context['platform'] == 'linux' and context['arch'] == 'arm64' and context['parallelism'] == 4
assert [[p['config'] for p in batch] for batch in context['batches']] == [[configs[0],configs[2]],[configs[1]]]
assert context['projects'] == manifest['projects']
assert run(['pnpm','--version']).stdout.decode().strip() == '12.8.1'
assert run(['bun','--revision']).stdout.decode().strip() == '1.4.2+744846f84'
assert len(os.environ['TRIAL_DEFINITION_SHA']) == 40 and os.environ['GITHUB_RUN_ID'].isdigit() and os.environ['GITHUB_RUN_ATTEMPT'].isdigit()
assert context['memory'] / 1024**3 >= 14 and context['memory'] / 1024**3 <= 18
native_context = json.loads(run(['node','--input-type=module','-e',"import getExePath from './node_modules/typescript/lib/getExePath.js'; console.log(JSON.stringify({node:process.execPath,native:getExePath()}))"]).stdout)
installed = {}
for name, expected in manifest['installedCommonHashes'].items():
    assert sha((root/name).read_bytes()) == expected, name
    installed[name] = expected
native_path = pathlib.Path(native_context['native']).resolve()
assert native_path.is_file() and native_path.is_relative_to((root/'node_modules').resolve())
native_package = json.loads((native_path.parent.parent/'package.json').read_text())
assert native_package['name'] == '@typescript/typescript-linux-arm64' and native_package['version'] == '7.0.2'
native_context.update({'package':native_package['name'],'version':native_package['version'],'packageSha256':sha((native_path.parent.parent/'package.json').read_bytes())})
installed[native_context['native']] = sha(pathlib.Path(native_context['native']).read_bytes())
context.update({'nativeExecutable':native_context,'installedHashes':installed,'manifestSha256':sha((payload/'manifest.json').read_bytes()),'sourceHead':source,'definitionSha':os.environ['TRIAL_DEFINITION_SHA'],'runId':os.environ['GITHUB_RUN_ID'],'runAttempt':os.environ['GITHUB_RUN_ATTEMPT'],'coldInitialBuildinfoAbsent':True,'gnuTimeMaximumRssScope':'Maximum resident size reported for a single process in the waited command tree; not simultaneous aggregate process RSS.','compilerEnvironment':{key:os.environ.get(key) for key in ['NODE_OPTIONS','GOMAXPROCS','GOFLAGS','TS_NODE_PROJECT']},'captureOverhead':'Identical file-descriptor capture and extendedDiagnostics in both arms.'})
write(evidence/'context.json',context)
owned = {}
for arm in [4,2]:
    destination = root/f'config/scripts/run-typecheck-checkers-{arm}-owned.mjs'
    assert not destination.exists()
    with destination.open('xb') as stream: stream.write((payload/f'wrapper-{arm}.mjs').read_bytes())
    owned[arm] = destination
snapshots = {4:{},2:{}}
live = {}
rows = []
qualified = False

def source_guard():
    assert run(['git','rev-parse','HEAD']).stdout.decode().strip() == source
    assert run(['git','diff','--binary','HEAD']).stdout == b''
    for name, expected in manifest['sourceHashes'].items(): assert sha((root/name).read_bytes()) == expected, name
    for arm, path in owned.items(): assert sha(path.read_bytes()) == manifest['payloadHashes'][f'wrapper-{arm}.mjs']
    for name in manifest['sourceAbsentPaths']: assert not (root/name).exists(), name
    for name, expected in installed.items(): assert sha(pathlib.Path(name).read_bytes() if pathlib.Path(name).is_absolute() else (root/name).read_bytes()) == expected, name
    allowed = {str(p.relative_to(root)) for p in owned.values()} | {manifest['negativeFixture']}
    extras = run(['git','ls-files','--others','--exclude-standard','-z']).stdout.decode().split('\0')
    assert set(filter(None,extras)) <= allowed, 'Unowned untracked program input'
    if negative.exists(): assert negative.read_text() == manifest['negativeBytes']

def activate(arm):
    global live
    actual = {p.name:sha(p.read_bytes()) for p in (root/'config').glob('*.tsbuildinfo')}
    assert actual == live, 'Unexpected cache writer or state drift'
    for name, expected in live.items():
        path = root/'config'/name
        assert sha(path.read_bytes()) == expected
        path.unlink()
    for name, path in snapshots[arm].items():
        destination = root/'config'/name
        assert not destination.exists()
        with destination.open('xb') as stream: stream.write(path.read_bytes())
    live = {name:sha(path.read_bytes()) for name,path in snapshots[arm].items()}
    return dict(live)

def save_cache(arm, folder):
    global live
    actual = {p.name:p for p in (root/'config').glob('*.tsbuildinfo')}
    assert set(actual) == set(cache_names), 'Exactly original three canonical caches'
    folder.mkdir()
    inventory = {}
    for name,path in actual.items():
        value = json.loads(path.read_text())
        assert value['version'] == '7.0.2' and value['fileNames']
        assert any(pathlib.PurePosixPath(file).name == pathlib.Path(manifest['negativeFixture']).name for file in value['fileNames']) == negative.exists(), 'Included-file incremental invalidation/removal required'
        inventory[name] = {'sha256':sha(path.read_bytes()),'bytes':path.stat().st_size,'version':value['version'],'programFiles':value['fileNames'],'programFileCount':len(value['fileNames'])}
        with (folder/name).open('xb') as stream: stream.write(path.read_bytes())
    snapshots[arm] = {name:folder/name for name in actual}
    live = {name:value['sha256'] for name,value in inventory.items()}
    return inventory

def command(arm, label, expected_failure=False):
    source_guard()
    folder = evidence/label
    folder.mkdir()
    cache_before = activate(arm)
    capture = folder/'projects'
    capture.mkdir()
    argv = ['/usr/bin/time','-v','-o',str(folder/'gnu-time.txt'),'node',str(owned[arm])]
    environment = dict(os.environ,ORCA_BACKGROUND_LAUNCH='1',ORCA_CHECKER_CAPTURE_DIRECTORY=str(capture))
    start = time.perf_counter()
    with (folder/'whole.stdout').open('xb') as stdout, (folder/'whole.stderr').open('xb') as stderr:
        result = subprocess.run(argv,env=environment,stdout=stdout,stderr=stderr)
    wall = time.perf_counter()-start
    row = {'arm':arm,'label':label,'argv':argv,'returncode':result.returncode,'wholeWallSeconds':wall,'cacheBefore':cache_before,'timed':not expected_failure and label in manifest['schedule'],'expectedFailure':expected_failure}
    rows.append(row)
    raw_time = (folder/'gnu-time.txt').read_text()
    def time_value(label):
        match = re.search(r'^\s*'+re.escape(label)+r':\s*(.+)$',raw_time,re.M)
        assert match, label
        return match.group(1)
    elapsed_parts = [float(p) for p in time_value('Elapsed (wall clock) time (h:mm:ss or m:ss)').split(':')]
    assert len(elapsed_parts) in [2,3]
    elapsed = sum(value * 60**index for index,value in enumerate(reversed(elapsed_parts)))
    rss = int(time_value('Maximum resident set size (kbytes)'))
    assert math.isfinite(wall) and wall > 0 and rss > 0 and abs(elapsed-wall) < 2
    assert int(time_value('Exit status')) == result.returncode
    row.update({'gnuTimeWallSeconds':elapsed,'gnuTimeMaximumSingleProcessRssKib':rss,'gnuTimeUserSeconds':float(time_value('User time (seconds)')),'gnuTimeSystemSeconds':float(time_value('System time (seconds)')),'gnuTimeSha256':sha((folder/'gnu-time.txt').read_bytes())})
    write(folder/'command-receipt.json',row)
    write(evidence/f'ledger-{len(rows):02}.json',rows)
    source_guard()
    assert result.returncode == (1 if expected_failure else 0), 'Retain failure; no retries'
    projects = {}
    for config in configs:
        args = json.loads((capture/(config+'.argv.json')).read_text())
        assert args[0] == native_context['node']
        assert args[1:] == [str(root/'node_modules/typescript/bin/tsc'),'--noEmit','-p','config/'+config,'--checkers',str(arm),'--extendedDiagnostics']
        text = (capture/(config+'.stdout')).read_text()+(capture/(config+'.stderr')).read_text()
        errors = re.findall(r'^(.+?)\((\d+),(\d+)\): error TS(\d+): (.*)$',text,re.M)
        total_errors = re.findall(r'\berror TS\d+:',text)
        assert len(total_errors) == (1 if expected_failure else 0), 'Reject unlocated or additional global diagnostics'
        if expected_failure:
            assert len(errors)==1 and errors[0][0].replace('\\','/')==manifest['negativeFixture'] and errors[0][3]=='2322', (config,errors)
        else: assert not errors, (config,errors)
        assert re.search(r'^Files:\s+\d+',text,re.M), 'Extended diagnostics retained for every project'
        extended = {name:value.strip() for name,value in re.findall(r'^([A-Za-z][A-Za-z /]+):\s*(.*?)\s*$',text,re.M)}
        projects[config] = {'extendedDiagnostics':extended,'diagnostics':[list(e) for e in errors],'stdoutSha256':sha((capture/(config+'.stdout')).read_bytes()),'stderrSha256':sha((capture/(config+'.stderr')).read_bytes()),'argv':args}
    write(folder/'project-diagnostics.json',projects)
    cache = save_cache(arm,folder/'saved-buildinfo')
    write(folder/'cache-after.json',cache)
    row.update({'projects':projects,'cacheAfter':{name:value['sha256'] for name,value in cache.items()}})
    return row, projects, cache

try:
    timed = []
    programs = None
    for label in manifest['schedule']:
        arm = int(label.split('-')[0])
        row, _, cache = command(arm,label)
        assert bool(row['cacheBefore']) == ('cold' not in label), 'Cold arms absent and warm own-cache only'
        files = {name:sorted(value['programFiles']) for name,value in cache.items()}
        if programs is None: programs = files
        else: assert files == programs, 'Exact original program file inventory each count/round'
        timed.append(row)
    write(evidence/'timed-program-inventory.json',programs)
    # Included by all three existing project include roots; after all counted timings.
    with negative.open('x') as stream: stream.write(manifest['negativeBytes'])
    negative_maps=[]
    for arm in [4,2]:
        _, diagnostic, _ = command(arm,f'{arm}-negative-incremental',True)
        negative_maps.append({config:Counter(tuple(d) for d in row['diagnostics']) for config,row in diagnostic.items()})
    assert negative_maps[0] == negative_maps[1], 'No checker count diagnostic differences'
    write(evidence/'negative-diagnostic-parity.json',{config:[list(value) for value in sorted(counter.elements())] for config,counter in negative_maps[0].items()})
    negative.unlink()
    for arm in [4,2]: command(arm,f'{arm}-negative-restored')
    pairs=[]
    for index,stage in enumerate(['cold','warm1','warm2']):
        before=next(r['wholeWallSeconds'] for r in timed if r['label']=='4-'+stage)
        after=next(r['wholeWallSeconds'] for r in timed if r['label']=='2-'+stage)
        pairs.append({'stage':stage,'beforeSeconds':before,'afterSeconds':after,'reductionPercent':100*(1-after/before)})
    before_mean = sum(pair['beforeSeconds'] for pair in pairs)/3
    after_mean = sum(pair['afterSeconds'] for pair in pairs)/3
    qualified=True
    write(evidence/'result.json',{'qualified':True,'performanceAdoption':False,'timedCommands':6,'timedCompilerInvocations':18,'afterTimingDiagnosticCommands':4,'pairs':pairs,'beforeMeanSeconds':before_mean,'afterMeanSeconds':after_mean,'reductionPercent':100*(1-after_mean/before_mean),'qualificationRequiresClosedReceiptAndJobSuccess':True,'allFirstCommandsRetained':True,'independentlyColdOsHosts':False,'scope':'One held ARM4; private per-count canonical buildinfo snapshots, shared OS/dependency caches. Full wrapper source/batches preserved. Negative and restore checks after timings. GNU maximum RSS is not aggregate peak. No ordinary CI change.'})
except BaseException as error:
    write(evidence/'rejected.json',{'qualified':False,'errorType':type(error).__name__,'error':str(error),'traceback':traceback.format_exc(),'attemptsRetained':len(rows)})
    raise
finally:
    source_guard()
    if negative.exists():
        assert negative.read_text()==manifest['negativeBytes']
        negative.unlink()
    write(evidence/'all-attempt-rows.json',rows)
    write(evidence/'closed.json',{'qualified':qualified,'attempts':len(rows),'trackedSourceUnchanged':True,'allAttemptRowsRetained':True})
