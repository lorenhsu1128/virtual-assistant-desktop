/**
 * 多情境 e2e — 同一個 AgentEmbedded 跑多種對話 scenario，量測表現。
 *
 * 載入一次 LLM（~10s），跑 N 個 scenario 各自獨立 session，每個 scenario：
 *  - 帶 prompt + max turn duration + 預期結果類別
 *  - 收集：turn 時長、frames 數、assistant blocks、mascot dispatches、結尾類型
 *  - 收尾後印 PASS/WARN/FAIL 對照表
 *
 * 預設 prompt 包含中英文混合 / tool call 觸發 / clarifying question /
 * 長 context / 連續 tool call。
 *
 * 用法：node tests/integration/agentScenariosE2E.mjs
 */
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { z } from 'zod'

// ── 設定 ──────────────────────────────────────────────────────────────
const MY_AGENT_REPO =
  process.env.MY_AGENT_REPO || 'C:/Users/LOREN/Documents/_projects/my-agent'
const MODEL_ABS = resolve(MY_AGENT_REPO, 'models/Qwen3.5-9B-Q4_K_M.gguf')
const MMPROJ_ABS = resolve(MY_AGENT_REPO, 'models/mmproj-Qwen3.5-9B-F16.gguf')

if (!existsSync(MODEL_ABS)) {
  console.error(`[scenarios] FAIL: GGUF 不存在 ${MODEL_ABS}`)
  process.exit(2)
}

const TEMP_CONFIG_DIR = join(tmpdir(), `vad-scenarios-${process.pid}-${Date.now()}`)
mkdirSync(TEMP_CONFIG_DIR, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = TEMP_CONFIG_DIR
process.env.MY_AGENT_LLAMACPP_EMBEDDED = '1'

const llamacppJsonc = `{
  "baseUrl": "http://127.0.0.1:8081/v1",
  "model": "qwen3.5-9b",
  "contextSize": 131072,
  "autoCompactBufferTokens": 4000,
  "debug": false,
  "modelAliases": ["qwen3.5-9b"],
  "server": {
    "host": "127.0.0.1",
    "port": 8081,
    "ctxSize": 131072,
    "gpuLayers": 99,
    "modelPath": ${JSON.stringify(MODEL_ABS)},
    "alias": "qwen3.5-9b",
    "binaryPath": ${JSON.stringify(resolve(MY_AGENT_REPO, 'buun-llama-cpp/build/bin/Release/llama-server.exe'))},
    "extraArgs": [],
    "vision": {"mmprojPath": ${JSON.stringify(MMPROJ_ABS)}},
    "binaryKind": "buun"
  },
  "vision": {"enabled": false}
}
`
writeFileSync(join(TEMP_CONFIG_DIR, 'llamacpp.jsonc'), llamacppJsonc, 'utf-8')

console.log(`[scenarios] CLAUDE_CONFIG_DIR=${TEMP_CONFIG_DIR}`)

// ── Mascot tools ──────────────────────────────────────────────────────
function makeTool({ name, description, schema, onCall }) {
  return {
    name,
    inputSchema: schema,
    description: async () => description,
    prompt: async () => description,
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    isDestructive: () => false,
    userFacingName: () => name,
    checkPermissions: async (input) => ({ behavior: 'allow', updatedInput: input }),
    toAutoClassifierInput: () => '',
    async call(args) {
      onCall?.(args)
      return {
        data: { ok: true },
        resultForAssistant: `${name}(${JSON.stringify(args)}) dispatched`,
      }
    },
  }
}

const dispatchLog = []
function record(action) {
  dispatchLog.push({ ts: Date.now(), action })
}

const tools = [
  makeTool({
    name: 'set_expression',
    description:
      '把桌寵 VRM 表情切換為指定名稱（joy / angry / sorrow / fun / surprised / hehe 等）。覆蓋自動表情輪播。',
    schema: z.object({
      name: z.string().describe('表情名稱：joy / angry / sorrow / fun / surprised / hehe / neutral'),
      durationMs: z.number().int().positive().optional(),
    }),
    onCall: (a) => record({ kind: 'set_expression', ...a }),
  }),
  makeTool({
    name: 'play_animation',
    description: '播放桌寵動畫；category 可選 idle / action / sit / fall / peek，或直接傳檔名 name。',
    schema: z.object({
      category: z.enum(['idle', 'action', 'sit', 'fall', 'peek']).optional(),
      name: z.string().optional(),
    }),
    onCall: (a) => record({ kind: 'play_animation', ...a }),
  }),
  makeTool({
    name: 'say',
    description: '在桌寵對話氣泡顯示短訊息（最多 80 字）。',
    schema: z.object({
      text: z.string().max(80),
    }),
    onCall: (a) => record({ kind: 'say', ...a }),
  }),
  makeTool({
    name: 'look_at_screen',
    description: '把桌寵視線轉向螢幕特定位置（normalized 0.0-1.0）。',
    schema: z.object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
    }),
    onCall: (a) => record({ kind: 'look_at_screen', ...a }),
  }),
]

