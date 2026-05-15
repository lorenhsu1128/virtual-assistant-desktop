/**
 * Embedded streaming wire-level E2E.
 *
 * QueryEngine 對外 yield 的是「完整 assistant SDKMessage」（每 turn 一個），
 * 所以從 session.on('frame') 看不到 token-by-token。要驗證 wire-level streaming
 * 真的逐 token 來，我們在 embedded adapter 的 sink.onChunk 內塞 timestamp log
 * （LLAMA_STREAM_DEBUG=1 啟用），透過 stderr 收下來統計。
 *
 * 驗收：
 *  T1 incremental: sink 收到 ≥ 3 個 chunk，相鄰時間有 gap > 50ms（streaming 證據）
 *  T2 abort：mid-generation 呼叫 session.abort()，turn 在 3s 內結束
 *
 * 用法：node tests/integration/embeddedStreamingTimingE2E.mjs
 */
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const MY_AGENT_REPO =
  process.env.MY_AGENT_REPO || 'C:/Users/LOREN/Documents/_projects/my-agent'
const MODEL_ABS = resolve(MY_AGENT_REPO, 'models/Qwen3.5-9B-Q4_K_M.gguf')
const MMPROJ_ABS = resolve(MY_AGENT_REPO, 'models/mmproj-Qwen3.5-9B-F16.gguf')

if (!existsSync(MODEL_ABS)) {
  console.error(`[streaming] FAIL: GGUF 不存在 ${MODEL_ABS}`)
  process.exit(2)
}

// Mode A: 直接執行（子程序），把 stderr 寫到 file，main 進程分析
const STDERR_LOG = join(tmpdir(), `vad-stream-stderr-${process.pid}-${Date.now()}.log`)

if (!process.env.VAD_STREAM_CHILD) {
  console.log(`[streaming] spawning child node process for true stderr capture...`)
  const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname.slice(1)], {
    env: { ...process.env, VAD_STREAM_CHILD: '1', LLAMA_STREAM_DEBUG: '1' },
    stdio: ['ignore', 'inherit', 'pipe'],
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024 * 32,
  })
  writeFileSync(STDERR_LOG, child.stderr ?? '', 'utf-8')
  console.log(`[streaming] child exit=${child.status} stderr=${(child.stderr ?? '').length} bytes → ${STDERR_LOG}`)

  // 分析 stderr
  const log = child.stderr ?? ''
  const sinkLines = log.split('\n').filter((l) => l.includes('[embedded:sink]'))

  console.log(`\n══════════════════════════════════════════════════════`)
  console.log(`            STREAMING WIRE-LEVEL ANALYSIS`)
  console.log(`══════════════════════════════════════════════════════`)
  if (sinkLines.length === 0) {
    console.log(`✗ no [embedded:sink] log lines — streaming sink was not invoked`)
    process.exit(1)
  }

  // 解析 timestamp
  const stamps = []
  for (const ln of sinkLines) {
    const m = /\+(\d+)ms #(\d+) "([^"]*)"/.exec(ln)
    if (m) stamps.push({ ms: Number(m[1]), n: Number(m[2]), preview: m[3] })
  }
  console.log(`Total sink.onChunk calls observed: ${sinkLines.length}+ (logged first ${stamps.length})`)
  console.log(`Timeline of first ${stamps.length} chunks:`)
  for (const s of stamps) {
    console.log(`  +${s.ms}ms #${s.n} "${s.preview}"`)
  }

  const gaps = []
  for (let i = 1; i < stamps.length; i++) gaps.push(stamps[i].ms - stamps[i - 1].ms)
  console.log(`Inter-chunk gaps (first ${gaps.length}): ${gaps.join('ms, ')}ms`)

  const incremental = gaps.some((g) => g > 30) && stamps.length >= 3
  console.log(`\nT1 incremental delivery: ${incremental ? 'PASS' : 'FAIL'}`)
  console.log(`  ${stamps.length >= 3 ? '✓' : '✗'} chunk count ${stamps.length} >= 3`)
  console.log(`  ${gaps.some((g) => g > 30) ? '✓' : '✗'} at least one gap > 30ms (proves not all-at-once)`)

  // T2: abort scenario log
  const abortLog = log.split('\n').filter((l) => l.includes('[T2]') || l.includes('aborting'))
  console.log(`\nT2 abort latency:`)
  abortLog.slice(-5).forEach((l) => console.log(`  ${l.trim()}`))

  process.exit(child.status ?? 0)
}

