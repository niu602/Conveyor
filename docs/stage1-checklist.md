# Stage 1 §6 互操作七条 · 线上自证清单

规范原文：`D:\OpenAgenticWeb\docs\worldwide_agentic_web_mvp_spec.md` §6（第 427–445 行），
基线 `90d561d6185d3b5625f9d8055da4d259074af745`。Stage 1 是 **pass/fail 规范符合性**，不合规直接淘汰，
所以这七条必须**逐条在真线上 URL 上自证**，不能只用本地证据顶替。

本文件在 11-28 建立，**上线前先把方法与判据钉死**，上线当天只填证据。
状态口径：`待上线` = 方法已定、证据未取；`本地已证` = 有本地证据但按 §6 仍须线上复现。

---

## 前置：三条读规范时容易踩空的地方（已核实，附证据）

### A. 「two-agent network」怎么算

§6 第 1 条原文是 "Publish a **two-agent** HOCON network and a manifest"。
我们两站各只有 **1 个** agent：`courier_desk_assistant`、`little_oven_assistant`。

**但官方三个参考示例也全是单 agent**（实测枚举 `D:\OpenAgenticWeb\examples\*\*.hocon`）：

| 示例 | agent |
| --- | --- |
| `guesthouse_agentified/tidewhistle_guesthouse.hocon` | `tidewhistle_assistant` |
| `harbor_tours_agentified/marrow_point_harbor_tours.hocon` | `harbor_tours_assistant` |
| `marrow_point_pizza_agentified/little_oven_pizza.hocon` | `little_oven_assistant` |

且 skill 的默认设计就是「one front agent，只在知识/系统/流程分离时才加 specialist」。
**结论**：该条按「跨两站组合出的两个 agent」读，与参考实现一致；我们的披萨→跑腿正是这一形态。
**备选**（若评委坚持单网络内 ≥2 agent）：给跑腿加一个 specialist（如计价/规则专员），
改 HOCON + rebuild + 重跑测试，约半天。**不擅自改**，等线上自证或评委反馈再说。

### B. §4 明确认可我们的本地反代——但生产必须拆成两个端点

§4「Caller-site BYOK proxy option」原文允许：站点 MAY 暴露同源转发端点，
用于访客所选 router 不支持浏览器 CORS 的情况；**BYOK 模式下该端点转发访客的 Authorization，
MUST NOT 替换成站方自己的 provider key**；另有一个**独立的 default-inference 端点**才 MAY 用站方凭据。

我们段 1·5 的 `llm-proxy.mjs` 是**混合体**：访客真 key 透传，占位 `env`/`use-env`/`proxy`
或无头则注入服务端 `ZHIPU_API_KEY`（`llm-proxy.mjs:17-20, 43, 135`）。
**它 dev-only、Worker 无此路由、从未上线，所以当前不构成违规**；
但 **M3 的网关不能照抄这个形状**，必须：

- `/byok/v1/chat/completions`：只透传访客 Authorization，**永不注入**站方 key；
- `/v1/chat/completions`（default inference，即 manifest 的 `base_url`）：用站方 secret，**忽略浏览器传来的任何 Authorization**。

这条是 M3 网关的设计硬约束，写进 `docs/upstream-0.2.2-notes.md` 的落地补充。

### C. default inference 是 MAY，但 §6 第 2 条要「跑起来」

§4 第 345 行：站点 **MAY** 发布无需访客 key 的默认 router。所以 publisher_funded 本身不是符合性必需。
**但 §6 第 2 条要求**「用站点**已发布的默认 router 与 model** 在浏览器里加载并运行该网络」。
我们当前 manifest 的 `base_url` 指向 otari 且 `publisher_funded` 未开 → 默认路径仍需访客填 key，
严格读第 2 条会缺口。**所以 publisher_funded 是干净满足第 2 条的手段**，不只是"演示更好看"。

---

## 七条逐条

### 第 1 条 · 从普通 HTTPS 主机发布网络与 manifest

> Publish a two-agent HOCON network and a manifest from an ordinary HTTPS web host.

**线上自证**
1. 两站 Pages URL 用 HTTPS 打开，`/agent-manifest.json` 与 `/<network>.network.json` 直接可下载。
2. 第三方视角（非本机、未登录）能取到同样文件——用海外可达性实测，不用本机 curl 顶替。
3. `node SKILL_DIR/scripts/check_partner.mjs <线上 network URL>`（不带 `--origin`）通过。

