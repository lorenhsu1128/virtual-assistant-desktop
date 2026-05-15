/**
 * Embedded Web UI E2E（Phase 3 of 3-feature opt-in plan）。
 *
 * 驗證：
 *  1. startDaemonServer 後 startWebUi 啟動 Node HTTP server（不依賴 Bun.serve）
 *  2. GET /api/health → 200 JSON
 *  3. GET / → 200 HTML（若 web/dist 存在）或 503 含 build 提示
 *  4. WS /ws upgrade → 收到 hello frame
 *  5. shutdown() 完整關閉
 *
 * 用法：node tests/integration/embeddedWebUiE2E.mjs
 */
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import WebSocket from 'ws'

const MY_AGENT_REPO = process.env.MY_AGENT_REPO || 'C:/Users/LOREN/Documents/_projects/my-agent'
const MODEL_ABS = resolve(MY_AGENT_REPO, 'models/Qwen3.5-9B-Q4_K_M.gguf')

if (!existsSync(MODEL_ABS)) {
  console.error(`[web-ui] FAIL: 缺 model ${MODEL_ABS}`)
  process.exit(2)
}

const TEMP = join(tmpdir(), `vad-webui-${process.pid}-${Date.now()}`)
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

console.log(`[web-ui] CLAUDE_CONFIG_DIR=${TEMP}`)
const tLoad = Date.now()
const { AgentEmbedded } = await import('../../vendor/my-agent/dist-embedded/index.js')
const agent = await AgentEmbedded.create({
  cwd: TEMP,
  configDir: TEMP,
  extraTools: [],
  skipMcp: true,
  onPreloadProgress: () => {},
})
console.log(`[web-ui] AgentEmbedded ready in ${Date.now() - tLoad}ms`)

// ── T1: 未啟 daemon → startWebUi throw ────────────────────────────────
let t1Ok = false
try {
  await agent.startWebUi()
  console.error('[web-ui] T1 FAIL: 預期 throw')
} catch (err) {
  if (err.message.includes('startDaemonServer')) {
    t1Ok = true
    console.log(`[web-ui] T1 PASS: 正確 throw without daemon`)
  } else {
    console.error(`[web-ui] T1 FAIL: 訊息錯 "${err.message}"`)
  }
}

// ── 啟 daemon + web ───────────────────────────────────────────────────
await agent.startDaemonServer({ port: 0 })
console.log(`[web-ui] daemon started`)

const tWeb = Date.now()
let webHandle
try {
  // port 0 = OS 指派；bindHost 127.0.0.1 loopback only
  webHandle = await agent.startWebUi({ port: 0, bindHost: '127.0.0.1' })
} catch (err) {
  console.error(`[web-ui] startWebUi failed: ${err.message}`)
  await agent.shutdown()
  process.exit(1)
}
console.log(`[web-ui] web started in ${Date.now() - tWeb}ms`)
console.log(`[web-ui]   port: ${webHandle.port}, bindHost: ${webHandle.bindHost}`)
console.log(`[web-ui]   url: ${webHandle.url}`)
console.log(`[web-ui]   isRunning: ${webHandle.isRunning}`)

const baseUrl = webHandle.url
let t2Ok = false
let t3Ok = false
let t4Ok = false

// ── T2: GET /api/health → 200 JSON ─────────────────────────────────────
try {
  const res = await fetch(`${baseUrl}/api/health`)
  const body = await res.json()
  t2Ok = res.status === 200 && body.ok === true && typeof body.serverTime === 'number'
  console.log(`[web-ui] T2 ${t2Ok ? 'PASS' : 'FAIL'}: /api/health status=${res.status}, body=${JSON.stringify(body).slice(0, 80)}`)
} catch (err) {
  console.error(`[web-ui] T2 FAIL: ${err.message}`)
}

// ── T3: GET / → 200 (web/dist 存在) 或 503 (build 提示) ───────────────
try {
  const res = await fetch(`${baseUrl}/`)
  const text = await res.text()
  // 兩種都算 PASS — Node http server 正確回應，內容由 staticServer 決定
  t3Ok = res.status === 200 || (res.status === 503 && text.includes('build'))
  console.log(`[web-ui] T3 ${t3Ok ? 'PASS' : 'FAIL'}: GET / status=${res.status}, body[0..80]="${text.slice(0, 80)}"`)
} catch (err) {
  console.error(`[web-ui] T3 FAIL: ${err.message}`)
}

// ── T4: WS /ws upgrade + hello frame ──────────────────────────────────
const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws'
console.log(`[web-ui] connecting WS to ${wsUrl}...`)
await new Promise((resolve) => {
  const ws = new WebSocket(wsUrl)
  const timeout = setTimeout(() => {
    try { ws.close() } catch {}
    console.error(`[web-ui] T4 FAIL: 5s 內沒收到 hello`)
    resolve()
  }, 5000)
  ws.on('open', () => {
    console.log(`[web-ui] WS open`)
  })
  ws.on('message', (raw) => {
    try {
      const frame = JSON.parse(raw.toString('utf-8'))
      if (frame.type === 'hello' && frame.sessionId) {
        t4Ok = true
        console.log(`[web-ui] T4 PASS: hello sessionId=${frame.sessionId.slice(0, 8)}, serverTime=${frame.serverTime}`)
        clearTimeout(timeout)
        try { ws.close() } catch {}
        resolve()
      }
    } catch (err) {
      console.error(`[web-ui] WS parse error: ${err.message}`)
    }
  })
  ws.on('error', (err) => {
    console.error(`[web-ui] WS error: ${err.message}`)
  })
  ws.on('close', () => resolve())
})

// ── shutdown ───────────────────────────────────────────────────────────
try { await agent.shutdown() } catch (err) {
  console.error(`[web-ui] shutdown error: ${err.message}`)
}
console.log(`[web-ui] shutdown OK`)

console.log(`\n══════════════════════════════════════════════════════`)
console.log(`            EMBEDDED WEB UI E2E RESULTS`)
console.log(`══════════════════════════════════════════════════════`)
console.log(`T1 no-daemon throws:  ${t1Ok ? 'PASS' : 'FAIL'}`)
console.log(`T2 /api/health 200:   ${t2Ok ? 'PASS' : 'FAIL'}`)
console.log(`T3 GET / responds:    ${t3Ok ? 'PASS' : 'FAIL'}`)
console.log(`T4 WS hello frame:    ${t4Ok ? 'PASS' : 'FAIL'}`)

const pass = t1Ok && t2Ok && t3Ok && t4Ok
console.log(`\nVerdict: ${pass ? 'PASS' : 'FAIL'}\n`)
process.exit(pass ? 0 : 1)
