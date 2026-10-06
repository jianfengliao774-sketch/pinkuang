#!/usr/bin/env python3
"""Pure offline generation: reviewed staged pair -> explicit v4 units and plan."""
import argparse
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import re

DOMAIN_SHA='d51fda716d1144b4cb52b44436167d5ec8b6e3c201efdd8c9a601150d148e4d3'
SIGNER_SHA='002ced9077b7ff418bb2ed0f29c3fe8aab4428243bf291d7fde8af26a30f5293'
PRODUCT='pinkuang-product-v4.service';INDEX='pinkuang-index-v4.service'
SIGNER='pinkuang-v4-signer.service';PURCHASE='pinkuang-v4-purchase.service';MINING='pinkuang-v4-mining.service'
ENV_FILE='/etc/pinkuang-v4/product-runtime.env'
INPUT_ROOT='/etc/pinkuang-v4/product'


def need(ok,reason):
    if not ok: raise RuntimeError(reason)


def sha(b):return hashlib.sha256(b).hexdigest()


def env_lines(values):
    for key,value in values.items():
        need(re.fullmatch('[A-Z][A-Z0-9_]+',key) and '\n' not in str(value) and '"' not in str(value),'Unsafe unit environment.')
    return ''.join(f'Environment="{key}={value}"\n' for key,value in values.items())


def unit(description,user,group,runtime,entry,state,env,credentials=False,signer=False,args=''):
    text=f'''[Unit]
Description={description}
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=10min
StartLimitBurst=3

[Service]
Type=simple
User={user}
Group={group}
SupplementaryGroups=pinkuang-v4-relay
WorkingDirectory={runtime}
ExecStart=/usr/bin/node {runtime}/{entry}{args}
EnvironmentFile={ENV_FILE}
StateDirectory={state}
StateDirectoryMode=0700
'''+env_lines(env)
    if credentials:text+='LoadCredential=keeper-private-key:/etc/pinkuang/keeper.key\n'
    if signer or user=='pinkuang-v4-product' and state=='pinkuang-product-v4':
        text+='LoadCredential=authority-ipc-hmac:/etc/pinkuang-v4/authority-ipc-hmac\n'
    if signer:text+='RuntimeDirectory=pinkuang-v4-relay\nRuntimeDirectoryMode=0750\n'
    text+='UMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\n'
    text+='RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\n'
    text+='ReadWritePaths='+ ' '.join('/var/lib/'+x for x in state.split())+(' /run/pinkuang-v4-relay' if signer else '')+'\n'
    return text+'Restart=on-failure\nRestartSec=5\nTimeoutStopSec=45\n\n[Install]\nWantedBy=multi-user.target\n'


def vhost():
    return '''server {
    listen 80;
    listen [::]:80;
    server_name bemine.cc.cd;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/bemine-v4-acme;
        default_type text/plain;
        try_files $uri =404;
    }
    location / { return 308 https://bemine.cc.cd$request_uri; }
}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name bemine.cc.cd;
    ssl_certificate /etc/letsencrypt/live/bemine-domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bemine-domain/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:BEMineV4TLS:1m;
    ssl_session_timeout 10m;
    charset utf-8;
    add_header X-Content-Type-Options nosniff always;
    location = / { return 308 /bemine-v4/; }
    location = /bemine-v4 { return 308 /bemine-v4/; }
    location ^~ /bemine-v4/api/journal/deployment { return 404; }
    location ^~ /bemine-v4/api/journal/fresh-activation { return 404; }
    location ^~ /bemine-v4/api/journal/upgrade { return 404; }
    location ^~ /bemine-v4/api/ {
        proxy_pass http://127.0.0.1:4187/api/;
        proxy_set_header Host $host;
        proxy_set_header Origin $http_origin;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For "";
        proxy_set_header X-Forwarded-Host "";
        proxy_set_header X-Forwarded-Proto "";
        proxy_cookie_path /api/journal /bemine-v4/api/journal;
        proxy_connect_timeout 5s;
        proxy_read_timeout 90s;
    }
    location ^~ /bemine-v4/firsto-api/ {
        proxy_pass http://127.0.0.1:4187/firsto-api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For "";
        proxy_set_header X-Forwarded-Host "";
        proxy_set_header X-Forwarded-Proto "";
        proxy_set_header Cookie "";
        proxy_set_header Authorization "";
        proxy_hide_header Set-Cookie;
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
    }
    location = /bemine-v4/data/bem-price.json {
        alias /var/www/bemine-preview/data/bem-price.json;
        default_type application/json;
        add_header Cache-Control "no-store" always;
    }
    location ^~ /bemine-v4/ {
        rewrite ^/bemine-v4/(.*)$ /$1 break;
        root /var/www/bemine-v4/current;
        index index.html;
        try_files $uri $uri.html $uri/ =404;
        add_header Cache-Control "no-store" always;
    }
    location / { return 404; }
}
'''


