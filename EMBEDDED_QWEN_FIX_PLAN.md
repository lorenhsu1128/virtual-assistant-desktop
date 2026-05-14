# Embedded Adapter Qwen 完整化計劃

> **狀態**：規劃中
> **建立日期**：2026-05-14
> **背景**：postinstall 完成、CUDA binding e2e 通過後，發現 embedded adapter
> 只送 last user text、丟掉 system+tools+history，Qwen 不知道 tool 存在。
> fetch+TCQ-shim 路徑早已把這些做完整，需把同等邏輯接到 embedded 路徑。

---

## 問題重述

### Bug 1 — `adapterMode='tcq'` 不對

`vendor/my-agent/src/services/api/llamacpp-embedded-adapter.ts` 我寫死：
```ts
const adapterMode: "vanilla" | "tcq" = "tcq";
```

`'tcq'` 是「TCQ-shim HTTP server 已 server-side parse 過 Qwen tool format」的訊號，
讓 fetch-adapter `translateOpenAIStreamToAnthropic` 跳過 leak parser fallback。

embedded 模式**根本沒 shim server**——我直接呼叫
`LlamaChatSession.prompt()` 回的是純文字，沒人 parse。設 `'tcq'` 等於
告訴下游「相信我已 parse 過了」，但其實沒有 → tool_use 永遠拿不到。

### Bug 2 — 全部對話脈絡被丟掉（更嚴重）

```ts
const userMsg = lastUserMessage(body.messages);
return await state.session.prompt(userMsg, { maxTokens, temperature });
```

`lastUserMessage` 只回最後一則 user 純文字。**全部丟掉**：

- system prompt（含 my-agent 完整人格 + tool 使用指引）
- 對話歷史（多輪上下文）
- `tools[]` 陣列（4 個 mascot tool + 46+ 內建 tool 的 JSON schema）
- 先前的 `tool_calls` / `tool_result` 訊息

Qwen 完全不知道有什麼 tool 可用 → 即使送「請露出微笑」也只會回「請問你需要什麼」。
e2e 結果 `mascot dispatches=0` 就是這個。

---

## 既有 my-agent / node-llama-tcq 的 Qwen 處理盤點

### A. fetch-adapter (`llamacpp-fetch-adapter.ts`) — Client side

| 機制 | 行號 | 用途 |
|---|---|---|
| `translateRequestToOpenAI` | 682 | Anthropic body → OpenAI body（含 messages + tools + tool_choice） |
| `flattenSystemPrompt` | 268 | Anthropic system block 陣列 → 單一字串 |
| `translateToolsToOpenAI` | 472 | Anthropic `tools[]` → OpenAI `{type:'function', function:{name,description,parameters}}` |
| `imageBlockToOpenAIPart` | 322 | Anthropic image block → OpenAI `image_url` part |
| `applySamplingPreset` | (other file) | 依 model family glob 注入 temp / top_p / top_k |
| `TOOL_USAGE_POLICY_NUDGE` | 789 | system 段追加：「能用 tool 答的問題必須 emit tool_use，不可只回文字」 |
| `streamWithRetryOnEmptyTool` | 1700 | 空 tool_call 偵測 + `RETRY_TOOL_NUDGE` 重發 |
| `parseLeakedXmlToolCalls` | 815 | Hermes XML leak parser（`<tool_call><function=NAME><parameter=K>V</parameter></function></tool_call>`） |
| `parseLeakedBarePythonicToolCalls` | 867 | 無外層的 bare pythonic 變體 |
| `translateChatCompletionToAnthropic` | 937 | 非串流 OpenAI → Anthropic（含 leak 修復） |
| `translateOpenAIStreamToAnthropic` | 1107 | 串流 OpenAI SSE → Anthropic SSE（含 leak 修復） |
| `adapterMode` gate | 940 / 1115 / 1706 | `'tcq'` 跳過 leak parser（信任 server 已 parse） |

### B. TCQ-shim (`vendor/node-llama-tcq/src/server/`) — Server side（純 TS 函式，**不依賴 HTTP**）

