#!/usr/bin/env python3
"""Stage a reviewed fresh-v4 release pair; never activate a service or site.

The expected plan hash comes from the offline Git-source and release-pair review.
Both archives are checked against that plan before any release directory is made.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tarfile
import tempfile

HEX64 = re.compile(r'[0-9a-f]{64}')
HEX40 = re.compile(r'[0-9a-f]{40}')
RELEASE = re.compile(r'v4-[a-z0-9][a-z0-9-]{1,70}')
MAX_FILE = 128 * 1024 * 1024
MAX_ARCHIVE_CONTENT = 512 * 1024 * 1024


def require(ok, reason):
    if not ok:
        raise RuntimeError(reason)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def load_plan(path, expected_sha256):
    require(HEX64.fullmatch(expected_sha256), 'Reviewed plan SHA256 is malformed.')
    require(path.is_absolute() and path.is_file() and not path.is_symlink(),
            'Reviewed plan must be a regular absolute file.')
    raw = path.read_bytes()
    require(sha256(raw) == expected_sha256, 'Reviewed plan SHA256 differs.')
    plan = json.loads(raw)
    pair = plan.get('releasePair')
    require(plan.get('schemaVersion') == 1
            and plan.get('kind') == 'fresh-v4-bound-cutover-draft'
            and plan.get('chainId') == 56
            and plan.get('activationAllowed') is False
            and isinstance(pair, dict)
            and pair.get('productFamily') == 'fresh-v4',
            'Plan is not a disabled, validated fresh-v4 release pair.')
    for key in ('frontendContentSha256', 'frontendReleaseSha256',
                'backendReleaseSha256', 'indexManifestSha256'):
        require(isinstance(pair.get(key), str) and HEX64.fullmatch(pair[key]),
                f'Plan {key} is missing or malformed.')
    require(isinstance(pair.get('sourceHead'), str)
            and HEX40.fullmatch(pair['sourceHead']), 'Reviewed source HEAD is malformed.')
    for key, prefix in (('runtimeRoot', '/srv/pinkuang-deploy-v4/releases/'),
                        ('productRoot', '/var/www/bemine-v4/releases/')):
        root = plan.get(key)
        require(isinstance(root, str) and root.startswith(prefix)
                and RELEASE.fullmatch(root[len(prefix):]),
                f'Plan {key} is not a new release directory.')
    for env, required in (('runtimeEnvironment',
                           {'BEMINE_FRESH_CONSOLE_PRE_GENESIS': '1',
                            'BEMINE_FRESH_STAGE2_HOLD': '1',
                            'AUTHORITY_RELAY_ENABLED': '0',
                            'BEMINE_NOTIFICATIONS_ENABLED': '0'}),
                          ('purchaseEnvironment', {'FRESH_PURCHASE_ENABLED': '0'})):
        values = plan.get(env)
        require(isinstance(values, dict) and all(values.get(k) == v for k, v in required.items()),
                f'Plan {env} does not retain the disabled safety state.')
    return plan


def archive_files(path):
    require(path.is_absolute() and path.is_file() and not path.is_symlink(),
            'Release archive must be a regular absolute file.')
    files = {}
    total = 0
    with tarfile.open(path, 'r:gz') as archive:
        for item in archive:
            name = PurePosixPath(item.name)
            if str(name) == '.' and item.isdir():
                continue
            require(not name.is_absolute() and name.parts and '..' not in name.parts
                    and not any(part.startswith('.') for part in name.parts)
                    and (item.isfile() or item.isdir()),
                    'Release archive contains an unsafe entry.')
            if item.isdir():
                continue
            key = str(name)
            require(key not in files and 0 <= item.size <= MAX_FILE,
                    'Release archive has a duplicate or oversized file.')
            with archive.extractfile(item) as source:
                data = source.read(MAX_FILE + 1)
            require(len(data) == item.size, 'Release archive file length differs.')
            files[key] = data
            total += len(data)
            require(total <= MAX_ARCHIVE_CONTENT, 'Release archive is oversized.')
    return files


def validate_pair(plan, frontend, backend):
    pair = plan['releasePair']
    front_meta = frontend.get('fresh-product-release.json')
    back_meta = backend.get('public/fresh-release-manifest.json')
    require(front_meta and back_meta, 'Release metadata is missing.')
    require(sha256(front_meta) == pair['frontendReleaseSha256']
            and sha256(back_meta) == pair['backendReleaseSha256'],
            'Release metadata differs from the reviewed plan.')
    front = json.loads(front_meta)
    back = json.loads(back_meta)
    front_names = sorted(set(frontend) - {'fresh-product-release.json'})
    inventory = ''.join(f'{name}\0{sha256(frontend[name])}\n' for name in front_names)
    require(sha256(inventory.encode()) == pair['frontendContentSha256']
            and len(front_names) == pair['frontendFileCount']
            and front.get('contentSha256') == pair['frontendContentSha256']
            and front.get('frontendSourceHead') == pair['sourceHead']
            and front.get('manifestSha256') == pair['frontendManifestSha256']
            and front.get('activationAllowed') is False
            and front.get('kind') == 'fresh-v4-product-static-candidate'
            and 'data/frontend-manifest.json' not in frontend,
            'Frontend archive differs from the source-bound plan.')
    require(back.get('kind') == 'fresh-v4-product-backend-draft'
            and back.get('sourceHead') == pair['sourceHead']
            and back.get('indexManifestSha256') == pair['indexManifestSha256']
            and back.get('artifactDigest') == pair['artifactDigest']
            and back.get('sourceCommit') == pair['backendArtifactSourceCommit']
            and len(backend) == pair['backendFileCount'],
            'Backend archive differs from the source-bound plan.')
    listed = back.get('files')
    actual = set(backend) - {'public/fresh-release-manifest.json'}
    require(isinstance(listed, dict) and set(listed) == actual,
            'Backend file inventory differs from the release manifest.')
    for name in actual:
        require(listed[name] == {'sha256': sha256(backend[name]), 'bytes': len(backend[name])},
                f'Backend file differs from its release manifest: {name}')
    require(sha256(backend['public/fresh-product-manifest.json']) == pair['indexManifestSha256']
            and backend['dist/deployment-artifacts.json'] == backend['public/deployment-artifacts.json']
            and sha256(backend['public/deployment-artifacts.json']) == back.get('artifactSha256'),
            'Backend graph or deployment artifact differs from the reviewed plan.')
    for key in ('artifactDigest', 'factory', 'portfolioFactory', 'authority', 'gasWallet'):
        require(front.get(key) == pair.get(key),
                f'Frontend {key} differs from the reviewed plan.')


def safe_parent(root):
    parent = root.parent
    for ancestor in (parent, *parent.parents):
        require(not ancestor.is_symlink(), 'Release path traverses a symlink.')
    require(parent.is_dir() and parent.stat().st_uid == 0
            and not parent.stat().st_mode & (stat.S_IWGRP | stat.S_IWOTH),
            'Release parent must already be a root-owned, non-writable directory.')
    require(not root.exists() and not root.is_symlink(), 'Release directory already exists.')


def write_tree(directory, files):
    for name, data in files.items():
        target = directory.joinpath(*PurePosixPath(name).parts)
        target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        with target.open('xb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        target.chmod(0o644)
    for folder in (directory, *directory.rglob('*')):
        if folder.is_dir():
            folder.chmod(0o755)


def stage_pair(plan, frontend, backend):
    destinations = [(Path(plan['runtimeRoot']), backend), (Path(plan['productRoot']), frontend)]
    for root, _ in destinations:
        safe_parent(root)
    staged = []
    try:
        for root, files in destinations:
            directory = Path(tempfile.mkdtemp(prefix='.fresh-v4-stage-', dir=root.parent))
            staged.append((root, directory))
            write_tree(directory, files)
        for root, directory in staged:
            safe_parent(root)
            os.rename(directory, root)
        return [str(root) for root, _ in staged]
    finally:
        for _, directory in staged:
            if directory.exists():
                shutil.rmtree(directory)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--plan', required=True, type=Path)
    parser.add_argument('--plan-sha256', required=True)
    parser.add_argument('--frontend-archive', required=True, type=Path)
    parser.add_argument('--backend-archive', required=True, type=Path)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--dry-run', action='store_true')
    mode.add_argument('--stage', action='store_true')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'Root is required to stage a fresh-v4 release pair.')
    plan = load_plan(args.plan, args.plan_sha256)
    frontend = archive_files(args.frontend_archive)
    backend = archive_files(args.backend_archive)
    validate_pair(plan, frontend, backend)
    for root in (Path(plan['runtimeRoot']), Path(plan['productRoot'])):
        safe_parent(root)
    if args.dry_run:
        print('DRY-RUN OK: both release archives match the reviewed, disabled plan.')
        return
    staged = stage_pair(plan, frontend, backend)
    print('STAGED fresh-v4 pair: ' + ', '.join(staged))
    print('No service, site, signer, or transaction was activated.')


if __name__ == '__main__':
    main()
