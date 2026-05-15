/**
 * 直接調用 node-llama-tcq 確認 GPU backend 與 model offload 實況。
 * 不經過 my-agent，最小化測試。
 */
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'

const MODEL = resolve('C:/Users/LOREN/Documents/_projects/my-agent/models/Qwen3.5-9B-Q4_K_M.gguf')

function gpu() {
  const out = execSync(
    'nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader,nounits',
    { encoding: 'utf8' },
  ).trim()
  const [mem, util] = out.split(',').map((s) => parseInt(s.trim(), 10))
  return { mem, util }
}

console.log('[sanity] baseline:', gpu())

// 直接從 vendor/my-agent submodule 的 dist 載入（postinstall junction 過）
const nlt = await import(
  'file:///C:/Users/LOREN/Documents/_projects/virtual-assistant-desktop/vendor/my-agent/vendor/node-llama-tcq/dist/index.js'
)

const llama = await nlt.getLlama({ gpu: 'cuda', debug: true })
console.log('[sanity] llama.gpu =', llama.gpu)
console.log('[sanity] llama.gpuSupported =', llama.supportsGpuOffloading)
console.log('[sanity] llama.deviceNames =', await llama.getGpuDeviceNames?.())
const vramState = await llama.getVramState()
console.log('[sanity] vramState =', vramState)
console.log('[sanity] post-getLlama GPU:', gpu())

console.log('\n[sanity] loading model with gpuLayers="max"...')
const t0 = Date.now()
const model = await llama.loadModel({ modelPath: MODEL, gpuLayers: 'max' })
console.log(`[sanity] model loaded in ${Date.now() - t0}ms`)
console.log('[sanity] model.gpuLayers =', model.gpuLayers)
console.log('[sanity] model.fileInfo:', {
  totalLayers: model.fileInfo?.totalLayers,
  fileType: model.fileInfo?.fileType,
})
console.log('[sanity] post-load GPU:', gpu())
console.log('[sanity] vramState after load =', await llama.getVramState())

console.log('\n[sanity] creating context (4096) + chat session...')
const ctx = await model.createContext({ contextSize: 4096, flashAttention: true })
const seq = ctx.getSequence()
const sess = new nlt.LlamaChatSession({ contextSequence: seq })
console.log('[sanity] post-ctx GPU:', gpu())

console.log('\n[sanity] prompting (sampling every 100ms)...')
let sampling = true
const samples = []
;(async () => {
  while (sampling) {
    samples.push({ t: Date.now(), ...gpu() })
    await new Promise((r) => setTimeout(r, 100))
  }
})()

const tInferStart = Date.now()
const reply = await sess.prompt('Write a haiku about cats. 3 short lines only.', {
  maxTokens: 100,
  temperature: 0.7,
})
const tInferEnd = Date.now()
sampling = false
await new Promise((r) => setTimeout(r, 300))

console.log(`[sanity] inference took ${tInferEnd - tInferStart}ms`)
console.log(`[sanity] reply: ${JSON.stringify(reply)}`)

const inferSamples = samples.filter((s) => s.t >= tInferStart - 100 && s.t <= tInferEnd + 100)
console.log(`\n[sanity] inference window samples (${inferSamples.length}):`)
for (const s of inferSamples) {
  console.log(`  +${((s.t - tInferStart) / 1000).toFixed(2)}s mem=${s.mem}MiB util=${s.util}%`)
}

const utilMax = Math.max(...inferSamples.map((s) => s.util))
const utilAvg = inferSamples.reduce((a, b) => a + b.util, 0) / inferSamples.length
const memMax = Math.max(...inferSamples.map((s) => s.mem))
console.log(`\n[sanity] util max=${utilMax}% avg=${utilAvg.toFixed(1)}% mem peak=${memMax}MiB`)

await ctx.dispose()
await model.dispose()
console.log('[sanity] after dispose GPU:', gpu())
process.exit(0)