def prepare(pair,inputs,limits):
    meta=pair.get('releasePair',{})
    need(pair.get('kind')=='fresh-v4-bound-cutover-draft' and pair.get('activationAllowed') is False
         and re.fullmatch('[0-9a-f]{40}',meta.get('sourceHead','')),'Reviewed source-bound pair is required.')
    runtime=pair.get('runtimeRoot','');product=pair.get('productRoot','')
    need(re.fullmatch('/srv/pinkuang-deploy-v4/releases/v4-[a-z0-9-]+',runtime)
         and re.fullmatch('/var/www/bemine-v4/releases/v4-[a-z0-9-]+',product),'Unsafe release paths.')
    for key in ['record','activation']:
        need(isinstance(inputs.get(key),dict) and str(inputs[key].get('sourcePath','')).startswith('/root/')
             and re.fullmatch('[0-9a-f]{64}',inputs[key].get('sha256','')),'Pinned root-private input is required.')
    for key in ['authorityTotalBnb','purchasePerJournalBnb','miningPerJournalBnb']:
        need(re.fullmatch(r'0\.[0-9]{1,8}',str(limits.get(key,''))) and 0<Decimal(limits[key])<=Decimal('0.5'),'Explicit bounded gas budgets are required.')
    need(0<Decimal(str(limits.get('maxGasPriceGwei','0')))<=3,'Gas-price limit must be explicit and <=3 gwei.')
    a=meta
    for key in ['factory','portfolioFactory','authority','gasWallet']:
        need(re.fullmatch('0x[0-9a-fA-F]{40}',a.get(key,'')),'Missing reviewed graph address.')
    common={'NODE_ENV':'production','DEPLOYMENT_JOURNAL_ORIGIN':'https://bemine.cc.cd',
       'BEMINE_DEPLOYMENT_RECORD_PATH':INPUT_ROOT+'/trusted-product-deployment.json',
       'BEMINE_PRODUCT_GENESIS_ARTIFACT_PATH':runtime+'/public/deployment-artifacts.json',
       'BEMINE_PRODUCT_ACTIVATION_PATH':INPUT_ROOT+'/fresh-activation.json',
       'BEMINE_EXPECTED_GAS_WALLET':a['gasWallet'],
       'BEMINE_FRESH_PRODUCT_MANIFEST_PATH':runtime+'/public/fresh-product-manifest.json',
       'BEMINE_FRESH_PRODUCT_MANIFEST_SHA256':a['indexManifestSha256']}
    product_env={**common,'HOST':'127.0.0.1','PORT':'4187','BEMINE_FRESH_PRODUCT_ENABLED':'1',
       'BEMINE_FRESH_CONSOLE_PRE_GENESIS':'0','BEMINE_FRESH_STAGE2_HOLD':'1',
       'DEPLOYMENT_JOURNAL_DB':'/var/lib/pinkuang-product-v4/journal.sqlite',
       'BEMINE_INDEX_URL':'http://127.0.0.1:4184','BEMINE_NOTIFICATIONS_ENABLED':'0',
       'BEMINE_JOURNAL_FACTORIES':a['factory']+','+a['portfolioFactory'],
       'AUTHORITY_RELAY_SOCKET':'/run/pinkuang-v4-relay/authority.sock',
       'AUTHORITY_RELAY_PUBLIC_ENABLED':'1','AUTHORITY_RELAY_ENABLED':'0'}
    index_env={'NODE_ENV':'production','CHAIN_INDEX_HOST':'127.0.0.1','CHAIN_INDEX_PORT':'4184',
       'CHAIN_INDEX_DB':'/var/lib/pinkuang-index-v4/index.sqlite','CHAIN_INDEX_CONFIRMATIONS':'12',
       'CHAIN_INDEX_SCAN_RANGE':'500','CHAIN_INDEX_LOGS_TIMEOUT_MS':'30000','CHAIN_INDEX_MODE':'fresh-v4',
       'CHAIN_INDEX_FRESH_MANIFEST_PATH':runtime+'/public/fresh-product-manifest.json',
       'CHAIN_INDEX_FRESH_MANIFEST_SHA256':a['indexManifestSha256']}
    worker={**common,'FRESH_PURCHASE_ENABLED':'1','BEMINE_V2_GAS_SENDER_DRAINED':'1',
       'PINKUANG_KEEPER_STATE_ROOT':'/var/lib/pinkuang-v4-signer/keeper',
       'AUTHORITY_RELAY_JOURNAL':'/var/lib/pinkuang-v4-signer/authority/authority.json'}
    signer={**worker,'AUTHORITY_RELAY_ENABLED':'1','AUTHORITY_SIGNER_ATTEST_ONLY':'0',
       'AUTHORITY_REQUIRE_FRESH_READINESS':'1','AUTHORITY_ATTESTATION_ORIGIN':'https://tapeout.cc.cd',
       'AUTHORITY_RELAY_SOCKET':'/run/pinkuang-v4-relay/authority.sock',
       'DEPLOYMENT_JOURNAL_DB':'/var/lib/pinkuang-product-v4/journal.sqlite',
       'AUTHORITY_RELAY_MAX_GAS_BNB':limits['authorityTotalBnb'],
       'AUTHORITY_RELAY_MAX_GAS_PRICE_GWEI':str(limits['maxGasPriceGwei'])}
    units={PRODUCT:unit('BEMine v4 independent product API','pinkuang-v4-product','pinkuang-v4-product',runtime,
              'server/index.mjs','pinkuang-product-v4',product_env),
           INDEX:unit('BEMine v4 independent verified chain index','pinkuang-v4-product','pinkuang-v4-product',runtime,
              'server/chain-index/server.mjs','pinkuang-index-v4',index_env),
           SIGNER:unit('BEMine v4 private Authority relay','pinkuang-v4-signer','pinkuang-v4-relay',runtime,
              'server/authority-signer.mjs','pinkuang-v4-signer',signer,credentials=True,signer=True)}
    for name,kind in [(PURCHASE,'purchase'),(MINING,'mining')]:
        args=f' --factory {a["factory"]} --rpc ${{DEPLOYMENT_JOURNAL_RPC_URL}} --journal-dir /var/lib/pinkuang-v4-signer/{kind}-journal --fresh-graph --send --max-gas-bnb {limits[kind+"PerJournalBnb"]} --max-gas-price-gwei {limits["maxGasPriceGwei"]}'
        if kind=='mining':args+=' --authority '+a['authority']
        units[name]=unit('BEMine v4 '+kind+' worker','pinkuang-v4-signer','pinkuang-v4-relay',runtime,
            'scripts/'+kind+'-supervisor.mjs','pinkuang-v4-signer',worker,credentials=True,args=args)
        units[name]=units[name].replace('Restart=on-failure\n','Restart=on-failure\nRestartPreventExitStatus=2\n')
    return {'schemaVersion':1,'kind':'bemine-v4-product-runtime-plan','chainId':56,
        'sourceHead':a['sourceHead'],'runtimeRoot':runtime,'productRoot':product,'releasePair':a,
        'inputs':inputs,'gasLimits':limits,'units':units,'unitSha256':{n:sha(t.encode()) for n,t in units.items()},
        'expectedDomainVhostSha256':DOMAIN_SHA,'expectedSignerUnitSha256':SIGNER_SHA,
        'expectedSignerDropins':[], 'environmentFile':ENV_FILE,'inputRoot':INPUT_ROOT,
        'expectedIndexUnitSha256':'2dfb199649ea006cc423bed4d5786bdd8851f6b33322fdc904d06e66ba18ebe0',
        'expectedIndexEnvironmentSha256':'2ef98608df23a9100a0a95fac14d5d544743453e0b963f64bd042befc4b986de',
        'rpcSourceUnit':'pinkuang-deploy-v4.service','logsRpcSourceUnit':'pinkuang-index-v4.service',
        'gasScope':{'ordinaryMemberTransactions':'user-wallet-pays','platformGas':'necessary-backend-automation-fees-only',
                    'purchasePrincipal':'pool-contract-pays','sharedCumulativeCap':False,
                    'budgetsAre':'authority-single-journal;purchase-and-mining-per-pool-journal'},
        'publication':{'currentLink':'/var/www/bemine-v4/current','expectedTarget':None,
                       'nginxVhost':'/etc/nginx/sites-available/bemine-v4-domain','content':vhost(),'sha256':sha(vhost().encode())},
        'operationOrder':['install-readers','enable-automation','publish','finalize-enable'],
        'automaticLegacySenderRestart':False}


if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--pair-plan',required=True);ap.add_argument('--pair-sha256',required=True)
    ap.add_argument('--inputs',required=True);ap.add_argument('--gas-limits',required=True);ap.add_argument('--out',required=True)
    a=ap.parse_args();raw=Path(a.pair_plan).read_bytes();need(sha(raw)==a.pair_sha256,'Pinned pair differs.')
    result=prepare(json.loads(raw),json.loads(Path(a.inputs).read_bytes()),json.loads(Path(a.gas_limits).read_bytes()))
    result['pairPlanSha256']=a.pair_sha256
    with Path(a.out).open('x',encoding='utf8') as f:f.write(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'planSha256':sha(Path(a.out).read_bytes()),'sourceHead':result['sourceHead'],
                      'roles':list(result['units']),'actionsRun':False}))
