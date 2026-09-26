// Explicit preview-only memberships, intentionally shared across projects so totals
// count unique participant identities rather than adding per-project member counts.
export function platformTotals(pools){
 const participants=new Set();
 pools.forEach((p,i)=>{for(let n=0;n<p.members;n++)participants.add(`demo-wallet-${(n+i*8)%60}`)});
 const managed=pools.filter(p=>['Active','Listed'].includes(p.status));
 return {projects:pools.length,participants:participants.size,managed:managed.length,daily:managed.reduce((s,p)=>s+p.daily,0)};
}
