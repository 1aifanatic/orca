# Metadata only: copies raw qualification views, then derives the golden timing plan.
from pathlib import Path
import hashlib,json,os,shutil,sys
sha=lambda b:hashlib.sha256(b).hexdigest()
directory=Path(sys.argv[2])
manifest=json.loads((directory/'definition-manifest.json').read_text())
assert manifest['sourceHead']==os.environ['WAIT_SOURCE_SHA']
if sys.argv[1]=='views':
    for runtime in ['bun','node']:
        for seed in manifest['shuffleSeeds']:
            source=directory/'runs'/f'{runtime}-{seed}'
            target=directory/'qualification-artifacts'/f'recovery-delay-clock-{runtime}-{seed}'/'runs'/f'{runtime}-{seed}'
            for path in source.iterdir():
                assert path.is_file() and not path.is_symlink()
                destination=target/path.name
                assert not destination.exists()
                shutil.copyfile(path,destination)
                assert destination.read_bytes()==path.read_bytes()
elif sys.argv[1]=='plan':
    path=directory/'qualification-result.json'
    admission=json.loads(path.read_text())
    assert admission['qualified'] is True and len(admission['snapshots'])==8
    assert admission['sourceHead']==manifest['sourceHead']
    assert admission['runtimeDerivedCaseCount']==19
    assert all(row['count']==19 and row['map']==admission['caseIdentityMapByFile'] for row in admission['snapshots'])
    template=json.loads((directory/'measurement-plan-template.json').read_text())
    plan={**template,'caseCount':admission['runtimeDerivedCaseCount'],'caseIdentityMapByFile':admission['caseIdentityMapByFile'],'runtimeManifestPending':False,'identityProofFiles':{**admission['artifactHashes'],str(path):sha(path.read_bytes())}}
    for file,digest in plan['identityProofFiles'].items():assert sha(Path(file).read_bytes())==digest
    planpath=directory/'measurement-plan.json'
    with planpath.open('x') as stream:stream.write(json.dumps(plan,indent=2)+'\n')
    context=json.loads((directory/'held-context-before-admission.json').read_text())
    context.update(planSha256=sha(planpath.read_bytes()),qualificationRun=os.environ['GITHUB_RUN_ID'])
    with (directory/'ci-context.json').open('x') as stream:stream.write(json.dumps(context,indent=2)+'\n')
else:raise AssertionError('Unknown metadata phase')