**判据**：两站六个公开文件均 200 且带 `Access-Control-Allow-Origin: *`；`_headers` 已就位（`b03045f`）。
**证据位**：`docs/m3-*.png` + `raw-m3-*.txt`（待取）。
**状态**：待上线。two-agent 口径见前置 A。

### 第 2 条 · 用已发布的默认 router 与 model 在浏览器里跑起来；若提供 BYOK 也要证

> Load and run that network in a browser with the site's published default router and model; if BYOK is offered, also demonstrate the user-selected path.

**线上自证**
1. **默认路径**：全新浏览器 profile、**不存任何 key**，打开线上披萨站 → ⚙ AI model settings 首行应显示
   "paid for by this site, no key needed" → 直接提问能答。
2. **BYOK 路径**：同一页面填入访客自己的 router/model/key → in-use 行切到 BYOK → 再跑一轮。
3. 两条路径各录一次原始屏录。

**判据**：默认路径依赖 publisher_funded 网关上线（前置 C）；网关须满足 `bundle_and_hosting.md:353-380`
的三条必做 + 五条自保（origin 白名单、按访客限流、花费上限、model 白名单、不记访客内容），
且 **`base_url` ≠ `byok_router`**（build 会拒相等的 manifest）。
**本地已证**：套 A deepseek 直连（BYOK）、套 B glm-4-plus 经反代，见 `m2-unknown.md` §9。
**状态**：待上线 + 网关未建。

### 第 3 条 · 调用内部 agent 与至少一个 grounded capability

> Call an internal agent and at least one grounded capability through MCP or a registered local site action.

**线上自证**：在线上披萨站问「medium box 3 items 到 North town 多少钱、多久」，
trace 里应出现 `website_request_quote`（注册本地 site action）并返回真实计价；
跑腿站问 job 状态应走 `website_lookup_job`。

**判据**：答案数字必须来自 tool result，不是模型编的。跑腿计价可手算核对：
north 450 / 18min，medium +200，超过 2 件每件 +50。
**本地已证**：`m1-real-llm.md`、`m2-mandate.md`。
**状态**：本地已证，线上待复现。

### 第 4 条 · 用户批准后，从第二个 origin 加载指名网络并在调用方浏览器里本地运行

> After user approval, load an exact named network from a second origin and run it locally in the caller's browser.

**线上自证**：线上披萨站 → 让助手找跑腿报价 → **consent 卡必须先出现**且指名跑腿 host 与请求前 140 字符 →
点 allow 后才发请求 → 跑腿网络在披萨页的浏览器里运行（不是跑腿服务器）。

**判据**：allow 之前 Network 面板对跑腿 origin **零请求**；卡片文案与 `link_labels` 一致。
**依赖**：披萨 manifest 的 `allowed_peers` 与 HOCON 的 partner URL 必须换成线上域名
（`tools/deploy-origins.mjs --check` 会把未换的列出来并 exit 1）。
**本地已证**：`m2-mandate-panel.png`、四分支演练。
**状态**：本地已证，线上待复现。

### 第 5 条 · 访客 key 生效时，第二站永远拿不到它，也改不了调用方的 router

> When a user key is active, show that the second site never receives it and cannot change the caller's router.

**线上自证**：BYOK 模式下跑一次跨站，抓跑腿 origin 的**全部**请求（含 bridge frame 与 partner 调用），
逐条确认请求头无 `Authorization`、URL 与 body 无 key；跑腿 manifest 里的 `llm_router` 不得覆盖调用方 in-use 行。

**判据**：§4「Credential handling」列的禁止位置全部为空——URL、manifest、网络文件、prompt、
action 参数、trace、analytics、peer 请求。
**注意**：这正是前置 B 要求网关拆端点的原因；BYOK 转发端点若注入站方 key 就违反 §4。
**本地已证**：`m1-real-llm.md` 的 CORS/凭据段。
**状态**：本地已证，线上待复现（线上必须重抓，不能引用本地抓包）。

### 第 6 条 · 私有上下文在 peer 侧缺席，除非显式放行某个命名字段

> Show that private context is absent at the peer unless a named field is explicitly allowed.

