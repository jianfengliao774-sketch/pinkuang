"""Reviewed HOLD-only switch. No chain writes, sessions, relay enable or DB writes."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time

PUBLIC = 'pinkuang-deploy-v4.service'
SIGNER = 'pinkuang-v4-signer.service'
HEADER = 'X-Pinkuang-Activation-Protocol'
VERSION = '2'


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def load_helper(path, digest):
    import hashlib
    import stat
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022
            and info.st_nlink == 1 and path.resolve() == path,
            'Helper must be a root-owned canonical regular file.')
    require(hashlib.sha256(path.read_bytes()).hexdigest() == digest, 'Reviewed helper hash differs.')
    spec = importlib.util.spec_from_file_location('held_helper_' + digest[:12], path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def replacement(original):
    old = b'Environment=BEMINE_FRESH_STAGE2_HOLD=1\n'
    require(original.count(old) == 1
            and len(re.findall(rb'BEMINE_FRESH_STAGE2_HOLD', original)) == 1,
            'HOLD replacement is ambiguous.')
    return original.replace(old, b'Environment=BEMINE_FRESH_STAGE2_HOLD=0\n')


def validate_plan(p):
    keys = {'schemaVersion', 'operationId', 'releaseId', 'sourceHead', 'manifestSha256',
            'unitSha256', 'publicDropInSha256', 'journalSha256', 'artifactSha256',
            'artifactDigest', 'account', 'deploymentId', 'signerReleaseId',
            'signerManifestSha256', 'signerUnitSha256', 'updaterSha256',
            'attestorHelperSha256', 'chainProofSha256', 'protocolEvidenceSha256'}
    require(isinstance(p, dict) and set(p) == keys and p['schemaVersion'] == 1, 'Invalid plan fields.')
    require(re.fullmatch(r'hold-release-[a-z0-9-]{1,60}', p['operationId']), 'Invalid operation ID.')
    for name in ('releaseId', 'signerReleaseId'):
        require(re.fullmatch(r'v4-[a-z0-9][a-z0-9-]{1,70}', p[name]), 'Invalid release ID.')
    require(re.fullmatch(r'[a-f0-9]{40}', p['sourceHead']), 'Invalid source commit.')
    for name in keys:
        if name.endswith('Sha256'):
            require(re.fullmatch(r'[a-f0-9]{64}', p[name]), 'Invalid reviewed digest.')
    require(re.fullmatch(r'0x[0-9a-fA-F]{40}', p['account'])
            and int(p['account'], 16) != 0
            and re.fullmatch(r'0x[0-9a-f]{64}', p['artifactDigest'])
            and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,159}', p['deploymentId']),
            'Invalid deployment identity.')
    return p


def validate_evidence(p, chain, protocol, now=None):
    now = time.time() if now is None else now
    require(chain.get('schemaVersion') == 1 and chain.get('fullDeploymentVerified') is True
            and chain.get('chainId') == 56 and chain.get('sourceHead') == p['sourceHead']
            and chain.get('artifactDigest') == p['artifactDigest']
            and chain.get('journalSha256') == p['journalSha256']
            and chain.get('account', '').lower() == p['account'].lower()
            and chain.get('deploymentId') == p['deploymentId'], 'Chain evidence identity differs.')
    try:
        checked = datetime.fromisoformat(chain['checkedAt'].replace('Z', '+00:00'))
        require(checked.tzinfo is not None, 'Evidence timestamp lacks timezone.')
        age = now - checked.timestamp()
    except (KeyError, ValueError, TypeError):
        raise RuntimeError('Invalid evidence timestamp.') from None
    require(0 <= age <= 300, 'Chain evidence is stale; obtain a fresh reviewed proof.')
    require(type(chain.get('blockNumber')) is int and chain['blockNumber'] > 0
            and re.fullmatch(r'0x[0-9a-fA-F]{64}', chain.get('blockHash', ''))
            and type(chain.get('nonce')) is int and chain['nonce'] >= 0,
            'Invalid chain evidence block or nonce.')
    require(protocol.get('schemaVersion') == 1 and protocol.get('sourceHead') == p['sourceHead']
            and protocol.get('header') == HEADER and protocol.get('version') == VERSION
            and protocol.get('realHttpIntegrationPassed') is True
            and protocol.get('authenticatedMissingVersionStatus') == 426
            and protocol.get('unauthenticatedStatus') == 401,
            'Reviewed protocol HTTP regression evidence is missing.')


CHAIN_JS = r'''
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [root] = process.argv.slice(1);
try {
 const { JsonRpcProvider, FetchRequest, Interface } = await import(pathToFileURL(root+'/node_modules/ethers/lib.esm/index.js'));
 const { rpc, proof, account, factory, portfolioFactory } = JSON.parse(readFileSync(0,'utf8'));
 const request = new FetchRequest(rpc); request.timeout=9000;
 const provider = new JsonRpcProvider(request,56,{staticNetwork:true,batchMaxCount:1,cacheTimeout:-1});
 try {
  if (BigInt(await provider.send('eth_chainId',[]))!==56n) throw Error();
  const anchor=await provider.send('eth_getBlockByNumber',['0x'+proof.blockNumber.toString(16),false]);
  const block=await provider.send('eth_getBlockByNumber',['latest',false]);
  if (!anchor || anchor.hash.toLowerCase()!==proof.blockHash.toLowerCase() || !block
   || BigInt(block.number)<BigInt(anchor.number) || Math.abs(Date.now()/1000-Number(BigInt(block.timestamp)))>60) throw Error();
  const abi=new Interface(['function owner() view returns(address)','function operator() view returns(address)',
   'function treasury() view returns(address)','function poolCount() view returns(uint256)',
   'function portfolioCount() view returns(uint256)','function creationPaused() view returns(bool)']);
  for (const [target,count] of [[factory,'poolCount'],[portfolioFactory,'portfolioCount']]) {
   for (const role of ['owner','operator','treasury',count,'creationPaused']) {
    const raw=await provider.send('eth_call',[{to:target,data:abi.encodeFunctionData(role)},block.number]);
    const value=abi.decodeFunctionResult(role,raw)[0];
    if (role===count ? value!==0n : role==='creationPaused' ? value!==false : value.toLowerCase()!==account.toLowerCase()) throw Error();
   }
  }
  const after=await provider.send('eth_getBlockByNumber',[block.number,false]);
  const latest=await provider.send('eth_getTransactionCount',[account,'latest']);
  const pending=await provider.send('eth_getTransactionCount',[account,'pending']);
  if (!after || after.hash!==block.hash || BigInt(latest)!==BigInt(proof.nonce) || pending!==latest) throw Error();
  console.log(JSON.stringify({verified:true,blockNumber:Number(BigInt(block.number)),blockHash:block.hash,nonce:Number(BigInt(latest))}));
 } finally {provider.destroy();}
} catch { console.log(JSON.stringify({verified:false,error:'chain_prefix_or_nonce_unverified'})); process.exitCode=1; }
'''


class Host:
    def __init__(self, updater, attestor):
        self.u, self.a = updater, attestor
        self.h = attestor.Host()

    def protected(self):
        return self.h.protected()

    def run(self, args):
        return self.u.run(args)

    def package(self, p):
        root = self.u.RELEASES / p['releaseId']
        self.a.safe_parents(root)
        raw = self.u.regular(root / 'public/fresh-release-manifest.json')
        require(self.u.sha(raw) == p['manifestSha256'], 'Public manifest changed.')
        m = json.loads(raw)
        require(m.get('sourceHead') == p['sourceHead'] and m.get('artifactDigest') == p['artifactDigest']
                and m.get('kind') == 'fresh-console-pre-genesis' and m.get('chainId') == 56,
                'Public release identity differs.')
        files = set()
        for parent, dirs, names in os.walk(root, followlinks=False):
            for name in list(dirs):
                child = Path(parent) / name
                self.a.safe_parents(child)
                if child == root / 'node_modules':
                    dirs.remove(name)
            for name in names:
                child = Path(parent) / name
                self.a.safe_regular(child)
                files.add(child.relative_to(root).as_posix())
        require(files == set(m['files']) | {'public/fresh-release-manifest.json'}, 'Public file inventory differs.')
        for name, spec in m['files'].items():
            require(not Path(name).is_absolute() and '..' not in Path(name).parts and '\\' not in name, 'Unsafe manifest path.')
            data = self.u.regular(root / name)
            require(self.u.sha(data) == spec['sha256'] and len(data) == spec['bytes'], 'Runtime source changed.')
        require(all(self.u.sha(self.u.regular(root / path)) == p['artifactSha256']
                    for path in ('public/deployment-artifacts.json', 'dist/deployment-artifacts.json')),
                'Solidity artifact differs.')
        self.a.validate_package(Path('/srv/pinkuang-v4-signer/releases') / p['signerReleaseId'],
                                {'manifestSha256': p['signerManifestSha256'], 'sourceCommit': p['sourceHead']}, installed=True)

    def configuration(self, p, hold, *, active=True):
        require(self.u.sha(self.u.regular(self.u.UNIT)) == p['unitSha256'], 'Public main unit changed.')
        # A failed reload after our own CAS can leave NeedDaemonReload=yes.
        # Only while stopped, check the disk inventory without requiring reload;
        # main-unit hash and exact same drop-in path still must match.
        class StoppedView:
            path = self.h.path
            def show(inner, service):
                return {**self.h.show(service), 'NeedDaemonReload': 'no'}
        self.a.no_dropins(self.h if active else StoppedView(), PUBLIC, expected=self.a.DROP_IN)
        self.a.no_dropins(self.h, SIGNER)
        require(self.u.sha(self.u.regular(Path(self.a.SIGNER_UNIT))) == p['signerUnitSha256'], 'Signer main unit changed.')
        signer = self.h.show(SIGNER)
        require(signer.get('ActiveState') == 'active' and signer.get('User') == self.a.USER
                and signer.get('Group') == self.a.GROUP and signer.get('PrivateNetwork') == 'yes'
                and signer.get('RestrictAddressFamilies') == 'AF_UNIX'
                and signer.get('WorkingDirectory') == '/srv/pinkuang-v4-signer/releases/' + p['signerReleaseId'],
                'Private signer isolation differs.')
        env = self.u.environment(int(signer['MainPID']))
        require(env.get('AUTHORITY_SIGNER_ATTEST_ONLY') == '1' and env.get('AUTHORITY_RELAY_ENABLED') == '0'
                and env.get('BEMINE_EXPECTED_GAS_WALLET') == self.a.GAS
                and not any('PRIVATE_KEY' in k for k in env), 'Signer is not proof-only.')
        credentials = Path(env.get('CREDENTIALS_DIRECTORY', '/nonexistent'))
        require(credentials.is_dir() and {p.name for p in credentials.iterdir()}
                == {'authority-ipc-hmac', 'keeper-private-key'}, 'Signer credentials differ.')
        state = self.h.show(PUBLIC)
        require(state.get('WorkingDirectory') == str(self.u.RELEASES / p['releaseId'])
                and state.get('FragmentPath') == str(self.u.UNIT)
                and state.get('User') == 'pinkuang-v4' and state.get('Group') == 'pinkuang-v4',
                'Public service identity differs.')
        if not active:
            require(state.get('ActiveState') == 'inactive' and state.get('MainPID') == '0', 'Public service is not stopped.')
            return
        require(state.get('ActiveState') == 'active', 'Public service is not active.')
        env = self.u.environment(int(state['MainPID']))
        expected = {**self.u.FLAGS, 'BEMINE_FRESH_STAGE2_HOLD': str(hold)}
        require(all(env.get(k) == v for k, v in expected.items())
                and not any('PRIVATE_KEY' in k for k in env)
                and env.get('AUTHORITY_RELAY_SOCKET') == self.a.SOCKET
                and env.get('BEMINE_EXPECTED_GAS_WALLET') == self.a.GAS,
                'Public flags or key isolation differ.')
        credentials = Path(env.get('CREDENTIALS_DIRECTORY', '/nonexistent'))
        require(credentials.is_dir() and {p.name for p in credentials.iterdir()} == {'authority-ipc-hmac'},
                'Public credentials differ.')

    def chain(self, p, proof):
        state = self.h.show(PUBLIC)
        rpc = self.u.environment(int(state['MainPID'])).get('DEPLOYMENT_JOURNAL_RPC_URL')
        require(rpc and rpc.startswith('https://'), 'Live BSC RPC is unavailable.')
        with closing(sqlite3.connect(f'file:{self.u.DB}?mode=ro', uri=True)) as db:
            record = json.loads(db.execute('SELECT record FROM deployment').fetchone()[0])
        inputs = {'rpc': rpc, 'proof': proof, 'account': p['account'],
                  'factory': record['addresses']['factory'], 'portfolioFactory': record['addresses']['portfolioFactory']}
        out = self.u.run(['/usr/bin/node', '--input-type=module', '--eval', CHAIN_JS,
                          str(self.u.RELEASES / p['releaseId'])], input=json.dumps(inputs), timeout=150)
        result = json.loads(out)
        require(result.get('verified') is True and result.get('nonce') == proof['nonce'], 'Chain prefix or nonce changed.')
        return result

    def proof(self, p):
        challenge = {'chainId': 56, 'origin': self.a.ORIGIN, 'deploymentAccount': p['account'],
                     'deploymentId': p['deploymentId'], 'artifactDigest': p['artifactDigest'],
                     'expectedGasWallet': self.a.GAS}
        result = self.u.run(['systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--service-type=exec',
            '--unit=' + p['operationId'] + '-proof-' + str(time.time_ns()),
            '--property=User=pinkuang-v4', '--property=Group=pinkuang-v4',
            '--property=SupplementaryGroups=' + self.a.GROUP,
            '--property=LoadCredential=authority-ipc-hmac:' + self.a.HMAC,
            '--property=PrivateNetwork=true', '--property=RestrictAddressFamilies=AF_UNIX',
            '--property=NoNewPrivileges=true', '--property=ProtectSystem=strict',
            '--property=ProtectHome=true', '--property=PrivateTmp=true', '--property=RuntimeMaxSec=20',
            '/usr/bin/node', '--input-type=module', '--eval', self.a.PROBE_JS,
            '/srv/pinkuang-v4-signer/releases/' + p['signerReleaseId'], json.dumps(challenge)], timeout=30)
        require(json.loads(result) == {'verified': True, 'gasWallet': self.a.GAS, 'relayDisabled': True},
                'Gas possession proof failed.')

    def health(self, p):
        self.h.wait_public()
        self.u.status('http://127.0.0.1:4177/', 200,
                      self.u.regular(self.u.RELEASES / p['releaseId'] / 'dist/index.html'))
        # Anonymous real HTTP checks, never a manufactured wallet session.
        self.h.health()


class Release:
    def __init__(self, host, p, chain, protocol):
        self.h = host; self.u = host.u; self.p = validate_plan(p)
        self.chain = chain; self.protocol = protocol
        self.drop = self.u.DROPINS / '20-stage2-attestation.conf'
        self.evidence = Path('/var/lib/pinkuang-v4-attestor-ops') / p['operationId']

    def cas(self, expected, replacement_data):
        require(self.u.regular(self.drop) == expected, 'Drop-in changed independently; CAS refused.')
        self.u.install_text(self.drop, replacement_data)

    def preflight(self):
        validate_evidence(self.p, self.chain, self.protocol)
        self.h.package(self.p)
        self.original = self.u.regular(self.drop)
        require(self.u.sha(self.original) == self.p['publicDropInSha256'], 'Reviewed drop-in changed.')
        self.updated = replacement(self.original)
        self.h.configuration(self.p, 1)
        self.u.journal_snapshot(self.p)
        self.protected = self.h.protected()
        self.h.health(self.p)
        self.h.proof(self.p)
        self.chain_read = self.h.chain(self.p, self.chain)
        self.u.journal_snapshot(self.p)
        require(self.h.protected() == self.protected, 'Protected service changed.')
        return {'dryRun': True, 'readyForHoldRelease': True, 'sourceHead': self.p['sourceHead'],
                'chain': self.chain_read, 'relayEnabled': False, 'stage2TransactionsSent': False,
                'authenticated426VerifiedBy': 'pinned-real-HTTP-regression-only'}

    def apply(self):
        self.preflight()
        require(not self.evidence.exists(), 'Operation evidence already exists; re-review before retry.')
        self.evidence.mkdir(mode=0o700, parents=True)
        (self.evidence / 'reviewed-plan.json').write_bytes(self.u.canonical(self.p) + b'\n')
        (self.evidence / 'original-dropin.conf').write_bytes(self.original)
        touched = False
        try:
            # Fresh proof/nonce immediately before the brief process stop; no RPC while stopped.
            validate_evidence(self.p, self.chain, self.protocol)
            self.h.chain(self.p, self.chain)
            self.h.configuration(self.p, 1)
            self.u.journal_snapshot(self.p)
            require(self.u.regular(self.drop) == self.original, 'Drop-in changed before stop.')
            touched = True
            self.h.run(['systemctl', 'stop', PUBLIC])
            self.h.configuration(self.p, 1, active=False)
            self.u.journal_snapshot(self.p)
            self.cas(self.original, self.updated)
            self.h.run(['systemctl', 'daemon-reload'])
            self.h.run(['systemctl', 'start', PUBLIC])
            self.h.health(self.p)
            self.h.configuration(self.p, 0)
            require(self.u.regular(self.drop) == self.updated, 'Changed drop-in after restart.')
            self.u.journal_snapshot(self.p)
            self.h.proof(self.p)
            require(self.h.protected() == self.protected, 'Protected service identity changed.')
            result = {'released': True, 'stage2Held': False, 'preGenesis': True, 'relayEnabled': False,
                      'onChainActivationComplete': False, 'transactionsSent': False,
                      'sourceHead': self.p['sourceHead'], 'dropInSha256': self.u.sha(self.updated)}
            (self.evidence / 'result.json').write_bytes(self.u.canonical(result) + b'\n')
            return result
        except Exception:
            if touched:
                self.h.run(['systemctl', 'stop', PUBLIC])
                # Never overwrite another operator's changes, and never restore journal contents.
                require(self.u.sha(self.u.regular(self.u.UNIT)) == self.p['unitSha256'],
                        'Main unit changed; automatic rollback refused, public service left stopped.')
                self.h.configuration(self.p, 0, active=False)
                current = self.u.regular(self.drop)
                require(current in (self.original, self.updated), 'Drop-in changed; automatic rollback refused.')
                if current == self.updated:
                    self.cas(self.updated, self.original)
                self.h.run(['systemctl', 'daemon-reload'])
                self.h.run(['systemctl', 'start', PUBLIC])
                self.h.health(self.p)
                self.h.configuration(self.p, 1)
                require(self.h.protected() == self.protected, 'Protected service changed during rollback.')
                (self.evidence / 'result.json').write_text('{"released":false,"rolledBackToHold":true,"journalRestored":false}\n')
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('plan', 'updater', 'attestor-helper', 'chain-proof', 'protocol-evidence'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--plan-sha256', required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--dry-run', action='store_true'); mode.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    require(sys.platform == 'linux' and os.geteuid() == 0 and __debug__, 'Root Linux without -O is required.')
    os.umask(0o077)
    import hashlib
    require(args.plan.resolve() == args.plan and not args.plan.is_symlink(), 'Unsafe plan path.')
    raw = args.plan.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == args.plan_sha256, 'Reviewed plan hash differs.')
    p = validate_plan(json.loads(raw))
    u = load_helper(args.updater, p['updaterSha256'])
    a = load_helper(args.attestor_helper, p['attestorHelperSha256'])
    a.safe_regular(args.plan, private=True, max_bytes=65536)
    evidence = []
    for path, key in ((args.chain_proof, 'chainProofSha256'), (args.protocol_evidence, 'protocolEvidenceSha256')):
        a.safe_regular(path, max_bytes=65536)
        data = path.read_bytes()
        require(u.sha(data) == p[key], 'Pinned evidence hash differs.')
        evidence.append(json.loads(data))
    release = Release(Host(u, a), p, *evidence)
    print(json.dumps(release.preflight() if args.dry_run else release.apply(), separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Exceptions may originate in dependencies or RPC: never print their private bodies.
        print('{"released":false,"error":"hold_release_rejected_review_private_state"}')
        sys.exit(1)
