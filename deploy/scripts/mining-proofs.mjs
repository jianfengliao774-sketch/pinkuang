import { AbiCoder, concat, getAddress, keccak256, solidityPackedKeccak256 } from 'ethers';

const coder = AbiCoder.defaultAbiCoder();
const hex = value => typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value);
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const pair = (left, right) => keccak256(concat(left.toLowerCase() < right.toLowerCase() ? [left, right] : [right, left]));

/** Rebuild the official PoD Merkle root before any paid arm transaction. */
export function buildVectorTree(task) {
  if (!task || !Number.isSafeInteger(task.cycles) || task.cycles < 1 || task.cycles > 256
    || !Array.isArray(task.vectors) || task.vectors.length !== 256 || !hash(task.root)) {
    throw new Error('Official task vectors have an unsupported shape.');
  }
  const leaves = task.vectors.map((vector, index) => {
    if (!hex(vector?.input) || !hex(vector?.out)) throw new Error('Official task vector contains malformed bytes.');
    return keccak256(keccak256(coder.encode(['uint32', 'bytes', 'bytes'], [index, vector.input, vector.out])));
  });
  const layers = [leaves];
  while (layers.at(-1).length > 1) {
    const previous = layers.at(-1), next = [];
    for (let i = 0; i < previous.length; i += 2) next.push(pair(previous[i], previous[i + 1]));
    layers.push(next);
  }
  if (layers.at(-1)[0].toLowerCase() !== task.root.toLowerCase()) throw new Error('Official vector root mismatch.');
  return { task, layers, root: layers.at(-1)[0] };
}

export function startSamples(tree, anchorHash, circuits, circuitId, count) {
  if (!hash(anchorHash) || !Number.isSafeInteger(count) || count < 1 || count > 256) throw new Error('Invalid PoD anchor or sample count.');
  const collection = getAddress(circuits), id = BigInt(circuitId);
  const inputs = [], outputs = [], proofs = [];
  for (let sample = 0; sample < count; sample += 1) {
    const index = Number(BigInt(solidityPackedKeccak256(['bytes32', 'address', 'uint256', 'uint32'],
      [anchorHash, collection, id, sample])) % 256n);
    const vector = tree.task.vectors[index], proof = [];
    let at = index;
    for (let depth = 0; depth < tree.layers.length - 1; depth += 1) {
      proof.push(tree.layers[depth][at ^ 1]);
      at >>= 1;
    }
    inputs.push(vector.input); outputs.push(vector.out); proofs.push(proof);
  }
  return { inputs, outputs, proofs };
}

/** Bounded, read-only retrieval; transaction simulation remains the final protocol check. */
export async function fetchTaskVectors(taskId, fetcher = fetch) {
  const id = BigInt(taskId);
  if (id < 1n || id > 2n ** 32n - 1n) throw new Error('A verified task ID is required.');
  const response = await fetcher('https://tapeout.net/pod/pod-vectors-all.json',
    { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok || response.redirected || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
    throw new Error('Official vector bank is unavailable.');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 4 * 1024 * 1024) throw new Error('Official vector bank is too large.');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Official vector bank has no body.');
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 * 1024) throw new Error('Official vector bank is too large.');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatBytes(chunks, size)));
  if (!Object.hasOwn(json, id.toString())) throw new Error('Task is missing from the official vector bank.');
  return buildVectorTree(json[id.toString()]);
}

function concatBytes(chunks, size) {
  const output = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}