| 機制 | 檔案:行 | 用途 |
|---|---|---|
| `isQwenModel(alias)` | qwenToolFormat.ts:36 | model alias 開頭 `qwen` → 走 Qwen native 路徑 |
| `packMessages(messages, tools, useQwenFormat)` | chatCompletions.ts:821 | OpenAI messages + tools → `{systemPrompt, history, lastUserPrompt}` 三段；Qwen 路徑會 inject `<tools>` system block |
| `buildQwenToolsSystemBlock(tools)` | qwenToolFormat.ts:46 | 產生標準 Qwen3.5 native system 段：`# Tools\nYou have access to the following functions:\n<tools>{...JSON schema...}</tools>\nIf you choose to call a function ONLY reply in the following format with NO suffix:\n<tool_call><function=NAME><parameter=K>V</parameter></function></tool_call>` |
| `renderQwenToolCall(tc)` / `renderQwenToolResponse(...)` | qwenToolFormat.ts | 對話歷史中的 assistant tool_calls / tool result → XML 字串放回 history（讓模型看到自己過去的 tool 互動） |
| `buildQwenToolsReminder(tools)` | qwenToolFormat.ts:157 | Multi-turn 攻擊 attention recency bias，最後 user prompt 尾部重新塞 `<tools>` schema（Q4 量化緩解） |
| `buildQwenToolChoicePrefix(toolChoice)` | qwenToolFormat.ts:133 | `tool_choice='auto'` 不用；強制特定 tool 時 prefix-token 強制 |
| `composeResponsePrefix(reasoning, body, useQwen, tools)` | chatCompletions.ts | 組 `responsePrefix` 給 `promptWithMeta`（如 `<think>` 開頭 / `<tool_call>\n<function=` 強制 prefix） |
| `chatSession.promptWithMeta(lastUserPrompt, {...})` | node-llama-tcq 核心 | 真實推論呼叫；支援 `responsePrefix` / `customStopTriggers` / `signal` / `budgets.thoughtTokens` |
| `bundleResponse(meta.response)` | chatCompletions.ts | 利用 chat wrapper 已分段的 thought / visible / tool segments；fallback 走純 regex split |
| `parseQwenToolCalls(text, declaredTools)` | qwenToolFormat.ts:266 | 從完整 visible content 抽 `<tool_call>...<function=NAME>...<parameter=K>V</parameter>...</function>...</tool_call>` 多筆；型別強制 `true/false/null/number/JSON`；未宣告的 name filter；loose `<k>v</k>` 回救 Q4 變形（行 285-294） |
| `detectToolCallLeak(text)` | qwenToolFormat.ts:231 | 8 種 XML marker 掃描，命中即視為 leak，回 `ToolCallLeakReport`（marker / snippet / contentLength） |
| `StreamToolSniffer` | streamToolSniffer.ts:29 | 前 64 字嗅探 → 決策是 text 還 tool；後續同流 suppress `delta.content`（避免 raw XML 漏給 client） |
| `extractToolCallsForFormat(text, tools, useQwen)` | chatCompletions.ts:171 | wrapper：Qwen 走 `parseQwenToolCalls` + leak detect；non-Qwen 走 JSON-fallback |

### C. QwenChatWrapper (`vendor/node-llama-tcq/src/chatWrappers/QwenChatWrapper.ts`)

node-llama-tcq 內建的 chat wrapper，知道 Qwen3 / Qwen3.5 兩種 variation 的:
- system 段格式
- 對話訊息分隔 token
- `<think>` 開頭 reasoning 訊號
- tool_call 包裝格式（var 3 是 JSON、var 3.5 是 pythonic-XML）

**由 GGUF 的 `tokenizer_config.json` chat_template 自動載入**，無需手動指定。

---

## TCQ-shim 與 fetch-adapter 的責任分工（重要）

