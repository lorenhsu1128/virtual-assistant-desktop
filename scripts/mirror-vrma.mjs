/**
 * mirror-vrma.mjs
 *
 * Reads a VRM Animation (.vrma / binary glTF) and mirrors it across the YZ plane,
 * producing a left-right flipped version. Used to generate SYS_HIDE_SHOW_LOOP_RIGHT
 * from SYS_HIDE_SHOW_LOOP_LEFT.
 *
 * VRM humanoid bones have symmetric local coordinate frames — paired bones (Left/Right)
 * only need their data swapped (no quaternion modification). Center bones need Y/Z negation.
 *
 * Usage: node scripts/mirror-vrma.mjs <input.vrma> <output.vrma>
 */

import { readFileSync, writeFileSync } from 'fs';

const [,, inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/mirror-vrma.mjs <input.vrma> <output.vrma>');
  process.exit(1);
}

// ── Parse GLB ──

const srcBuf = readFileSync(inputPath);
const magic = srcBuf.readUInt32LE(0);
if (magic !== 0x46546C67) { // 'glTF'
  console.error('Not a valid GLB file');
  process.exit(1);
}

const jsonChunkLen = srcBuf.readUInt32LE(12);
const jsonStr = srcBuf.slice(20, 20 + jsonChunkLen).toString('utf8');
const gltf = JSON.parse(jsonStr);

// Binary chunk starts after JSON chunk (aligned to 4 bytes)
const binChunkOffset = 20 + jsonChunkLen;
const binChunkLen = srcBuf.readUInt32LE(binChunkOffset);
const binStart = binChunkOffset + 8; // skip length(4) + type(4)
const binBuf = Buffer.from(srcBuf.slice(binStart, binStart + binChunkLen));

// ── Build bone name → channel/sampler mapping ──

const anim = gltf.animations[0];
const channels = anim.channels;
const samplers = anim.samplers;

/** @type {Map<string, {channelIdx: number, path: string, samplerIdx: number}>} */
const boneMap = new Map();
for (let i = 0; i < channels.length; i++) {
  const ch = channels[i];
  const nodeName = gltf.nodes[ch.target.node].name;
  const key = `${nodeName}:${ch.target.path}`;
  boneMap.set(key, { channelIdx: i, path: ch.target.path, samplerIdx: ch.sampler });
}

// ── Left ↔ Right bone pairs ──

const BONE_PAIRS = [
  ['LeftUpperLeg', 'RightUpperLeg'],
  ['LeftLowerLeg', 'RightLowerLeg'],
  ['LeftFoot', 'RightFoot'],
  ['LeftToes', 'RightToes'],
  ['LeftShoulder', 'RightShoulder'],
  ['LeftUpperArm', 'RightUpperArm'],
  ['LeftLowerArm', 'RightLowerArm'],
  ['LeftHand', 'RightHand'],
  ['LeftThumbProximal', 'RightThumbProximal'],
  ['LeftThumbIntermediate', 'RightThumbIntermediate'],
  ['LeftThumbDistal', 'RightThumbDistal'],
  ['LeftIndexProximal', 'RightIndexProximal'],
  ['LeftIndexIntermediate', 'RightIndexIntermediate'],
  ['LeftIndexDistal', 'RightIndexDistal'],
  ['LeftMiddleProximal', 'RightMiddleProximal'],
  ['LeftMiddleIntermediate', 'RightMiddleIntermediate'],
  ['LeftMiddleDistal', 'RightMiddleDistal'],
  ['LeftRingProximal', 'RightRingProximal'],
  ['LeftRingIntermediate', 'RightRingIntermediate'],
  ['LeftRingDistal', 'RightRingDistal'],
  ['LeftLittleProximal', 'RightLittleProximal'],
  ['LeftLittleIntermediate', 'RightLittleIntermediate'],
  ['LeftLittleDistal', 'RightLittleDistal'],
];

const CENTER_BONES = ['Hips', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head'];

// Also handle eye/jaw bones that might exist
const SINGLE_MIRROR_BONES = ['LeftEye', 'RightEye', 'Jaw'];

// ── Helper: read float32 array from accessor ──

function readAccessorFloats(accessorIdx) {
  const acc = gltf.accessors[accessorIdx];
  const bv = gltf.bufferViews[acc.bufferView];
  const offset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const componentCount = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type] || 1;
  const count = acc.count * componentCount;
  const floats = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    floats[i] = binBuf.readFloatLE(offset + i * 4);
  }
  return floats;
}

function writeAccessorFloats(accessorIdx, floats) {
  const acc = gltf.accessors[accessorIdx];
  const bv = gltf.bufferViews[acc.bufferView];
  const offset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  for (let i = 0; i < floats.length; i++) {
    binBuf.writeFloatLE(floats[i], offset + i * 4);
  }
}

