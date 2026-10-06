"""Fault injection for real static-update functions. No SSH or production commands."""
import ast,datetime,hashlib,json,os,pathlib,re,stat,subprocess,tempfile,time,unittest
HERE=pathlib.Path(__file__).resolve().parent
tree=ast.parse((HERE/'product-static-update.remote.py.template').read_text(encoding='utf8'))
def functions(ns):
    definitions=[n for n in tree.body if isinstance(n,ast.FunctionDef)]
    exec(compile(ast.Module(body=definitions,type_ignores=[]),'static-update-functions','exec'),ns);return ns
def plan():
    return {'operationId':'v2-static-test-1','releaseId':'v2-product-new','previousReleaseId':'v2-product-old','sourceHead':'a'*40,
      'previousSourceHead':'b'*40,'manifestSha256':'c'*64,'previousManifestSha256':'d'*64,'frontendManifestSha256':'e'*64,'artifactDigest':'0x'+'f'*64}

class Configuration(unittest.TestCase):
    def setUp(self):self.ns=functions({'re':re})
    def test_next_assets_use_product_base_path(self):
        self.ns['html_name']='public/bemine-v2/index.html'
        self.ns['regular']=lambda _:b'<script src="/bemine-v2/_next/static/chunks/app.js"></script>'
        self.ns['verify_base_path_assets'](pathlib.Path('/candidate'))
        self.ns['regular']=lambda _:b'<script src="/_next/static/chunks/app.js"></script>'
        with self.assertRaises(AssertionError):self.ns['verify_base_path_assets'](pathlib.Path('/candidate'))
    def test_expected_commit_hashes_and_paths(self):self.assertEqual(self.ns['options'](plan()),plan())
    def test_invalid_inputs_rejected(self):
        for key,value in [('releaseId','../elsewhere'),('releaseId','v2-product-old'),('operationId','v2-static-../bad'),('sourceHead','latest'),('manifestSha256','f'*63),('artifactDigest','0x00')]:
            with self.subTest(key=key),self.assertRaises(AssertionError):self.ns['options']({**plan(),key:value})
    def test_only_public_static_paths_allowed(self):
        self.ns['pathlib']=pathlib
        self.ns['relative_file']('public/bemine-v2/_next/static/chunks/app.js')
        for value in ['public/bemine-v2/../../x','/public/bemine-v2/x','public/bemine-v2/.env','public/bemine-v2/wallet.key','public/bemine-v2/journal.sqlite','server/index.mjs','public\\bemine-v2\\index.html','public/bemine-v2//index.html']:
            with self.subTest(value=value),self.assertRaises(AssertionError):self.ns['relative_file'](value)

