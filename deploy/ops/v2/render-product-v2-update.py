"""Render local review scripts only. Never opens SSH or alters a server."""
import argparse,ast,hashlib,json,re
from pathlib import Path
HERE=Path(__file__).resolve().parent
ap=argparse.ArgumentParser();ap.add_argument('--plan',type=Path,required=True);ap.add_argument('--record',type=Path,required=True);ap.add_argument('--manifest',type=Path,required=True);ap.add_argument('--out',type=Path,required=True);args=ap.parse_args()
plan=json.loads(args.plan.read_text(encoding='utf8'))
for key in ['runtimeReleaseId','productReleaseId']:
 if not re.fullmatch(r'v2-[a-z0-9][a-z0-9-]{1,70}',plan[key]):raise ValueError('Fill final reviewed release ID: '+key)
for key in ['runtimeSourceHead','productSourceHead']:
 if not re.fullmatch(r'[a-f0-9]{40}',plan[key]):raise ValueError('Fill final reviewed source head: '+key)
for key in ['runtimeManifestSha256','productManifestSha256','nginxSha256','deployUnitSha256']:
 if not re.fullmatch(r'[a-f0-9]{64}',plan[key]):raise ValueError('Fill actual checked SHA256: '+key)
record=json.loads(args.record.read_text(encoding='utf8'))
manifest=json.loads(args.manifest.read_text(encoding='utf8'))
if record['artifactDigest']!=manifest['artifactDigest'] or plan['artifactDigest']!=manifest['artifactDigest']:raise ValueError('Genesis artifact digest mismatch')
dual=plan.get('candidateArtifactDigest') is not None
if dual:
 for key in ['candidateArtifactDigest']:
  if not re.fullmatch(r'0x[a-fA-F0-9]{64}',plan.get(key,'')):raise ValueError('Fill reviewed '+key)
 if plan['candidateArtifactDigest'].lower()==plan['artifactDigest'].lower():raise ValueError('Candidate must differ from genesis')
 for key in ['genesisBundleSha256','genesisManifestSha256','integratedUpgradeEvidenceSha256',
             'productSnippetSha256','indexUnitSha256','trustedRecordSha256']:
  if not re.fullmatch(r'[a-f0-9]{64}',plan.get(key,'')):raise ValueError('Fill reviewed '+key)
 if hashlib.sha256(args.manifest.read_bytes()).hexdigest()!=plan['genesisManifestSha256']:
  raise ValueError('Preserved genesis manifest bytes differ from reviewed SHA256')
elif any(key in plan for key in ['genesisBundleSha256','genesisManifestSha256','integratedUpgradeEvidenceSha256']):
 raise ValueError('Dual-graph evidence requires candidateArtifactDigest')
plan.update(record=record,manifest=manifest)
template=(HERE/'product-v2-update.remote.py.template').read_text(encoding='utf8')
options=next(node for node in ast.parse(template).body if isinstance(node,ast.FunctionDef) and node.name=='release_options')
namespace={'re':re};exec(compile(ast.Module(body=[options],type_ignores=[]),'release-options','exec'),namespace)
namespace['release_options'](plan)
args.out.mkdir(exist_ok=False)
for phase in ['prepare','activate','rollback']:
 source=template.replace('__CONFIG_JSON__',repr(json.dumps(plan))).replace('__PHASE__',repr(phase))
 compile(source,'product-v2-'+phase+'.py','exec')
 (args.out/('product-v2-'+phase+'.py')).write_text(source,encoding='utf8')
(args.out/'reviewed-plan.json').write_text(json.dumps(plan,indent=2),encoding='utf8')
print(json.dumps({'localOnly':True,'directory':str(args.out),'phases':['prepare','activate','rollback']}))
