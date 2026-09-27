import { notFound } from 'next/navigation';
import ShareLanding from '../../../components/ShareLanding';
import { SHARE_ARTWORKS } from '../../../lib/share-artwork.mjs';

export const dynamicParams = false;
export function generateStaticParams() {
  return SHARE_ARTWORKS.map(art => ({ poster: art.id }));
}

export async function generateMetadata({ params }) {
  const { poster } = await params;
  const artwork = SHARE_ARTWORKS.find(art => art.id === poster);
  if (!artwork) notFound();
  const title = '拼矿 BEMine · 矿友的邀请';
  const description = '一起了解 TapeOut 矿机，分享共同参与的乐趣。Explore a shared mining adventure with BEMine.';
  const image = `https://tapeout.cc.cd/bemine/images/${artwork.base}.jpg`;
  return {
    title, description,
    robots: { index: false, follow: false },
    openGraph: { title, description, type: 'website', siteName: '拼矿 BEMine',
      images: [{ url: image, width: 1200, height: 630, alt: `BEMine · ${artwork.zh}` }] },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}

export default function SharePage() { return <ShareLanding />; }
