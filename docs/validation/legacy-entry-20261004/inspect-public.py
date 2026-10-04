#!/usr/bin/env python3
"""Read public BEMine files/routes only; no RPC, credential or journal access."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html.parser import HTMLParser
import hashlib
import json
from pathlib import Path
import re
import urllib.error
import urllib.parse
import urllib.request

PAGE_SHA = '19a332738b5c0365ec128eadf0e55c5e87dd2a7a12eddc62f83fa0e87b9b491a'
ROOT = Path('/var/www/bemine-v5/current')
PREFIXES = ['bemine', *['bemine-v' + str(n) for n in range(1, 5)],
            'bemine-full-test', 'bemine-sale-test', 'bemine-test', 'bemine-live-test', 'bemine-preview',
            'pinkuang-deploy', *['pinkuang-deploy-v' + str(n) for n in range(1, 5)],
            'pinkuang-upgrade', *['pinkuang-upgrade-v' + str(n) for n in range(1, 5)]]


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []
    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            self.links.append(dict(attrs).get('href', ''))


def fetch(url):
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'BEMine-public-entry-audit'})
    try:
        response = urllib.request.urlopen(request, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read()
        parser = Links()
        parser.feed(body.decode('utf-8', errors='replace'))
        return {'url': url, 'finalUrl': response.url, 'status': response.status,
                'sha256': hashlib.sha256(body).hexdigest(), 'cacheControl': response.headers.get('Cache-Control'),
                'publicEntryLinks': [link for link in parser.links if re.search(r'(bemine|pinkuang)', link)]}


def main():
    hosts = ['https://tapeout.cc.cd', 'https://bemine.cc.cd']
    retired_urls = [host + '/' + prefix + '/?lang=zh' for host in hosts for prefix in PREFIXES]
    retired_urls.extend(host + path for host in hosts for path in [
        '/bemine/review-20260926/review.html', '/bemine-v3/#market',
        '/bemine-full-test/deploy/', '/bemine-sale-test/api/chain-index/v1/display/pools',
    ])
    regular_urls = ['https://bemine.cc.cd' + path for path in [
        '/', '/live', '/bemine-v5/?lang=zh', '/share/original.html?mode=live&project=0x8475ffffffffffffffffffffffffffffffffb67b',
        '/bemine-v5/share/original.html?mode=live&project=0x8475ffffffffffffffffffffffffffffffffb67b',
        '/mobile-review', '/preview', '/404', '/not-a-real-page-legacy-check/',
    ]] + ['https://tapeout.cc.cd/', 'https://tapeout.cc.cd/bemine-v5/?lang=zh',
           'https://bemine.cc.cd/pinkuang-target-owner-upgrade/']
    with ThreadPoolExecutor(max_workers=4) as pool:
        retired = list(pool.map(fetch, retired_urls))
        regular = list(pool.map(fetch, regular_urls))
    assert all(row['status'] == 503 and row['sha256'] == PAGE_SHA for row in retired)
    assert all('pinkuang-' not in link for row in retired for link in row['publicEntryLinks'])
    release = json.loads((ROOT / 'fresh-product-release.json').read_text())
    script_paths = set()
    html_links = []
    for path in sorted(ROOT.rglob('*.html')):
        text = path.read_text()
        parser = Links(); parser.feed(text)
        old_links = [link for link in parser.links if 'tapeout.cc.cd/bemine' in link or '/pinkuang-' in link]
        if old_links:
            html_links.append({'file': str(path.relative_to(ROOT)), 'links': old_links})
        script_paths.update(src[len('/bemine-v5/'):] for src in re.findall(r'<script[^>]+src="([^"]+)"', text)
                            if src.startswith('/bemine-v5/_next/static/'))
    urls = re.compile(r'https?://(?:tapeout|bemine)\.cc\.cd/[^\s"\x27\\<>`)]*')
    script_links = []
    for relative in sorted(script_paths):
        path = ROOT / urllib.parse.unquote(relative)
        links = sorted(set(urls.findall(path.read_text())))
        if links:
            script_links.append({'file': relative, 'links': links})
    nginx = []
    for base in [Path('/etc/nginx/sites-enabled'), Path('/etc/nginx/snippets')]:
        for path in sorted(base.iterdir()):
            if not path.is_file() or '.bak-' in path.name or '.before-' in path.name:
                continue
            for number, line in enumerate(path.read_text().splitlines(), 1):
                if re.search(r'(error_page|return|rewrite)', line) and re.search(r'(pinkuang|bemine|418|503)', line):
                    nginx.append({'file': str(path), 'line': number, 'rule': line.strip()})
    result = {'checkedAt': datetime.now(timezone.utc).isoformat(),
              'scope': 'public static files, nginx public entry rules, static HTTP GETs; no paid RPC or wallet calls',
              'currentProductDirectory': str(ROOT.resolve()),
              'release': {key: release.get(key) for key in ['frontendSourceHead', 'publicOrigin', 'publicUrl', 'deployConsoleUrl', 'basePath', 'artifactDigest']},
              'retiredFamilyCount': len(PREFIXES), 'retiredRouteResults': retired, 'regularRouteResults': regular,
              'activeHtmlCrossSiteLinks': html_links, 'activeScriptCount': len(script_paths), 'activeScriptCrossSiteLinks': script_links,
              'nginxEntryRules': nginx}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
