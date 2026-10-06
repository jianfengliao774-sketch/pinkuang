#!/usr/bin/env python3
"""Install only the reviewed v4 EIP-191 attestor. Never unblock Stage2 or relay.

The CLI accepts a separately reviewed plan hash; --dry-run changes nothing.
Payload, unit draft and pre-existing public unit are all content-pinned. The
public business DB is read-only. Failure removes only our own public drop-in
with compare-and-swap and stops only the newly installed signer.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import sqlite3
import stat
import subprocess
import sys
import time
from urllib.parse import quote

PUBLIC = 'pinkuang-deploy-v4.service'
SIGNER = 'pinkuang-v4-signer.service'
USER = 'pinkuang-v4-signer'
GROUP = 'pinkuang-v4-relay'
ORIGIN = 'https://tapeout.cc.cd'
GAS = '0xA285d1933e32b5990625aC1F5BEa205Cf2606619'
SOCKET = '/run/pinkuang-v4-relay/authority.sock'
DB = '/var/lib/pinkuang-deploy-v4/journal.sqlite'
UNIT = '/etc/systemd/system/' + PUBLIC
SIGNER_UNIT = '/etc/systemd/system/' + SIGNER
DROP_DIR = '/etc/systemd/system/' + PUBLIC + '.d'
DROP_IN = DROP_DIR + '/20-stage2-attestation.conf'
HMAC = '/etc/pinkuang-v4/authority-ipc-hmac'
OLD_KEY = '/etc/pinkuang/keeper.key'
HASH = re.compile(r'^[0-9a-f]{64}$')
COMMIT = re.compile(r'^[0-9a-f]{40}$')
ADDRESS = re.compile(r'^0x[0-9a-fA-F]{40}$')
RELEASE = re.compile(r'^v4-[a-z0-9][a-z0-9-]{1,70}$')
MODULES = {
    'scripts/authority-relay.mjs', 'scripts/budget-multicall-read.mjs',
    'scripts/keeper-credential.mjs', 'scripts/official-market-discovery.mjs',
    'scripts/purchase-keeper.mjs', 'server/authority-ipc.mjs',
    'server/authority-relay-api.mjs', 'server/authority-role.mjs',
    'server/authority-signer.mjs', 'server/fresh-activation-journal.mjs',
    'server/journal-store.mjs', 'server/product-graph.mjs',
    'server/request-limiter.mjs', 'shared/authority-typed.mjs',
    'shared/firsto-upgrade-proof.mjs', 'shared/gas-signer-attestation.mjs',
    'shared/integrated-upgrade-plan.mjs', 'shared/original-gas-wallet.mjs',
    'src/firsto-purchase.mjs', 'package.json', 'package-lock.json',
}
BUSINESS = ('fresh_activation', 'deployment_archives', 'market', 'market_abandoned',
            'market_signing', 'market_results', 'budget_queues', 'quotes')


class Rejected(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise Rejected(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def safe_regular(path, *, private=False, max_bytes=None):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_nlink == 1,
            'Expected a regular unlinked file.')
    require(info.st_uid == 0 and info.st_mode & (0o077 if private else 0o022) == 0,
            'File ownership or permissions are unsafe.')
    if max_bytes is not None:
        require(info.st_size <= max_bytes, 'File exceeds its reviewed bound.')
    return info


def safe_parents(path):
    """Reject symlinks and writable ancestors; no path text is executed."""
    require(path.is_absolute() and '..' not in path.parts, 'An absolute canonical path is required.')
    for item in [path, *path.parents]:
        if item.exists() or item.is_symlink():
            info = item.lstat()
            require(stat.S_ISDIR(info.st_mode) and not item.is_symlink(), 'Unsafe directory or symlink.')
            sticky_ancestor = item != path and bool(info.st_mode & stat.S_ISVTX)
            require(info.st_uid == 0 and (info.st_mode & 0o022 == 0 or sticky_ancestor),
                    'Directory is not root-controlled.')


def validate_plan(plan):
    keys = {'schemaVersion', 'operationId', 'sourceCommit', 'releaseId', 'manifestSha256',
            'unitsSha256', 'currentUnitSha256', 'currentPublicRelease', 'deploymentAccount',
            'deploymentId', 'artifactDigest', 'stage1RecordSha256', 'stage1Revision'}
    require(isinstance(plan, dict) and set(plan) == keys, 'Unexpected plan fields.')
    require(plan['schemaVersion'] == 1 and RELEASE.fullmatch(plan['releaseId']) is not None,
            'Invalid attestor release plan.')
    require(re.fullmatch(r'attestor-[a-z0-9][a-z0-9-]{1,60}', plan['operationId']) is not None,
            'Invalid operation identity.')
    require(COMMIT.fullmatch(plan['sourceCommit']) is not None, 'Invalid source commit.')
    for name in ('manifestSha256', 'unitsSha256', 'currentUnitSha256', 'stage1RecordSha256'):
        require(HASH.fullmatch(plan[name]) is not None, 'Invalid reviewed digest.')
    require(re.fullmatch(r'/srv/pinkuang-deploy-v4/releases/v4-[a-z0-9][a-z0-9-]{1,70}',
                         plan['currentPublicRelease']) is not None, 'Invalid public release.')
    require(ADDRESS.fullmatch(plan['deploymentAccount']) is not None and
            re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,159}', plan['deploymentId']) is not None and
            re.fullmatch(r'0x[0-9a-f]{64}', plan['artifactDigest']) is not None and
            type(plan['stage1Revision']) is int and plan['stage1Revision'] > 0,
            'Invalid Stage1 identity.')
    return plan


def validate_package(directory, plan, *, installed=False):
    safe_parents(directory)
    manifest_path = directory / 'stage2-attestor-manifest.json'
    safe_regular(manifest_path, max_bytes=65536)
    raw = manifest_path.read_bytes()
    require(sha(raw) == plan['manifestSha256'], 'Attestor manifest digest differs.')
    manifest = json.loads(raw)
    require(manifest.get('schemaVersion') == 1 and manifest.get('kind') == 'fresh-v4-stage2-attestor'
            and manifest.get('chainId') == 56 and manifest.get('sourceCommit') == plan['sourceCommit']
            and manifest.get('entrypoint') == 'node server/authority-signer.mjs'
            and manifest.get('installation') == 'npm ci --omit=dev --ignore-scripts'
            and manifest.get('activation') == 'Attestation only; Authority relay and automatic purchase are disabled.'
            and isinstance(manifest.get('files'), dict)
            and MODULES <= set(manifest['files']) and len(manifest['files']) <= 128,
            'Unreviewed signer package manifest.')
    # The pinned official manifest may gain a reviewed static helper. Never
    # hard-code one commit's file count; still reject traversal/private files.
    for name in manifest['files']:
        path = PurePosixPath(name)
        require(str(path) == name and not path.is_absolute() and '..' not in path.parts
                and (name in {'package.json', 'package-lock.json'} or
                     len(path.parts) == 2 and path.parts[0] in {'server', 'shared', 'scripts', 'src'}
                     and re.fullmatch(r'[a-zA-Z0-9_-]+\.mjs', path.name) is not None),
                'Manifest contains an unreviewed path type.')
    expected = set(manifest['files']) | {'stage2-attestor-manifest.json'}
    actual = set()
    for parent, dirs, files in os.walk(directory, followlinks=False):
        for name in list(dirs):
            child = Path(parent) / name
            require(not child.is_symlink(), 'Package contains a directory symlink.')
            if installed and child == directory / 'node_modules':
                dirs.remove(name)
                continue
            safe_parents(child)
        for name in files:
            child = Path(parent) / name
            safe_regular(child, max_bytes=4 * 1024 * 1024)
            actual.add(child.relative_to(directory).as_posix())
    require(actual == expected, 'Package contains missing or unexpected files.')
    for name, spec in manifest['files'].items():
        require(set(spec) == {'sha256', 'bytes'} and HASH.fullmatch(spec['sha256']) is not None
                and type(spec['bytes']) is int, 'Invalid package file evidence.')
        data = (directory / name).read_bytes()
        require(len(data) == spec['bytes'] and sha(data) == spec['sha256'], 'Package file digest differs.')
    return manifest


def expected_units(release):
    root = '/srv/pinkuang-v4-signer/releases/' + release
    signer = f'''[Unit]
Description=BEMine v4 Stage 2 Gas public-address attestation only
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=10min
StartLimitBurst=3

[Service]
Type=simple
User={USER}
Group={GROUP}
WorkingDirectory={root}
ExecStart=/usr/bin/node {root}/server/authority-signer.mjs
LoadCredential=authority-ipc-hmac:{HMAC}
LoadCredential=keeper-private-key:{OLD_KEY}
RuntimeDirectory=pinkuang-v4-relay
RuntimeDirectoryMode=0750
Environment=NODE_ENV=production
Environment=AUTHORITY_RELAY_ENABLED=0
Environment=AUTHORITY_SIGNER_ATTEST_ONLY=1
Environment=AUTHORITY_RELAY_SOCKET={SOCKET}
Environment=DEPLOYMENT_JOURNAL_ORIGIN={ORIGIN}
Environment=BEMINE_EXPECTED_GAS_WALLET={GAS}
UMask=0007
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/run/pinkuang-v4-relay
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
'''
    public = f'''[Service]
SupplementaryGroups={GROUP}
LoadCredential=authority-ipc-hmac:{HMAC}
Environment=AUTHORITY_RELAY_SOCKET={SOCKET}
Environment=AUTHORITY_RELAY_PUBLIC_ENABLED=0
Environment=AUTHORITY_RELAY_ENABLED=0
Environment=BEMINE_EXPECTED_GAS_WALLET={GAS}
Environment=BEMINE_FRESH_STAGE2_HOLD=1
'''
    return signer, public


def validate_draft(path, plan):
    safe_parents(path.parent)
    safe_regular(path, max_bytes=65536)
    data = path.read_bytes()
    require(sha(data) == plan['unitsSha256'], 'Unit draft digest differs.')
    draft = json.loads(data)
    signer, public = expected_units(plan['releaseId'])
    require(draft.get('kind') == 'fresh-v4-stage2-attestation-draft'
            and draft.get('schemaVersion') == 1 and draft.get('chainId') == 56
            and draft.get('activationAllowed') is False
            and draft.get('signerRoot') == '/srv/pinkuang-v4-signer/releases/' + plan['releaseId']
            and draft.get('signerUnit') == signer and draft.get('publicDropIn') == public
            and draft.get('requiredSignerEntrypoint') == 'server/authority-signer.mjs'
            and draft.get('signerReleaseRequiresIndependentPackage') is True,
            'Unit draft differs from the reviewed attestation-only shape.')
    # The private process never needs an internet socket, even during proof.
    signer += 'PrivateNetwork=true\nRestrictAddressFamilies=AF_UNIX\n'
    return signer.encode(), public.encode()


def parse_unit(text):
    result = {}; section = None
    for line in text.splitlines():
        if not line or line.startswith('#'):
            continue
        if line.startswith('[') and line.endswith(']'):
            section = line[1:-1]
            require(section in {'Unit', 'Service', 'Install'}, 'Unreviewed public unit section.')
            continue
        require(section is not None and line == line.strip() and '=' in line and not line.endswith('\\'),
                'Unreviewed public unit syntax.')
        key, value = line.split('=', 1)
        result.setdefault(section, {}).setdefault(key, []).append(value)
    return result


def validate_public_unit(data, plan):
    require(sha(data) == plan['currentUnitSha256'], 'Public unit digest changed.')
    service = parse_unit(data.decode())['Service']
    allowed = {'Type', 'User', 'Group', 'WorkingDirectory', 'ExecStart', 'Environment', 'UMask',
               'NoNewPrivileges', 'PrivateTmp', 'ProtectHome', 'ProtectSystem', 'ReadWritePaths',
               'Restart', 'RestartSec', 'TimeoutStopSec'}
    require(set(service) <= allowed, 'Public unit has credential injection or an unexpected directive.')
    for key, value in {'User': 'pinkuang-v4', 'Group': 'pinkuang-v4', 'Type': 'simple',
                       'WorkingDirectory': plan['currentPublicRelease'],
                       'ExecStart': '/usr/bin/node ' + plan['currentPublicRelease'] + '/server/index.mjs',
                       'ProtectSystem': 'strict', 'NoNewPrivileges': 'true',
                       'ProtectHome': 'true', 'ReadWritePaths': '/var/lib/pinkuang-deploy-v4'}.items():
        require(service.get(key) == [value], 'Public unit identity or isolation differs.')
    values = {}
    for entry in service.get('Environment', []):
        require('=' in entry, 'Invalid public environment.')
        key, value = entry.split('=', 1)
        require(key not in values, 'Duplicate public environment.')
        values[key] = value
    expected = {'BEMINE_FRESH_CONSOLE_PRE_GENESIS': '1', 'BEMINE_FRESH_STAGE2_HOLD': '1',
                'AUTHORITY_RELAY_ENABLED': '0', 'BEMINE_EXPECTED_GAS_WALLET': GAS,
                'DEPLOYMENT_JOURNAL_ORIGIN': ORIGIN, 'DEPLOYMENT_JOURNAL_DB': DB,
                'HOST': '127.0.0.1', 'PORT': '4177'}
    require(all(values.get(k) == v for k, v in expected.items()), 'Public safety flags differ.')
    require(values.get('AUTHORITY_RELAY_PUBLIC_ENABLED', '0') == '0'
            and values.get('BEMINE_NOTIFICATIONS_ENABLED', '0') == '0'
            and not any('PRIVATE_KEY' in key or 'CREDENTIAL' in key for key in values),
            'Public service may not hold keys or enable relay.')


def read_stage1(db, plan):
    """A read-only SQLite connection; never instantiate the write-capable store."""
    require(not db.is_symlink() and db.is_file(), 'Missing or symlinked v4 journal.')
    connection = sqlite3.connect('file:' + quote(str(db), safe='/') + '?mode=ro', uri=True)
    try:
        connection.execute('PRAGMA query_only=ON')
        connection.execute('BEGIN')
        rows = connection.execute('SELECT account,revision,record FROM deployment').fetchall()
        require(len(rows) == 1, 'Exactly one reviewed Stage1 journal is required.')
        account, revision, raw = rows[0]; record = json.loads(raw)
        require(account.lower() == plan['deploymentAccount'].lower() and revision == plan['stage1Revision']
                and sha(canonical(record)) == plan['stage1RecordSha256']
                and record.get('account', '').lower() == account.lower()
                and record.get('id') == plan['deploymentId']
                and record.get('artifactDigest') == plan['artifactDigest']
                and record.get('status') == 'complete' and record.get('kind') == 'integrated-v2'
                and record.get('chainId') == 56 and len(record.get('steps', [])) == 16
                and all(s.get('status') == 'confirmed' for s in record['steps']),
                'Stage1 record changed or is not complete.')
        for table in BUSINESS:
            require(connection.execute('SELECT COUNT(*) FROM "' + table + '"').fetchone()[0] == 0,
                    'Stage2 or product journal is not empty.')
        return record
    finally:
        connection.close()


class Host:
    def __init__(self, root=Path('/')):
        self.root = root

    def path(self, name):
        return self.root / name.lstrip('/')

    def run(self, argv, *, timeout=45, cwd=None, env=None, allow_failure=False, umask=-1):
        try:
            result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout,
                                    cwd=cwd, env=env, check=False, umask=umask)
        except (OSError, subprocess.TimeoutExpired):
            raise Rejected('A bounded system command failed or timed out.') from None
        require(allow_failure or result.returncode == 0, 'A system command failed; private output withheld.')
        return result.returncode, result.stdout

    def show(self, service):
        _, text = self.run(['systemctl', 'show', service,
                           '--property=LoadState,ActiveState,SubState,MainPID,InvocationID,FragmentPath,DropInPaths,NeedDaemonReload,User,Group,WorkingDirectory,PrivateNetwork,RestrictAddressFamilies,SupplementaryGroups'])
        return dict(line.split('=', 1) for line in text.splitlines() if '=' in line)

    def identity(self, kind, name):
        status, text = self.run(['getent', kind, name], allow_failure=True)
        require(status in (0, 2), 'Cannot verify account identity.')
        return text.strip() if status == 0 else None

    def protected(self):
        _, text = self.run(['systemctl', 'list-units', '--all', '--type=service', '--no-legend',
                           '--plain', 'pinkuang*.service'])
        names = {line.split()[0] for line in text.splitlines() if line.split()}
        names.add('pinkuang-purchase-v2.service')
        names -= {PUBLIC, SIGNER}
        result = {}
        for name in sorted(names):
            require(re.fullmatch(r'pinkuang[a-zA-Z0-9_.@-]*\.service', name) is not None,
                    'Unrecognized protected service identity.')
            state = self.show(name)
            result[name] = {k: state.get(k) for k in ('LoadState', 'ActiveState', 'SubState', 'MainPID', 'InvocationID', 'FragmentPath')}
            fragment = state.get('FragmentPath')
            if fragment:
                result[name]['unitSha256'] = sha(Path(fragment).read_bytes())
        return result

    def public_process_safe(self, *, installed):
        props = self.show(PUBLIC)
        require(props.get('ActiveState') == 'active' and int(props.get('MainPID', '0')) > 0,
                'v4 public process is not active.')
        raw = self.path('/proc/' + props['MainPID'] + '/environ').read_bytes()
        env = dict(part.split(b'=', 1) for part in raw.split(b'\0') if b'=' in part)
        require(env.get(b'BEMINE_FRESH_STAGE2_HOLD') == b'1'
                and env.get(b'BEMINE_FRESH_CONSOLE_PRE_GENESIS') == b'1'
                and env.get(b'AUTHORITY_RELAY_ENABLED') == b'0'
                and env.get(b'AUTHORITY_RELAY_PUBLIC_ENABLED', b'0') == b'0'
                and not any(b'PRIVATE_KEY' in key for key in env), 'Effective public flags or key isolation differ.')
        credentials = env.get(b'CREDENTIALS_DIRECTORY')
        names = set(p.name for p in Path(os.fsdecode(credentials)).iterdir()) if credentials else set()
        require(names == ({'authority-ipc-hmac'} if installed else set()),
                'Public process received unexpected credentials.')

    def health(self):
        checks = [('http://127.0.0.1:4177/', 200),
                  ('http://127.0.0.1:4177/api/journal/fresh-activation/config', 401),
                  ('http://127.0.0.1:4177/api/journal/authority-relay/status', 503),
                  (ORIGIN + '/pinkuang-deploy-v4/', 401),
                  (ORIGIN + '/pinkuang-deploy-v4/deployment-artifacts.json', 401),
                  (ORIGIN + '/pinkuang-deploy-v4/api/journal/fresh-activation/config', 401),
                  (ORIGIN + '/bemine-v2/', 200)]
        for url, code in checks:
            argv = ['curl', '--silent', '--show-error', '--max-time', '8', '--noproxy', '*',
                    '--output', '/dev/null', '--write-out', '%{http_code}']
            if url.startswith('https:'):
                argv += ['--resolve', 'tapeout.cc.cd:443:127.0.0.1']
            status, value = self.run(argv + [url], timeout=10, allow_failure=True)
            require(status == 0 and value.strip() == str(code), 'Public or protected HTTP status differs.')
        return True

    def wait_public(self):
        for _ in range(40):
            code, output = self.run(['curl', '--silent', '--max-time', '1', '--noproxy', '*',
                                     '--output', '/dev/null', '--write-out', '%{http_code}',
                                     'http://127.0.0.1:4177/'], timeout=2, allow_failure=True)
            if code == 0 and output == '200':
                return
            time.sleep(0.25)
        raise Rejected('Public v4 service did not become ready within its bound.')


def no_dropins(host, service, *, expected=None):
    props = host.show(service)
    require(props.get('NeedDaemonReload') == 'no', 'systemd has pending unreviewed changes.')
    loaded = props.get('DropInPaths', '')
    require(loaded == (expected or ''), 'Effective drop-ins differ.')
    stem = service.removesuffix('.service')
    names = {service + '.d', 'service.d'} | {stem[:i + 1] + '.service.d' for i, char in enumerate(stem) if char == '-'}
    found = set()
    for root in ('/etc/systemd/system', '/run/systemd/system', '/usr/local/lib/systemd/system', '/usr/lib/systemd/system', '/lib/systemd/system'):
        for name in names:
            folder = host.path(root) / name
            if folder.exists():
                require(not folder.is_symlink(), 'Drop-in directory is a symlink.')
                found.update(str(p) for p in folder.glob('*.conf'))
    # /lib can alias /usr/lib; the required /etc drop-in still has one path.
    require(found == ({str(host.path(expected))} if expected else set()), 'On-disk drop-ins differ.')


def exclusive_file(path, data, mode=0o644):
    safe_parents(path.parent)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, 'wb', closefd=False) as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
    finally:
        os.close(descriptor)


def secure_dependencies(directory):
    """Keep installed third-party code root-owned and read-only to the signer."""
    require(directory.is_dir() and not directory.is_symlink(), 'Missing runtime dependencies.')
    count = 0
    for parent, dirs, files in os.walk(directory, followlinks=False):
        for name in [None, *dirs, *files]:
            path = Path(parent) if name is None else Path(parent) / name
            count += 1
            require(count <= 200000, 'Runtime dependency inventory exceeds its bound.')
            info = path.lstat()
            require(info.st_uid == 0, 'Runtime dependency is not root-owned.')
            if path.is_symlink():
                require(path.resolve().is_relative_to(directory.resolve()),
                        'Runtime dependency symlink escapes its root.')
            elif stat.S_ISDIR(info.st_mode):
                path.chmod(0o755)
            elif stat.S_ISREG(info.st_mode):
                path.chmod(0o644 | (info.st_mode & 0o111))
            else:
                raise Rejected('Runtime dependency contains a special file.')


PROBE_JS = r'''
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { pathToFileURL } from 'node:url';
const [root, input] = process.argv.slice(1);
try {
  const { createGasSignerProofReader, readAuthorityIpcKey, AUTHORITY_SOCKET } =
    await import(pathToFileURL(root + '/server/authority-ipc.mjs'));
  const { verifyGasSignerAttestation } = await import(pathToFileURL(root + '/shared/gas-signer-attestation.mjs'));
  const base = JSON.parse(input);
  const challenge = { ...base, nonce: '0x' + randomBytes(32).toString('hex') };
  const reader = createGasSignerProofReader({ socketPath: AUTHORITY_SOCKET,
    origin: base.origin, expectedGasWallet: base.expectedGasWallet, key: readAuthorityIpcKey() });
  const proof = await reader(challenge);
  const verified = verifyGasSignerAttestation(challenge, proof);
  const relayDisabled = await new Promise((resolve, reject) => {
    const req = request({ socketPath: AUTHORITY_SOCKET, path: '/api/journal/authority-relay', method: 'POST',
      headers: { 'content-length': '2', 'content-type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode === 503));
    });
    req.setTimeout(3000, () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end('{}');
  });
  if (!verified || !relayDisabled) throw new Error('failed');
  console.log(JSON.stringify({verified:true, gasWallet:proof.gasWallet, relayDisabled:true}));
} catch { console.log(JSON.stringify({verified:false, error:'attestation_probe_failed'})); process.exitCode=1; }
'''


class Installer:
    def __init__(self, host, plan, package, draft):
        self.host = host; self.plan = validate_plan(plan)
        self.package = package; self.draft = draft
        self.release = host.path('/srv/pinkuang-v4-signer/releases/' + plan['releaseId'])
        self.evidence = host.path('/var/lib/pinkuang-v4-attestor-ops/' + plan['operationId'])
        self.signer_data = None; self.public_data = None
        self.created_dropin = False; self.created_signer = False; self.public_touched = False
        self.events = []

    def event(self, name, **safe):
        self.events.append({'at': time.time(), 'event': name, **safe})
        if self.evidence.exists():
            # Never record command output, environment, credentials or signatures.
            path = self.evidence / 'events.json'
            temp = self.evidence / 'events.next'
            temp.write_text(json.dumps(self.events, indent=2) + '\n'); temp.chmod(0o600)
            os.replace(temp, path)

    def journal(self):
        return read_stage1(self.host.path(DB), self.plan)

    def preflight(self):
        require(os.geteuid() == 0 and sys.platform == 'linux' and __debug__, 'Requires root Linux without -O.')
        validate_package(self.package, self.plan)
        self.signer_data, self.public_data = validate_draft(self.draft, self.plan)
        safe_regular(self.host.path(UNIT), max_bytes=32768)
        validate_public_unit(self.host.path(UNIT).read_bytes(), self.plan)
        props = self.host.show(PUBLIC)
        require(props.get('FragmentPath') == UNIT and props.get('User') == 'pinkuang-v4'
                and props.get('Group') == 'pinkuang-v4' and props.get('ActiveState') == 'active'
                and props.get('WorkingDirectory') == self.plan['currentPublicRelease'], 'Public service changed.')
        no_dropins(self.host, PUBLIC)
        no_dropins(self.host, SIGNER)
        require(self.host.show(SIGNER).get('LoadState') == 'not-found', 'Signer unit already exists.')
        for path in (self.release, self.host.path(SIGNER_UNIT), self.host.path(DROP_DIR),
                     self.host.path(HMAC), self.host.path('/run/pinkuang-v4-relay'), self.evidence):
            require(not path.exists() and not path.is_symlink(), 'Installation target already exists.')
            safe_parents(path.parent)
        require(self.host.identity('passwd', USER) is None and self.host.identity('group', GROUP) is None,
                'Signer user or relay group already exists; review separately.')
        require(self.host.identity('passwd', 'pinkuang-v4') is not None, 'Missing public service account.')
        safe_regular(self.host.path(OLD_KEY), private=True, max_bytes=128)  # Metadata only.
        require(self.host.path(OLD_KEY).stat().st_mode & 0o777 == 0o600, 'Original credential mode differs.')
        self.journal()
        self.host.public_process_safe(installed=False)
        self.protected = self.host.protected()
        self.host.health()
        return {'preflight': True, 'sourceCommit': self.plan['sourceCommit'], 'stage2Held': True,
                'relayEnabled': False, 'stage1Verified': True, 'changesMade': False}

    def assert_protected(self):
        require(self.host.protected() == self.protected, 'A protected service identity changed.')

    def probe(self):
        challenge = {'chainId': 56, 'origin': ORIGIN, 'deploymentAccount': self.plan['deploymentAccount'],
                     'deploymentId': self.plan['deploymentId'], 'artifactDigest': self.plan['artifactDigest'],
                     'expectedGasWallet': GAS}
        argv = ['systemd-run', '--quiet', '--wait', '--pipe', '--collect', '--service-type=exec',
                '--unit=' + self.plan['operationId'] + '-proof',
                '--property=User=pinkuang-v4', '--property=Group=pinkuang-v4',
                '--property=SupplementaryGroups=' + GROUP,
                '--property=LoadCredential=authority-ipc-hmac:' + HMAC,
                '--property=PrivateNetwork=true', '--property=RestrictAddressFamilies=AF_UNIX',
                '--property=NoNewPrivileges=true', '--property=ProtectSystem=strict',
                '--property=ProtectHome=true', '--property=PrivateTmp=true',
                '--property=RuntimeMaxSec=20', '/usr/bin/node', '--input-type=module', '--eval', PROBE_JS,
                str(self.release), json.dumps(challenge, separators=(',', ':'))]
        _, output = self.host.run(argv, timeout=30)
        try:
            result = json.loads(output)
        except (ValueError, TypeError):
            raise Rejected('Attestation probe returned invalid evidence.') from None
        require(result == {'verified': True, 'gasWallet': GAS, 'relayDisabled': True},
                'Attestation probe did not verify the reviewed wallet.')
        return result

    def wait_signer(self):
        user = self.host.identity('passwd', USER).split(':')
        group = self.host.identity('group', GROUP).split(':')
        for _ in range(40):
            path = self.host.path(SOCKET)
            if path.exists():
                info = path.lstat()
                parent = path.parent.lstat()
                require(stat.S_ISSOCK(info.st_mode) and info.st_mode & 0o777 == 0o660
                        and info.st_uid == int(user[2]) and info.st_gid == int(group[2])
                        and stat.S_ISDIR(parent.st_mode) and parent.st_mode & 0o777 == 0o750
                        and parent.st_uid == int(user[2]) and parent.st_gid == int(group[2]),
                        'Private signer socket identity or permissions differ.')
                return
            time.sleep(0.25)
        raise Rejected('Private signer did not become ready within its bound.')

    def verify_installed(self):
        require(self.host.path(UNIT).read_bytes() and sha(self.host.path(UNIT).read_bytes()) == self.plan['currentUnitSha256'],
                'Original public unit changed.')
        require(self.host.path(DROP_IN).read_bytes() == self.public_data
                and self.host.path(SIGNER_UNIT).read_bytes() == self.signer_data, 'Installed unit changed.')
        no_dropins(self.host, PUBLIC, expected=DROP_IN)
        self.verify_signer_isolation()
        self.host.public_process_safe(installed=True)
        self.journal(); self.assert_protected(); self.host.health()

    def verify_signer_isolation(self):
        require(self.host.path(SIGNER_UNIT).read_bytes() == self.signer_data, 'Signer unit changed.')
        no_dropins(self.host, SIGNER)
        signer = self.host.show(SIGNER)
        require(signer.get('ActiveState') == 'active' and signer.get('User') == USER
                and signer.get('Group') == GROUP and signer.get('WorkingDirectory') == str(self.release)
                and signer.get('PrivateNetwork') == 'yes'
                and signer.get('RestrictAddressFamilies') == 'AF_UNIX', 'Signer isolation is not effective.')

    def apply(self):
        self.preflight()
        self.evidence.mkdir(parents=True, mode=0o700)
        self.evidence.chmod(0o700)
        exclusive_file(self.evidence / 'reviewed-plan.json', canonical(self.plan) + b'\n', 0o600)
        self.event('preflight_passed')
        try:
            self.release.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            shutil.copytree(self.package, self.release, symlinks=False)
            for parent, dirs, files in os.walk(self.release):
                Path(parent).chmod(0o755)
                for name in files:
                    (Path(parent) / name).chmod(0o644)
            validate_package(self.release, self.plan)
            env = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                   'HOME': str(self.evidence), 'NODE_ENV': 'production'}
            # npm 11 rejects one file used as both user and global config.
            # Keep separate empty private files rather than inheriting host settings.
            npm_user_config = self.evidence / 'npm-user.config'
            npm_global_config = self.evidence / 'npm-global.config'
            exclusive_file(npm_user_config, b'', 0o600)
            exclusive_file(npm_global_config, b'', 0o600)
            self.host.run(['npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
                           '--userconfig=' + str(npm_user_config), '--globalconfig=' + str(npm_global_config),
                           '--cache=' + str(self.evidence / 'npm-cache')],
                          timeout=240, cwd=self.release, env=env, umask=0o022)
            secure_dependencies(self.release / 'node_modules')
            validate_package(self.release, self.plan, installed=True)
            self.host.run(['groupadd', '--system', GROUP])
            self.host.run(['useradd', '--system', '--gid', GROUP, '--no-create-home',
                           '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', USER])
            credential_parent = self.host.path(HMAC).parent
            if not credential_parent.exists():
                credential_parent.mkdir(mode=0o700)
            safe_parents(credential_parent)
            require(credential_parent.stat().st_mode & 0o777 == 0o700, 'HMAC source directory must be 0700.')
            exclusive_file(self.host.path(HMAC), os.urandom(32), 0o600)
            exclusive_file(self.host.path(SIGNER_UNIT), self.signer_data)
            self.created_signer = True
            self.host.run(['systemctl', 'daemon-reload'])
            self.host.run(['systemctl', 'start', SIGNER])
            self.wait_signer()
            self.verify_signer_isolation()
            self.event('private_signer_started')
            # A transient process runs as the public UID, with only HMAC. It
            # never invents a wallet cookie or receives the Gas credential.
            proof = self.probe()
            self.event('private_proof_verified', **proof)
            self.assert_protected()
            validate_public_unit(self.host.path(UNIT).read_bytes(), self.plan)
            no_dropins(self.host, PUBLIC); self.journal()
            self.public_touched = True
            self.host.run(['systemctl', 'stop', PUBLIC])
            # Close the race with wallet writes before the stop.
            self.journal()
            validate_public_unit(self.host.path(UNIT).read_bytes(), self.plan)
            self.host.path(DROP_DIR).mkdir(mode=0o755)
            exclusive_file(self.host.path(DROP_IN), self.public_data)
            self.created_dropin = True
            self.host.run(['systemctl', 'daemon-reload'])
            self.host.run(['systemctl', 'start', PUBLIC])
            self.host.wait_public()
            self.verify_installed()
            self.event('installed_and_verified', stage2Held=True, relayEnabled=False)
            return {'installed': True, **proof, 'stage2Held': True, 'relayEnabled': False,
                    'stage1Unchanged': True, 'protectedServicesUnchanged': True}
        except BaseException:
            self.event('installation_failed')
            try:
                self.rollback()
            except BaseException:
                self.event('rollback_requires_review')
                raise Rejected('Installation failed; rollback requires review. Evidence is preserved.') from None
            raise Rejected('Installation failed; public drop-in rolled back and signer stopped. Evidence is preserved.') from None

    def rollback(self):
        errors = []
        # Always attempt to stop the newly installed signer, even on a public
        # configuration race. Do not remove credentials, users, code or DBs.
        if self.created_signer:
            try:
                require(self.host.path(SIGNER_UNIT).read_bytes() == self.signer_data,
                        'Concurrent signer unit change.')
                self.host.run(['systemctl', 'stop', SIGNER])
            except BaseException:
                errors.append('signer_stop')
        if self.created_dropin:
            try:
                path = self.host.path(DROP_IN)
                safe_regular(path)
                require(path.read_bytes() == self.public_data, 'Concurrent public drop-in change.')
                path.unlink()
                self.host.path(DROP_DIR).rmdir()
                self.created_dropin = False
            except BaseException:
                errors.append('dropin_compare_and_swap')
        if self.public_touched:
            try:
                require(not errors, 'Rollback cannot restart an unreviewed public service.')
                validate_public_unit(self.host.path(UNIT).read_bytes(), self.plan)
                self.host.run(['systemctl', 'daemon-reload'])
                no_dropins(self.host, PUBLIC)
                self.host.run(['systemctl', 'restart', PUBLIC])
                self.host.wait_public()
                self.host.public_process_safe(installed=False)
                self.journal(); self.assert_protected(); self.host.health()
            except BaseException:
                errors.append('public_restore')
        self.event('rollback_finished', successful=not errors, failedChecks=errors)
        require(not errors, 'Rollback needs independent review.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--plan-sha256', required=True)
    parser.add_argument('--package-dir', type=Path, required=True)
    parser.add_argument('--units-json', type=Path, required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--dry-run', action='store_true'); mode.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    require(os.geteuid() == 0 and sys.platform == 'linux' and __debug__, 'Requires root Linux without -O.')
    safe_parents(args.plan.parent)
    safe_regular(args.plan, private=True, max_bytes=65536)
    require(HASH.fullmatch(args.plan_sha256) is not None and sha(args.plan.read_bytes()) == args.plan_sha256,
            'Reviewed plan digest differs.')
    installer = Installer(Host(), json.loads(args.plan.read_bytes()), args.package_dir, args.units_json)
    if args.dry_run:
        result = installer.preflight()
    else:
        import fcntl
        descriptor = os.open('/run/lock/pinkuang-v4-attestor-install.lock',
                             os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(descriptor)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                    and info.st_mode & 0o777 == 0o600, 'Installer lock permissions differ.')
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = installer.apply()
        finally:
            os.close(descriptor)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        # Raw subprocess/RPC/credential errors are never reflected.
        print(json.dumps({'ok': False, 'error': str(error) if isinstance(error, Rejected)
                          else 'Attestor installation stopped; inspect private evidence.'}), file=sys.stderr)
        sys.exit(1)
