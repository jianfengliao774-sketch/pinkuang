import { AbiCoder, Interface, TypedDataEncoder, ZeroAddress, getAddress, keccak256, toUtf8Bytes } from 'ethers';

const types = Object.freeze({ ConfigureTargetOwner: Object.freeze([
  ['pool', 'address'], ['factory', 'address'], ['circuits', 'address'], ['circuitId', 'uint256'],
  ['originalOwner', 'address'], ['authority', 'address'], ['administratorOne', 'address'],
  ['administratorTwo', 'address'], ['nonce', 'uint256'], ['deadline', 'uint256'],
].map(([name, type]) => Object.freeze({ name, type }))) });
const authorizationTuple = '(address originalOwner,address authority,address administratorOne,address administratorTwo,uint256 nonce,uint256 deadline)';
const iface = new Interface(['function configureTargetOwner(bytes authorization)']);
const nft = new Interface(['function ownerOf(uint256) view returns(address)',
  'event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)']);
const factoryEvents = new Interface(['event PoolCreated(address indexed pool,address indexed circuits,uint256 indexed circuitId,uint256 targetRaise,uint256 priceCap,address treasury)']);
const need = (ok, message) => { if (!ok) throw new Error(message); };
const address = (value, label) => {
  const a = getAddress(value); need(a !== ZeroAddress, `${label} is zero.`); return a;
};
const uint = (value, label) => {
  need(typeof value === 'bigint' || typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
    || Number.isSafeInteger(value) && value >= 0, `${label} must be an exact unsigned integer.`);
  const n = BigInt(value); need(n >= 0n && n < 2n ** 256n, `${label} is outside uint256.`); return n;
};
function normalize(input) {
  const out = Object.fromEntries(['originalOwner', 'authority', 'administratorOne', 'administratorTwo']
    .map(name => [name, address(input[name], name)]));
  need(out.administratorOne !== out.administratorTwo, 'Two distinct current administrators are required.');
  return { ...out, nonce: uint(input.nonce, 'nonce'), deadline: uint(input.deadline, 'deadline') };
}

/** Unsigned staged-only data. The caller must first verify current roles, capability and the historical owner evidence. */
export function targetOwnerTypedAction(context, authorization) {
  const a = normalize(authorization), pool = address(context.pool, 'pool');
  need(pool !== a.originalOwner, 'The original owner cannot be this pool.');
  const chainId = uint(context.chainId, 'chainId'); need(chainId > 0n, 'chainId is zero.');
  const domain = { name: 'BEMine Target Owner', version: '1', chainId, verifyingContract: pool };
  const message = { pool, factory: address(context.factory, 'factory'), circuits: address(context.circuits, 'circuits'),
    circuitId: uint(context.circuitId, 'circuitId'), ...a };
  return Object.freeze({ domain: Object.freeze(domain), types, primaryType: 'ConfigureTargetOwner',
    message: Object.freeze(message), digest: TypedDataEncoder.hash(domain, types, message) });
}

export function encodeTargetOwnerConfiguration(authorization, signatureOne, signatureTwo) {
  const a = normalize(authorization);
  need(/^0x[\da-f]{130}$/i.test(signatureOne ?? '') && /^0x[\da-f]{130}$/i.test(signatureTwo ?? ''),
    'Two canonical 65-byte ECDSA signatures are required.');
  const encoded = AbiCoder.defaultAbiCoder().encode([authorizationTuple, 'bytes', 'bytes'], [a, signatureOne, signatureTwo]);
  need((encoded.length - 2) / 2 === 512, 'Unexpected target-owner authorization length.');
  return Object.freeze({ authorization: encoded, data: iface.encodeFunctionData('configureTargetOwner', [encoded]) });
}

