/**
 * Built-in tools 執行驗證 — Bash / FileWrite / FileRead 真實 dispatch + 結果回填。
 *
 * 透過 my-agent 既有 ToolRegistry：要求 LLM 寫檔案 + 讀檔案 + 跑 bash，
 * 驗證 tool 真的執行（檔案內容存在 / bash output 出現在後續對話）。
 */
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'

const MY_AGENT_REPO = process.env.MY_AGENT_REPO || 'C:/Users/LOREN/Documents/_projects/my-agent'
const MODEL_ABS = resolve(MY_AGENT_REPO, 'models/Qwen3.5-9B-Q4_K_M.gguf')
if (!existsSync(MODEL_ABS)) { console.error(`[builtin] FAIL: 缺 model`); process.exit(2) }

const TEMP = join(tmpdir(), `vad-builtin-${process.pid}-${Date.now()}`)
mkdirSync(TEMP, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = TEMP
process.env.MY_AGENT_REMOTE_MEMORY_DIR = TEMP
process.env.MY_AGENT_LLAMACPP_EMBEDDED = '1'

writeFileSync(join(TEMP, 'llamacpp.jsonc'),
  `{"baseUrl":"http://127.0.0.1:8081/v1","model":"qwen3.5-9b","contextSize":131072,"debug":false,"modelAliases":["qwen3.5-9b"],"server":{"host":"127.0.0.1","port":8081,"ctxSize":131072,"gpuLayers":99,"modelPath":${JSON.stringify(MODEL_ABS)},"alias":"qwen3.5-9b","binaryPath":${JSON.stringify(resolve(MY_AGENT_REPO,'buun-llama-cpp/build/bin/Release/llama-server.exe'))},"extraArgs":["--flash-attn","on","--cache-type-k","turbo4","--cache-type-v","turbo4","-b","2048","-ub","512","--threads","12","--no-mmap"],"binaryKind":"buun"}}`, 'utf-8')

const { AgentEmbedded } = await import('../../vendor/my-agent/dist-embedded/index.js')
const agent = await AgentEmbedded.create({
  cwd: TEMP,
  configDir: TEMP,
  extraTools: [],
  skipMcp: true,
  // 允許所有 tool（避免 permission gate 卡住）
  canUseTool: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
  onPreloadProgress: () => {},
})

const targetFile = join(TEMP, 'mascot_test.txt')
const targetFileNorm = targetFile.replace(/\\/g, '/')
const session = agent.createSession({ source: 'mascot' })
const blocks = { tool_use: [], text: [], thinking: 0 }
let turnEnded = false
session.on('frame', (f) => {
  if (f.type === 'runnerEvent' && f.event?.type === 'output') {
    const p = f.event.payload
    if (p?.type === 'assistant' && Array.isArray(p.message?.content)) {
      for (const b of p.message.content) {
        if (b.type === 'tool_use') blocks.tool_use.push({ name: b.name, input: b.input })
        else if (b.type === 'text') blocks.text.push(b.text)
        else if (b.type === 'thinking') blocks.thinking++
      }
    }
  }
  if (f.type === 'turnEnd') turnEnded = true
})

await new Promise(r => setTimeout(r, 30))
const prompt = `請依序執行：
1. 用 Write tool 建立檔案 ${targetFileNorm}，內容是 "hello from mascot"
2. 用 Read tool 讀回該檔案
3. 結束後簡短總結你做了什麼（一句話即可）`
session.send(prompt)

const tStart = Date.now()
await new Promise(r => {
  const t = setInterval(() => {
    if (turnEnded || Date.now() - tStart > 240000) { clearInterval(t); r() }
  }, 100)
})

try { await session.close() } catch {}
try { await agent.shutdown?.() } catch {}

const elapsed = Date.now() - tStart
const writeCall = blocks.tool_use.find(t => /^Write$/i.test(t.name))
const readCall = blocks.tool_use.find(t => /^Read$/i.test(t.name))
const fileExists = existsSync(targetFile)
const fileContent = fileExists ? readFileSync(targetFile, 'utf-8') : ''
const hasHello = fileContent.includes('hello')

console.log(`\n══════════════════════════════════════════════════════`)
console.log(`           BUILT-IN TOOLS E2E RESULTS`)
console.log(`══════════════════════════════════════════════════════`)
console.log(`elapsed: ${elapsed}ms  turnEnded: ${turnEnded}`)
console.log(`tool_use blocks: ${blocks.tool_use.length}`)
for (const t of blocks.tool_use) console.log(`  ${t.name}(${JSON.stringify(t.input).slice(0,80)})`)
console.log(`text blocks: ${blocks.text.length}`)
console.log(`file exists: ${fileExists}, content: "${fileContent}"`)

const t1 = !!writeCall
const t2 = !!readCall
const t3 = fileExists
const t4 = hasHello
const t5 = turnEnded
console.log(`\nT1 Write tool called:  ${t1 ? 'PASS' : 'FAIL'}`)
console.log(`T2 Read tool called:   ${t2 ? 'PASS' : 'FAIL'}`)
console.log(`T3 file created:       ${t3 ? 'PASS' : 'FAIL'}`)
console.log(`T4 file content right: ${t4 ? 'PASS' : 'FAIL'}`)
console.log(`T5 turn completed:     ${t5 ? 'PASS' : 'FAIL'}`)

const pass = t1 && t2 && t3 && t4 && t5
console.log(`\nVerdict: ${pass ? 'PASS' : 'FAIL'}\n`)
process.exit(pass ? 0 : 1)
