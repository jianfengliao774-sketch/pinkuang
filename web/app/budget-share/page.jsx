import PortfolioShareLanding from '../../components/PortfolioShareLanding';
import { PUBLIC_SHARE_ORIGIN } from '../../lib/public-share-origin.mjs';
const title='拼矿 BEMine · 多矿机共同项目';
const description='整个项目100份，多台矿机共同持有。100 project shares, multiple miners, shared decisions.';
const base=process.env.NEXT_PUBLIC_BASE_PATH||'/bemine';
const image=`${PUBLIC_SHARE_ORIGIN}${base}/images/bemine-budget-share.png`;
export const metadata={title,description,robots:{index:false,follow:false},
  openGraph:{title,description,type:'website',siteName:'拼矿 BEMine',images:[{url:image,width:1200,height:630,alt:'BEMine multi-miner portfolio'}]},
  twitter:{card:'summary_large_image',title,description,images:[image]}};
export default function Page(){return <PortfolioShareLanding/>;}
