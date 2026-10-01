"""Repair new-miner discovery in the isolated runtime, preserving its contract graph."""
import hashlib
import json
import os
import re
import sys
from pathlib import Path

root = Path('/srv/bemine-full-test/current').resolve()
assert os.geteuid() == 0 and root.parent == Path('/srv/bemine-full-test/releases')
head, replacement_path, replacement_sha = sys.argv[1:]
assert re.fullmatch('[a-f0-9]{40}', head) and re.fullmatch('[a-f0-9]{64}', replacement_sha)
name = 'runtime/deploy/server/firsto-proxy.mjs'
target = root / name
inventories = [root / 'runtime-source-manifest.json', root / 'runtime/deploy/public/fresh-release-manifest.json']
records = [json.loads(path.read_text()) for path in inventories]
assert records[0] == records[1]
for entry, proof in records[0]['files'].items():
    assert hashlib.sha256((root / entry).read_bytes()).hexdigest() == proof['installedSha256'], entry
old, new = target.read_bytes(), Path(replacement_path).read_bytes()
assert hashlib.sha256(new).hexdigest() == replacement_sha
# Only the eligibility classification line and its explanatory comment may change.
before = b"    && row.category === 'official_mining' && row.classification === 'official_mining'"
after = b"    // New official NFTs may await netlist enrichment while Mining has already\n    // verified their weight. That unknown classification is not a missing ask.\n    && row.category === 'official_mining' && ['official_mining', 'unknown'].includes(row.classification)"
assert old == new or old.count(before) == 1 and old.replace(before, after) == new
backup = target.with_name(target.name + '.before-enrichment-fix')
if not backup.exists():
    backup.write_bytes(old)
def write(path, body):
    temporary = path.with_name(path.name + '.enrichment.next')
    with open(temporary, 'xb') as file:
        os.chmod(temporary, path.stat().st_mode & 0o777)
        file.write(body)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)
write(target, new)
record = records[0]
record['files'][name]['installedSha256'] = replacement_sha
record['runtimePatchSourceHead'] = head
body = (json.dumps(record, indent=2) + '\n').encode()
for inventory in inventories:
    write(inventory, body)
print('New official miner discovery and matching runtime inventories updated.')
