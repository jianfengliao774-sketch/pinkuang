"""Repair the isolated index's quote endpoint without changing its deployed graph."""
import hashlib
import json
import os
import re
import sys
from pathlib import Path

root = Path('/srv/bemine-full-test/current').resolve()
assert os.geteuid() == 0 and root.parent == Path('/srv/bemine-full-test/releases')
head = sys.argv[1]
assert re.fullmatch('[a-f0-9]{40}', head)
name = 'runtime/deploy/server/chain-index/overview-stats.mjs'
target = root / name
inventories = [root / 'runtime-source-manifest.json', root / 'runtime/deploy/public/fresh-release-manifest.json']
records = [json.loads(path.read_text()) for path in inventories]
assert records[0] == records[1]
for entry, proof in records[0]['files'].items():
    assert hashlib.sha256((root / entry).read_bytes()).hexdigest() == proof['installedSha256'], entry
old = target.read_bytes()
before = b'http://127.0.0.1:4187/firsto-api'
after = b'http://127.0.0.1:4207/firsto-api'
assert old.count(before) == 1 or (old.count(after) == 1 and before not in old)
new = old.replace(before, after)
backup = target.with_name(target.name + '.before-home-cache')
if not backup.exists():
    backup.write_bytes(old)
def write(path, body):
    temporary = path.with_name(path.name + '.home-cache.next')
    with open(temporary, 'xb') as file:
        os.chmod(temporary, path.stat().st_mode & 0o777)
        file.write(body)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)
write(target, new)
record = records[0]
record['files'][name]['installedSha256'] = hashlib.sha256(new).hexdigest()
record['runtimePatchSourceHead'] = head
body = (json.dumps(record, indent=2) + '\n').encode()
for inventory in inventories:
    write(inventory, body)
print('Isolated index quote proxy and matching source inventories updated.')
