"""Validate saved Vitest and child receipts only; never launch workloads."""
import collections, hashlib, json, pathlib, re, sys
root = pathlib.Path(sys.argv[1]); mode = sys.argv[2]
m = None
hashfile = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
result = {'qualified': False, 'errors': [], 'quietTeardownContractQualified': False, 'persistentInstallQualified': False, 'performanceClaim': False}
def read(name): return json.loads((root / name).read_text())
def key(row): return (row['file'], tuple(row['ancestorTitles']), row['title'], row['fullName'], row['status'])
def jsonrows(text):
    decoder = json.JSONDecoder(); rows=[]
    for line in text.splitlines():
        for index, char in enumerate(line):
            if char != '{': continue
            try: value, _ = decoder.raw_decode(line[index:])
            except (ValueError, TypeError): continue
            if isinstance(value, dict) and value.get('phase') in ['inputs','fence','complete']: rows.append(value); break
    return rows

def phase(phase):
    context = read(phase+'-context.json'); command=read(phase+'-command.json'); report=read(phase+'-report.json'); details=read(phase+'-details.json')
    assert context['sourceSha']==command['sourceSha']==m['sourceSha']
    assert context['manifestSha256']==command['manifestSha256']==hashfile(root/'manifest.json')
    for field in ['definitionSha','runId','runAttempt','source','installed']: assert command[field]==context[field]
    assert all(isinstance(context[field],str) and context[field] for field in ['definitionSha','runId','runAttempt'])
    assert command['naturalForegroundReturn'] is True and command['elapsedMs']>0 and command['argv']==m['argv'][phase]
    assert command['code']==(1 if phase=='before' else 0)
    installed=context['installed']; assert re.fullmatch(r'v24\.\d+\.\d+',installed['node']) is not None and installed['vitest']=='5.0.3'
    expected_source=dict(m['sourceGuards']); expected_source.update({f:m['payload'][f]['sha256'] for f in m['commonTargets']})
    if phase=='after': expected_source.update({f:m['payload'][f]['sha256'] for f in m['afterTargets']})
    assert context['source']==expected_source
    for name, target in [('windowsTerminal.js','lib/windowsTerminal.js'),('windowsTerminal.ts','src/windowsTerminal.ts')]: assert installed['files'][name]['sha256']==(m['installedBefore'][target] if phase=='before' else m['payload'][target]['sha256'])
    assert details['errors']==[] and details['rootFsModuleCache'] is True and details['rootIsolation'] is True and details['resolvedRootMaxWorkers']==4
    expected_projects=[('node',4),('node-measurement',4)]
    assert [(p['name'],p['effectiveMaxWorkers']) for p in details['projects']]==expected_projects
    for p in details['projects']:
        assert p['pool']=='forks' and p['fsModuleCache'] is True and p['isolate'] is True
        assert p['testTimeout']==30000 and p['hookTimeout']==60000 and p['setups']==m['setups']
        assert p['execArgv']==['--no-experimental-webstorage','--expose-gc']
    expected_files={r['file'] for r in m['cases'][phase]}
    assert {row['file'] for row in details['modules']}==expected_files and len(details['modules'])==len(expected_files)
    assert all(row['project']=='node' and row['pool']=='forks' and not row.get('diagnostic',{}).get('errors') for row in details['modules'])
    rows=[]; failed={}
    assert len(report['testResults'])==len(expected_files)
    for module in report['testResults']:
        filename=module['name'].replace('\\','/'); file=next((f for f in expected_files if filename.endswith('/'+f)), None); assert file is not None
        assert module['assertionResults']
        for row in module['assertionResults']:
            record={k:row[k] for k in ['ancestorTitles','title','fullName','status']}; record['file']=file; rows.append(record)
            if row['status']=='failed': failed[row['title']]=row['failureMessages']
    assert collections.Counter(map(key,rows))==collections.Counter(map(key,m['cases'][phase]))
    counts=collections.Counter(r['status'] for r in rows)
    assert report['numTotalTests']==len(rows) and report['numPassedTests']==counts['passed'] and report['numFailedTests']==counts['failed']
    assert report['numPendingTests']==0 and report['numTodoTests']==0
    assert report['success'] is (phase=='after') and details['reason']==('failed' if phase=='before' else 'passed')
    console=(root/(phase+'-command.log')).read_text(encoding='utf-8-sig')
    observations=[]
    if phase=='before':
        # Per-case failureMessages identify each actual child independently of repeated console output.
        streams=[('\n'.join(failed[title]), pair) for title,pair in zip([r['title'] for r in m['cases']['before'] if r['status']=='failed'],m['quietPairs'])]
    else: streams=[(console,pair) for pair in m['quietPairs']]
    all_input_rows=[]
    for text,pair in streams:
        raw=jsonrows(text); all_input_rows.extend(r for r in raw if r['phase']=='inputs' and 'hostPid' not in r)
        matching=[r for r in raw if r.get('operation')==pair[0] and r.get('fence')==pair[1]]
        # Collapse only exact duplicate printed records for checks; raw bytes and multiplicities stay bound below.
        unique={json.dumps(r,sort_keys=True):r for r in matching}; observed=list(unique.values())
        fences=[r for r in observed if r['phase']=='fence']; assert fences
        pids={r['pid'] for r in fences}; assert len(pids)==1 and all(type(pid) is int and pid>0 for pid in pids)
        assert all(r['dataCallbacks']==0 for r in fences)
        bystage={stage:[r for r in fences if r['stage']==stage] for stage in ['before-public-teardown','after-public-teardown','forwarding-connected','pre-first-data-retirement']}
        assert all(len(v)==1 for v in bystage.values())
        assert bystage['before-public-teardown'][0]['inputDestroyed'] is False
        assert bystage['pre-first-data-retirement'][0]['inputDestroyed'] is (phase=='after')
        if phase=='before': assert 'AssertionError [ERR_ASSERTION]' in text and m['resourceError'] in text and not any(r['phase']=='complete' for r in observed)
        else:
            complete=[r for r in observed if r['phase']=='complete']; assert len(complete)==1 and complete[0]['exitCallbacks']==1 and complete[0]['pid'] in pids
            if pair[1]=='connected': assert bystage['after-public-teardown'][0]['inputDestroyed'] is True
        observations.append({'pair':pair,'pid':next(iter(pids)),'rawMatchedRows':len(matching),'distinctMatchedRows':len(observed),'rows':observed})
    assert all_input_rows
    for row in all_input_rows:
        assert row['node']==installed['node']; assert collections.Counter(item['name'] for item in row['inputs'])==collections.Counter(name for name in installed['files'] if name!='windowsTerminal.ts')
        for item in row['inputs']:
            assert 'unavailable' not in item and item['sha256']==installed['files'][item['name']]['sha256'] and item['bytes']==installed['files'][item['name']]['bytes']
    if phase=='before':
        for text,pair in streams: assert any(r['phase']=='inputs' and 'hostPid' not in r for r in jsonrows(text))
    else: assert len({json.dumps(r,sort_keys=True) for r in all_input_rows})==1
    return {'context':context,'command':command,'caseCounts':dict(counts),'identities':rows,'quiet':observations,'rawFiles':{name:hashfile(root/name) for name in [phase+'-context.json',phase+'-command.json',phase+'-report.json',phase+'-details.json',phase+'-command.log']}}
