/**
 * Embedded vision + tools E2E.
 *
 * 驗證 Phase A 後 embedded vision branch 改走 tcq-shim runVisionChatCompletionCore：
 *  - 上傳一張圖（PNG）作為 image_url block
 *  - 附帶 mascot tools（set_expression / play_animation 等）
 *  - 期望 LLM 描述圖片 + 觸發至少 1 個 tool dispatch
 *
 * 之前 embedded vision 跑自家 batch path，tools 完全無法被解析。
 *
 * 用法：node tests/integration/embeddedVisionToolE2E.mjs
 */
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'

const MY_AGENT_REPO = process.env.MY_AGENT_REPO || 'C:/Users/LOREN/Documents/_projects/my-agent'
const MODEL_ABS = resolve(MY_AGENT_REPO, 'models/Qwen3.5-9B-Q4_K_M.gguf')
const MMPROJ_ABS = resolve(MY_AGENT_REPO, 'models/mmproj-Qwen3.5-9B-F16.gguf')
// 抓一張存在的範例圖（任一即可，需 PNG/JPG）
const IMAGE_ABS = resolve('C:/Users/LOREN/Documents/_projects/virtual-assistant-desktop/HybrIK/examples/000000000431.jpg')

if (!existsSync(MODEL_ABS) || !existsSync(MMPROJ_ABS)) {
  console.error(`[vision] FAIL: 缺 model/mmproj — ${MODEL_ABS} / ${MMPROJ_ABS}`)
  process.exit(2)
}
if (!existsSync(IMAGE_ABS)) {
  console.error(`[vision] FAIL: 測試圖不存在 ${IMAGE_ABS}`)
  process.exit(2)
}

const TEMP = join(tmpdir(), `vad-vision-${process.pid}-${Date.now()}`)
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
    "vision": {"enabled": true}
  }`,
  'utf-8',
)

console.log(`[vision] CLAUDE_CONFIG_DIR=${TEMP}`)

// ── Mascot tools（同 agentScenariosE2E 的 makeTool 定義） ─────────────────
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
const tools = [
  makeTool({
    name: 'set_expression',
    description: '把桌寵 VRM 表情切換為指定名稱（joy / angry / sorrow / fun / surprised / hehe / neutral 等）。',
    schema: z.object({
      name: z.string().describe('表情名稱'),
      durationMs: z.number().int().positive().optional(),
    }),
    onCall: (a) => dispatchLog.push({ kind: 'set_expression', ...a }),
  }),
  makeTool({
    name: 'play_animation',
    description: '播放桌寵動畫；category 可選 idle / action / sit / fall / peek。',
    schema: z.object({
      category: z.enum(['idle', 'action', 'sit', 'fall', 'peek']).optional(),
      name: z.string().optional(),
    }),
    onCall: (a) => dispatchLog.push({ kind: 'play_animation', ...a }),
  }),
  makeTool({
    name: 'say',
    description: '在桌寵對話氣泡顯示短訊息（最多 80 字）。',
    schema: z.object({ text: z.string().max(80) }),
    onCall: (a) => dispatchLog.push({ kind: 'say', ...a }),
  }),
]

console.log(`[vision] 載入 AgentEmbedded + 圖 ${IMAGE_ABS}`)
const tLoad = Date.now()
const { AgentEmbedded } = await import('../../vendor/my-agent/dist-embedded/index.js')
const agent = await AgentEmbedded.create({
  cwd: process.cwd(),
  configDir: TEMP,
  extraTools: tools,
  skipMcp: true,
  onPreloadProgress: () => {},
})
console.log(`[vision] ready in ${Date.now() - tLoad}ms`)

// ── 把圖 encode 成 data URL ───────────────────────────────────────────────
const imageBuf = readFileSync(IMAGE_ABS)
const imageDataUrl = `data:image/jpeg;base64,${imageBuf.toString('base64')}`
console.log(`[vision] image size = ${imageBuf.length} bytes`)

// ── 跑 turn：附圖 + 要求依圖選表情 ───────────────────────────────────────
const session = agent.createSession({ source: 'mascot' })
const frames = []
let turnEnded = false
const blocks = { thinking: 0, text: 0, tool_use: 0, other: 0 }
let lastText = ''

session.on('frame', (f) => {
  frames.push(f)
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
  if (f.type === 'turnEnd') turnEnded = true
})

await new Promise((r) => setTimeout(r, 30))

// Anthropic-style content array — 含 image + text；session.send 接 string|array
session.send([
  {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/jpeg',
      data: imageBuf.toString('base64'),
    },
  },
  {
    type: 'text',
    text: '請看這張圖，並用 set_expression tool 設一個適合的表情（例如 joy / surprised / fun），同時用 say tool 簡短描述圖中內容。',
  },
])

const tStart = Date.now()
await new Promise((resolve) => {
  const t = setInterval(() => {
    if (turnEnded || Date.now() - tStart > 180000) { clearInterval(t); resolve() }
  }, 100)
})
const elapsed = Date.now() - tStart

try { await session.close() } catch {}
try { await agent.shutdown?.() } catch {}

console.log(`\n══════════════════════════════════════════════════════`)
console.log(`            VISION + TOOLS E2E RESULTS`)
console.log(`══════════════════════════════════════════════════════`)
console.log(`elapsed: ${elapsed}ms turnEnded: ${turnEnded}`)
console.log(`frames: ${frames.length}`)
console.log(`assistant blocks: text=${blocks.text} thinking=${blocks.thinking} tool_use=${blocks.tool_use}`)
console.log(`tool dispatches: ${dispatchLog.length}`)
for (const d of dispatchLog) console.log(`  ${d.kind}(${JSON.stringify(d).slice(0, 80)})`)
console.log(`last text preview: ${lastText.slice(0, 150).replace(/\n/g, '\\n')}`)

const pass = turnEnded && dispatchLog.length >= 1
console.log(`\nVerdict: ${pass ? 'PASS' : 'FAIL'} (turnEnded=${turnEnded}, dispatches>=1=${dispatchLog.length >= 1})\n`)
process.exit(pass ? 0 : 1)