```
┌─ fetch-adapter (client side) ─────────────────────────────────┐
│                                                                │
│  Anthropic SDK request                                         │
│      ↓ translateRequestToOpenAI                                │
│  OpenAI body (含 tools[])                                       │
│      ↓ HTTP /v1/chat/completions                                │
│      ↓                                                          │
│  ┌─ TCQ-shim (server side) ──────────────────────────────┐    │
│  │  packMessages + buildQwenToolsSystemBlock              │    │
│  │  → system 段含 <tools>...</tools>                       │    │
│  │  → history 含 renderQwenToolCall                       │    │
│  │  → lastUserPrompt（必要時 buildQwenToolsReminder 追加） │    │
│  │  chatSession.promptWithMeta(lastUserPrompt, {...})     │    │
│  │  ↓ 純文字 response                                      │    │
│  │  bundleResponse → 拆 thought / visible / segments       │    │
│  │  parseQwenToolCalls → tool_calls[] (OpenAI 格式)        │    │
│  │  + detectToolCallLeak → _qwen_tool_leak（diagnostic）   │    │
│  │  → OpenAI ChatCompletion JSON / SSE                    │    │
│  └─────────────────────────────────────────────────────────┘    │
│      ↓ HTTP response                                            │
│  translateChatCompletionToAnthropic / translateOpenAIStreamToAnthropic
│      ↓ (adapterMode='tcq' 跳 leak parser，信任 server 已 parse)  │
│  Anthropic SSE / JSON                                          │
│      ↓ Anthropic SDK                                            │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**結論**：TCQ-shim 的全部 Qwen 邏輯都是純 TS 函式，**HTTP 只是傳輸層**。
embedded adapter 可以 in-process 直接 import 相同函式，達到一模一樣的完整度。

---

## 修正方案

### Phase 1 — 把 TCQ-shim 內部用的 utility 函式 export 出來

**檔案**：`vendor/my-agent/vendor/node-llama-tcq/src/server/chatCompletions.ts`

需要 export：
- `packMessages` (行 821) — 已是 private function，加 `export`
- `extractToolCallsForFormat` (行 171) — 同上
- `bundleResponse` — 同上（若尚未 export）
- `composeResponsePrefix` — 同上
- `resolveReasoning` — 同上
- `stripResponsePrefix` — 同上
- `formatReasoning` / `assembleFormattedFromSegments` — 同上
- `maybeApplyBudgetExhaustionMessage` — 同上
- `mapStopReason` / `toOpenAIFinishReason` — 同上
- `buildRepeatPenalty` — 同上
- `normalizeStop` — 同上
- `countFullPromptTokens` / `countTokens` / `recordChatTokens` — 視需求

可能要新增頂層 export 模組：
`vendor/my-agent/vendor/node-llama-tcq/src/server/shimCore.ts`（重新 export 全部）
讓 embedded adapter 一行 import 拿到全部。

**OR 更乾淨**：把 `runNonStreaming` / `runStreaming` 內 HTTP 寫入前的「純運算」邏輯
抽成兩個 reusable 函式：
- `runChatCompletionNonStreaming(opts: RunCtx): Promise<OpenAIChatCompletion>`
- `runChatCompletionStreaming(opts: RunCtx): AsyncGenerator<OpenAISSEChunk>`

不傳 `req` / `res`，回傳 plain JS object / generator。HTTP handler（runStreaming / runNonStreaming）改成薄包裝：取結果 → sendJson / write SSE。

**這條路較難但長期最乾淨**——TCQ-shim 跟 embedded 共用同一個 chat 核心，
未來任何 Qwen 修正自動兩邊都享受到。

### Phase 2 — 在 embedded adapter 替換 `lastUserMessage` + `session.prompt` 為 reuse TCQ-shim 核心

**檔案**：`vendor/my-agent/src/services/api/llamacpp-embedded-adapter.ts`

```ts
import {
    isQwenModel,
    packMessages,
    extractToolCallsForFormat,
    bundleResponse,
    composeResponsePrefix,
    resolveReasoning,
    // ... 其他 utility
    runChatCompletionNonStreaming,    // Phase 1 抽出的純函式
    runChatCompletionStreaming,        // Phase 1 抽出的純函式
} from "node-llama-tcq/server-core"; // 新 export 點
```

Embedded adapter 不再用 `lastUserMessage` + `state.session.prompt(text)`，
改成：

```ts
// 取現有 LlamaChatSession（_modelCache 內的）— 已經 contextSize / KV 設好
const reasoning = resolveReasoning(session, body);
const useQwen = isQwenModel(body.model ?? "");
const { systemPrompt, history, lastUserPrompt } = packMessages(
    body.messages, body.tools ?? [], useQwen
);

