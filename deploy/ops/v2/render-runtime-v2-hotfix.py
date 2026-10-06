"""Generate reviewed scripts for an existing active v2 installation. No SSH."""
import argparse,ast,json,re
from pathlib import Path
HERE=Path(__file__).resolve().parent
ap=argparse.ArgumentParser();ap.add_argument('--plan',type=Path,required=True);ap.add_argument('--manifest',type=Path,required=True);ap.add_argument('--out',type=Path,required=True);args=ap.parse_args()
plan=json.loads(args.plan.read_text(encoding='utf8'));manifest=json.loads(args.manifest.read_text(encoding='utf8'))
assert manifest['artifactDigest']==plan['artifactDigest'] and manifest['kind']=='integrated-v2';plan['manifest']=manifest
template=(HERE/'runtime-v2-hotfix.remote.py.template').read_text(encoding='utf8');tree=ast.parse(template)
options=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='hotfix_options')
names=next(node.value for node in tree.body if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='legacy_names' for t in node.targets))
ns={'re':re,'legacy_names':ast.literal_eval(names)};exec(compile(ast.Module(body=[options],type_ignores=[]),'hotfix-options','exec'),ns);ns['hotfix_options'](plan)
args.out.mkdir(exist_ok=False)
for phase in ['prepare','activate','rollback']:
    source=template.replace('__CONFIG_JSON__',repr(json.dumps(plan))).replace('__PHASE__',repr(phase));compile(source,'runtime-v2-hotfix-'+phase+'.py','exec')
    (args.out/('runtime-v2-hotfix-'+phase+'.py')).write_text(source,encoding='utf8')
(args.out/'reviewed-plan.json').write_text(json.dumps(plan,indent=2),encoding='utf8')
print(json.dumps({'localOnly':True,'directory':str(args.out),'phases':['prepare','activate','rollback']}))