/** Offline review packet, not a chain proof. Completeness/canonical-chain provenance requires independent administrator review. */
export function prepareTargetOwnerMigration(context, authorization, evidence) {
  const action = targetOwnerTypedAction(context, authorization), identity = action.message;
  const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  const hash = value => /^0x[\da-f]{64}$/i.test(value ?? '');
  const ordinal = value => Number.isSafeInteger(value) && value >= 0;
  const creation = evidence?.creation;
  need(uint(evidence?.chainId, 'evidence chainId') === action.domain.chainId, 'Evidence belongs to another chain.');
  need(creation && ordinal(creation.blockNumber) && hash(creation.blockHash) && hash(creation.transactionHash)
    && ordinal(creation.transactionIndex) && ordinal(creation.logIndex), 'Canonical creation identity is required.');
  const canonicalLog = (log, iface) => {
    need(log && log.removed !== true && log.blockNumber === creation.blockNumber
      && same(log.blockHash, creation.blockHash) && hash(log.transactionHash)
      && ordinal(log.transactionIndex) && ordinal(log.logIndex) && Array.isArray(log.topics),
    'Canonical same-block event evidence is required.');
    const parsed = iface.parseLog(log), encoded = iface.encodeEventLog(parsed.fragment, parsed.args);
    need(same(encoded.data, log.data) && encoded.topics.length === log.topics.length
      && encoded.topics.every((topic, index) => same(topic, log.topics[index])), 'Event evidence is not canonical.');
    return parsed;
  };
  const created = canonicalLog(creation, factoryEvents);
  need(created.name === 'PoolCreated' && same(creation.address, identity.factory)
    && same(created.args.pool, identity.pool) && same(created.args.circuits, identity.circuits)
    && created.args.circuitId === identity.circuitId, 'Creation evidence belongs to another pool or target.');
  const read = evidence.blockEndOwnerRead;
  need(read && same(read.to, identity.circuits) && read.blockNumber === creation.blockNumber
    && same(read.blockHash, creation.blockHash)
    && same(read.data, nft.encodeFunctionData('ownerOf', [identity.circuitId])), 'Creation-block owner read is required.');
  need(/^0x[\da-f]{64}$/i.test(read.result ?? ''), 'Creation-block owner result is not canonical.');
  const [endOwner] = nft.decodeFunctionResult('ownerOf', read.result);
  need(same(nft.encodeFunctionResult('ownerOf', [endOwner]), read.result) && endOwner !== ZeroAddress,
    'Creation-block owner result is not canonical.');
  need(Array.isArray(evidence.transfers) && evidence.transfers.length <= 10_000,
    'The complete bounded target-transfer evidence is required.');
  const transfers = evidence.transfers.map(log => {
    const event = canonicalLog(log, nft);
    need(event.name === 'Transfer' && same(log.address, identity.circuits)
      && event.args.tokenId === identity.circuitId, 'Transfer evidence belongs to another target.');
    return { log, from: getAddress(event.args.from), to: getAddress(event.args.to) };
  }).sort((a, b) => a.log.logIndex - b.log.logIndex);
  need(new Set(transfers.map(item => item.log.logIndex)).size === transfers.length
    && !transfers.some((item, index) => item.log.logIndex === creation.logIndex
      || index && item.log.transactionIndex < transfers[index - 1].log.transactionIndex
      || (item.log.logIndex > creation.logIndex) !== (item.log.transactionIndex > creation.transactionIndex
        || item.log.transactionIndex === creation.transactionIndex && item.log.logIndex > creation.logIndex)),
  'Transfer event ordering is inconsistent.');
  const transactionHashes = new Map([[creation.transactionIndex, creation.transactionHash.toLowerCase()]]);
  for (const { log } of transfers) {
    const prior = transactionHashes.get(log.transactionIndex);
    need(!prior || same(prior, log.transactionHash), 'Transfer transaction identity is inconsistent.');
    transactionHashes.set(log.transactionIndex, log.transactionHash.toLowerCase());
  }
  let owner = getAddress(endOwner);
  for (const item of transfers.filter(item => item.log.logIndex > creation.logIndex).reverse()) {
    need(owner === item.to && item.from !== ZeroAddress, 'Creation-block owner transfer chain is incomplete.');
    owner = item.from;
  }
  need(owner === identity.originalOwner, 'Authorized original owner differs from creation-time evidence.');
  const json = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item));
  const publicLog = log => ({ address: getAddress(log.address), blockNumber: log.blockNumber,
    blockHash: log.blockHash.toLowerCase(), transactionHash: log.transactionHash.toLowerCase(),
    transactionIndex: log.transactionIndex, logIndex: log.logIndex, data: log.data.toLowerCase(),
    topics: log.topics.map(topic => topic.toLowerCase()), removed: false });
  const reviewedEvidence = json({ chainId: action.domain.chainId, creation: publicLog(creation),
    blockEndOwnerRead: { to: identity.circuits, blockNumber: creation.blockNumber,
      blockHash: creation.blockHash.toLowerCase(), data: read.data.toLowerCase(), result: read.result.toLowerCase() },
    transfers: transfers.map(item => publicLog(item.log)), reconstructedOwner: owner });
  return Object.freeze({ schemaVersion: 1, kind: 'target-owner-migration-review-v1',
    context: json({ chainId: action.domain.chainId, ...identity }), typedAction: json(action),
    evidence: reviewedEvidence, evidenceDigest: keccak256(toUtf8Bytes(JSON.stringify(reviewedEvidence))),
    signers: [identity.administratorOne, identity.administratorTwo],
    evidenceTrust: 'administrator_review_required', evidenceDigestIsSigned: false,
    activation: 'requires_reviewed_targetOwnerVersion_1_runtime', submitted: false });
}
