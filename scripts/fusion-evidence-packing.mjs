import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_DOCUMENTS = 10;
const MAX_FEATURES = 32;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;

function record(value, required, optional = []) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function vector(value, width) {
  return Array.isArray(value) && value.length === width && Array.from(value).every(Number.isFinite);
}

/** Select a bounded document set from a caller-supplied conditional pair model. */
export function packEvidence(input) {
  if (!record(input, ['version', 'documentCount', 'head', 'pairs'], ['limit']) || input.version !== 1
    || !Number.isSafeInteger(input.documentCount) || input.documentCount < 2 || input.documentCount > MAX_DOCUMENTS) {
    throw new Error('invalid_evidence_input');
  }
  const count = input.documentCount;
  const limit = input.limit === undefined ? Math.min(4, count) : input.limit;
  if (!Number.isSafeInteger(limit) || limit < 2 || limit > count) throw new Error('invalid_evidence_limit');
  const head = input.head;
  const width = head?.weights?.length;
  if (!record(head, ['weights', 'mean', 'scale']) || !Number.isSafeInteger(width) || width < 1 || width > MAX_FEATURES
    || !vector(head.weights, width) || !vector(head.mean, width) || !vector(head.scale, width)
    || head.scale.some(value => value <= 0)) throw new Error('invalid_evidence_head');
  if (!Array.isArray(input.pairs) || input.pairs.length !== count * (count - 1) / 2) {
    throw new Error('incomplete_evidence_pairs');
  }
  const seen = new Set();
  const pairs = Array.from(input.pairs, pair => {
    if (!record(pair, ['indices', 'features']) || !Array.isArray(pair.indices) || pair.indices.length !== 2
      || !Array.from(pair.indices).every(Number.isSafeInteger) || pair.indices[0] < 0
      || pair.indices[0] >= pair.indices[1] || pair.indices[1] >= count || !vector(pair.features, width)) {
      throw new Error('invalid_evidence_pair');
    }
    const [first, second] = pair.indices;
    const key = first * count + second;
    if (seen.has(key)) throw new Error('duplicate_evidence_pair');
    seen.add(key);
    let logit = 0;
    for (let i = 0; i < width; i++) logit += ((pair.features[i] - head.mean[i]) / head.scale[i]) * head.weights[i];
    if (!Number.isFinite(logit)) throw new Error('nonfinite_evidence_score');
    return { key, mask: (1 << first) | (1 << second), logit };
  }).sort((a, b) => a.key - b.key);
  const maximum = Math.max(...pairs.map(pair => pair.logit));
  const weighted = pairs.map(pair => ({ mask: pair.mask, weight: Math.exp(pair.logit - maximum) }));
  const total = weighted.reduce((sum, pair) => sum + pair.weight, 0);
  let bestMass = -1;
  let selectedIndices;
  const search = (start, indices, mask) => {
    if (indices.length === limit) {
      let mass = 0;
      for (const pair of weighted) if ((mask & pair.mask) === pair.mask) mass += pair.weight;
      // Lexicographic traversal and strict comparison make exact ties stable.
      if (mass > bestMass) { bestMass = mass; selectedIndices = [...indices]; }
      return;
    }
    for (let index = start; index <= count - (limit - indices.length); index++) {
      indices.push(index);
      search(index + 1, indices, mask | (1 << index));
      indices.pop();
    }
  };
  search(0, [], 0);
  return { selectedIndices, retainedPairMass: bestMass / total };
}

async function main(args) {
  if (args.length !== 1) throw new Error('usage: node scripts/fusion-evidence-packing.mjs input.json');
  const file = await open(args[0], constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  let bytes;
  try {
    if (!(await file.stat()).isFile()) throw new Error('evidence_input_not_file');
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_INPUT_BYTES) throw new Error('evidence_input_too_large');
    bytes = buffer.subarray(0, offset);
  } finally { await file.close(); }
  process.stdout.write(`${JSON.stringify(packEvidence(JSON.parse(bytes.toString('utf8'))))}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof SyntaxError ? 'invalid_evidence_json' : error.message}\n`);
    process.exitCode = 1;
  });
}
