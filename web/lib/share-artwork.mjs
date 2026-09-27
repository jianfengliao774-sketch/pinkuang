/** Explicit image and landing-page identities; invitation parameters cannot choose arbitrary assets. */
export const SHARE_ARTWORKS = Object.freeze([
  { id: 'original', zh: '墨绿经典', en: 'Green & gold', base: 'bemine-share-v10' },
  { id: 'anime', zh: '动漫矿友', en: 'Anime', base: 'bemine-share-v11-anime' },
  { id: 'real', zh: '真实矿友', en: 'Photography', base: 'bemine-share-v11-real' },
  { id: 'finance', zh: '金融共创', en: 'Finance', base: 'bemine-share-v11-finance' },
  { id: 'tech', zh: '科技电路', en: 'Technology', base: 'bemine-share-v11-tech' },
  { id: 'future', zh: '未来城市', en: 'Futurism', base: 'bemine-share-v11-future' },
  { id: 'papercraft', zh: '纸艺拼矿', en: 'Paper art', base: 'bemine-share-v11-papercraft' },
  { id: 'space', zh: '星际矿友', en: 'Space', base: 'bemine-share-v11-space' },
  { id: 'ink', zh: '水墨新章', en: 'Ink wash', base: 'bemine-share-v11-ink' },
].map(artwork => Object.freeze(artwork)));

export function normalizeSharePoster(id) {
  return typeof id === 'string' && SHARE_ARTWORKS.some(artwork => artwork.id === id) ? id : 'original';
}

export function shareArtwork(id) {
  return SHARE_ARTWORKS.find(artwork => artwork.id === normalizeSharePoster(id));
}
