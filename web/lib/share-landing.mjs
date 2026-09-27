import { pools } from './demo-data.js';
import { normalizeSharePoster } from './share-artwork.mjs';

const ORIGIN = 'https://tapeout.cc.cd';
const BASE = '/bemine';
const DEMO_IDS = new Set(pools.map(pool => pool.id));
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const SOURCES = new Set(['tg', 'x', 'native']);
const KEYS = new Set(['mode', 'project', 'source']);

function validProject(mode, project) {
  return mode === 'demo' ? DEMO_IDS.has(project)
    : mode === 'live' && ADDRESS.test(project || '') && !/^0x0{40}$/i.test(project);
}

/** Static per-artwork URLs let social crawlers see the selected image without JavaScript. */
export function makeArtworkShareUrl(projectUrl, posterId = 'original') {
  try {
    const source = new URL(projectUrl);
    if (source.origin !== ORIGIN || source.username || source.password
      || ![`${BASE}/`, `${BASE}/preview.html`].includes(source.pathname)
      || [...source.searchParams.keys()].some(key => key !== 'source')
      || source.searchParams.getAll('source').length > 1) return null;
    const mode = source.pathname.endsWith('/preview.html') ? 'demo' : 'live';
    const project = source.hash.startsWith('#detail/') ? source.hash.slice(8) : '';
    const attribution = source.searchParams.get('source');
    if (!validProject(mode, project) || attribution !== null && !SOURCES.has(attribution)) return null;
    const target = new URL(`${BASE}/share/${normalizeSharePoster(posterId)}.html`, ORIGIN);
    target.searchParams.set('mode', mode);
    target.searchParams.set('project', mode === 'live' ? project.toLowerCase() : project);
    if (attribution) target.searchParams.set('source', attribution);
    return target.href;
  } catch { return null; }
}

/** No arbitrary redirect, factory or wallet parameters. Destinations are same-site project routes only. */
export function resolveArtworkShareTarget(search, basePath = '/bemine', staticExport = true) {
  const params = new URLSearchParams(search);
  if ([...params.keys()].some(key => !KEYS.has(key) || params.getAll(key).length !== 1)) return null;
  const mode = params.get('mode');
  const project = params.get('project');
  const source = params.get('source');
  if (!validProject(mode, project) || source !== null && !SOURCES.has(source)) return null;
  // basePath comes only from build configuration; reject protocol-relative/path traversal forms.
  if (!['', '/bemine'].includes(basePath)) return null;
  const route = mode === 'demo' ? `${basePath}/preview${staticExport ? '.html' : ''}` : `${basePath}/`;
  const query = source ? `?source=${source}` : '';
  return `${route}${query}#detail/${mode === 'live' ? project.toLowerCase() : project}`;
}
