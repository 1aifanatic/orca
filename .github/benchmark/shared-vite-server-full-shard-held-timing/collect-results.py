# Reuses held-six raw source/config/route/census/wall gates; fresh first counted map.
import hashlib,json,math,os,re,statistics,sys
from collections import Counter
from pathlib import Path
root,payload,output=map(Path,sys.argv[1:]);assert not output.exists()
sha=lambda b:hashlib.sha256(b).hexdigest();artifacts={};result={'qualified':False,'errors':[],'performanceClaim':False,'samples':[],'unlaunchedSamples':[],'attemptedRawSummaries':[]}
def read(p):b=Path(p).read_bytes();artifacts[str(p)]=sha(b);return json.loads(b)
def counter(rows):return Counter(json.dumps(r,sort_keys=True,ensure_ascii=True,separators=(',',':')) for r in rows)
def canonical(raw,files):
 # Exact existing canonicalizer's only applicable allowance: one source-bound nonce variant.
 assert 'src/main/ai-vault/session-scanner-opencode-native-worker.test.ts' not in files
 name='src/shared/orcad-profile-preflight.test.ts';prefix='refuses stale or incomplete evidence: '
 table=[r for r in raw if r['file']==name and r['title'].startswith(prefix)];assert len(table)==6
 nonces=[r for r in table if r['title'].startswith(prefix+'{"nonce"')];assert len(nonces)==1
 assert sorted(r['title'] for r in table if r not in nonces)==sorted(prefix+x for x in ['{"runtime":"node"}','{"runtimeVersion":"1.4.0"}','{"artifactVersion":"0.1.0+000000000000"}','{"revision":0}','{"sqliteVersion":""}'])
 for r in table:assert r['ancestorTitles']==['candidate profile readiness'] and r['fullName']=='candidate profile readiness '+r['title']
 assert re.fullmatch(r'refuses stale or incomplete evidence: \{"nonce":"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"\}',nonces[0]['title'])
 rows=[]
 for r in raw:
  if r is nonces[0]:
   title=prefix+'{"nonce":"<generated-uuid-v4>"}';r={**r,'title':title,'fullName':'candidate profile readiness '+title}
  rows.append(r)
 names=[r['fullName'] for r in rows if r['file']==name];assert len(names)==len(set(names))
 return rows