// ── 載入 AgentEmbedded（共享給所有 scenario） ──────────────────────────
console.log(`\n[scenarios] 載入 AgentEmbedded + Qwen3.5-9B + mmproj (CUDA)...`)
const tLoad = Date.now()
const { AgentEmbedded } = await import('../../vendor/my-agent/dist-embedded/index.js')
const agent = await AgentEmbedded.create({
  cwd: process.cwd(),
  configDir: TEMP_CONFIG_DIR,
  extraTools: tools,
  skipMcp: true,
  onPreloadProgress: () => {},
})
console.log(`[scenarios] AgentEmbedded ready in ${Date.now() - tLoad}ms\n`)

// ── Scenario runner ─────────────────────────────────────────────────────
async function runScenario({ id, title, prompt, expect, timeoutMs = 90000, abortOnDispatch = true }) {
  const session = agent.createSession({ source: 'mascot' })
  const frames = []
  let helloFrame = null
  let turnEndReceived = false
  let turnEndReason = null
  const dispatchCountBefore = dispatchLog.length

  const blocks = { thinking: 0, text: 0, tool_use: 0, other: 0 }
  let lastText = ''
  let firstAssistantMs = 0
  const tStart = Date.now()

  session.on('frame', (f) => {
    frames.push(f)
    if (f.type === 'hello' && !helloFrame) helloFrame = f
    if (f.type === 'turnStart' && !firstAssistantMs) firstAssistantMs = Date.now() - tStart
    if (f.type === 'runnerEvent' && f.event?.type === 'output') {
      const p = f.event.payload
      if (p?.type === 'assistant' && Array.isArray(p.message?.content)) {
        for (const b of p.message.content) {
          if (b.type === 'thinking') blocks.thinking++
          else if (b.type === 'text') { blocks.text++; lastText = b.text || lastText }
          else if (b.type === 'tool_use') blocks.tool_use++
          else blocks.other++
        }
      }
    }
    if (f.type === 'turnEnd') {
      turnEndReceived = true
      turnEndReason = f.reason
    }
  })

  await new Promise((r) => setTimeout(r, 30))
  session.send(prompt)

  const dispatchedDuringScenario = () => dispatchLog.length - dispatchCountBefore
  let abortedReason = null

  await Promise.race([
    new Promise((resolve) => {
      const check = setInterval(() => {
        if (turnEndReceived) { clearInterval(check); resolve() }
        if (abortOnDispatch && dispatchedDuringScenario() >= 1 && !turnEndReceived) {
          clearInterval(check); abortedReason = 'first-dispatch'; resolve()
        }
      }, 80)
    }),
    new Promise((resolve) => setTimeout(() => { abortedReason = 'timeout'; resolve() }, timeoutMs)),
  ])

  // 給 streaming 收尾 frames 緩衝（不再等 turnEnd）
  await new Promise((r) => setTimeout(r, 500))
  try { session.abort?.() } catch {}
  try { await session.close() } catch {}

  const duration = Date.now() - tStart
  const dispatches = dispatchLog.slice(dispatchCountBefore)

  const result = {
    id, title, duration,
    hello: !!helloFrame,
    firstAssistantMs,
    frames: frames.length,
    blocks,
    lastTextPreview: lastText.slice(0, 80).replace(/\n/g, '\\n'),
    turnEnd: turnEndReason ?? `aborted:${abortedReason}`,
    dispatchCount: dispatches.length,
    dispatches: dispatches.map((d) => d.action),
  }

  // 評分
  const verdict = (() => {
    if (!helloFrame) return { tag: 'FAIL', why: 'no hello frame' }
    if (frames.length === 0) return { tag: 'FAIL', why: 'no frames' }
    if (expect.kind === 'tool_use') {
      if (dispatches.length === 0) return { tag: 'FAIL', why: 'expected tool dispatch but none' }
      if (expect.toolName && !dispatches.some((d) => d.action.kind === expect.toolName))
        return { tag: 'WARN', why: `dispatched but not expected tool ${expect.toolName}` }
      return { tag: 'PASS', why: `${dispatches.length} dispatch` }
    }
    if (expect.kind === 'text') {
      if (blocks.text === 0) return { tag: 'FAIL', why: 'expected text response but none' }
      if (dispatches.length > 0)
        return { tag: 'WARN', why: `text response but also ${dispatches.length} tool dispatch` }
      return { tag: 'PASS', why: 'text response only' }
    }
    if (expect.kind === 'either') {
      if (dispatches.length === 0 && blocks.text === 0)
        return { tag: 'FAIL', why: 'no response at all' }
      return { tag: 'PASS', why: dispatches.length > 0 ? `${dispatches.length} dispatch` : 'text only' }
    }
    return { tag: 'WARN', why: 'no expectation' }
  })()

  result.verdict = verdict
  return result
}

