"""Generate prepare/activate review drafts from an already reviewed staging plan. No SSH."""
from pathlib import Path
import argparse,ast,hashlib,json,re
HERE=Path(__file__).resolve().parent

def build(plan,snapshot):
    rid=plan['releaseId'];assert re.fullmatch(r'v2-[a-z0-9][a-z0-9-]{1,70}',rid)
    assert snapshot['readOnly'] is True and snapshot['nginxFile']=='/etc/nginx/sites-available/bem2075'
    assert snapshot['anchorLine']==['    location = /pinkuang-deploy { return 308 /pinkuang-deploy/; }']
    for key in ['archiveSha256','manifestSha256']:assert re.fullmatch(r'[a-f0-9]{64}',plan[key])
    for key in ['sourceHead','sourceCommit']:assert re.fullmatch(r'[a-f0-9]{40}',plan[key])
    assert re.fullmatch(r'0x[a-f0-9]{64}',plan['artifactDigest'])
    service=(HERE/'pinkuang-deploy-v2.service.template').read_text(encoding='utf8').replace('__RELEASE_ID__',rid)
    service='\n'.join(line for line in service.splitlines() if not line.startswith('EnvironmentFile=') and not line.startswith('# Optional new file'))+'\n'
    service=service.replace('Environment=BEMINE_NOTIFICATIONS_ENABLED=0\n','Environment=BEMINE_NOTIFICATIONS_ENABLED=0\nEnvironment=BEMINE_JOURNAL_FACTORIES=\nEnvironment=BEMINE_DEPLOYMENT_RECORD_PATH=\n')
    locations=(HERE/'nginx-v2.locations.conf').read_text(encoding='utf8')
    locations=locations.rstrip()+'\n'
    locations=locations.replace('    add_header Cache-Control "no-store" always;','    add_header Cache-Control "no-store" always;\n    add_header X-Robots-Tag "noindex, nofollow" always;')
    assert '/bemine-v2' not in locations and locations.count('location ')==2
    old_services=['pinkuang-deploy.service','pinkuang-index.service','bem2075-site.service','sparkdraw-keeper.service','sparkdraw-bot.service']
    config={**plan,'nginxSha256':snapshot['nginxSha256'],'snapshotAtUtc':snapshot['checkedAtUtc'],
            'oldServices':{name:snapshot['services'][name] for name in old_services},'oldCurrent':snapshot['current'],
            'unitText':service,'snippetText':locations}
    template=(HERE/'activation-v2.remote.py.template').read_text(encoding='utf8')
    scripts={phase:template.replace('__CONFIG_JSON__',repr(json.dumps(config))).replace('__PHASE__',repr(phase)) for phase in ['prepare','activate']}
    for phase,source in scripts.items():ast.parse(source,filename=phase+'-v2.remote.py')
    return config,scripts

def main():
    p=argparse.ArgumentParser();p.add_argument('--plan-directory',type=Path,required=True)
    p.add_argument('--snapshot',type=Path,required=True);p.add_argument('--out',type=Path,required=True);args=p.parse_args()
    plan=json.loads((args.plan_directory.resolve(strict=True)/'plan.json').read_text(encoding='utf8'))
    snapshot=json.loads(args.snapshot.read_text(encoding='utf8'));config,scripts=build(plan,snapshot)
    out=args.out.resolve();out.mkdir(parents=False,exist_ok=False)
    (out/'activation-plan.json').write_text(json.dumps(config,indent=2),encoding='utf8')
    for phase,source in scripts.items():(out/(phase+'-v2.remote.py')).write_text(source,encoding='utf8')
    (out/'pinkuang-deploy-v2.service').write_text(config['unitText'],encoding='utf8')
    (out/'pinkuang-deploy-v2.locations.conf').write_text(config['snippetText'],encoding='utf8')
    print(json.dumps({'localOnly':True,'activated':False,'directory':str(out),'scripts':list(scripts),'nginxSha256':config['nginxSha256']},indent=2))
if __name__=='__main__':main()
