#!/usr/bin/env python3
"""Replace the existing v5 graph without replacing Gas credentials or nonce locks.

Run prepare, activate, then publish after reviewing local readiness. The former
website symlink is preserved until publish. This script never signs a transaction.
Runtime services may sign only after activate starts the reviewed existing workers.
Rollback is allowed only if the shared Gas nonce has not advanced.
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse
import fcntl
import hashlib
import json
import os
import pwd
import re
import shutil
import subprocess
import urllib.request

CONFIG = Path('/etc/pinkuang-v5')
SYSTEMD = Path('/etc/systemd/system')
CURRENT = Path('/var/www/bemine-v5/current')
SIGNER = Path('/var/lib/pinkuang-v5-signer')
STATE = [Path('/var/lib/pinkuang-product-v5'), Path('/var/lib/pinkuang-index-v5')]
UNITS = ['pinkuang-index-v5', 'pinkuang-product-v5', 'pinkuang-v5-purchase',
         'pinkuang-v5-mining', 'pinkuang-v5-signer', 'pinkuang-v5-price']
LEGACY = ['pinkuang-purchase-v2', 'pinkuang-v4-purchase', 'pinkuang-v4-mining', 'pinkuang-v4-signer']
GAS = '0xA285d1933e32b5990625aC1F5BEa205Cf2606619'
NEW_FACTORY = '0xCFc7D864DeB615bE04C7f6ac62875c2092C5b1B9'
NEW_BUDGET = '0x533199B4E535C03BBAB4EC3fcf9B69aD16936065'
NEW_AUTHORITY = '0xE549DDF776312c1Bf6E1DB0Ce647f92ca998953c'
NEW_TIMELOCK = '0x2c0AaE63302A7bF7caF5322Cdfc9da67d4ec8F97'

def need(ok, message):
    if not ok:
        raise RuntimeError(message)

def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def copy_tree(source, target):
    """Preserve private state ownership as well as modes and file contents."""
    source, target = Path(source), Path(target)
    shutil.copytree(source, target, symlinks=True)
    for old in [source, *source.rglob('*')]:
        new = target / old.relative_to(source)
        info = old.lstat()
        os.chown(new, info.st_uid, info.st_gid, follow_symlinks=False)

def load(path):
    return json.loads(Path(path).read_text())

def same(a, b):
    return isinstance(a, str) and isinstance(b, str) and a.lower() == b.lower()

def run(*args):
    result = subprocess.run(args, check=False, capture_output=True, text=True)
    # Commands may receive RPC configuration through systemd. Never echo their
    # complete command, stdout or stderr on failure.
    need(result.returncode == 0, 'A required system command failed: ' + str(args[0]))
    return result.stdout

def atomic_json(path, value):
    path = Path(path)
    temp = path.with_name(path.name + '.tmp-' + str(os.getpid()))
    try:
        with temp.open('x') as stream:
            json.dump(value, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        temp.chmod(0o600)
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()

def receipt(path, phase, **fields):
    value = load(path / 'receipt.json')
    value.update(phase=phase, checkedAt=datetime.now(timezone.utc).isoformat(), **fields)
    atomic_json(path / 'receipt.json', value)
    return value

def state(unit):
    lines = run('systemctl', 'show', unit + '.service',
                '--property=ActiveState,MainPID,LoadState,UnitFileState').strip().splitlines()
    return dict(line.split('=', 1) for line in lines if '=' in line)

def legacy_off():
    for unit in LEGACY:
        value = state(unit)
        need(value.get('ActiveState') == 'inactive' and value.get('MainPID') == '0'
             and (value.get('LoadState') == 'not-found'
                  or value.get('UnitFileState') in ['disabled', 'masked']),
             'An older Gas sender remains active or enabled: ' + unit)

def stop_all():
    run('systemctl', 'stop', *(unit + '.service' for unit in UNITS))
    for unit in UNITS:
        value = state(unit)
        need(value.get('ActiveState') == 'inactive' and value.get('MainPID') == '0',
             'An existing runtime has not stopped: ' + unit)

def require_empty_old_financial_journals():
    need(not (SIGNER / 'authority/authority.json').exists(),
         'An old Authority relay journal requires reconciliation before graph replacement.')
    for name in ['purchase', 'mining']:
        need(not list((SIGNER / name).rglob('*.json')),
             'An old automatic-worker journal requires reconciliation before graph replacement.')

def chain_proof(runtime, record, activation, verify=True):
    """Use the protected read-only RPC URL in-process; emit only public facts."""
    javascript = r'''
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {pathToFileURL} from 'node:url';
const [runtime,recordPath,activationPath,verify]=process.argv.slice(1);
const {JsonRpcProvider,FetchRequest}=await import(pathToFileURL(runtime+'/node_modules/ethers/lib.esm/index.js'));
const env=parseEnv(readFileSync('/etc/pinkuang-v5/rpc.env','utf8'));
const request=new FetchRequest(env.DEPLOYMENT_JOURNAL_RPC_URL);request.timeout=15000;
const provider=new JsonRpcProvider(request,56,{staticNetwork:true,batchMaxCount:1});
try {
 const gas='0xA285d1933e32b5990625aC1F5BEa205Cf2606619';
 const latest=await provider.getTransactionCount(gas,'latest'),pending=await provider.getTransactionCount(gas,'pending');
 if(latest!==pending)throw Error('pending');
 const result={latestNonce:latest,pendingNonce:pending};
 if(verify==='yes') {
  const {productGraphConfiguration,verifyProductGraph}=await import(pathToFileURL(runtime+'/server/product-graph.mjs'));
  const {freshGraphIdentity}=await import(pathToFileURL(runtime+'/shared/fresh-runtime-identity.mjs'));
  const {verifyFreshLegacyDrain}=await import(pathToFileURL(runtime+'/server/fresh-machine-readiness.mjs'));
  const trusted=productGraphConfiguration({recordPath,bundlePath:runtime+'/public/deployment-artifacts.json',productActivationPath:activationPath,expectedGasWallet:gas});
  const block=await provider.getBlock('finalized');
  const graph=await verifyProductGraph(provider,trusted.record.addresses.factory,trusted,block);
  if(!graph.freshFactoryVerified||!graph.freshAuthority)throw Error('graph');
  const drain=await verifyFreshLegacyDrain(provider,freshGraphIdentity(graph));
  Object.assign(result,{factory:graph.factory,portfolioFactory:graph.portfolioFactory,authority:graph.freshAuthority.address,artifactDigest:graph.artifactDigest,blockNumber:graph.blockNumber,blockHash:block.hash,oldSendersDisabled:drain.oldSendersDisabled});
 }
 const lastLatest=Number(BigInt(await provider.send('eth_getTransactionCount',[gas,'latest']))),
       lastPending=Number(BigInt(await provider.send('eth_getTransactionCount',[gas,'pending'])));
 if(lastLatest!==latest||lastPending!==latest)throw Error('nonce changed');
 console.log(JSON.stringify(result));
}catch {console.error('Read-only graph or shared Gas drain verification failed.');process.exitCode=1;}
finally {provider.destroy();}
'''
    env = dict(os.environ, BEMINE_FRESH_RUNTIME_VERSION='5')
    result = subprocess.run(['/usr/bin/node', '--input-type=module', '-e', javascript,
                             str(runtime), str(record), str(activation), 'yes' if verify else 'no'],
                            capture_output=True, text=True, env=env, timeout=120)
    need(result.returncode == 0, 'Read-only graph or shared Gas drain verification failed.')
    return json.loads(result.stdout)

def set_line(text, key, value, append=False):
    pattern = re.compile(r'^' + re.escape(key) + r'=.*$', re.M)
    count = len(pattern.findall(text))
    need(count == 1 or append and count == 0, 'Unexpected configuration key: ' + key)
    return pattern.sub(lambda _match: key + '=' + value, text) if count else text + key + '=' + value + '\n'

def require_environment(text, key, value):
    pattern = re.compile(r'^Environment=' + re.escape(key) + r'=.*$', re.M)
    need(len(pattern.findall(text)) == 1, 'Unexpected service environment key: ' + key)
    return pattern.sub(lambda _match: 'Environment=' + key + '=' + value, text)

def configured_unit(unit, original, plan):
    """Keep reviewed hardening/credential bindings; replace only graph/source pins."""
    if unit == 'pinkuang-v5-price':
        # The price service has no graph binding and its scripts are not in the
        # product backend package. Keep its independent reviewed price runtime.
        return original
    text = set_line(original, 'WorkingDirectory', plan['runtime'])
    if unit == 'pinkuang-index-v5':
        text = require_environment(text, 'CHAIN_INDEX_FRESH_MANIFEST_PATH', plan['runtime'] + '/public/fresh-product-manifest.json')
        text = require_environment(text, 'CHAIN_INDEX_FRESH_MANIFEST_SHA256', plan['indexManifestSha256'])
    if unit == 'pinkuang-product-v5':
        text = require_environment(text, 'BEMINE_FRESH_PRODUCT_MANIFEST_PATH', plan['runtime'] + '/public/fresh-product-manifest.json')
        text = require_environment(text, 'BEMINE_FRESH_PRODUCT_MANIFEST_SHA256', plan['indexManifestSha256'])
    if unit == 'pinkuang-v5-signer':
        # The reference publisher's financial ledger is bound to its Factory.
        # Preserve the old ledger and nonce lock domain; use a new graph-specific
        # ledger under the same reviewed private parent directory.
        reference = '/var/lib/pinkuang-v5-signer/authority/sale-reference-' + plan['factory'][2:14].lower() + '.json'
        text = require_environment(text, 'SALE_REFERENCE_PUBLISHER_JOURNAL', reference)
    if unit in ['pinkuang-v5-purchase', 'pinkuang-v5-mining']:
        text, count = re.subn(r'--factory 0x[0-9a-fA-F]{40}', '--factory ' + plan['factory'], text)
        need(count == 1, 'Unexpected supervisor factory binding.')
    if unit == 'pinkuang-v5-mining':
        text, count = re.subn(r'--authority 0x[0-9a-fA-F]{40}', '--authority ' + plan['authority'], text)
        need(count == 1, 'Unexpected mining Authority binding.')
    return text

def validate_inputs(args):
    runtime = args.runtime.resolve()
    need(runtime == args.runtime and re.fullmatch(r'/srv/pinkuang-v5/releases/v5-[a-z0-9][a-z0-9-]{1,70}', str(runtime)),
         'Runtime must be a canonical immutable v5 release directory.')
    metadata = load(runtime / 'public/fresh-release-manifest.json')
    need(metadata.get('kind') == 'fresh-v4-product-backend-draft'
         and metadata.get('chainId') == 56 and re.fullmatch(r'[0-9a-f]{40}', metadata.get('sourceHead', '')),
         'A committed product-backend package is required.')
    for name, entry in metadata['files'].items():
        path = runtime / name
        need(not Path(name).is_absolute() and '..' not in Path(name).parts
             and path.is_file() and not path.is_symlink() and not path.stat().st_mode & 0o022
             and sha(path) == entry['sha256'],
             'An immutable package file differs: ' + name)
    need((runtime / 'node_modules/ethers/lib.esm/index.js').is_file(), 'Staged runtime dependencies are missing.')
    record = args.record or args.inputs / 'genesis.json'
    activation = args.activation or args.inputs / 'fresh-activation.json'
    index = load(runtime / 'public/fresh-product-manifest.json')
    need(same(index.get('factory'), NEW_FACTORY) and same(index.get('portfolioFactory'), NEW_BUDGET)
         and same(index.get('authority'), NEW_AUTHORITY) and same(index.get('timelock'), NEW_TIMELOCK)
         and same(index.get('gasWallet'), GAS) and same(index.get('artifactDigest'), metadata['artifactDigest']),
         'Package graph differs from the latest reviewed mainnet deployment.')
    need(sha(runtime / 'public/fresh-product-manifest.json') == metadata['indexManifestSha256'],
         'Index manifest bytes differ from the package.')
    need(record.is_file() and activation.is_file(), 'Reviewed genesis/activation inputs are missing.')
    return runtime, record.resolve(), activation.resolve(), metadata, index

def prepare(args):
    runtime, record, activation, metadata, index = validate_inputs(args)
    need(not args.backup.exists(), 'Backup directory already exists; use its recorded phase.')
    need(CURRENT.is_symlink() and CURRENT.resolve().is_dir(), 'Current static release is not preserved.')
    legacy_off()
    proof = chain_proof(runtime, record, activation)
    need(same(proof['factory'], NEW_FACTORY) and same(proof['authority'], NEW_AUTHORITY), 'Live graph differs.')
    for file in ['/etc/pinkuang/keeper.key', '/etc/pinkuang-v4/authority-ipc-hmac']:
        need(Path(file).is_file(), 'An existing systemd credential is missing.')
    need(SIGNER.is_dir() and (SIGNER / 'keeper').is_dir(), 'Existing wallet nonce lock root is missing.')
    require_empty_old_financial_journals()
    args.backup.mkdir(mode=0o700, parents=True)
    copy_tree(CONFIG, args.backup / 'config')
    units = args.backup / 'systemd'
    units.mkdir(mode=0o700)
    for unit in UNITS:
        path = SYSTEMD / (unit + '.service')
        need(path.is_file() and not path.is_symlink(), 'Unexpected installed unit: ' + unit)
        shutil.copy2(path, units / path.name)
        dropin = SYSTEMD / (unit + '.service.d')
        if dropin.exists():
            allowed = {'pinkuang-product-v5': {'40-backend-audit.conf'},
                       'pinkuang-index-v5': {'20-read-throughput.conf'}}.get(unit, set())
            need({x.name for x in dropin.iterdir()} <= allowed, 'An unreviewed service override exists: ' + unit)
            copy_tree(dropin, units / dropin.name)
    shutil.copy2(record, args.backup / 'new-trusted-product-deployment.json')
    shutil.copy2(activation, args.backup / 'new-fresh-activation.json')
    plan = {'runtime': str(runtime), 'sourceHead': metadata['sourceHead'], 'artifactDigest': metadata['artifactDigest'],
            'runtimeManifestSha256': sha(runtime / 'public/fresh-release-manifest.json'),
            'indexManifestSha256': metadata['indexManifestSha256'], 'factory': NEW_FACTORY,
            'portfolioFactory': NEW_BUDGET, 'authority': NEW_AUTHORITY, 'gasWallet': GAS,
            'oldStatic': str(CURRENT.resolve()), 'oldStaticManifestSha256': sha(CURRENT / 'fresh-product-release.json'),
            'cutoverNonce': proof['latestNonce'], 'graphProof': proof,
            'configHashes': {str(p.relative_to(CONFIG)): sha(p) for p in CONFIG.rglob('*') if p.is_file()},
            'unitHashes': {str(p.relative_to(units)): sha(p) for p in units.rglob('*') if p.is_file()}}
    # Prove transforms before touching services.
    for unit in UNITS:
        configured_unit(unit, (units / (unit + '.service')).read_text(), plan)
    atomic_json(args.backup / 'plan.json', plan)
    atomic_json(args.backup / 'receipt.json', {'schemaVersion': 1, 'phase': 'prepared', 'sourceHead': plan['sourceHead'],
                                              'factory': NEW_FACTORY, 'backup': str(args.backup), 'websitePublished': False})
    print(json.dumps({'phase': 'prepared', 'backup': str(args.backup), 'factory': NEW_FACTORY,
                      'sourceHead': plan['sourceHead'], 'nonce': proof['latestNonce']}))

def verify_unchanged(plan, backup):
    need(str(CURRENT.resolve()) == plan['oldStatic'] and sha(CURRENT / 'fresh-product-release.json') == plan['oldStaticManifestSha256'],
         'Static release changed after preparation.')
    need(sha(Path(plan['runtime']) / 'public/fresh-release-manifest.json') == plan['runtimeManifestSha256'],
         'Staged runtime changed after preparation.')
    need({str(p.relative_to(CONFIG)) for p in CONFIG.rglob('*') if p.is_file()} == set(plan['configHashes']),
         'Installed configuration inventory changed after preparation.')
    for name, digest in plan['configHashes'].items():
        need(sha(CONFIG / name) == digest, 'Installed configuration changed after preparation: ' + name)
    for name, digest in plan['unitHashes'].items():
        need(sha(SYSTEMD / name) == digest, 'Installed unit changed after preparation: ' + name)

def activate(args):
    plan = load(args.backup / 'plan.json')
    need(load(args.backup / 'receipt.json')['phase'] == 'prepared', 'Activation requires its untouched prepared backup.')
    verify_unchanged(plan, args.backup)
    legacy_off()
    stop_all()
    receipt(args.backup, 'stopped')
    require_empty_old_financial_journals()
    proof = chain_proof(Path(plan['runtime']), args.backup / 'new-trusted-product-deployment.json', args.backup / 'new-fresh-activation.json')
    need(proof['latestNonce'] == plan['cutoverNonce'], 'Gas nonce changed after preparation; reconcile before cutover.')
    # All SQLite writers have exited. Preserve complete databases/WAL/SHM and
    # display caches together, plus nonce metadata/journals, before replacing state.
    temporary_state = args.backup / 'state.partial'
    for directory in [*STATE, SIGNER]:
        copy_tree(directory, temporary_state / directory.name)
    temporary_state.rename(args.backup / 'state')
    receipt(args.backup, 'state-backed-up')
    for source, name in [('new-trusted-product-deployment.json', 'trusted-product-deployment.json'),
                         ('new-fresh-activation.json', 'fresh-activation.json')]:
        shutil.copyfile(args.backup / source, CONFIG / name)
        (CONFIG / name).chmod(0o644)
    product = (args.backup / 'config/product.env').read_text()
    for key, value in {
        'BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH': plan['runtime'] + '/public/deployment-artifacts.json',
        'BEMINE_JOURNAL_FACTORIES': plan['factory'] + ',' + plan['portfolioFactory'],
    }.items():
        product = set_line(product, key, value)
    (CONFIG / 'product.env').write_text(product)
    (CONFIG / 'product.env').chmod(0o600)
    for unit in UNITS:
        (SYSTEMD / (unit + '.service')).write_text(configured_unit(unit,
            (args.backup / 'systemd' / (unit + '.service')).read_text(), plan))
    dropin = SYSTEMD / 'pinkuang-product-v5.service.d/40-backend-audit.conf'
    need(dropin.is_file(), 'Reviewed API source override is missing.')
    text = (args.backup / 'systemd/pinkuang-product-v5.service.d/40-backend-audit.conf').read_text()
    text = set_line(text, 'WorkingDirectory', plan['runtime'])
    pattern = re.compile(r'^ExecStart=.+$', re.M)
    need(len(pattern.findall(text)) == 1, 'Unexpected API executable override.')
    text = pattern.sub(lambda _match: 'ExecStart=/usr/bin/node ' + plan['runtime'] + '/server/index.mjs', text)
    text = require_environment(text, 'BEMINE_FRESH_MACHINE_SOURCE_HEAD', plan['sourceHead'])
    dropin.write_text(text)
    # New graph data must not reuse the old Factory's SQLite headers or caches.
    moved = {}
    user = pwd.getpwnam('pinkuang-v5-product')
    for directory in STATE:
        old = directory.with_name(directory.name + '.retired-' + args.backup.name)
        need(not old.exists(), 'Old graph archive already exists.')
        directory.rename(old)
        moved[str(directory)] = str(old)
        receipt(args.backup, 'state-replacing', movedState=moved)
        directory.mkdir(mode=0o700)
        os.chown(directory, user.pw_uid, user.pw_gid)
    # Keep keeper and signed journals unchanged. Readiness files carry process
    # identity and will be replaced by the new workers after their live scan.
    run('systemctl', 'daemon-reload')
    receipt(args.backup, 'configured', movedState=moved)
    run('systemctl', 'start', 'pinkuang-index-v5.service')
    run('systemctl', 'start', 'pinkuang-v5-purchase.service', 'pinkuang-v5-mining.service')
    run('systemctl', 'start', 'pinkuang-v5-signer.service', 'pinkuang-product-v5.service', 'pinkuang-v5-price.service')
    for unit in UNITS:
        need(state(unit)['ActiveState'] == 'active', 'A new runtime service failed to start: ' + unit)
    receipt(args.backup, 'activated', websitePublished=False)
    print(json.dumps({'phase': 'activated', 'factory': plan['factory'], 'sourceHead': plan['sourceHead'],
                      'websitePublished': False, 'oldStaticPreserved': str(CURRENT.resolve()) == plan['oldStatic']}))

def read_http(port, path):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}', timeout=30) as response:
        need(response.status == 200, 'A local readiness surface is unavailable.')
        return json.load(response)

def check_ready(plan):
    legacy_off()
    for unit in UNITS:
        need(state(unit)['ActiveState'] == 'active', 'Runtime is inactive: ' + unit)
    graph = read_http(4227, '/api/journal/product-graph')
    source = read_http(4224, '/health')['source']
    need(same(graph.get('factory'), plan['factory']) and same(graph.get('portfolioFactory'), plan['portfolioFactory'])
         and same(graph.get('artifactDigest'), plan['artifactDigest']) and graph.get('stage') == 'fresh-active'
         and same(graph.get('freshAuthority', {}).get('address'), plan['authority'])
         and graph.get('freshFactoryVerified') is True and graph.get('operationalReady') is True
         and graph.get('stale') is not True and graph.get('snapshotAgeMs', 999999) <= 20000,
         'New product graph has not proved current operational readiness.')
    need(source.get('complete') is True and not source.get('unknownReason')
         and same(source.get('factory'), plan['factory']) and same(source.get('portfolioFactory'), plan['portfolioFactory'])
         and source['indexedThrough'] == source['observedSafeHead']
         and 0 <= datetime.now(timezone.utc).timestamp() - source['indexedTimestamp'] <= 90,
         'New index has not caught up at its current safe head.')
    for route in ['/v1/display/stats', '/v1/display/pools', '/v1/display/orders']:
        need(read_http(4224, route).get('data') is not None, 'A new display surface is unavailable.')
    return {'graphBlock': graph['verifiedBlockNumber'], 'indexedThrough': source['indexedThrough'], 'operationalReady': True}

def publish(args):
    plan = load(args.backup / 'plan.json')
    need(load(args.backup / 'receipt.json')['phase'] == 'activated', 'Only an activated runtime may be published.')
    need(args.frontend is not None, 'An immutable new frontend release directory is required.')
    frontend = args.frontend.resolve()
    need(frontend == args.frontend and frontend.parent == Path('/var/www/bemine-v5/releases'), 'Unexpected static release directory.')
    manifest = load(frontend / 'fresh-product-release.json')
    need(manifest.get('frontendSourceHead') == plan['sourceHead'] and same(manifest.get('factory'), plan['factory'])
         and same(manifest.get('authority'), plan['authority']) and same(manifest.get('artifactDigest'), plan['artifactDigest'])
         and manifest.get('basePath') == '/bemine-v5' and manifest.get('publicOrigin') == 'https://bemine.cc.cd',
         'Frontend differs from the active reviewed graph and source.')
    need((frontend / 'index.html').is_file() and str(CURRENT.resolve()) == plan['oldStatic'], 'Static publication precondition changed.')
    ready = check_ready(plan)
    temp = CURRENT.with_name('current-latest-' + str(os.getpid()))
    try:
        temp.symlink_to(frontend, target_is_directory=True)
        os.replace(temp, CURRENT)
    finally:
        if temp.is_symlink():
            temp.unlink()
    receipt(args.backup, 'published', websitePublished=True, frontend=str(frontend), readiness=ready)
    print(json.dumps({'phase': 'published', 'publicUrl': 'https://bemine.cc.cd/', 'factory': plan['factory'], **ready}))

def rollback(args):
    plan = load(args.backup / 'plan.json')
    phase = load(args.backup / 'receipt.json')['phase']
    need(phase not in ['prepared', 'rolled-back'], 'No active cutover state requires rollback.')
    stop_all()
    proof = chain_proof(Path(plan['runtime']), args.backup / 'new-trusted-product-deployment.json',
                        args.backup / 'new-fresh-activation.json', verify=False)
    need(proof['latestNonce'] == plan['cutoverNonce'],
         'Gas nonce advanced: keep services stopped, preserve both journals, and reconcile before rollback.')
    # Do not erase financial state unless the shared nonce proves no new Gas
    # transaction was accepted. The protected stopped-state backup remains intact.
    saved = args.backup / 'state'
    if saved.exists():
        for directory in [*STATE, SIGNER]:
            archived = saved / directory.name
            need(archived.is_dir(), 'Stopped-state backup is incomplete.')
            if directory.exists():
                failed = directory.with_name(directory.name + '.failed-' + args.backup.name)
                need(not failed.exists(), 'Failed-runtime state was already archived.')
                directory.rename(failed)
            copy_tree(archived, directory)
    shutil.rmtree(CONFIG)
    copy_tree(args.backup / 'config', CONFIG)
    for unit in UNITS:
        path = SYSTEMD / (unit + '.service')
        shutil.copy2(args.backup / 'systemd' / path.name, path)
        dropin = SYSTEMD / (unit + '.service.d')
        if dropin.exists():
            shutil.rmtree(dropin)
        saved_dropin = args.backup / 'systemd' / dropin.name
        if saved_dropin.exists():
            copy_tree(saved_dropin, dropin)
    if str(CURRENT.resolve()) != plan['oldStatic']:
        temp = CURRENT.with_name('current-rollback-' + str(os.getpid()))
        temp.symlink_to(plan['oldStatic'], target_is_directory=True)
        os.replace(temp, CURRENT)
    run('systemctl', 'daemon-reload')
    run('systemctl', 'start', *(unit + '.service' for unit in UNITS))
    legacy_off()
    receipt(args.backup, 'rolled-back', websitePublished=False)
    print(json.dumps({'phase': 'rolled-back', 'gasNonce': proof['latestNonce'], 'static': plan['oldStatic']}))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['prepare', 'activate', 'ready', 'publish', 'rollback'])
    parser.add_argument('--backup', required=True, type=Path)
    parser.add_argument('--runtime', type=Path)
    parser.add_argument('--inputs', type=Path)
    parser.add_argument('--record', type=Path)
    parser.add_argument('--activation', type=Path)
    parser.add_argument('--frontend', type=Path)
    args = parser.parse_args()
    need(os.getuid() == 0, 'Run on the reviewed host as root.')
    need(args.backup.is_absolute() and args.backup.parent == Path('/root') and re.fullmatch(r'bemine-v5-activation-[a-z0-9-]+', args.backup.name),
         'Backup must be a new protected /root/bemine-v5-activation-* directory.')
    descriptor = os.open('/run/pinkuang-v5-activation.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another cutover phase is running; wait for its recorded result.')
        if args.phase == 'prepare':
            need(args.runtime is not None and args.runtime.is_absolute() and args.inputs is not None and args.inputs.is_absolute(),
                 'Prepare requires absolute --runtime and --inputs paths.')
            prepare(args)
        else:
            need(args.backup.is_dir() and not args.backup.is_symlink()
                 and args.backup.stat().st_uid == 0 and args.backup.stat().st_mode & 0o077 == 0,
                 'Existing cutover backup must remain protected and root-owned.')
            if args.phase == 'ready':
                print(json.dumps(check_ready(load(args.backup / 'plan.json'))))
            else:
                globals()[args.phase](args)
    finally:
        os.close(descriptor)

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Fixed custom failures are safe. Avoid dumping raw subprocess/library
        # payloads, protected environment contents or credentials.
        if isinstance(error, RuntimeError):
            print(str(error))
        else:
            print('Cutover failed; inspect the protected backup receipt and service state.')
        raise SystemExit(1)
