# 细胞谱系编辑器（Pair-wise GSB Lineage Editor）

一个**本地**的显微时序细胞谱系人工审校编辑器。像素分割由其他程序完成，本工具只消费其输出的
每帧轮廓（ID、中心、面积、简化边界）和自动跟踪候选，并把人工确认的帧间链接、母女关系、
暂时遮挡与人工否定沉淀为**可追溯的版本化谱系**。

- Node.js + Express API（`server/`）
- Vite 单页编辑界面（`src/`）：帧带、谱系图、候选面板
- SQLite（better-sqlite3）持久化，WAL + 外键
- 发布 = 图不变量校验 + **单事务**版本快照
- 小型时序 fixture（`fixtures/tiny-lineage.json`，6 帧，含分裂 / 合并 / 遮挡 / 竞争候选）

## 安装与演示

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test -- --run && corepack pnpm dev -- --host 127.0.0.1 --port 5335 --strictPort
```

打开 <http://127.0.0.1:5335>。

- `pnpm test`：Vitest 单元 / API 测试（纯不变量、幂等导入、原子发布、并发冲突）。
- `pnpm test:e2e`：Playwright 浏览器端到端测试（界面编辑、遮挡、冲突分叉）。
- SQLite 文件默认在 `data/lineage.sqlite`；可用 `LINEAGE_DB_PATH=/path/to.sqlite` 覆盖。
- 首次启动会幂等导入 `fixtures/tiny-lineage.json`，并发布一条基线假设与一条并行竞争假设。

## 数据模型

| 表 | 作用 |
| --- | --- |
| `datasets` | 数据集（键 = 稳定 `dataset_hash`），完整原始导入 JSON 存在 `raw_payload` |
| `contours` | 每帧轮廓：中心、面积、简化边界、来源、**完整原始记录 `raw_json`** |
| `candidates` | 外部自动跟踪候选（continuation/division/merge、分数、来源、原始记录） |
| `reviewed_evidence` | 人工接受 / 否定的审校证据，与候选软关联，**自动重跑不会覆盖** |
| `hypotheses` | 并行假设；`parent_id` 记录派生来源（可从任意版本 fork） |
| `versions` | 版本头：`seq`、`parent_version`、`base_version`、计数、说明 |
| `hypothesis_heads` | 每个假设当前指向的版本（与版本行在同一事务里移动） |
| `version_edges` / `version_occlusions` | **每个版本的完整快照**，历史永不就地修改 |
| `publish_log` | 成功发布的追加审计日志 |

### 导入幂等（以数据集哈希为键）

- `POST /api/datasets/import` 以 `dataset_hash` 为身份；同哈希重复导入返回 `already_existed`。
- 轮廓只在首次导入时写入；候选按外部 `id`（或 `from->to:kind:source` 派生键）去重，
  **自动重跑只会 `INSERT OR IGNORE` 新增候选**，绝不删除或改动旧候选。
- 已审核证据（`reviewed_evidence`）独立于候选表与假设快照，导入流程完全不触碰它。
- 数据集哈希代表“这份影像/轮廓”的身份，不应随候选批次变化；fixture 显式提供 `dataset_hash`。

## 谱系规则（图不变量）

校验代码在 `server/graph.js`（纯函数，无框架依赖），浏览器端原样复用同一份实现。
发布前前端即时检查，发布时服务端以数据库中的帧信息**再次强制检查**。

- **唯一前驱（单个已发布假设内）**：每个轮廓至多一个入边；两条轨迹不得在未标记 merge 时复用同一轮廓。
- **分裂（division）**：母细胞必须有且仅有两条 `division` 出边（两个女儿）。
  分裂后的母细胞**不能在下一帧既继续又已终止**——同时存在 division 与 continuation 出边即
  `MOTHER_CONTINUES_AFTER_DIVISION`，服务端拒绝发布。
- **一对多非分裂**：同一轮廓两条非 division 出边 → `NON_DIVISION_FAN_OUT`。
- **合并（merge）**：一个子细胞必须恰好有两条 `merge` 入边（两个父细胞）。
- **多对一非合并**：同一轮廓两条非 merge 入边 → `NON_MERGE_FAN_IN`；混合类型 → `MIXED_FAN_IN`。
- **时间方向**：每条边的目标帧必须严格晚于源帧，否则 `TIME_REVERSAL`。
- **环**：有向图不允许成环（`CYCLE`），即使外部帧数据缺失也会检测。
- **跨帧虚构链接**：
  - 相邻帧（gap=1）可直接 continuation。
  - gap>1 的链接必须同时满足：标记 `occluded`、被一个**遮挡区间**覆盖、且未超过
    `maxOcclusionGap`（默认 3 帧，可用 `MAX_OCCLUSION_GAP` 环境变量调整），
    否则报 `GAP_NOT_FLAGGED` / `GAP_WITHOUT_OCCLUSION` / `GAP_TOO_LARGE`。
- **遮挡区间（occlusion）**：许可一条轨迹在限定帧数内没有轮廓。区间锚定在遮挡前的最后一个轮廓
  （`occl_uid`），必须从该轮廓的下一帧开始（`frame_start = anchor+1`），长度不得超过上限。
  遮挡是轨迹自身“缺席”的许可，**不**允许两条轨迹借遮挡复用同一个轮廓（仍受唯一前驱约束）。

非法图永远不能发布；422 响应会带 `errors` 与**最小受影响子图**（`affected`）。

## 版本、并发与冲突

- 每次手工改动都只进入本地待发布编辑；点“发布新版本”才产生一个不可变版本。
- 发布体携带客户端所基于的 `base_version`（乐观并发）。
  服务端比较当前 head：`head != base` 即判定过期。
- **单事务原子性**：`version_edges`、`version_occlusions`、`versions` 头与 `hypothesis_heads`
  指针在同一个 better-sqlite3 事务里提交。崩溃时整笔回滚——不会出现“谱系边已更新而版本头
  仍指向旧图”的中间状态（见 `test/db.test.js` 的事务中断用例）。
- 过期保存（默认 `mode: 'strict'`）返回 **409**，绝不会静默覆盖后一次保存先写入的链接。
  冲突页显示：
  - `minimal_subgraph`：服务器当前版本中与冲突轮廓相邻的最小子图；
  - `incoming`：你本次改动涉及的最小子图；
  - 历史版本链。
- 两种派生解：
  - **rebase**：把你的编辑在最新 head 上重放后重新校验、发布为新版本（`rebased_from` 标明基线）。
  - **fork**：从最新 head 派生一条**新假设**，让两条竞争谱系作为并行假设同时保留。

## HTTP 接口（摘要）

- `GET  /api/datasets` / `GET /api/datasets/:hash`（含候选、证据、假设）
- `POST /api/datasets/import`（幂等）
- `GET  /api/contours/:hash/:uid/raw`（完整原始轮廓记录）
- `POST /api/datasets/:hash/evidence`（accepted/rejected）
- `POST /api/datasets/:hash/hypotheses`、`GET /api/hypotheses/:id`、`.../snapshot`
- `POST /api/hypotheses/:id/fork`（从指定版本派生并行假设）
- `POST /api/hypotheses/:id/publish`（`{base_version, edits, note, mode: strict|rebase|fork}`）
- `GET  /api/versions/:versionId`（版本审计）

编辑操作：`upsertEdge` / `deleteEdge` / `addOcclusion` / `updateOcclusion` / `deleteOcclusion`。

## 界面用法

1. 在顶部选择数据集与假设；中部谱系图按帧列布局，蓝=延续、紫=分裂、黄=合并，虚线=遮挡跨帧，灰色虚线=尚未采纳的外部候选。
2. 工具栏：选择、→ 连接、⤵ 分裂（母+两个女儿，点 3 下）、⇢ 合并（两个父+子，点 3 下）、👁 遮挡（点遮挡前轮廓与重现后轮廓，自动生成区间与跨帧边）、✂ 断开。
3. 右侧检查器展示轮廓 / 边 / 候选的完整来源与原始 JSON；右下方可逐项撤销待发布改动。
4. 左侧候选面板可 ✓ 接受（同时加入待发布边）或 ✕ 人工否定；“模拟重跑”会追加一条新外部候选，演示自动重跑只增不改。
5. 底部状态栏实时显示图不变量结果；发布时服务端二次校验，违规或冲突会弹窗展示最小子图并给出 rebase / fork。

## 目录

```
server/      Express API、SQLite 持久化、纯图不变量、fixture 播种
src/         Vite 前端（状态、布局、渲染、面板、冲突弹窗）
fixtures/    tiny-lineage.json 时序样例
test/        Vitest 单元/API 测试；test/e2e 为 Playwright 用例
data/        运行时 SQLite（已 gitignore）
```
