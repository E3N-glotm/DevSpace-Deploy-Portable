# DevSpace Portable 1.1.59 dev76 验证记录

## 现场故障

dev75 已部署并实际产生 `synthetic-execution-v3`，但随后一次人工消息开始后，用户等待数分钟仍没有出现新的自动续轮。D-live SQLite 还原显示：上一条 synthetic generation 36 已在 `02:56:10.737Z` ACK 并保持 `WORK_REQUIRED`，人工 turn 于 `02:58:38.745Z` 开始、于 `03:02:50.544Z` 签署 `turn-complete`，但 generation 36 一直没有被该人工 takeover 关闭，直到下一次 Workset replacement 在 `03:07:42.011Z` 才以 `manual-new-workset` 结束。因此 `turn-complete` 期间已经存在一个权威 live synthetic generation，没有创建新的 READY。

## 根因

`recoverCanonicalConversationTaskProjection()` 可以从 conversation/workset 架构恢复兼容 `continuation_tasks` 投影。在 projection 漂移场景里，任务行可能显示 `delivery_owner=manual` 或为空，但 `continuation_generations` 中当前 active Workset 仍有 `owner_type=synthetic,state=WORK_REQUIRED`。dev75 的 manual takeover 只依据任务行 `delivery_owner` 判断是否需要撤销 synthetic ownership，因此漏掉了权威 generation ledger。

## dev76 修复

manual takeover 现在同时读取当前 conversation card 的 active Workset，并检查 generation ledger 中仍存活的 synthetic `READY/CLAIMED/DELIVERING/DELIVERED/TURN_ACKED/WORK_REQUIRED`。只要存在这样的 generation，就走既有 manual-wins 原子 fence，supersede stale synthetic generation、清除 delivery ownership，并为当前人工 turn 建立新的 lease。该逻辑不把静默、activity lease、iframe heartbeat 或历史 cutoff 当作新轮授权。

新增 ATCC production-equivalent 回归：先把 generation 人工置为 `synthetic + WORK_REQUIRED` 并写入 ACK 时间，再故意把 task projection 改成 `delivery_owner=manual`；随后 `status(manualTakeover=true)` 必须使该 generation 进入 `SUPERSEDED`，且 active Workset 中 live synthetic generation 数量必须为 0。

## 当前验证边界

E 盘源码阶段已经完成以下门槛：

- `scripts/verify-source-tree.mjs`：PASS，665 个文件检查通过，EOL mismatch=0，版本身份为 `1.1.59 dev76`。
- 核心包重新 pack、`npm ci --prefix app` 与 nested dependency hardening：PASS。
- 8 项续轮/卡片重点回归全部 exit 0：guard、architecture、wire、supervisor scheduler、ATCC、milestone-card lifecycle、portable-ui heartbeat、runtime-cards。
- native UI 构建：PASS，重新生成 `DevSpace-Portable.exe`、`Update.exe`、`DevSpace-SshAskPass.exe`；随后按现有 208 项 key-file 集合刷新 manifest 哈希。

dev76 同时收敛了 UI/sender 身份：历史 superseded milestone iframe 不再作为可变的 headless sender relay；可用 sender capability 由当前普通 Workspace App 接管，历史卡片保持惰性，避免旧卡持续刷新/重绘与当前卡争夺 UI 身份。该调整保留 server-side sender CAS、manual-wins 和 durable READY，不使用 DOM 自动化或静默超时猜测。

源码回归 PASS 仍不等于最终自动续轮 PASS。下一步是 D-live 增量部署，并真实验证 `READY -> claim -> send -> synthetic ACK -> sustained substantive work`。验收要求仍是：人工输入可随时原子抢占；未改变里程碑的 synthetic 不创建重复卡；synthetic 不能完成一个里程碑就退出，而应在同一 Host turn 内继续所有可运行里程碑；续轮时延应落在用户要求的约 1–2 分钟内，且工作持续时间接近人工“继续”。未发布 GitHub Release。
