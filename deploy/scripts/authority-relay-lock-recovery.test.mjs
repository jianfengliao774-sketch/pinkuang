import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorityLockPath, clearStaleAuthorityLock } from './authority-relay-lock-recovery.mjs';
import { acquireKeeperLock } from './purchase-keeper.mjs';

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

test('explicit recovery preserves the lock inode and repairs a stale legacy or torn record',()=>{
  const f=fixture();
  try {
    const child=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'});
    assert.equal(child.status,0);
    const old=new Date(Date.now()-120_000);
    writeFileSync(f.path,JSON.stringify({pid:Number(child.stdout),resource:f.resource,createdAt:old.toISOString()}),{mode:0o600});
    utimesSync(f.path,old,old);
    const inode = statSync(f.path).ino;
    assert.equal(clearStaleAuthorityLock(f.resource,f.root).status,'stale-lock-reinitialized');
    assert.equal(statSync(f.path).ino,inode);
    assert.equal(JSON.parse(readFileSync(f.path,'utf8')).lockProtocol,'flock-v1');
    assert.equal(clearStaleAuthorityLock(f.resource,f.root).status,'stable-lock-reusable');
    writeFileSync(f.path,'');
    utimesSync(f.path,old,old);
    assert.equal(clearStaleAuthorityLock(f.resource,f.root).status,'stale-lock-reinitialized');
    assert.equal(statSync(f.path).ino,inode);
  } finally {f.close();}
});

test('recovery cannot change a lock held by a live signer',()=>{
  const f=fixture();
  try {
    const release=acquireKeeperLock(f.resource,f.root);
    try {
      assert.throws(()=>clearStaleAuthorityLock(f.resource,f.root),/holds this lock/);
      assert.equal(existsSync(f.path),true);
    } finally {release();}
  } finally {f.close();}
});
