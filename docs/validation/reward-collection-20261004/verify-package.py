"""Read-only local preflight for root's frontend build-summary.json/static.tgz."""

import argparse
import hashlib
import json
from pathlib import Path
import tarfile


def sha(data):
    return hashlib.sha256(data).hexdigest()


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def inventory(directory):
    names = sorted(path.relative_to(directory).as_posix() for path in directory.rglob('*')
                   if path.is_file() and path.name != 'fresh-product-release.json')
    require(all(not (directory / name).is_symlink() for name in names), 'Static tree contains symlinks')
    body = ''.join(name + '\0' + sha((directory / name).read_bytes()) + '\n' for name in names)
    return names, sha(body.encode())


def verify(root):
    summary = json.loads((root / 'build-summary.json').read_text())
    archive = root / 'static.tgz'
    static = root / 'static'
    require(archive.is_file() and static.is_dir(), 'Static directory or archive missing')
    require(archive.stat().st_size == summary['archive']['bytes'], 'Archive byte count mismatch')
    require(sha(archive.read_bytes()) == summary['archive']['sha256'], 'Archive SHA256 mismatch')
    files = sorted(path.relative_to(static).as_posix() for path in static.rglob('*') if path.is_file())
    require(len(files) == summary['packagedFileCount'], 'Static file count mismatch')
    with tarfile.open(archive, 'r:gz') as bundle:
        members = bundle.getmembers()
        names = [member.name for member in members]
        require(all(member.isfile() for member in members) and sorted(names) == files,
                'Archive file inventory differs from static directory')
        for member in members:
            require(sha(bundle.extractfile(member).read()) == sha((static / member.name).read_bytes()),
                    f'Archive content differs: {member.name}')
    release_bytes = (static / 'fresh-product-release.json').read_bytes()
    require(sha(release_bytes) == summary['frontendReleaseManifestSha256'],
            'Frontend release manifest SHA256 mismatch')
    release = json.loads(release_bytes)
    require(release['frontendSourceHead'] == summary['frontendSourceHead']
            and release['runtimeSourceHead'] == summary['runtimeSourceHead']
            and release['runtimeCutoverRequired'] is False,
            'Frontend source or runtime identity mismatch')
    names, content = inventory(static)
    require(release['fileCount'] == len(names) and release['contentSha256'] == content,
            'Frontend static content hash mismatch')
    require('index.html' in files and 'live.html' in files
            and 'data/frontend-manifest.v5.json' in files, 'Canonical page or manifest missing')
    return {'frontendSourceHead': release['frontendSourceHead'],
            'runtimeSourceHead': release['runtimeSourceHead'],
            'archiveSha256': summary['archive']['sha256'],
            'packagedFileCount': len(files), 'contentSha256': content}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path,
                        default=Path('/private/tmp/bemine-reward-collection-release-20261004'))
    print(json.dumps(verify(parser.parse_args().root), separators=(',', ':')))
