"""Publish the reviewed October 5 UI/mining fixes without changing contracts.

Uses the existing inventory, locking and static validation primitives. The
baseline is pinned here; a newer live deployment must be reviewed separately.
No signing, transaction recovery, journal editing or nginx changes occur here.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

spec = importlib.util.spec_from_file_location('publication_helpers',
    Path(__file__).with_name('publish-invalid-targets.py'))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
require = helper.require
regular = helper.regular
sha = helper.sha
inventory = helper.inventory
under = helper.under
unit = helper.unit
save = helper.save
MINER = 'pinkuang-v5-mining'
MINER_BASE = Path('/srv/pinkuang-v5/releases/v5-product-23b48e6adb2a')
FRONT_BASE = Path('/var/www/bemine-v5/releases/invalid-target-f86aa63a2425')
FRONT_HEAD = 'f86aa63a2425b8a9c3c804e48826e9712cc4e249'
FRONT_RELEASE_SHA = 'fb7b32fb564f5ccf0852673af09d63a753387651179fce8afcbca8caf49177ff'
MINER_DROPIN = Path('/etc/systemd/system/pinkuang-v5-mining.service.d/audit-fixes.conf')
BASE_HASHES = {
    'scripts/mining-supervisor.mjs': 'db397533eabb8f65e12b09b0bb88ec71a7ad72face7a5e922f4979e6e611aefc',
    'scripts/mining-keeper.mjs': '8092caccad14159cd161e42ca91fb8a95e82f2c61a82e527bc69cb8da474083e',
}
UNITS = (helper.INDEX_UNIT, *helper.OTHER_UNITS)
RELEASE = helper.RELEASE_NAME


def units():
    return {name: unit(name) for name in UNITS}


def verify_files(root, pins):
    for name, expected in pins.items():
        require(sha(regular(under(root, name), 5_000_000)) == expected,
                'Mining file differs: ' + name)


def baseline():
    current = helper.WEB_ROOT / 'current'
    require(current.is_symlink() and current.resolve(strict=True) == FRONT_BASE,
            'Live frontend differs from reviewed baseline')
    raw = regular(FRONT_BASE / RELEASE)
    require(sha(raw) == FRONT_RELEASE_SHA, 'Baseline release metadata changed')
    meta = json.loads(raw)
    files = inventory(FRONT_BASE, exclude=(RELEASE,))
    require(meta['frontendSourceHead'] == FRONT_HEAD
            and meta['factory'].lower() == helper.FACTORY
            and meta['artifactDigest'] == helper.ARTIFACT
            and meta['manifestSha256'] == helper.MANIFEST
            and helper.content_digest(files) == meta['contentSha256']
            and len(files) == meta['fileCount'], 'Baseline frontend binding differs')
    require(sha(regular(FRONT_BASE / 'data/frontend-manifest.v5.json'))
            == helper.FRONT_MANIFEST_SHA, 'Formal manifest changed')
    return current, meta, files


def restart():
    subprocess.run(['systemctl', 'daemon-reload'], check=True, timeout=20)
    subprocess.run(['systemctl', 'restart', MINER], check=True, timeout=45)


def mining_process(fields, directory, previous=None):
    """Bind the running PID to the intended directory without logging RPC URLs."""
    pid = fields.get('MainPID', '')
    require(pid.isdigit() and int(pid) > 0, 'Mining process PID is unavailable')
    proc = Path('/proc') / pid
    require((proc / 'cwd').resolve(strict=True) == directory.resolve(strict=True),
            'Running mining process uses another working directory')
    command = (proc / 'cmdline').read_bytes()
    require(0 < len(command) <= 100_000 and command.split(b'\0')[1:2]
            == [b'scripts/mining-supervisor.mjs'], 'Mining entrypoint differs')
    result = {'cwd': str(directory), 'commandSha256': sha(command)}
    if previous is not None:
        require(result['commandSha256'] == previous['commandSha256'],
                'Mining command or environment-expanded arguments changed')
    return result


def publish(incoming, head):
    require(helper.valid_head(head), 'A complete reviewed source HEAD is required')
    require(incoming.is_absolute() and incoming.is_dir() and not incoming.is_symlink(),
            'Incoming must be an absolute directory')
    summary_raw = regular(incoming / 'build-summary.json', 5_000_000)
    summary = json.loads(summary_raw)
    require(summary.get('schemaVersion') == 1 and summary.get('sourceHead') == head,
            'Incoming source HEAD differs')
    pins = summary.get('mining', {}).get('files', {})
    require(set(pins) == set(BASE_HASHES) and all(helper.valid_sha(v) for v in pins.values()),
            'Mining overlay must contain exactly the two reviewed files')
    verify_files(incoming, pins)
    front_pins = summary['frontend']
    require(front_pins.get('frontendManifestSha256') == helper.FRONT_MANIFEST_SHA
            and front_pins.get('releaseManifestSha256') == front_pins['files'].get(RELEASE),
            'Frontend pins differ from formal manifest')
    archive = under(incoming, front_pins['archive']['name'])
    require(front_pins['archive']['name'] == 'candidate.tar.gz', 'Unexpected archive name')
    helper.validate_archive(archive, front_pins)
    require(not (incoming / 'publication.json').exists()
            and not (incoming / 'before.json').exists(), 'Existing attempt must be inspected')
    current, previous, old_files = baseline()
    before_units = units()
    require(before_units[MINER]['WorkingDirectory'] == str(MINER_BASE), 'Mining runtime changed')
    before_process = mining_process(before_units[MINER], MINER_BASE)
    require(not MINER_DROPIN.exists() and not MINER_DROPIN.is_symlink(),
            'Mining overlay dropin already exists')
    verify_files(MINER_BASE, BASE_HASHES)
    base_runtime = inventory(MINER_BASE, allow_links=True)
    stable = {'units': {k: v for k, v in before_units.items() if k != MINER},
              'protected': helper.protected(exclude=(MINER_DROPIN,)),
              'nginx': unit('nginx'), 'upgrade': helper.upgrade_entry()}
    mining_dest = MINER_BASE.parent / ('v5-audit-mining-' + head[:12])
    front_dest = helper.WEB_ROOT / ('releases/audit-fixes-' + head[:12])
    require(not mining_dest.exists() and not front_dest.exists(), 'Release destination exists')
    save(incoming, 'before.json', {'sourceHead': head, 'summarySha256': sha(summary_raw),
         'frontend': str(FRONT_BASE), 'frontendMetadata': previous,
         'mining': before_units[MINER], 'miningProcess': before_process,
         'stable': stable, 'savedAt': helper.stamp()})
    shutil.copytree(MINER_BASE, mining_dest, symlinks=True)
    for name in pins:
        target = under(mining_dest, name)
        target.write_bytes(regular(under(incoming, name), 5_000_000))
        target.chmod(0o644)
        subprocess.run(['/usr/bin/node', '--check', str(target)], check=True, timeout=15)
    new_runtime = inventory(mining_dest, allow_links=True)
    require({k: v for k, v in new_runtime.items() if k not in pins}
            == {k: v for k, v in base_runtime.items() if k not in pins},
            'A nonoverlay mining runtime file changed')
    verify_files(mining_dest, pins)
    helper.extract_archive(archive, front_dest, front_pins['files'])
    built = json.loads(regular(front_dest / RELEASE))
    require(built['frontendSourceHead'] == head and built['publicUrl'] == helper.SITE + '/',
            'Frontend source/canonical URL differs')
    for key in ['chainId', 'basePath', 'productFamily', 'publicOrigin', 'manifestSha256',
                'artifactDigest', 'factory', 'portfolioFactory', 'authority', 'gasWallet', 'deployment']:
        require(built[key] == previous[key], 'Contract binding changed: ' + key)
    require(regular(front_dest / 'data/frontend-manifest.v5.json')
            == regular(FRONT_BASE / 'data/frontend-manifest.v5.json'), 'Manifest bytes changed')
    built_files = inventory(front_dest, exclude=(RELEASE,))
    require(helper.content_digest(built_files) == built['contentSha256']
            and len(built_files) == built['fileCount'], 'Build content differs')
    retained = []
    for name, expected in old_files.items():
        if not name.startswith('_next/static/'):
            continue
        target = under(front_dest, name)
        if target.exists():
            require(sha(regular(target)) == expected, 'Immutable chunk collision')
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(under(FRONT_BASE, name), target)
            retained.append(name)
    final_files = inventory(front_dest, exclude=(RELEASE,))
    meta = dict(previous)
    directories = dict(previous['runtimeServiceDirectories'])
    for name, path in directories.items():
        require(before_units[name]['WorkingDirectory'] == path, 'Runtime provenance differs: ' + name)
    directories[MINER] = str(mining_dest)
    meta.update(sourceCommit=head, frontendSourceHead=head, previousFrontendSourceHead=FRONT_HEAD,
        publicUrl=helper.SITE + '/', runtimeServiceDirectories=directories,
        miningOverlaySourceHead=head, miningOverlayDirectory=str(mining_dest),
        generatedAt=helper.stamp(), uiOnlyRelease=False, runtimeCutoverRequired=False,
        updateScope='Refresh loaded pages and current booked rewards; delisted invitations; mining follow-up and read deduplication',
        buildContentSha256=helper.content_digest(built_files), buildFileCount=len(built_files),
        retainedImmutableChunks=len(retained), contentSha256=helper.content_digest(final_files),
        fileCount=len(final_files))
    metadata = (json.dumps(meta, indent=2) + '\n').encode()
    (front_dest / RELEASE).write_bytes(metadata)
    for path in [front_dest, *front_dest.rglob('*')]:
        require(not path.is_symlink(), 'Static symlinks are forbidden')
        path.chmod(0o755 if path.is_dir() else 0o644)

    def unchanged():
        now = units()
        require({k: v for k, v in now.items() if k != MINER} == stable['units']
                and helper.protected(exclude=(MINER_DROPIN,)) == stable['protected']
                and unit('nginx') == stable['nginx'] and helper.upgrade_entry() == stable['upgrade'],
                'Another deployment changed; publication stopped')
        require(inventory(MINER_BASE, allow_links=True) == base_runtime
                and inventory(mining_dest, allow_links=True) == new_runtime
                and inventory(FRONT_BASE, exclude=(RELEASE,)) == old_files,
                'Reviewed release content changed')
        require(sha(regular(incoming / 'build-summary.json', 5_000_000)) == sha(summary_raw),
                'Reviewed input summary changed')
        return now

    require(unchanged() == before_units and current.resolve(strict=True) == FRONT_BASE,
            'Baseline changed during staging')
    expected_dropin = ('[Service]\nWorkingDirectory=' + str(mining_dest) + '\n').encode()
    mining_changed = static_changed = False
    try:
        MINER_DROPIN.parent.mkdir(exist_ok=True)
        helper.atomic_write(MINER_DROPIN, expected_dropin, 0o644)
        mining_changed = True
        restart()
        time.sleep(5)
        started = unit(MINER)
        require(started['WorkingDirectory'] == str(mining_dest)
                and started['InvocationID'] != before_units[MINER]['InvocationID'],
                'New mining runtime invocation is not active')
        process_proof = mining_process(started, mining_dest, before_process)
        unchanged()
        helper.switch_static(current, front_dest, helper.WEB_ROOT / ('.audit-switch-' + head[:12]))
        static_changed = True
        proof = helper.verify_static(front_dest, metadata)
        after = unchanged()
        require(after[MINER] == started, 'Mining invocation changed during publication')
        require(mining_process(after[MINER], mining_dest, before_process) == process_proof,
                'Mining process provenance changed during publication')
        require(inventory(front_dest, exclude=(RELEASE,)) == final_files
                and regular(front_dest / RELEASE) == metadata, 'Published static content changed')
        result = {'published': True, 'sourceHead': head, 'publishedAt': helper.stamp(),
            'summarySha256': sha(summary_raw), 'frontend': str(front_dest),
            'mining': str(mining_dest), 'overlayFiles': pins, 'onlyMiningRestarted': True,
            'contractUpgradeApplied': False, 'nginxChanged': False, 'journalFilesPreserved': True,
            'frontendManifestPreserved': True, 'stableUnits': stable['units'],
            'miningUnit': after[MINER], 'miningProcess': process_proof, 'proof': proof,
            'contentSha256': meta['contentSha256'], 'releaseMetadataSha256': sha(metadata)}
        save(incoming, 'publication.json', result)
        print(json.dumps({k: result[k] for k in ['published', 'sourceHead', 'frontend', 'mining',
              'onlyMiningRestarted', 'contractUpgradeApplied']}), flush=True)
    except BaseException:
        if static_changed:
            helper.restore_static(current, front_dest, FRONT_BASE,
                helper.WEB_ROOT / ('.audit-rollback-' + head[:12]))
        if mining_changed:
            require(regular(MINER_DROPIN) == expected_dropin, 'Mining dropin externally changed; rollback refused')
            MINER_DROPIN.unlink()
            restart()
            require(unit(MINER)['WorkingDirectory'] == str(MINER_BASE), 'Mining rollback failed')
        save(incoming, 'rollback.json', {'restored': True, 'sourceHead': head, 'at': helper.stamp()})
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('incoming', type=Path)
    parser.add_argument('--source-head', required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0, 'Run only as root on the formal host')
    with helper.locks():
        publish(args.incoming, args.source_head)
