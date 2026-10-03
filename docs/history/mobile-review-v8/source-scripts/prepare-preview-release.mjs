// Call after building with NEXT_PUBLIC_BASE_PATH=/bemine.
// Retire public links without modifying offline archived releases or browser feedback.
import {mkdirSync,writeFileSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const out=fileURLToPath(new URL('../out/',import.meta.url));
function redirect(path,target){const full=join(out,path);mkdirSync(join(full,'..'),{recursive:true});writeFileSync(full,`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>拼矿 BEMine · 审查入口已更新</title><meta http-equiv="refresh" content="0;url=${target}"><body><p>审查入口已更新。</p><a href="${target}">打开最新版</a><script>location.replace(${JSON.stringify(target)}+location.search+location.hash)</script></body></html>`)}
for(const prefix of ['review-20260926','review-mobile-v7','review-mobile-v8']){
 redirect(`${prefix}/index.html`,'/bemine/mobile-review.html');
 for(const page of ['review.html','mobile-review.html'])redirect(`${prefix}/${page}`,'/bemine/mobile-review.html');
 for(const page of ['review/frame.html','mobile-review/frame.html'])redirect(`${prefix}/${page}`,'/bemine/mobile-review/frame.html');
 redirect(`${prefix}/mobile-review/view.html`,'/bemine/mobile-review/view.html');
 redirect(`${prefix}/design.html`,'/bemine/design.html');
 const dir=join(out,prefix,'review-files');mkdirSync(dir,{recursive:true});
 for(const name of ['bemine-review-checklist.md','bemine-review-index.json','bemine-mobile-review-v8.md'])copyFileSync(join(out,'review-files',name),join(dir,name));
 copyFileSync(join(out,'review-files/bemine-mobile-review-v8.md'),join(dir,'bemine-mobile-review-v7.md'));
}
// Preserve the old standalone checklist link with current contents.
copyFileSync(join(out,'review-files/bemine-mobile-review-v8.md'),join(out,'review-files/bemine-mobile-review-v7.md'));
console.log('Compatibility review entries now point to the current v8 review.');
