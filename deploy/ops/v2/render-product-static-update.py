"""Local draft renderer only; no SSH, service commands or activation."""
import argparse,ast,json,re
from pathlib import Path
HERE=Path(__file__).resolve().parent
parser=argparse.ArgumentParser();parser.add_argument('--plan',type=Path,required=True);parser.add_argument('--out',type=Path,required=True);args=parser.parse_args()
value=json.loads(args.plan.read_text(encoding='utf8'));template=(HERE/'product-static-update.remote.py.template').read_text(encoding='utf8')
tree=ast.parse(template);check=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='options')
namespace={'re':re};exec(compile(ast.Module(body=[check],type_ignores=[]),'static-options','exec'),namespace);namespace['options'](value)
args.out.mkdir(exist_ok=False)
for phase in ['prepare','activate','rollback']:
    rendered=template.replace('__CONFIG_JSON__',repr(json.dumps(value))).replace('__PHASE__',repr(phase));compile(rendered,'product-static-'+phase+'.py','exec')
    (args.out/('product-static-'+phase+'.py')).write_text(rendered,encoding='utf8')
(args.out/'reviewed-plan.json').write_text(json.dumps(value,indent=2)+'\n',encoding='utf8')
print(json.dumps({'localOnly':True,'directory':str(args.out),'phases':['prepare','activate','rollback']}))