try:
    m = read('manifest.json')
    before=phase('before'); result['before']=before; result['beforeReceiptSha256']=hashfile(root/'before-command.json')
    for name in ['conpty.node','conpty.dll','OpenConsole.exe','windowsTerminal.js','windowsTerminal.ts']: assert hashfile(root/'native-before'/name)==before['context']['installed']['files'][name]['sha256']
    if mode=='final':
        after=phase('after'); result['after']=after
        bi=before['context']['installed']; ai=after['context']['installed']
        assert bi['node']==ai['node'] and bi['executable']==ai['executable'] and bi['executableSha256']==ai['executableSha256']
        for name in bi['files']:
            if name not in ['windowsTerminal.js','windowsTerminal.ts']: assert bi['files'][name]==ai['files'][name]
        assert before['context']['runId']==after['context']['runId'] and before['context']['definitionSha']==after['context']['definitionSha']
        result['quietTeardownContractQualified']=True
    else: assert mode=='before'
    result['qualified']=True
except Exception as error: result['errors'].append(type(error).__name__+': '+str(error))
output=root/('before-admission.json' if mode=='before' else 'diagnostic-result.json')
root.mkdir(parents=True, exist_ok=True)
assert not output.exists(); output.write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:result[k] for k in ['qualified','errors','quietTeardownContractQualified','persistentInstallQualified']}))
sys.exit(0 if result['qualified'] else 1)