try:
 manifest=read(payload/'definition-manifest.json');plan=read(payload/'measurement-plan.json');directory=root/Path(manifest['isolatedDirectory']).name;context=read(directory/'ci-context.json')
 assert context['sourceSha']==plan['sourceHead']==manifest['sourceHead']==os.environ['SHARED_SERVER_SOURCE_SHA']
 assert context['definitionSha']==os.environ['GITHUB_SHA'] and context['runId']==os.environ['GITHUB_RUN_ID'] and context['runAttempt']==os.environ['GITHUB_RUN_ATTEMPT']
 assert all(type(context[k]) is str for k in ['sourceSha','definitionSha','runId','runAttempt'])
 assert context['platform']=='linux' and context['arch']=='arm64' and context['logicalCpus']==4
 assert context['nodeVersion']=='24.21.0' and context['bunVersion']=='1.4.2' and context['bunRevisionDisplay']=='1.4.2+744846f84' and context['vitestVersion']=='5.0.3'
 assert context['expectedBunRuntimeRevision']=='744846f844374847c902b5e7fd59b4342a51ef99'
 assert context['definitionManifestSha256']==sha((payload/'definition-manifest.json').read_bytes()) and context['planSha256']==sha((payload/'measurement-plan.json').read_bytes())
 assert context['controllerSha256']==manifest['controllerSha256'] and context['reporterSha256']==manifest['reporterSha256']=='2d2b20c3b06cc11c28650496a48ae525903e4fc43d4306aad5405e85f086e76e'
 assert context['qualificationRun']==manifest['actualQualificationRun']==37793987040 and manifest['runtimeQualificationPending'] is False
 assert context['ciOnly'] and context['testsLaunchedByMaterializer'] is False and context['launchEnvironment']['ORCA_BACKGROUND_LAUNCH']=='1'
 assert all(v is None for k,v in context['launchEnvironment'].items() if k!='ORCA_BACKGROUND_LAUNCH')
 assert set(context['absentProfilingEnvironment'])==set(manifest['absentProfilingEnvironment']) and all(v is None for v in context['absentProfilingEnvironment'].values())
 for name,h in manifest['payloadSha256'].items():
  assert sha((payload/name).read_bytes())==h
  path=root/name if name in ['benchmark-persistence-import-reuse.mjs','persistence-import-reuse-benchmark-reporter.mjs','canonical-case-identities.mjs'] else directory/name
  assert path.read_bytes()==(payload/name).read_bytes();artifacts[str(path)]=h
 admission=read(payload/'actual-eight-result.json');peer=read(payload/'independent-eight-proof.json');sourcePeer=read(payload/'independent-source-tree-proof.json');catalog=read(payload/'catalog-eight-peer.json')
 assert admission['qualified'] and peer['qualified'] and sourcePeer['qualified']
 assert catalog['allEightExactDuplicatePreservingMapsEqual'] and catalog['fullStrictPreflightPairEqualityWithOnlyDeclaredIdentityMetadataOmitted'] and catalog['frozenCollectorReplayedUnchanged']
 assert catalog['allCasesPerCommand']==296 and catalog['originalCasesPerCommand']==278 and catalog['diagnosticCasesPerCommand']==18
 assert admission['sourceHead']==plan['sourceHead'] and admission['runtimeDerivedCaseCount']==296 and admission['originalRuntimeDerivedCaseCount']==278
 assert len(admission['snapshots'])==8 and peer['actualCollectorSemanticResultEqualsIndependentRawReplay']
 assert peer['runId']==37793987040 and peer['definitionSha']==manifest['actualQualificationDefinition']
 assert plan['caseCount'] is None and plan['caseIdentityMapByFile'] is None and plan['runtimeManifestPending'] is True
 files=plan['files'];assert len(files)==len(set(files))==1187 and plan['timedFiles']==files
 assert plan['schedule']==[['before',0],['after',0],['after',1],['before',1],['before',2],['after',2]]
 assert plan['maxWorkers']==4 and plan['fsModuleCache'] is True
 expectedConfig=next(s['config'] for s in admission['snapshots'] if s['runtime']=='bun');keys=['name','pool','fsModuleCache','effectiveMaxWorkers','isolate','testTimeout','hookTimeout','setups','execArgv']
 goldenPath=directory/Path(plan['goldenPath']).name;golden=read(goldenPath)
 assert golden['sourceHead']==plan['sourceHead'] and golden['files']==files
 expected=counter(golden['canonicalIdentities']);assert sum(expected.values())>0
 freeze=read(root/(plan['label']+'-benchmark-freeze.json'));empty=sha(b'');firstRaw=None
 for phase,roundIndex in plan['schedule']:
  prefix=root/(plan['label']+'-'+phase+'-'+str(roundIndex));summaryPath=Path(str(prefix)+'-summary.json')
  if not summaryPath.exists():result['unlaunchedSamples'].append({'phase':phase,'round':roundIndex});continue
  row=read(summaryPath);result['attemptedRawSummaries'].append({'phase':phase,'round':roundIndex,'seconds':row.get('seconds'),'result':row.get('result'),'performanceQualified':row.get('performanceQualified'),'summarySha256':artifacts[str(summaryPath)]});report=read(Path(str(prefix)+'.json'));details=read(Path(str(prefix)+'-details.json'));logPath=Path(str(prefix)+'.log');log=logPath.read_bytes();artifacts[str(logPath)]=sha(log)
  assert row['phase']==phase and row['round']==roundIndex and row['qualified'] and row['performanceQualified']
  assert row['result']=={'code':0,'signal':None} and not row.get('launchError') and not row['external'] and not row['lifecycleError'] and not row['lingeringCoordinators']
  assert row['noiseGuardAvailable'] and row['samples'][0]['coordinators']==row['samples'][-1]['coordinators']==[]
  assert all(not s.get('error') and s['noiseGuardAvailable'] and all(c['owned'] for c in s['coordinators']) for s in row['samples'])
  assert row['before']==row['after'] and row['sourceUnchanged'];fingerprint=row['before'];source=plan['sourceBeforeSha256'] if phase=='before' else plan['sourceAfterSha256']
  assert fingerprint['head']==plan['sourceHead'] and fingerprint['unrelatedDiffSha256']==empty and fingerprint['sourceSha256']==source
  assert fingerprint['configSha256']==source['config/vitest.config.ts'] and fingerprint['reporterSha256']==manifest['reporterSha256'] and fingerprint['harnessSha256']==manifest['controllerSha256'] and fingerprint['planSha256']==context['planSha256']==row['casePlanSha256']
  assert row['patchSha256']==plan['patchSha256']
  assert (fingerprint['diffSha256']==empty)==(phase=='before')
  assert freeze=={'expectedHead':plan['sourceHead'],'unrelatedDiffSha256':empty,'configurationPhaseHashes':{'before':plan['sourceBeforeSha256']['config/vitest.config.ts'],'after':plan['sourceAfterSha256']['config/vitest.config.ts']},'reporterSha256':manifest['reporterSha256'],'planSha256':context['planSha256'],'harnessSha256':manifest['controllerSha256']}
  argv=['pnpm','test',*files,'--fsModuleCache=true','--maxWorkers=4','--reporter=json','--reporter=./notes/bun-migration/performance/persistence-import-reuse-benchmark-reporter.mjs','--outputFile='+str(Path(context['repositoryRoot'])/'notes/bun-migration/performance'/prefix.name)+'.json'];assert row['command']==argv
  assert report['success'] and report['numFailedTests']==report['numFailedTestSuites']==0
  raw=[];physical=[]
  for module in report['testResults']:
   names=[f for f in files if module['name'].replace('\\','/')==f or module['name'].replace('\\','/').endswith('/'+f)];assert len(names)==1;physical+=names
   assert module['status'] in ['passed','pending','skipped']
   original=plan['expectedPhysicalModuleCounts'][names[0]]
   assert len(module['assertionResults'])==original['cases']
   assert sum(r['status'] in ['pending','skipped'] for r in module['assertionResults'])==original['skipped']
   raw.extend({'file':names[0],**{k:r[k] for k in ['fullName','title','ancestorTitles','status']}} for r in module['assertionResults'])
  assert len(physical)==len(set(physical))==1187 and set(physical)==set(files)
  assert counter(raw)==counter(row['identities']);states=Counter(r['status'] for r in raw);assert set(states)<=set(['passed','pending','todo','skipped']) and not states.get('failed')
  assert len(raw)==report['numTotalTests']==report['numPassedTests']+report['numPendingTests']+report['numTodoTests']+report['numFailedTests']
  assert states.get('passed',0)==report['numPassedTests'] and states.get('pending',0)+states.get('skipped',0)==report['numPendingTests'] and states.get('todo',0)==report['numTodoTests']
  assert row['physicalCaseCountsPreserved'] is True
  assert report['numTotalTests']==11602 and report['numPassedTests']==11479 and report['numPendingTests']==123 and report['numTodoTests']==0
  assert row['rawCounterParity'] is True and row['rawStatusCounts']==dict(states)==golden['rawStatusCounts']
  normalized=canonical(raw,files);assert counter(normalized)==counter(row['canonicalIdentities'])==expected
  if phase=='before' and roundIndex==0:
   assert row['goldenInputSha256'] is None and golden['firstBaselineSummarySha256']==artifacts[str(summaryPath)];firstRaw=raw
  else:assert row['goldenInputSha256']==artifacts[str(goldenPath)]
  assert details==row['details'] and details['reason']=='passed' and not details['errors']
  assert details['rootFsModuleCache'] and details['rootIsolation'] and details['resolvedRootMaxWorkers']==4
  assert sorted([{k:p[k] for k in keys} for p in details['projects']],key=lambda p:p['name'])==expectedConfig
  actualRoutes=[{k:m[k] for k in ['file','project','pool']} for m in details['modules']];assert len(actualRoutes)==1187 and len({r['file'] for r in actualRoutes})==1187
  assert sorted(actualRoutes,key=lambda r:r['file'])==sorted(plan['expectedModuleRoutes'],key=lambda r:r['file'])
  assert all(not m.get('diagnostic',{}).get('errors') for m in details['modules'])
  assert not re.search(rb'Timeout terminating|failed to terminate.*worker|worker.*termination.*timed out|Unhandled Errors',log,re.I)
  assert math.isfinite(row['seconds']) and row['seconds']>0
  result['samples'].append({'phase':phase,'round':roundIndex,'seconds':row['seconds'],'cases':len(raw),'rawCaseStatusCounts':dict(states),'censusSnapshots':len(row['samples']),'countedFiveSecondCallbacks':len(row['samples'])-2,'summarySha256':artifacts[str(summaryPath)]})
 assert not result['unlaunchedSamples'] and len(result['samples'])==6 and firstRaw is not None
 for phase,label in [('after','after-0'),('before','before-1'),('after','after-2')]:
  receipt=read(directory/('framework-transition-'+label+'-receipt.json'));framework=plan['frameworkCorrection'];beforeOwners=manifest['installedSourceOwners'] if phase=='after' else {**manifest['installedSourceOwners'],framework['path']:framework['afterSha256']};afterOwners={**beforeOwners,framework['path']:framework['afterSha256'] if phase=='after' else framework['beforeSha256']}
  assert receipt['sourceSha']==manifest['sourceHead'] and receipt['definitionSha']==context['definitionSha'] and receipt['runId']==context['runId'] and receipt['runAttempt']==context['runAttempt']
  assert receipt['phase']==phase and receipt['transition']==label and receipt['beforeHashes']==beforeOwners and receipt['afterHashes']==afterOwners
  assert receipt['patchSha256']==framework['patchSha256'] and receipt['switcherSha256']==plan['frameworkSwitcherSha256']
  assert receipt['exactThreeReplacements'] and receipt['atomicReplacementBreaksHardlinks'] and receipt['disposableCiOnly'] and receipt['productionInstallNotModified']
 pairs=[]
 for n in range(3):
  a=next(s['seconds'] for s in result['samples'] if s['phase']=='before' and s['round']==n);b=next(s['seconds'] for s in result['samples'] if s['phase']=='after' and s['round']==n);pairs.append({'round':n,'beforeSeconds':a,'afterSeconds':b,'lessTimePercent':100*(1-b/a)})
 am=statistics.mean(p['beforeSeconds'] for p in pairs);bm=statistics.mean(p['afterSeconds'] for p in pairs)
 result.update({'qualified':True,'sourceHead':plan['sourceHead'],'physicalFiles':1187,'caseCount':len(firstRaw),'rawCaseStatusCounts':dict(Counter(r['status'] for r in firstRaw)),'allSixDuplicatePreservingMapsEqual':True,'onlyDeclaredGeneratedNonceNameAllowanceRawNamesRetained':True,'pairs':pairs,'beforeMeanSeconds':am,'afterMeanSeconds':bm,'lessTimePercent':100*(1-bm/am),'ratio':am/bm,'allFirstSamplesRetained':True,'noExtraPrimer':True,'scope':'Whole1187-file archived ten-way shard9 workload on one ARM4; six whole commands with counted census. Shared warming, source907, cachefsTRUE/isolation preserved. Not the current five-way assignment, whole-fleet occupied saving, crossplatform qualification, persistent-install adoption, or2x goal.'})
except Exception as error:
 result['errors'].append(type(error).__name__+': '+str(error))
 result['artifactHashes']=artifacts
 with output.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
 raise
result['artifactHashes']=artifacts
with output.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
print(json.dumps({'qualified':True,'files':1187,'cases':result['caseCount'],'samples':6,'lessTimePercent':result['lessTimePercent']}))
