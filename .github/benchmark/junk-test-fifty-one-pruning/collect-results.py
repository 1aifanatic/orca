# Independently replay full raw phase maps; launch no process and preserve rejection.
from collections import Counter
import hashlib,json,math,os,re,statistics,sys
from pathlib import Path
root,payload,output=map(Path,sys.argv[1:]); assert not output.exists()
sha=lambda b:hashlib.sha256(b).hexdigest(); artifacts={}
def read(p):
 b=p.read_bytes();artifacts[str(p)]=sha(b);return json.loads(b)
def canonical(c):return (c['file'],c['fullName'],c['title'],tuple(c['ancestorTitles']),c['status'])
def expand(m):return [{'file':f,**c} for f,cs in m.items() for c in cs]
def counts(cs):return Counter(c['status'] for c in cs)
result={'qualified':False,'errors':[],'performanceClaim':False,'samples':[]}
try:
 manifest=read(payload/'definition-manifest.json'); runtime=root/Path(manifest['isolatedDirectory']).name
 plan=read(runtime/'measurement-plan.json'); assert plan==read(payload/'measurement-plan.json')
 context=read(runtime/'ci-context.json')
 assert context['sourceSha']==manifest['sourceHead']==plan['sourceHead']==os.environ['WAIT_TIMING_SOURCE_SHA']
 assert context['definitionSha']==os.environ['GITHUB_SHA'] and context['runId']==os.environ['GITHUB_RUN_ID'] and context['runAttempt']==os.environ['GITHUB_RUN_ATTEMPT']
 assert context['repositoryRoot']==str(Path.cwd()) and context['platform']=='linux' and context['arch']=='arm64' and context['logicalCpus']==4
 pins=manifest['expectedCiPins']; assert all(context[k]==pins[k.replace('Version','').replace('Revision','Revision')] for k in ['nodeVersion','bunVersion','bunRevision','vitestVersion'])
 assert context['driverSha256']==manifest['controllerSha256'] and context['reporterSha256']==manifest['reporterSha256']=='2d2b20c3b06cc11c28650496a48ae525903e4fc43d4306aad5405e85f086e76e'
 assert context['definitionManifestSha256']==sha((payload/'definition-manifest.json').read_bytes()) and context['planSha256']==sha((runtime/'measurement-plan.json').read_bytes())
 assert context['ciOnly'] and context['testsLaunchedByMaterializer'] is False and context['noPriorQualificationCommands'] and context['independentlyColdArms'] is False
 assert context['launchEnvironment']=={'ORCA_BACKGROUND_LAUNCH':'1',**{k:None for k in manifest['absentLaunchEnvironment']}}
 assert context['absentProfilingEnvironment']=={k:None for k in manifest['absentProfilingEnvironment']}
 for name,h in manifest['payloadSha256'].items():
  assert sha((payload/name).read_bytes())==h
  for destination,n in manifest['destinationToPayload'].items():
   if n==name:assert Path(destination).read_bytes()==(payload/name).read_bytes()
 assert plan['schedule']==[['before',0],['after',0],['after',1],['before',1],['before',2],['after',2]] and plan['fsModuleCache'] is True and plan['maxWorkers']==4
 assert plan['removedCases']==manifest['removedCases'] and plan['wholeFilesRemoved']==manifest['wholeFilesRemoved']
 assert plan['filesByPhase']=={'before':manifest['originalFiles'],'after':manifest['candidateFiles']}
 assert len(plan['filesByPhase']['before'])==17 and len(plan['filesByPhase']['after'])==11
 assert Counter(plan['filesByPhase']['before'])-Counter(plan['filesByPhase']['after'])==Counter(plan['wholeFilesRemoved'])
 assert len(plan['wholeFilesRemoved'])==6 and all(plan['sourceAfterSha256'][f] is None for f in plan['wholeFilesRemoved'])
 baseline=expand(plan['caseIdentityMapByPhase']['before']);candidate=expand(plan['caseIdentityMapByPhase']['after'])
 removed=Counter()
 for c in plan['removedCases']:
  assert isinstance(c['multiplicity'],int) and c['multiplicity']>0 and c['status']=='passed';removed[canonical(c)]+=c['multiplicity']
 original=Counter(map(canonical,baseline)); expected=Counter(map(canonical,candidate))
 assert sum(removed.values())==51 and all(original[k]>=v for k,v in removed.items()) and original-removed==expected and expected+removed==original
 assert len(baseline)==197 and len(candidate)==146 and counts(baseline)=={'passed':191,'skipped':6} and counts(candidate)=={'passed':140,'skipped':6}
 assert [c for c in baseline if c['status']=='skipped']==[c for c in candidate if c['status']=='skipped']
 for phase in ['before','after']:
  assert set(plan['caseIdentityMapByPhase'][phase])==set(plan['filesByPhase'][phase])
  assert all(plan['caseIdentityMapByPhase'][phase].values()) and plan['caseCountByPhase'][phase]==len(expand(plan['caseIdentityMapByPhase'][phase]))
 proof=read(runtime/'source-proposal-proof.json')
 assert proof['removedCases']==plan['removedCases'] and proof['wholeFilesRemoved']==plan['wholeFilesRemoved'] and proof['sourceHead']==plan['sourceHead']
 assert proof['currentWindowsRegistration']['expandedCases']==plan['caseIdentityMapByPhase']['before'][proof['currentWindowsRegistration']['file']]
 assert proof['currentWindowsRegistration']['sha256']==plan['sourceBeforeSha256'][proof['currentWindowsRegistration']['file']]
 assert set(proof['selectedFilesByteExactHistorical'])==set(plan['filesByPhase']['before'])-{proof['currentWindowsRegistration']['file']}
 assert all(plan['sourceBeforeSha256'][f]==h for f,h in proof['selectedFilesByteExactHistorical'].items())
 freeze=read(root/(plan['label']+'-benchmark-freeze.json')); signature=None; expected_config=None; paired={}
 keys=['name','pool','fsModuleCache','effectiveMaxWorkers','isolate','testTimeout','hookTimeout','setups','execArgv']
 setups=['config/scripts/vitest-real-agent-home-write-guard.ts','config/scripts/vitest-bun-node-builtins.ts','config/scripts/happy-dom-offscreen-canvas.ts','config/scripts/happy-dom-mutation-observer-retention.ts','config/scripts/vitest-host-ports-setup.ts','config/scripts/vitest-caller-identity-env-setup.ts']
 for phase,index in plan['schedule']:
  prefix=root/(plan['label']+'-'+phase+'-'+str(index));row=read(Path(str(prefix)+'-summary.json'));report=read(Path(str(prefix)+'.json')); details=read(Path(str(prefix)+'-details.json'))
  logfile=Path(str(prefix)+'.log');log=logfile.read_bytes();artifacts[str(logfile)]=sha(log)
  assert row['phase']==phase and row['round']==index and row['qualified'] and row['performanceQualified']
  assert row['command']==['pnpm','test',*plan['filesByPhase'][phase],'--fsModuleCache=true','--maxWorkers=4','--reporter=json','--reporter=./notes/bun-migration/performance/persistence-import-reuse-benchmark-reporter.mjs','--outputFile='+str(Path(context['repositoryRoot'])/'notes/bun-migration/performance'/(plan['label']+'-'+phase+'-'+str(index)+'.json'))]
  assert row['result']=={'code':0,'signal':None} and not row.get('launchError') and not row['external'] and not row['lifecycleError'] and not row['lingeringCoordinators']
  assert row['noiseGuardAvailable'] and row['samples'][0]['coordinators']==row['samples'][-1]['coordinators']==[]
  assert all(s['noiseGuardAvailable'] and not s.get('error') and all(p['owned'] for p in s['coordinators']) for s in row['samples'])
  assert row['before']==row['after'] and row['sourceUnchanged']
  fp=row['before'];assert fp['head']==plan['sourceHead'] and fp['unrelatedDiffSha256']==sha(b'')
  assert fp['configSha256']==plan['sourceBeforeSha256']['config/vitest.config.ts'] and fp['reporterSha256']==manifest['reporterSha256'] and fp['harnessSha256']==manifest['controllerSha256'] and fp['planSha256']==context['planSha256']==row['casePlanSha256']
  assert row['patchSha256']==plan['patchSha256'] and row['sourceHashReceipt']==(plan['sourceBeforeSha256'] if phase=='before' else plan['sourceAfterSha256'])
  assert (fp['diffSha256']==sha(b''))==(phase=='before')
  common={k:fp[k] for k in ['unrelatedDiffSha256','configSha256','reporterSha256','planSha256','harnessSha256']};assert freeze=={'expectedHead':plan['sourceHead'],**common}
  if signature is None:signature=common
  else:assert signature==common
  assert report['success'] and report['numFailedTests']==0 and not report.get('numTodoTests',0)
  phase_cases=expand(plan['caseIdentityMapByPhase'][phase]); statuses=counts(phase_cases)
  assert report['numTotalTests']==len(phase_cases) and report['numPassedTests']==statuses['passed'] and report['numPendingTests']==statuses['skipped']
  assert len(report['testResults'])==len(plan['filesByPhase'][phase]);actual=[];seen=set()
  for module in report['testResults']:
   matches=[f for f in plan['filesByPhase'][phase] if module['name'].replace('\\','/').endswith('/'+f)];assert len(matches)==1 and matches[0] not in seen;seen.add(matches[0])
   assert module['status'] in ['passed','skipped'] and module['assertionResults']
   actual.extend({'file':matches[0],**{k:c[k] for k in ['fullName','status','title','ancestorTitles']}} for c in module['assertionResults'])
  assert seen==set(plan['filesByPhase'][phase]) and Counter(map(canonical,actual))==Counter(map(canonical,phase_cases))==Counter(map(canonical,row['identities']))
  assert details==row['details'] and details['reason']=='passed' and not details['errors']
  assert details['rootFsModuleCache'] is True and details['rootIsolation'] is True and details['resolvedRootMaxWorkers']==4
  config=sorted([{k:p[k] for k in keys} for p in details['projects']],key=lambda p:p['name'])
  assert {p['name']:p['pool'] for p in config}=={'bun':'forks','node-runtime':'node-runtime','node-measurement':'node-runtime'}
  assert all(p['fsModuleCache'] is True and p['isolate'] is True and p['effectiveMaxWorkers']==4 and p['setups']==setups and p['execArgv']==['--no-experimental-webstorage','--expose-gc'] and p['testTimeout']==30000 and p['hookTimeout']==60000 for p in config)
  if expected_config is None:expected_config=config
  else:assert config==expected_config
  routes=[{k:m[k] for k in ['file','project','pool']} for m in details['modules']];assert sorted(routes,key=lambda x:x['file'])==sorted(plan['expectedModuleRoutesByPhase'][phase],key=lambda x:x['file'])
  assert all(not m.get('diagnostic',{}).get('errors') for m in details['modules'])
  assert all(row[k] for k in ['caseParity','filesEqual','cacheEnabled','setupPreserved','routePreserved','isolationPreserved','workerCapPreserved'])
  assert not re.search(rb'Timeout terminating|failed to terminate.*worker|worker.*termination.*timed out|Unhandled Errors',log,re.I)
  assert math.isfinite(row['seconds']) and row['seconds']>0
  result['samples'].append({'phase':phase,'round':index,'seconds':row['seconds'],'cases':len(actual),'passed':statuses['passed'],'stockSkipped':statuses['skipped'],'summarySha256':artifacts[str(prefix)+'-summary.json']});paired[(phase,index)]=actual
 for index in range(3):assert Counter(map(canonical,paired[('before',index)]))-removed==Counter(map(canonical,paired[('after',index)]))
 pairs=[{'round':i,'beforeSeconds':next(s['seconds'] for s in result['samples'] if s['phase']=='before' and s['round']==i),'afterSeconds':next(s['seconds'] for s in result['samples'] if s['phase']=='after' and s['round']==i)} for i in range(3)]
 before=statistics.mean(p['beforeSeconds'] for p in pairs);after=statistics.mean(p['afterSeconds'] for p in pairs)
 for p in pairs:p['reductionPercent']=(1-p['afterSeconds']/p['beforeSeconds'])*100
 result.update({'qualified':True,'sourceHead':plan['sourceHead'],'pairs':pairs,'beforeMeanSeconds':before,'afterMeanSeconds':after,'reductionPercent':(1-after/before)*100,'allSixAttemptedCommandSeconds':sum(s['seconds'] for s in result['samples']),'firstCommandsRetained':True,'independentlyColdArms':False,'countedOrder':plan['schedule'],'beforeCases':197,'afterCases':146,'removedCases':51,'stockWindowsSkipsBoth':6,'scope':'Three whole-pnpm pairs on one held ARM4, stockfsTRUE. Every first attempt counts; shared cache/OS/runtime warming disclosed. Only reviewed junk callbacks/files removed; all original remaining maps/statuses and real companions remain. No full-CI or fleet latency gain inferred.'})
except Exception as e:
 result['qualified']=False;result['errors'].append(type(e).__name__+': '+str(e));result['artifactHashes']=artifacts
 try:
  with output.open('x') as f:f.write(json.dumps(result,indent=2)+'\n')
 except OSError:pass
 raise
result['artifactHashes']=artifacts
with output.open('x') as f:f.write(json.dumps(result,indent=2)+'\n')
print(json.dumps({k:result[k] for k in ['qualified','beforeMeanSeconds','afterMeanSeconds','reductionPercent']}))
