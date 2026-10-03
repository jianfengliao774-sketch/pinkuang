"""Build an unsigned, credential-free installer plan from reviewed local evidence."""
import argparse
import hashlib
import json
import os
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package-dir', type=Path, required=True)
    parser.add_argument('--units-json', type=Path, required=True)
    parser.add_argument('--precheck', type=Path, required=True)
    parser.add_argument('--stage1', type=Path, required=True)
    parser.add_argument('--operation-id', required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    manifest_path = args.package_dir / 'stage2-attestor-manifest.json'
    manifest = read(manifest_path); units = read(args.units_json)
    check = read(args.precheck); stage1 = read(args.stage1)
    rows = stage1['records']['deployment']
    if len(rows) != 1:
        raise ValueError('Exactly one reviewed deployment row is required.')
    row = rows[0]; record = row['record']
    plan = {'schemaVersion': 1, 'operationId': args.operation_id,
            'sourceCommit': manifest['sourceCommit'],
            'releaseId': Path(units['signerRoot']).name,
            'manifestSha256': digest(manifest_path.read_bytes()),
            'unitsSha256': digest(args.units_json.read_bytes()),
            'currentUnitSha256': check['unitHashes']['/etc/systemd/system/pinkuang-deploy-v4.service'],
            'currentPublicRelease': check['services']['pinkuang-deploy-v4.service']['WorkingDirectory'],
            'deploymentAccount': record['account'], 'deploymentId': record['id'],
            'artifactDigest': record['artifactDigest'], 'stage1RecordSha256': digest(canonical(record)),
            'stage1Revision': row['revision']}
    # Always write a new plan; another release requires another review/digest.
    data = json.dumps(plan, ensure_ascii=False, indent=2).encode() + b'\n'
    descriptor = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(data)
    print(json.dumps({'plan': str(args.out), 'sha256': digest(data),
                      'sourceCommit': plan['sourceCommit'], 'releaseId': plan['releaseId']}))


if __name__ == '__main__':
    main()
