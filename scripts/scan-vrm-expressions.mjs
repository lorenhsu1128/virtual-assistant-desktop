#!/usr/bin/env node
/**
 * scan-vrm-expressions.mjs — 掃描 VRM 模型目錄，列出每個模型的表情清單與跨模型重複統計
 *
 * 用法：
 *   node scripts/scan-vrm-expressions.mjs               # 預設掃 vrmodels/
 *   node scripts/scan-vrm-expressions.mjs <folder>      # 指定目錄
 *   node scripts/scan-vrm-expressions.mjs --json        # 輸出 JSON 格式
 *   node scripts/scan-vrm-expressions.mjs --duplicates  # 只顯示重複表情排行
 *
 * 或透過 bun：
 *   bun run scan:expressions
 *   bun run scan:expressions -- --json
 *
 * 支援 VRM 0.x (VRM.blendShapeMaster) 與 VRM 1.0 (VRMC_vrm.expressions)。
 * 解析 GLB header 讀取 JSON chunk，不載入 BIN chunk，速度快且記憶體低。
 */

import { readdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ── 參數解析 ──
const args = process.argv.slice(2);
const flagJson = args.includes('--json');
const flagDuplicatesOnly = args.includes('--duplicates');
const positional = args.filter((a) => !a.startsWith('--'));
const VRMODELS_DIR = positional[0] ?? 'vrmodels';

/** 從 GLB 檔案讀 JSON chunk 並解析 */
function readGlbJson(filePath) {
  const fd = openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    readSync(fd, header, 0, 12, 0);
    const magic = header.toString('utf8', 0, 4);
    if (magic !== 'glTF') throw new Error('not a GLB file');
    // version = header.readUInt32LE(4);
    // total = header.readUInt32LE(8);
    const chunkHeader = Buffer.alloc(8);
    readSync(fd, chunkHeader, 0, 8, 12);
    const chunkLen = chunkHeader.readUInt32LE(0);
    const chunkType = chunkHeader.toString('utf8', 4, 8);
    if (chunkType !== 'JSON') throw new Error(`expected JSON chunk, got "${chunkType}"`);
    const chunkData = Buffer.alloc(chunkLen);
    readSync(fd, chunkData, 0, chunkLen, 20);
    const jsonText = chunkData.toString('utf8').replace(/\0+$/, '');
    return JSON.parse(jsonText);
  } finally {
    closeSync(fd);
  }
}

/** 從 glTF JSON 提取表情名稱（同時支援 VRM 1.0 與 0.x） */
function extractExpressions(gltf) {
  const ext = gltf.extensions ?? {};
  // VRM 1.0
  if (ext.VRMC_vrm?.expressions) {
    const exp = ext.VRMC_vrm.expressions;
    const names = [];
    if (exp.preset && typeof exp.preset === 'object') {
      for (const key of Object.keys(exp.preset)) names.push(key);
    }
    if (exp.custom && typeof exp.custom === 'object') {
      for (const key of Object.keys(exp.custom)) names.push(key);
    }
    return { version: '1.0', names };
  }
  // VRM 0.x
  if (ext.VRM?.blendShapeMaster?.blendShapeGroups) {
    const groups = ext.VRM.blendShapeMaster.blendShapeGroups;
    const names = groups.map((g) => g.presetName && g.presetName !== 'unknown' ? g.presetName : g.name).filter(Boolean);
    return { version: '0.x', names };
  }
  return { version: 'unknown', names: [] };
}

// ── main ──

let files;
try {
  files = readdirSync(VRMODELS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.vrm'))
    .sort();
} catch (e) {
  console.error(`[scan-vrm-expressions] 無法讀取目錄 "${resolve(VRMODELS_DIR)}": ${e.message}`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`[scan-vrm-expressions] ${VRMODELS_DIR}/ 下沒有 .vrm 檔`);
  process.exit(1);
}

if (!flagJson) console.log(`Found ${files.length} VRM files in ${VRMODELS_DIR}/\n`);

/** Map<modelName, { version, names }> */
const modelExpressions = new Map();
/** Map<expressionName, Set<modelName>> */
const expressionToModels = new Map();
const failures = [];

for (const file of files) {
  const filePath = join(VRMODELS_DIR, file);
  try {
    const size = statSync(filePath).size;
    if (size < 20) {
      failures.push({ file, reason: 'too small' });
      continue;
    }
    const gltf = readGlbJson(filePath);
    const { version, names } = extractExpressions(gltf);
    modelExpressions.set(file, { version, names });
    for (const name of names) {
      if (!expressionToModels.has(name)) expressionToModels.set(name, new Set());
      expressionToModels.get(name).add(file);
    }
  } catch (e) {
    failures.push({ file, reason: e.message });
  }
}

// ── 計算彙整資料 ──
const sorted = [...expressionToModels.entries()]
  .map(([name, set]) => ({ name, count: set.size, models: [...set].sort() }))
  .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

const duplicates = sorted.filter((e) => e.count >= 2);
const unique = sorted.filter((e) => e.count === 1);

// ── JSON 輸出模式 ──
if (flagJson) {
  const report = {
    directory: resolve(VRMODELS_DIR),
    totalFiles: files.length,
    models: [...modelExpressions.entries()].map(([file, { version, names }]) => ({
      file,
      version,
      expressionCount: names.length,
      expressions: names,
    })),
    summary: {
      totalUniqueExpressions: sorted.length,
      duplicateCount: duplicates.length,
      uniqueCount: unique.length,
    },
    duplicates: duplicates.map(({ name, count }) => ({ name, count })),
    unique: unique.map(({ name, models }) => ({ name, model: models[0] })),
    failures,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

// ── 文字輸出：每個模型的表情（--duplicates 模式時跳過） ──
if (!flagDuplicatesOnly) {
  console.log('═'.repeat(60));
  console.log('  每個模型的表情清單');
  console.log('═'.repeat(60));
  for (const [file, { version, names }] of modelExpressions) {
    console.log(`\n[${version}] ${file} (${names.length} 表情)`);
    if (names.length > 0) {
      console.log('  ' + names.join(', '));
    }
  }
  console.log();
}

// ── 文字輸出：重複表情排名 ──
console.log('═'.repeat(60));
console.log('  表情出現次數（>=2 次視為重複）');
console.log('═'.repeat(60));
console.log(`\n共 ${sorted.length} 個不同的表情名稱`);
console.log(`  ${duplicates.length} 個出現在 >=2 個模型（重複）`);
console.log(`  ${unique.length} 個只出現在 1 個模型（獨特）`);

console.log('\n── 重複表情清單（依出現次數降序）──');
for (const { name, count } of duplicates) {
  console.log(`  ${count.toString().padStart(3)} × ${name}`);
}

console.log('\n── 獨特表情（只出現 1 次）──');
for (const { name, models } of unique) {
  console.log(`  ${name}  @ ${models[0]}`);
}

// ── 失敗清單 ──
if (failures.length > 0) {
  console.log('\n' + '═'.repeat(60));
  console.log('  解析失敗');
  console.log('═'.repeat(60));
  for (const { file, reason } of failures) {
    console.log(`  ${file}: ${reason}`);
  }
}
