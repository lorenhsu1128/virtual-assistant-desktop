/**
 * G7 整合測試 — 三個 opt-in 服務在同一 AgentEmbedded 內並存 lifecycle。
 *
 * 模擬桌寵 AgentRuntime.autoStartServices() 的完整行為：
 *  1. AgentEmbedded.create → mascot session
 *  2. startDaemonServer → WS available
 *  3. startWebUi → HTTP server up
 *  4. startDiscordBot（無 token → 預期 throw，驗證契約）
 *  5. mascot session + WS client + HTTP /api/health 同時可用
 *  6. shutdown → 順序釋放（webui → discord → daemon → agent）
 *
 * 用法：node tests/integration/embeddedAllServicesE2E.mjs
 */
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import WebSocket from 'ws'

const MY_AGENT_REPO = process.env.MY_AGENT_REPO || 'C:/Users/LOREN/Documents/_projects/my-agent'
const MODEL_ABS = resolve(MY_AGENT_REPO, 'models/Qwen3.5-9B-Q4_K_M.gguf')

if (!existsSync(MODEL_ABS)) {
  console.error(`[all] FAIL: 缺 model ${MODEL_ABS}`)
  process.exit(2)
}

const TEMP = join(tmpdir(), `vad-all-${process.pid}-${Date.now()}`)
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

const results = {
  t1_load: false,
  t2_daemon_start: false,
  t3_webui_start: false,
  t4_discord_no_token_throws: false,
  t5_webui_http_health: false,
  t6_ws_client_hello: false,
  t7_webui_ws_hello: false,
  t8_mascot_session: false,
  t9_shutdown_order: false,
}

console.log(`[all] CLAUDE_CONFIG_DIR=${TEMP}`)
const tLoad = Date.now()
const { AgentEmbedded } = await import('../../vendor/my-agent/dist-embedded/index.js')
const agent = await AgentEmbedded.create({
  cwd: TEMP,
  configDir: TEMP,
  extraTools: [],
  skipMcp: true,
  onPreloadProgress: () => {},
})
results.t1_load = true
console.log(`[all] T1 PASS: AgentEmbedded ready in ${Date.now() - tLoad}ms`)

// ── T2: startDaemonServer ──────────────────────────────────────────────
const tDaemon = Date.now()
const daemonHandle = await agent.startDaemonServer({ port: 0, host: '127.0.0.1' })
results.t2_daemon_start = true
console.log(`[all] T2 PASS: daemon ${daemonHandle.url} in ${Date.now() - tDaemon}ms`)

// ── T3: startWebUi ─────────────────────────────────────────────────────
const tWeb = Date.now()
const webHandle = await agent.startWebUi({ port: 0, bindHost: '127.0.0.1' })
results.t3_webui_start = webHandle.isRunning === true
console.log(`[all] T3 ${results.t3_webui_start ? 'PASS' : 'FAIL'}: web ${webHandle.url} in ${Date.now() - tWeb}ms`)

// ── T4: discord without token → throws ─────────────────────────────────
try {
  await agent.startDiscordBot()
  console.error(`[all] T4 FAIL: 預期 throw`)
} catch (err) {
  if (err.message.includes('no token')) {
    results.t4_discord_no_token_throws = true
    console.log(`[all] T4 PASS: discord 無 token throw — "${err.message.slice(0, 60)}..."`)
  } else {
    console.error(`[all] T4 FAIL: 訊息錯 "${err.message}"`)
  }
}

// ── T5: Web UI /api/health responds 200 ────────────────────────────────
try {
  const res = await fetch(`${webHandle.url}/api/health`)
  const body = await res.json()
  results.t5_webui_http_health = res.status === 200 && body.ok === true
  console.log(`[all] T5 ${results.t5_webui_http_health ? 'PASS' : 'FAIL'}: /api/health ${res.status}`)
} catch (err) {
  console.error(`[all] T5 FAIL: ${err.message}`)
}