**线上自证**：在跑腿写窗口里填姓名/电话/地址 → 抓披萨→跑腿的 partner 请求 body，
确认只有 quoteId / orderRef / dropZone / parcelSize / itemCount / feeCents，**无 PII**；
再打开线上对账页，确认收据与页面均无 PII。

**判据**：`requestDigest` 故意排除 PII（`courier-desk.js`），收据 `SIGNED_FIELDS` 亦排除；
段 2 已有用例锁死「四个 PII 字段不在收据里」与「页面不画 PII」。
**本地已证**：`m2-receipts.md` §7、`raw-m2-receipt-sign.txt`（`PII in receipt: []`）。
**状态**：本地已证，线上待复现。

### 第 7 条 · 四种坏情况都要被拦住并有可见错误

> Stop an invalid network, a composition cycle, an over-budget request, and a denied origin with visible errors.

四种子情况，各自的线上自证方法：

| 子情况 | 怎么在线上触发 | 期望的可见错误 |
| --- | --- | --- |
| invalid network | 指向一个不存在/损坏的 network URL | 加载失败并显示原因，页面其余部分仍可用 |
| composition cycle | 让两站互相指名调用形成环 | runtime 拒绝并显示，不无限递归 |
| over-budget request | 触发 90 秒 composition deadline，或超过每消息 4 次 / 每 peer 1 次 partner 上限 | `COMPOSITION_LIMIT` 文案 + 卡片仍先出现；超限只跳过调用 |
| denied origin | 用未列入 `allowed_peers` 的 origin 调 bridge | 403 且无 CORS 头，调用方显示连不上 |

**本地已证**：over-budget 有 D 证据（`AGENT 181564ms` / `LLM 111803ms` / `COMPOSITION_LIMIT` /
`Skipped Conveyor Courier`，`m2-unknown-deadline.png`）；denied origin 有自动化用例（陌生 origin 403 无 ACAO）。
**缺口**：invalid network 与 composition cycle **尚无专门证据**，需在线上各造一次并截图。
**状态**：部分本地已证，两项待补。

---

## 可用的第三方校验器（社区，非官方）

官方简易校验工具 11-27 尚未发布，仍按每周盯 releases。
但官方清单 `docs/agentic_websites.md` 里已有若干社区校验站，上线后可直接拿它们跑我们两站，
作为**独立第三方证据**（比自己写脚本更有说服力）：

| 站点 | 能验什么 | 与我们的关系 |
| --- | --- | --- |
| Agent Atlas `https://agent-atlas-phi.vercel.app/` | spec 符合性、agent  contacting 的 origins、是否可被他人调用 | 直接对应 §6 第 1/4 条 |
| RungLab Trust Peer `https://agentic.runglab.dev/` | manifest 符合性 + **静态 `_headers` 的 CORS/CSP 隔离** | 直接验我们刚写的 `_headers` |
| NandaSeal `https://cocvn157.github.io/nanda-seal/` | 浏览器内 **ECDSA P-256** 签验 manifest/network、1 字节篡改检测 | 与我们收据同一算法族，可作对照素材 |
| Agent Crash Test `https://d3c7h3snp0n4hj.cloudfront.net/` | 用"什么都答应"的模型跑一遍，报告哪些 action 未经询问就执行、试图联系哪些站 | 对应 §6 第 7 条与我们的 consent 设计 |

**注意**：这些是他人站点，调用它们会走 consent 卡并消耗我们的模型额度（若 publisher_funded 已开则计我们的账）。
跑之前先看 `docs/usage-log.md` 的余量。

---

## 上线当天的取证顺序（避免返工）

1. `node tools/deploy-origins.mjs --check` → 必须 READY（含 partner 决策已定）。
2. 两站 rebuild + `--check` + 两站测试全绿。
3. 部署 → 海外视角取六个公开文件的 200 与 CORS 头（第 1 条）。
4. 真浏览器跑一次完整写链路：下单 → 询价 → authorize → consent → 写窗口 → 收据验签（第 3/4/6 条）。
5. BYOK 与默认两条路径各跑一次并抓包（第 2/5 条）。
6. 四种坏情况各造一次（第 7 条），其中 invalid network 与 cycle 是**新证据**。
7. 清单 PR + Devpost 草稿当天建。
8. 全部证据落 `docs/`，本文件逐条把 `待上线` 改成实际结论与文件名。