@unittest.skipUnless(os.name=='posix' and os.geteuid()==0,'Real file ownership, symlink and directory fsync tests require isolated Linux root')
class FilesAndSwitch(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        root=pathlib.Path(self.tmp.name);self.base=root/'releases';self.base.mkdir();self.current=root/'current'
        self.config=plan();self.old=self.base/self.config['previousReleaseId'];self.new=self.base/self.config['releaseId']
        self.sha=lambda body:hashlib.sha256(body).hexdigest()
        self.front=(json.dumps({'kind':'integrated-v2','chainId':56,'artifactDigest':self.config['artifactDigest']})+'\n').encode()
        self.config['frontendManifestSha256']=self.sha(self.front)
        for directory,source,key in [(self.old,self.config['previousSourceHead'],'previousManifestSha256'),(self.new,self.config['sourceHead'],'manifestSha256')]:
            directory.mkdir();files={}
            for name,data in [('public/bemine-v2/index.html',b'<html><script src="/bemine-v2/_next/static/chunks/app.js"></script>'+source.encode()+b'</html>'),('public/bemine-v2/data/frontend-manifest.json',self.front)]:
                path=directory/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data);path.chmod(0o644)
                files[name]={'sha256':self.sha(data),'bytes':len(data)}
            body=(json.dumps({'schemaVersion':1,'sourceHead':source,'artifactDigest':self.config['artifactDigest'],'chainId':56,'basePath':'/bemine-v2','files':files})+'\n').encode()
            (directory/'product-release-manifest.json').write_bytes(body);self.config[key]=self.sha(body)
        os.symlink(str(self.old),self.current)
        self.protected={'example':'unchanged'}
        self.ns=functions({'os':os,'pathlib':pathlib,'stat':stat,'re':re,'json':json,'time':time,'subprocess':subprocess,'datetime':datetime,
          'sha':self.sha,'base':self.base,'current':self.current,'candidate':self.new,'previous':self.old,'CONFIG':self.config,
          'manifest_name':'product-release-manifest.json','html_name':'public/bemine-v2/index.html','frontend_name':'public/bemine-v2/data/frontend-manifest.json'})
        self.ns['protected_surface']=lambda:self.protected.copy()
        self.probes=[]
        def public(path):
            self.probes.append(path);name=self.ns['html_name'] if path=='/bemine-v2/' else self.ns['frontend_name']
            return 200,(pathlib.Path(os.readlink(self.current))/name).read_bytes()
        self.ns['public']=public
        self.state={'configDigest':self.sha(self.ns['state_bytes'](self.config)),'priorTarget':str(self.old),'candidateTarget':str(self.new),'protected':self.protected.copy()}
    def verify(self):return self.ns['verify_release'](self.new,self.config['manifestSha256'],self.config['sourceHead'])
    def test_valid_release_and_exact_public_bytes_switch(self):
        self.verify();result=self.ns['activate'](self.state)
        self.assertEqual(os.readlink(self.current),str(self.new));self.assertTrue(result['activated']);self.assertFalse(result['servicesRestarted'])
        self.assertEqual(self.probes,['/bemine-v2/','/bemine-v2/data/frontend-manifest.json'])
    def test_unprefixed_next_assets_are_rejected(self):
        path=self.new/self.ns['html_name']
        path.write_bytes(b'<html><script src="/_next/static/chunks/app.js"></script></html>')
        with self.assertRaises(AssertionError):self.ns['verify_base_path_assets'](self.new)
    def test_file_tamper_or_unlisted_file_rejected_before_switch(self):
        path=self.new/'public/bemine-v2/extra.js';path.write_bytes(b'not listed')
        with self.assertRaises(AssertionError):self.ns['activate'](self.state)
        self.assertEqual(os.readlink(self.current),str(self.old));path.unlink()
        (self.new/self.ns['html_name']).write_bytes(b'changed')
        with self.assertRaises(AssertionError):self.verify()
    def test_file_and_parent_symlinks_rejected(self):
        path=self.new/self.ns['html_name'];path.unlink();os.symlink(self.old/self.ns['html_name'],path)
        with self.assertRaises(AssertionError):self.verify()
    def test_wrong_source_or_contract_manifest_rejected(self):
        with self.assertRaises(AssertionError):self.ns['verify_release'](self.new,self.config['manifestSha256'],'0'*40)
        self.config['frontendManifestSha256']='0'*64
        with self.assertRaises(AssertionError):self.verify()
    def test_wrong_current_target_refuses_activation(self):
        self.current.unlink();os.symlink(str(self.new),self.current)
        with self.assertRaises(AssertionError):self.ns['activate'](self.state)
    def test_public_mismatch_rolls_back_exact_old_pointer(self):
        original=self.ns['public']
        self.ns['public']=lambda path:(200,b'wrong page') if os.readlink(self.current)==str(self.new) else original(path)
        with self.assertRaises(AssertionError):self.ns['activate'](self.state)
        self.assertEqual(os.readlink(self.current),str(self.old))
    def test_partial_switch_error_after_replace_also_restores(self):
        original=self.ns['switch']
        def switch(expected,target):
            original(expected,target)
            if target==str(self.new):raise RuntimeError('failure after atomic replace')
        self.ns['switch']=switch
        with self.assertRaises(RuntimeError):self.ns['activate'](self.state)
        self.assertEqual(os.readlink(self.current),str(self.old))
    def test_concurrent_target_is_never_overwritten_during_rollback(self):
        other=self.base/'v2-product-other';other.mkdir()
        def public(_path):self.current.unlink();os.symlink(str(other),self.current);return 200,b'wrong'
        self.ns['public']=public
        with self.assertRaises(AssertionError):self.ns['activate'](self.state)
        self.assertEqual(os.readlink(self.current),str(other))
    def test_changed_previous_release_prevents_rollback(self):
        self.ns['switch'](str(self.old),str(self.new));(self.old/self.ns['html_name']).write_bytes(b'changed old')
        with self.assertRaises(AssertionError):self.ns['restore'](self.state)
        self.assertEqual(os.readlink(self.current),str(self.new))
    def test_protected_surface_change_prevents_pointer_mutation(self):
        self.protected['example']='changed'
        with self.assertRaises(AssertionError):self.ns['activate'](self.state)
        self.assertEqual(os.readlink(self.current),str(self.old))

if __name__=='__main__':unittest.main()