// 設 chat history
state.session.setChatHistory(history);
// 設 systemPrompt（含 buildQwenToolsSystemBlock 注入的 <tools>）
state.session.setSystemPrompt(systemPrompt);

// 與 TCQ-shim runNonStreaming 同一條 promptWithMeta 呼叫
const { engineResponsePrefix, stripPrefix } = composeResponsePrefix(
    reasoning, body, useQwen, body.tools ?? []
);
const meta = await state.session.promptWithMeta(lastUserPrompt, {
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    // ... 與 runNonStreaming 同
    signal: abortSignal,
    ...(engineResponsePrefix ? { responsePrefix: engineResponsePrefix } : {}),
});

// 解析 tool_calls + 包成 OpenAI ChatCompletion
const bundle = bundleResponse(meta.response);
const rawVisibleText = stripResponsePrefix(bundle.visibleText, stripPrefix);
const formatted = formatReasoning(rawVisibleText, reasoning.reasoningFormat);
const { content, toolCalls, leak } = extractToolCallsForFormat(
    formatted.content, body.tools ?? [], useQwen
);

const openaiJson: OpenAIChatCompletion = {
    id: ..., object: "chat.completion", model: ...,
    choices: [{
        index: 0,
        message: {
            role: "assistant",
            content: toolCalls.length > 0 ? null : content,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
    }],
    usage: { ... },
};
```

Streaming 模式同理走 `runChatCompletionStreaming` 或 `StreamToolSniffer`。

### Phase 3 — `adapterMode` 設回 `'tcq'`（正確）

因為 Phase 2 之後 embedded adapter 已經 **server-side parse 過 Qwen XML**
（與 TCQ-shim HTTP 版本完全等價），所以下游的
`translateChatCompletionToAnthropic` / `translateOpenAIStreamToAnthropic`
應該保持 `mode='tcq'` 跳過 leak parser fallback（避免雙重解析）。

之前我寫死 `'tcq'` 雖然方向對，但因為 Phase 2 沒做，server-side parse 不存在，
應該暫時是 `'vanilla'` 才有 leak parser 兜底。Phase 2 做完後改回 `'tcq'`。

### Phase 4 — 把 sampling preset 也接進來

fetch-adapter 在 `translateRequestToOpenAI` 內呼叫 `applySamplingPreset`
依 model family glob 注入 temperature / top_p / top_k。

embedded adapter 也應該套——同一份 `samplingPresets` 設定（從
`~/.virtual-assistant-desktop/llamacpp.jsonc` 讀）。

實作：呼叫 `getLlamaCppConfigSnapshot()` → 取 `samplingPresets[]` → 套用。

### Phase 5 — 串流 + 工具呼叫的 StreamToolSniffer 接入

Phase 2 第一輪可以只支援非串流（簡化）。**第二輪**接上 `StreamToolSniffer`：
- 前 64 字嗅探：text 還 tool？
- 是 tool → 後續 suppress `delta.content` 不要 raw XML 漏到 SSE
- 完整輸出後一次性 `parseQwenToolCalls` → emit OpenAI tool_calls chunk
- 包成 OpenAI SSE → 餵 `translateOpenAIStreamToAnthropic`

### Phase 6 — Vision path（如使用 mmproj）

embedded 的 `runVisionPath` 走 `LlamaMtmdContext` 而非 `LlamaChatSession`。
TCQ-shim 的 vision handler 在 `handleChatWithVision`，邏輯類似但不同函式。
v1 先確保純文字 + tools 完整，vision 維持目前 batch 模式（functional 但無 tool_call 整合）。

---

## 風險與緩解

| 風險 | 緩解 |
|---|---|
| 改 vendor/node-llama-tcq export — 可能與 upstream 衝突 | TCQ fork 本來就是 my-agent maintainer 改的，加 export 是純擴增不破壞，與 upstream 合併簡單 |
| `runChatCompletionNonStreaming` refactor 風險 | runNonStreaming 既有測試先跑一次確認沒 regression；refactor 完再跑 |
| my-agent submodule 改動 → 桌寵 dist-embedded 要重 build | postinstall 自動跑，dev 已驗證 |
| Qwen XML leak parser 設定變得多餘 | 保留兩條路徑（embedded server-side parsed → `mode='tcq'` 跳；萬一未來有 case 還是漏出 → 改 `'vanilla'` 啟用 fallback） |
| Embedded model 與 llama-server 用同樣 chat_template 嗎？ | 是。GGUF 的 chat_template 由 llama.cpp 解析。embedded 用 LlamaChatSession 內部會用同一個 wrapper（QwenChatWrapper）。行為一致 |
| `LlamaChatSession.setChatHistory()` 對長 history 的效率 | TCQ-shim 內部用 `chatSession.setChatHistory(history)` + autoDisposeSequence:false，已驗證 production 可用 |

---

## 驗證

### Phase 1+2+3 完成後

跑 `agentRuntimeE2E.mjs`（已 set `MY_AGENT_LLAMACPP_EMBEDDED=1`）：

- ✅ Turn 完成（< 30s）
- ✅ Assistant frame 含 `[tool_use:set_expression input={"name":"joy"}]`（不再是 raw XML 也不是 clarification 文字）
- ✅ `mascot dispatches=1` 或更多
- ✅ Turn end reason=done
- ✅ Frame schema 與 fetch+llama-server 模式完全一致（src-bubble 端零修改）

### 進階驗證

- 多輪對話 history 上下文（embed 連續送 3 個 turn）→ 模型認得前文
- Vision + tool（圖片 + 「請設置看到的表情」）
- 取消 turn（AbortController）→ promptWithMeta signal 中斷推論
- Context overflow（強制長 history）→ 413 error 正確回傳

---

## 時程

| Phase | 工作 | 估計人天 |
|---|---|---|
| 1 | node-llama-tcq export refactor（runChatCompletionNonStreaming） | 1-2 |
| 2 | embedded adapter 替換核心生成路徑（非串流） | 1 |
| 3 | adapterMode 設回 'tcq' + 確認 leak parser 兼容 | 0.5 |
| 4 | sampling preset 接入 | 0.5 |
| 5 | 串流 + StreamToolSniffer 整合 | 1-2 |
| 6 | Vision path 整合（v2） | 1-2（可延後） |
| 驗證 + e2e + 文件 | | 0.5 |
| **合計**（v1，含 Phase 1-3） | | **2.5-3.5 人天** |
| **+ Phase 4-5** | | **+1.5-2.5 人天** |

---

## 相關檔案（按執行順序）

### 需改

- `vendor/my-agent/vendor/node-llama-tcq/src/server/chatCompletions.ts` —
  抽 `runChatCompletionNonStreaming` / `runChatCompletionStreaming`；export utilities
- `vendor/my-agent/vendor/node-llama-tcq/src/server/` —
  可能新增 `serverCore.ts` 作為頂層 reusable export 集中點
- `vendor/my-agent/src/services/api/llamacpp-embedded-adapter.ts` —
  替換核心生成邏輯
- `vendor/my-agent/scripts/build-embedded.ts` —
  確認 server-core 也被 bundle 進 `dist-embedded/`

### 不改（重用即可）

- `vendor/my-agent/vendor/node-llama-tcq/src/server/qwenToolFormat.ts` —
  buildQwenToolsSystemBlock / parseQwenToolCalls / detectToolCallLeak
- `vendor/my-agent/vendor/node-llama-tcq/src/server/streamToolSniffer.ts`
- `vendor/my-agent/vendor/node-llama-tcq/src/chatWrappers/QwenChatWrapper.ts`
- `vendor/my-agent/src/services/api/llamacpp-fetch-adapter.ts`（除了已 export 的 mkMsgId / sseGeneratorToStream）

---

## 後續可選工作（v2+）

- **桌寵 production installer 內 bundle `llama-addon.node` + DLLs** —
  讓使用者不用自己 build CUDA binding（要做 GitHub Actions CI 或在 release zip 包進去）
- **`postinstall-vendor.mjs` 加偵測**：若 user 環境有 CUDA SDK + MSVC，自動觸發
  source build（複用 my-agent 的 cli 命令）
- **Tool grammar constraint**：v1 走 Qwen native + responsePrefix；v2 可加 GBNF 約束生成
- **non-Qwen model 走 JSON fallback**：tcq-shim 已實作（packMessages useQwenFormat=false 分支）；
  embedded path 沿用即可
