import Platform from '../../components/PreviewPlatform';
import {I18nProvider} from '../../lib/i18n';
const title = '拼矿 BEMine · 体验共持矿机';
const description = '一起拼矿，一起发光。体验项目认购与邀请朋友的完整流程。演示预览，使用样例数据，不发生真实交易。';
export const metadata = {
  title,
  description,
  robots: {index: false, follow: false},
  openGraph: {
    title,
    description,
    type: 'website',
    url: 'https://tapeout.cc.cd/bemine/preview.html',
    siteName: '拼矿 BEMine',
    images: [{
      url: 'https://tapeout.cc.cd/bemine/images/bemine-share-v10.jpg',
      width: 1200,
      height: 630,
      alt: '拼矿 BEMine · 一起拼矿，一起发光',
    }],
  },
  twitter: {card: 'summary_large_image', title, description,
    images: ['https://tapeout.cc.cd/bemine/images/bemine-share-v10.jpg']},
};
export default function PreviewPage(){return <I18nProvider><Platform/></I18nProvider>}
