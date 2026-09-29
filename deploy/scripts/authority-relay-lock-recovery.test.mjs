import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorityLockPath, clearStaleAuthorityLock } from './authority-relay-lock-recovery.mjs';

function fixture() {
  const directory=mkdtempSync(join(tmpdir(),'authority-lock-recovery-'));
  const root=join(directory,'locks'), resource=join(directory,'authority.json');
  mkdirSync(root,{mode:0o700});
  const path=authorityLockPath(resource,root);
  return {directory,root,resource,path,close:()=>rmSync(directory,{recursive:true,force:true})};
}

test('live, young, malformed and nonprivate Authority locks remain untouched',()=>{
  const f=fixture();
  try {
    const old=new Date(Date.now()-120_000);
    writeFileSync(f.path,JSON.stringify({pid:process.pid,resource:f.resource,createdAt:old.toISOString()}),{mode:0o600});
    utimesSync(f.path,old,old);
    assert.throws(()=>clearStaleAuthorityLock(f.resource,f.root),/still alive/);
    assert.equal(existsSync(f.path),true);
    const child=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'});
    assert.equal(child.status,0);
    writeFileSync(f.path,JSON.stringify({pid:Number(child.stdout),resource:f.resource,createdAt:new Date().toISOString()}));
    assert.throws(()=>clearStaleAuthorityLock(f.resource,f.root),/minimum age/);
    utimesSync(f.path,old,old);
    writeFileSync(f.path,JSON.stringify({pid:Number(child.stdout),resource:'wrong',createdAt:old.toISOString()}));
    utimesSync(f.path,old,old);
    assert.throws(()=>clearStaleAuthorityLock(f.resource,f.root),/identity/);
    chmodSync(f.path,0o644);
    assert.throws(()=>clearStaleAuthorityLock(f.resource,f.root),/private regular file/);
    assert.equal(existsSync(f.path),true);
  } finally {f.close();}
});

test('explicit recovery removes only an old lock whose owner is dead',()=>{
  const f=fixture();
  try {
    const child=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'});
    assert.equal(child.status,0);
    const old=new Date(Date.now()-120_000);
    writeFileSync(f.path,JSON.stringify({pid:Number(child.stdout),resource:f.resource,createdAt:old.toISOString()}),{mode:0o600});
    utimesSync(f.path,old,old);
    assert.equal(clearStaleAuthorityLock(f.resource,f.root).status,'stale-lock-cleared');
    assert.equal(existsSync(f.path),false);
    assert.equal(existsSync(`${f.path}.recovery`),false);
  } finally {f.close();}
});
