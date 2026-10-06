# Formal frontend: transaction submission without simulation

Published source: `c57de6cf5136bd17de100a264800b8099e869ccf`.
Public site: https://bemine.cc.cd/bemine-v4/.

The formal app entry uses `LivePlatform` and `sendProductTransaction`. This
sender does not execute the outgoing calldata with `eth_call`, and does not
invoke `eth_estimateGas`. It makes one explicit `eth_sendTransaction` request.
Contract getter calls used to read prices and balances are ordinary reads.
The unused older `LiveWorkspace` sender is not the formal app entry.

The initial wallet identity, session, journal, balance, fee and nonce reads now
start in one concurrent round instead of two sequential rounds. The submission
status reads “正在打开钱包…”. This change introduces no new confirmation page,
simulation step, service prerequisite or transaction lock. Existing exact
transaction encoding, server acknowledgement and wallet confirmation remain.

Validation:

- 671 web tests passed; 33 transaction tests passed again with a strengthened
  concurrency assertion that fails if reads wait for the test timeout.
- Contracts, deployment-console and fork jobs passed in
  https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/36750451073.
- Signed product build passed in
  https://github.com/jianfengliao774-sketch/pinkuang/actions/runs/36750456651.
- All three actual CI artifacts passed GitHub attestation verification. The
  exact clean source checkout independently verified the release pair.
- All backend business files and the contract deployment manifest match the
  existing deployment. The candidate backend archive was verification evidence
  only and was not installed.

Only static frontend files and the current symlink were published. API remains
on `bb546712caf5`; index, signer, purchase and mining remain on `10e243b35db1`.
The publisher verified unchanged service identities, configuration hashes and
database identities. It sent zero transactions and restarted zero services.

Publication receipt:
`/root/bemine-direct-wallet-c57de6cf5136-retry3/publication-receipt.json`, SHA256
`e34e97cc950ef9563bb3d4823b5d13d8f96c141d0e815608c7ddf41a68324e01`.
Plan SHA256: `0c63a560caa06ba9628eacd1a988f3d8ee205334f52f49cdfb85b339f511d2d8`.
Current frontend: `/var/www/bemine-v4/releases/v4-product-c57de6cf5136`.
Public HTML and all its JavaScript references match the reviewed CI bytes.

The first two publication checks rolled back the frontend after HTTP errors.
The diagnostic check identified HTTP 404 on `index.html`: new public directories
had mode 0700 because the evidence process used umask 077. The publisher now
sets reviewed public directories to 0755 before the switch. Evidence directories
remain private. Original attempt evidence is preserved separately.

Actual Chrome verification reconnected the existing MetaMask account, opened
the subscription form and prepared one share for TapeOut 12962. The amount
displayed `0.00111 BNB`, with the correct pool and payer, and “确认并前往钱包”
was enabled. That button was not clicked. The preview was closed afterwards.
Some background data remained marked as historical or pending update; this
publication does not claim that unrelated RPC read faults have disappeared.
The browser screenshot API timed out; verification used the actual DOM state.