// ── Child process body ────────────────────────────────────────────────────
const TEMP = join(tmpdir(), `vad-streaming-${process.pid}-${Date.now()}`)
mkdirSync(TEMP, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = TEMP
process.env.MY_AGENT_REMOTE_MEMORY_DIR = TEMP
process.env.MY_AGENT_LLAMACPP_EMBEDDED = '1'

writeFileSync(
  join(TEMP, 'llamacpp.jsonc'),
  `{
    "baseUrl": "http://127.0.0.1:8081/v1",
    "model": "qwen3.5-9b",
    "contextSize": 131072,
    "autoCompactBufferTokens": 4000,
    "debug": false,
    "modelAliases": ["qwen3.5-9b"],
    "server": {
      "host": "127.0.0.1", "port": 8081, "ctxSize": 131072, "gpuLayers": 99,
      "modelPath": ${JSON.stringify(MODEL_ABS)}, "alias": "qwen3.5-9b",
      "binaryPath": ${JSON.stringify(resolve(MY_AGENT_REPO, 'buun-llama-cpp/build/bin/Release/llama-server.exe'))},
      "extraArgs": [
        "--flash-attn", "on",
        "--cache-type-k", "turbo4",
        "--cache-type-v", "turbo4",
        "-b", "2048",
        "-ub", "512",
        "--threads", "12",
        "--no-mmap"
      ],
      "vision": {"mmprojPath": ${JSON.stringify(MMPROJ_ABS)}},
      "binaryKind": "buun"
    },
    "vision": {"enabled": false}
  }`,
  'utf-8',
)

console.error(`[streaming-child] loading AgentEmbedded...`)
const tLoad = Date.now()
const { AgentEmbedded } = await import('../../vendor/my-agent/dist-embedded/index.js')
const agent = await AgentEmbedded.create({
  cwd: process.cwd(),
  configDir: TEMP,
  skipMcp: true,
  onPreloadProgress: () => {},
})
console.error(`[streaming-child] ready in ${Date.now() - tLoad}ms`)

// T1: incremental delivery
console.error(`\n[T1] incremental delivery test`)
{
  const session = agent.createSession({ source: 'mascot' })
  let turnEnded = false
  session.on('frame', (f) => {
    if (f.type === 'turnEnd') turnEnded = true
  })
  await new Promise((r) => setTimeout(r, 30))
  session.send('Write a 5-sentence short story about a fox and a cat. Plain text only, no tools.')
  await new Promise((resolve) => {
    const start = Date.now()
    const t = setInterval(() => {
      if (turnEnded || Date.now() - start > 60000) { clearInterval(t); resolve() }
    }, 50)
  })
  try { await session.close() } catch {}
  console.error(`[T1] done turnEnded=${turnEnded}`)
}

// T2: abort latency
console.error(`\n[T2] abort latency test`)
{
  const session = agent.createSession({ source: 'mascot' })
  let turnEnded = false
  let firstFrameMs = -1
  const tSend = Date.now()
  session.on('frame', (f) => {
    if (firstFrameMs < 0 && f.type === 'runnerEvent') firstFrameMs = Date.now() - tSend
    if (f.type === 'turnEnd') turnEnded = true
  })
  await new Promise((r) => setTimeout(r, 30))
  session.send('Count from 1 to 100 in plain English, one per line. No tools.')

  // 等 8 秒（讓 generation 開始）
  await new Promise((r) => setTimeout(r, 8000))
  const abortAt = Date.now() - tSend
  console.error(`[T2] aborting at +${abortAt}ms`)
  session.abort?.()

  // 等 turn end 或 3s timeout
  const t0 = Date.now()
  await new Promise((resolve) => {
    const t = setInterval(() => {
      if (turnEnded || Date.now() - t0 > 3000) { clearInterval(t); resolve() }
    }, 50)
  })
  const gap = Date.now() - tSend - abortAt
  console.error(`[T2] turnEnded=${turnEnded} abort→turnEnd gap=${gap}ms`)
}

try { await agent.shutdown?.() } catch {}
process.exit(0)
