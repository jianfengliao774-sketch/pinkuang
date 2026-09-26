import {useI18n} from '../lib/i18n';
import assets from '../lib/hero-assets.json';
const asset=name=>`${process.env.NEXT_PUBLIC_BASE_PATH||''}/images/${name}`;
function SceneImage({kind,className}){
 const {mobile,desktop}=assets[kind];
 return <picture>
  <source media="(max-width: 600px)" srcSet={asset(mobile.file)} type="image/webp"/>
  <img className={className} src={asset(desktop.file)} width={desktop.width} height={desktop.height} alt="" decoding="async"/>
 </picture>;
}
export default function HeroScene(){
 const {t}=useI18n();
 return <div className="bemine-scene" role="img" aria-label={t('墨绿色芯片与 BEM 金币')}>
  <SceneImage kind="background" className="scene-background"/>
  <div className="scene-objects" aria-hidden="true">
   <SceneImage kind="chip" className="scene-chip"/>
   <SceneImage kind="coin" className="scene-coin coin-back"/>
   <SceneImage kind="coin" className="scene-coin coin-left"/>
   <SceneImage kind="coin" className="scene-coin coin-front"/>
  </div>
 </div>
}