// ── Mirror rotation quaternion for center bones: (x, y, z, w) → (x, -y, -z, w) ──

function mirrorCenterQuaternions(floats) {
  const result = new Float32Array(floats.length);
  for (let i = 0; i < floats.length; i += 4) {
    result[i] = floats[i];           // x: keep
    result[i + 1] = -floats[i + 1];  // y: negate
    result[i + 2] = -floats[i + 2];  // z: negate
    result[i + 3] = floats[i + 3];   // w: keep
  }
  return result;
}

// ── Mirror translation: (x, y, z) → (-x, y, z) ──

function mirrorTranslation(floats) {
  const result = new Float32Array(floats.length);
  for (let i = 0; i < floats.length; i += 3) {
    result[i] = -floats[i];          // x: negate
    result[i + 1] = floats[i + 1];   // y: keep
    result[i + 2] = floats[i + 2];   // z: keep
  }
  return result;
}

// ── Process animation ──

// Step 1: Read all sampler data (before writing, to avoid overwriting during swap)
const samplerData = new Map();
for (let i = 0; i < samplers.length; i++) {
  const s = samplers[i];
  samplerData.set(i, {
    input: readAccessorFloats(s.input),
    output: readAccessorFloats(s.output),
  });
}

// Step 2: Swap paired bones — NO quaternion modification
// VRM humanoid bones have symmetric local axes, so swapping data directly produces mirror
const processed = new Set();

for (const [leftBone, rightBone] of BONE_PAIRS) {
  const leftKey = `${leftBone}:rotation`;
  const rightKey = `${rightBone}:rotation`;
  const leftInfo = boneMap.get(leftKey);
  const rightInfo = boneMap.get(rightKey);

  if (leftInfo && rightInfo) {
    const leftData = samplerData.get(leftInfo.samplerIdx);
    const rightData = samplerData.get(rightInfo.samplerIdx);

    // Swap: left slot gets right's data, right slot gets left's data (AS-IS, no modification)
    writeAccessorFloats(samplers[leftInfo.samplerIdx].input, rightData.input);
    writeAccessorFloats(samplers[leftInfo.samplerIdx].output, rightData.output);

    writeAccessorFloats(samplers[rightInfo.samplerIdx].input, leftData.input);
    writeAccessorFloats(samplers[rightInfo.samplerIdx].output, leftData.output);

    processed.add(leftInfo.samplerIdx);
    processed.add(rightInfo.samplerIdx);
  }
}

// Also swap LeftEye ↔ RightEye if present
const eyePair = ['LeftEye', 'RightEye'];
{
  const leftInfo = boneMap.get(`${eyePair[0]}:rotation`);
  const rightInfo = boneMap.get(`${eyePair[1]}:rotation`);
  if (leftInfo && rightInfo) {
    const leftData = samplerData.get(leftInfo.samplerIdx);
    const rightData = samplerData.get(rightInfo.samplerIdx);
    writeAccessorFloats(samplers[leftInfo.samplerIdx].input, rightData.input);
    writeAccessorFloats(samplers[leftInfo.samplerIdx].output, rightData.output);
    writeAccessorFloats(samplers[rightInfo.samplerIdx].input, leftData.input);
    writeAccessorFloats(samplers[rightInfo.samplerIdx].output, leftData.output);
    processed.add(leftInfo.samplerIdx);
    processed.add(rightInfo.samplerIdx);
  }
}

// Step 3: Center bones — mirror rotation (negate Y and Z)
for (const bone of CENTER_BONES) {
  const rotKey = `${bone}:rotation`;
  const info = boneMap.get(rotKey);
  if (info && !processed.has(info.samplerIdx)) {
    const data = samplerData.get(info.samplerIdx);
    writeAccessorFloats(samplers[info.samplerIdx].output, mirrorCenterQuaternions(data.output));
    processed.add(info.samplerIdx);
  }

  // Hips translation: negate X
  const transKey = `${bone}:translation`;
  const transInfo = boneMap.get(transKey);
  if (transInfo && !processed.has(transInfo.samplerIdx)) {
    const data = samplerData.get(transInfo.samplerIdx);
    writeAccessorFloats(samplers[transInfo.samplerIdx].output, mirrorTranslation(data.output));
    processed.add(transInfo.samplerIdx);
  }
}

// ── Reassemble GLB ──

const outBuf = Buffer.from(srcBuf);
// Copy modified binary data back
binBuf.copy(outBuf, binStart);

writeFileSync(outputPath, outBuf);
console.log(`Mirrored: ${inputPath} → ${outputPath}`);
console.log(`Processed ${processed.size} samplers`);
console.log(`  Paired bones: ${BONE_PAIRS.length} pairs (swap only, no quaternion change)`);
console.log(`  Center bones: Y/Z quaternion negation + Hips X translation negation`);
