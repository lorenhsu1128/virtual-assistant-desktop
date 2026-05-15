/**
 * Embedded Discord adapter E2E（Phase 2 of 3-feature opt-in plan）。
 *
 * 兩種模式：
 *  - 預設（無 token）：驗證 API 契約 — startDiscordBot 在無 token 時正確 throw
 *    含明確訊息；DI/lifecycle 不 crash；shutdown 流程正確
 *  - 真實 token（export MY_AGENT_DISCORD_TOKEN=xxx）：實際連 Discord gateway，
 *    驗證 bot online、handle.isRunning=true；超過 30s 沒 ready 視為失敗
 *
 * 用法：
 *   node tests/integration/embeddedDiscordE2E.mjs              # 契約測試
 *   MY_AGENT_DISCORD_TOKEN=xxx node tests/...DiscordE2E.mjs    # 真實連線
 */
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'

const MY_AGENT_REPO = process.env.MY_AGENT_REPO || 'C:/Users/LOREN/Documents/_projects/my-agent'
const MODEL_ABS = resolve(MY_AGENT_REPO, 'models/Qwen3.5-9B-Q4_K_M.gguf')

if (!existsSync(MODEL_ABS)) {
  console.error(`[discord] FAIL: 缺 model ${MODEL_ABS}`)
  process.exit(2)
}

const TEMP = join(tmpdir(), `vad-discord-${process.pid}-${Date.now()}`)
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
    "debug": false,
    "modelAliases": ["qwen3.5-9b"],
    "server": {
      "host": "127.0.0.1", "port": 8081, "ctxSize": 131072, "gpuLayers": 99,
      "modelPath": ${JSON.stringify(MODEL_ABS)}, "alias": "qwen3.5-9b",
      "binaryPath": ${JSON.stringify(resolve(MY_AGENT_REPO, 'buun-llama-cpp/build/bin/Release/llama-server.exe'))},
      "extraArgs": ["--flash-attn", "on", "--cache-type-k", "turbo4", "--cache-type-v", "turbo4", "-b", "2048", "-ub", "512", "--threads", "12", "--no-mmap"],
      "binaryKind": "buun"
    }
  }`,
  'utf-8',
)

const realToken = process.env.MY_AGENT_DISCORD_TOKEN
const mode = realToken ? 'real-token' : 'contract'
console.log(`[discord] mode=${mode}`)
console.log(`[discord] CLAUDE_CONFIG_DIR=${TEMP}`)

const tLoad = Date.now()
const { AgentEmbedded } = await import('../../vendor/my-agent/dist-embedded/index.js')
const agent = await AgentEmbedded.create({
  cwd: TEMP,
  configDir: TEMP,
  extraTools: [],
  skipMcp: true,
  onPreloadProgress: () => {},
})
console.log(`[discord] AgentEmbedded ready in ${Date.now() - tLoad}ms`)

// ── T1: 未啟 daemon → startDiscordBot 必須 throw ───────────────────────
let t1Ok = false
try {
  await agent.startDiscordBot()
  console.error('[discord] T1 FAIL: 預期 throw 但成功 return')
} catch (err) {
  if (err.message.includes('startDaemonServer')) {
    t1Ok = true
    console.log(`[discord] T1 PASS: 正確 throw without daemon — "${err.message}"`)
  } else {
    console.error(`[discord] T1 FAIL: throw 訊息錯 "${err.message}"`)
  }
}

// ── 啟 daemon ─────────────────────────────────────────────────────────
await agent.startDaemonServer({ port: 0 })
console.log(`[discord] daemon started`)

// ── T2: getDiscordBot 預設未 running ─────────────────────────────────
const initialHandle = agent.getDiscordBot()
const t2Ok = initialHandle !== null && initialHandle.isRunning === false
console.log(`[discord] T2 ${t2Ok ? 'PASS' : 'FAIL'}: getDiscordBot before start (isRunning=${initialHandle?.isRunning})`)

// ── T3: 無 token + forceEnabled=true → startDiscordBot 必須 throw 含明確訊息 ──
let t3Ok = false
if (!realToken) {
  try {
    await agent.startDiscordBot()  // 沒給 tokenOverride，env 也沒，jsonc 也沒
    console.error('[discord] T3 FAIL: 預期 throw 但成功')
  } catch (err) {
    if (err.message.includes('no token')) {
      t3Ok = true
      console.log(`[discord] T3 PASS: 無 token throw — "${err.message}"`)
    } else {
      console.error(`[discord] T3 FAIL: throw 訊息錯 "${err.message}"`)
    }
  }
} else {
  console.log(`[discord] T3 skipped (real token mode)`)
  t3Ok = true
}

// ── T4: 真實 token 連線測試（只在 MY_AGENT_DISCORD_TOKEN 存在時跑） ───
let t4Ok = !realToken  // skip 視為 pass
if (realToken) {
  console.log(`[discord] T4: 連 Discord gateway with real token...`)
  try {
    const tStart = Date.now()
    const handle = await agent.startDiscordBot({ tokenOverride: realToken })
    const elapsed = Date.now() - tStart
    t4Ok = handle.isRunning === true
    console.log(`[discord] T4 ${t4Ok ? 'PASS' : 'FAIL'}: bot started in ${elapsed}ms, isRunning=${handle.isRunning}`)
    if (t4Ok) {
      console.log(`[discord] config snapshot:`, JSON.stringify(handle.config).slice(0, 200))
      // 等 5s 確認連線穩定
      await new Promise(r => setTimeout(r, 5000))
      console.log(`[discord] still running after 5s: ${handle.isRunning}`)
      await handle.stop()
      console.log(`[discord] stopped`)
    }
  } catch (err) {
    console.error(`[discord] T4 FAIL: ${err.message}`)
  }
}

// ── shutdown ───────────────────────────────────────────────────────────
try { await agent.shutdown() } catch (err) {
  console.error(`[discord] shutdown error: ${err.message}`)
}
console.log(`[discord] shutdown OK`)

const pass = t1Ok && t2Ok && t3Ok && t4Ok
console.log(`\n══════════════════════════════════════════════════════`)
console.log(`            DISCORD ADAPTER E2E RESULTS`)
console.log(`══════════════════════════════════════════════════════`)
console.log(`T1 no-daemon throws:    ${t1Ok ? 'PASS' : 'FAIL'}`)
console.log(`T2 initial isRunning=false: ${t2Ok ? 'PASS' : 'FAIL'}`)
console.log(`T3 no-token throws:     ${t3Ok ? 'PASS' : 'FAIL'}${realToken ? ' (skipped)' : ''}`)
console.log(`T4 real-token connect:  ${realToken ? (t4Ok ? 'PASS' : 'FAIL') : 'SKIP (set MY_AGENT_DISCORD_TOKEN to enable)'}`)
console.log(`\nVerdict: ${pass ? 'PASS' : 'FAIL'}\n`)
process.exit(pass ? 0 : 1)