// ── 情境清單 ────────────────────────────────────────────────────────────
const scenarios = [
  {
    id: 'S1-zh-greet',
    title: '中文基礎問候（不該觸發 tool）',
    prompt: '你好，今天天氣不錯',
    expect: { kind: 'text' },
    timeoutMs: 60000,
  },
  {
    id: 'S2-en-tool-explicit',
    title: '英文明確 tool 呼叫（set_expression joy）',
    prompt: 'Use the set_expression tool with name="joy", then say "Done".',
    expect: { kind: 'tool_use', toolName: 'set_expression' },
    timeoutMs: 90000,
  },
  {
    id: 'S3-zh-tool-implicit',
    title: '中文隱含意圖（讓桌寵微笑 → 應呼叫 set_expression）',
    prompt: '讓桌寵露出開心的微笑表情。',
    expect: { kind: 'tool_use', toolName: 'set_expression' },
    timeoutMs: 90000,
  },
  {
    id: 'S4-en-animation',
    title: '播放動畫 tool（play_animation idle）',
    prompt: 'Call play_animation with category="idle".',
    expect: { kind: 'tool_use', toolName: 'play_animation' },
    timeoutMs: 90000,
  },
  {
    id: 'S5-say-tool',
    title: 'say tool 顯示氣泡（不該額外發 text）',
    prompt: 'Use the say tool with text="Hello world".',
    expect: { kind: 'tool_use', toolName: 'say' },
    timeoutMs: 90000,
  },
  {
    id: 'S6-look-at',
    title: 'look_at_screen 數值型參數',
    prompt: 'Call look_at_screen with x=0.5, y=0.5 to look at screen center.',
    expect: { kind: 'tool_use', toolName: 'look_at_screen' },
    timeoutMs: 90000,
  },
  {
    id: 'S7-multi-step',
    title: '連續多 tool（先表情後動畫）',
    prompt: 'First call set_expression with name="surprised", then call play_animation with category="action".',
    expect: { kind: 'tool_use' },
    timeoutMs: 120000,
    abortOnDispatch: false, // 讓 LLM 嘗試 chain
  },
  {
    id: 'S8-refusal-no-tool',
    title: '一般問題（不該觸發 tool）',
    prompt: 'What is 2 + 2? Reply with plain text only, do not use any tools.',
    expect: { kind: 'text' },
    timeoutMs: 60000,
  },
  {
    id: 'S9-zh-conversational',
    title: '中文閒聊（測中文對應能力）',
    prompt: '請用一句話介紹你自己。',
    expect: { kind: 'text' },
    timeoutMs: 60000,
  },
  {
    id: 'S10-ambiguous',
    title: '曖昧描述（可能 tool 也可能 text，either 都接受）',
    prompt: '能不能讓桌寵看看我這邊？',
    expect: { kind: 'either' },
    timeoutMs: 90000,
  },
]

// ── 執行 ───────────────────────────────────────────────────────────────
const results = []
for (const sc of scenarios) {
  console.log(`\n──────────────────────────────────────────────────`)
  console.log(`[${sc.id}] ${sc.title}`)
  console.log(`  prompt: ${sc.prompt.slice(0, 80)}`)
  const t = Date.now()
  try {
    const r = await runScenario(sc)
    results.push(r)
    console.log(`  → ${r.verdict.tag} (${r.verdict.why}) in ${r.duration}ms`)
    console.log(`  blocks: thinking=${r.blocks.thinking} text=${r.blocks.text} tool_use=${r.blocks.tool_use}`)
    if (r.dispatches.length > 0) {
      console.log(`  dispatches: ${JSON.stringify(r.dispatches).slice(0, 120)}`)
    }
    if (r.lastTextPreview) {
      console.log(`  text: "${r.lastTextPreview}"`)
    }
  } catch (e) {
    console.error(`  ✖ scenario crashed: ${e.message}`)
    results.push({
      id: sc.id, title: sc.title, duration: Date.now() - t,
      verdict: { tag: 'CRASH', why: e.message },
    })
  }
}

// ── Summary ────────────────────────────────────────────────────────────
console.log(`\n\n══════════════════════════════════════════════════════`)
console.log(`            E2E SCENARIO RESULTS`)
console.log(`══════════════════════════════════════════════════════`)
console.log('')
const col = (s, n) => String(s).padEnd(n).slice(0, n)
console.log(col('ID', 24) + col('Tag', 6) + col('Dur(ms)', 9) + col('Disp', 5) + 'Note')
console.log('─'.repeat(70))
const tally = { PASS: 0, WARN: 0, FAIL: 0, CRASH: 0 }
for (const r of results) {
  tally[r.verdict.tag] = (tally[r.verdict.tag] ?? 0) + 1
  console.log(
    col(r.id, 24) + col(r.verdict.tag, 6) + col(r.duration ?? '-', 9) +
    col(r.dispatchCount ?? 0, 5) + (r.verdict.why ?? '')
  )
}
console.log('─'.repeat(70))
console.log(`Total: ${results.length} scenarios`)
console.log(`  PASS: ${tally.PASS}    WARN: ${tally.WARN}    FAIL: ${tally.FAIL}    CRASH: ${tally.CRASH ?? 0}`)

console.log(`\n[scenarios] shutdown...`)
const tDown = Date.now()
await agent.shutdown()
console.log(`[scenarios] shutdown OK in ${Date.now() - tDown}ms`)

process.exit(tally.FAIL > 0 || tally.CRASH > 0 ? 1 : 0)