// ── T6: 外部 ws client 連入 daemon /sessions ───────────────────────────
const wsUrl = `${daemonHandle.url}?token=${encodeURIComponent(daemonHandle.token)}&source=repl&cwd=${encodeURIComponent(TEMP)}`
await new Promise((resolve) => {
  const ws = new WebSocket(wsUrl)
  const timer = setTimeout(() => {
    try { ws.close() } catch {}
    resolve()
  }, 5000)
  ws.on('message', (raw) => {
    const lines = raw.toString('utf-8').split('\n').filter((s) => s.trim())
    for (const line of lines) {
      try {
        const f = JSON.parse(line)
        if (f.type === 'hello' && f.sessionId) {
          results.t6_ws_client_hello = true
          console.log(`[all] T6 PASS: daemon WS hello sessionId=${f.sessionId.slice(0, 8)}`)
          clearTimeout(timer)
          try { ws.close() } catch {}
          resolve()
          return
        }
      } catch {}
    }
  })
  ws.on('error', (err) => {
    console.error(`[all] T6 WS error: ${err.message}`)
  })
})
if (!results.t6_ws_client_hello) console.error(`[all] T6 FAIL: 5s 內無 hello`)

// ── T7: Web UI /ws upgrade → hello frame ───────────────────────────────
const webWsUrl = webHandle.url.replace(/^http/, 'ws') + '/ws'
await new Promise((resolve) => {
  const ws = new WebSocket(webWsUrl)
  const timer = setTimeout(() => {
    try { ws.close() } catch {}
    resolve()
  }, 5000)
  ws.on('message', (raw) => {
    try {
      const f = JSON.parse(raw.toString('utf-8'))
      if (f.type === 'hello' && f.sessionId) {
        results.t7_webui_ws_hello = true
        console.log(`[all] T7 PASS: web /ws hello sessionId=${f.sessionId.slice(0, 8)}`)
        clearTimeout(timer)
        try { ws.close() } catch {}
        resolve()
        return
      }
    } catch {}
  })
  ws.on('error', (err) => {
    console.error(`[all] T7 WS error: ${err.message}`)
  })
})
if (!results.t7_webui_ws_hello) console.error(`[all] T7 FAIL: 5s 內無 hello`)

// ── T8: mascot session 並存 ────────────────────────────────────────────
const session = agent.createSession({ source: 'mascot' })
let helloReceived = false
session.on('frame', (f) => {
  if (f.type === 'hello' && f.sessionId) helloReceived = true
})
await new Promise((r) => setTimeout(r, 100))
results.t8_mascot_session = helloReceived
console.log(`[all] T8 ${results.t8_mascot_session ? 'PASS' : 'FAIL'}: mascot session hello`)

// ── T9: shutdown 順序 ──────────────────────────────────────────────────
const tShutdown = Date.now()
try {
  await session.close()
  await agent.shutdown()
  results.t9_shutdown_order = true
  console.log(`[all] T9 PASS: shutdown clean in ${Date.now() - tShutdown}ms`)
} catch (err) {
  console.error(`[all] T9 FAIL: ${err.message}`)
}

// ── 結果 ───────────────────────────────────────────────────────────────
console.log(`\n══════════════════════════════════════════════════════`)
console.log(`           G7 ALL-SERVICES E2E RESULTS`)
console.log(`══════════════════════════════════════════════════════`)
const allTests = [
  ['T1 AgentEmbedded.create', results.t1_load],
  ['T2 startDaemonServer', results.t2_daemon_start],
  ['T3 startWebUi running', results.t3_webui_start],
  ['T4 startDiscordBot no-token throws', results.t4_discord_no_token_throws],
  ['T5 Web UI /api/health 200', results.t5_webui_http_health],
  ['T6 daemon WS client hello', results.t6_ws_client_hello],
  ['T7 Web UI /ws hello', results.t7_webui_ws_hello],
  ['T8 mascot session 並存', results.t8_mascot_session],
  ['T9 shutdown clean', results.t9_shutdown_order],
]
for (const [name, ok] of allTests) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
}
const passCount = allTests.filter(([, ok]) => ok).length
const totalCount = allTests.length
const overall = passCount === totalCount
console.log(`\n  Verdict: ${passCount}/${totalCount} ${overall ? 'PASS' : 'FAIL'}\n`)
process.exit(overall ? 0 : 1)
