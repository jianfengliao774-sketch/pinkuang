export default function CommunityPattern(){
 return <svg className="bemine-life-pattern" viewBox="0 0 420 260" fill="none" aria-hidden="true" focusable="false">
  <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
   <path opacity=".5" d="M0 66h88l32 32h50M0 195h73l38-38h59M420 60h-78l-38 38h-48M420 200h-73l-43-43h-48M212 0v58M212 202v58"/>
   <path d="M34 99h68l26 26h37M46 164h61l27-23h31M386 95h-63l-31 30h-34M374 162h-62l-23-21h-31"/>
   <rect x="164" y="80" width="94" height="100" rx="12"/>
   <rect x="177" y="93" width="68" height="74" rx="6"/>
   {[181,201,221,241].map(x=><path key={x} d={`M${x} 70v10M${x} 180v10`}/>)}
   {[99,119,139,159].map(y=><path key={y} d={`M154 ${y}h10M258 ${y}h10`}/>)}
   <path strokeWidth="2.2" d="M192 112h38v10h-14v29h-10v-29h-14z"/>
   <circle cx="98" cy="58" r="23"/><circle opacity=".6" cx="98" cy="58" r="17"/>
   <path d="M94 45v26m-5-22h11c8 0 8 9 0 9H90m10 0c9 0 9 10 0 10H89"/>
   <circle cx="322" cy="205" r="25"/><circle opacity=".6" cx="322" cy="205" r="19"/>
   <path d="M318 192v26m-5-22h11c8 0 8 9 0 9h-10m10 0c9 0 9 10 0 10h-11"/>
   {[[34,99],[46,164],[386,95],[374,162],[212,40],[212,220]].map(([x,y])=><circle key={`${x}-${y}`} cx={x} cy={y} r="3" fill="currentColor" stroke="none"/>)}
  </g>
 </svg>;
}
