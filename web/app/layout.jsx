import './globals.css';
import './themes.css';
import './refinement.css';
import './home.css';
import './catalog.css';
import './motion.css';
import './language.css';
import './appearance.css';
import './dark.css';
import './desktop-review.css';
import './deploy-console.css';
import './live.css';
import { PUBLIC_SHARE_ORIGIN } from '../lib/public-share-origin.mjs';
const title = '拼矿 BEMine · 矿机资产服务';
const description = '一起拼矿，一起发光。参与矿机共持，查看资产、收益与共同决策。';
const shareImage = `${PUBLIC_SHARE_ORIGIN}${process.env.NEXT_PUBLIC_BASE_PATH || '/bemine'}/images/bemine-share-v10.jpg`;
export const metadata = {
  title, description,
  openGraph: {title, description, type: 'website', siteName: '拼矿 BEMine',
    images: [{url: shareImage, width: 1200, height: 630, alt: '拼矿 BEMine · 一起拼矿，一起发光'}]},
  twitter: {card: 'summary_large_image', title, description, images: [shareImage]},
};
export const viewport = {width: 'device-width', initialScale: 1, viewportFit: 'cover'};
export default function RootLayout({children}) {return <html lang="zh-CN"><body>{children}</body></html>}
