# 细胞谱系本地编辑器（Cell Lineage Editor）

面向显微时序图像的**本地**谱系审校工具。外部分割/跟踪程序已经为每一帧输出了轮廓 ID、中心、面积与简化边界，并在拥挤、分裂、短暂消失等场景给出多个候选链接；本工具不处理像素分割，只负责把这些证据组织成**可追溯的谱系**：帧间链接、母女（分裂）关系、合并、暂时遮挡、人工否定，以及带版本的并行假设。

技术栈：Node.js（Express，挂载在 Vite 中间件上，单端口）+ Vite + TypeScript + 原生 SVG/Canvas 前端 + SQLite（Node 内置 `node:sqlite`，无需原生编译）。

## 安装与演示

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm test -- --run && corepack pnpm dev -- --host 127.0.0.1 --port 5335 --strictPort
```

打开 <http://127.0.0.1:5335>。

首次启动会自动把 `fixtures/demo-t0.json` 播种到 `data/lineage.sqlite`（WAL 模式），并创建一条已发布的“已审核主谱系”和一条待确认的“竞争假设”。设置环境变量 `LINEAGE_NO_SEED=1` 可关闭自动播种；`LINEAGE_DB=/path/to.sqlite` 可指定数据库位置。

重新导入同一文件（或 `fixtures/demo-t1-rerun.json`）可观察幂等行为：轮廓按内容哈希去重，候选按 `(runId, extKey)` 只追加。

## 界面

- **帧带**：每帧一个卡片，列出该帧轮廓（外部位 ID、面积）；已在图中的轮廓有绿色标记。
- **谱系图（SVG）**：每帧一列，轮廓为节点；绿线=延续，紫线=分裂，橙线=合并，青色虚线=遮挡区间。点击节点进行连接。
- **候选面板**：按相关轮廓筛选外部候选，显示分数、运行 ID、起止帧与完整 `raw` 原始证据；可“采纳为边”或“人工否定”，可展开 provenance。
- **左栏**：假设列表（可并行保留多条谱系）、工具模式、实时不变量检查结果。
- **轮廓预览（Canvas）**：绘制选中轮廓及其邻居的简化多边形边界。

### 交互

- **连接 / 断开**：依次点击两个轮廓建立 `continuation`；再次点击同一条边即断开。自动替换目标轮廓上的旧入边以维持“单前驱”。
- **确认分裂**：依次点母细胞与两个更晚帧的子细胞，母细胞原有出边被替换为恰好两条 `division` 边（母细胞不再继续）。
- **标记合并**：按顺序点 ≥2 个母轮廓，再点一个更晚帧的子轮廓，生成显式 `merge` 边。
- **遮挡区间**：在连接模式下选好进入前/重新出现的两个轮廓后点“用选中的两个轮廓标记遮挡”，帧窗口由两端轮廓帧自动推导。
- **人工否定**：在候选面板否定某候选；否定会阻止同形态边出现在已发布图中。
- **保存草稿 / 发布版本**：保存是乐观锁（带 `rev`）；发布会做不变量检查并原子地写入新版本。

## 谱系规则（图不变量）

检查器位于 `src/shared/graph.ts`，前端实时校验、后端发布前强制校验。

### 分裂（division）

- 一个轮廓在**单个已发布假设**中最多有一个前驱；分裂产生的子细胞的唯一前驱就是该 `division` 边。
- 分裂必须**恰好有两个子细胞**。
- 母细胞一旦标记分裂，就不能在下一帧既继续（`continuation`）又已分裂——报 `DIVISION_PARENT_CONTINUES`。
- 未确认的一对多报 `MULTI_CHILD_NON_DIVISION`。

### 合并（merge）

- 多对一只有在显式标记为 `merge` 时合法，且至少有两条入边。
- 未标记合并的多个前驱报 `MULTI_PARENT`；单独一条 merge 边或 merge 与普通入边混报 `MERGE_WITHOUT_MARK`。

### 遮挡（occlusion）

- 遮挡允许一条轨迹在**有限帧数**内没有轮廓：默认上限 `maxGapFrames = 3`（数据集级配置）。
- 普通边跨越的空帧数超过上限而没有遮挡窗口，报 `FRAME_GAP_TOO_LARGE`（防止虚构的跨帧长链）。
- 遮挡窗口必须：挂在一条 `continuation` 边上；`gapStartFrame = 进入轮廓帧 + 1`、`gapEndFrame = 复出轮廓帧 - 1`；长度不超过上限；不覆盖已有轮廓的帧。违例分别报 `OCCLUSION_WITHOUT_EDGE / OCCLUSION_MISMATCH / OCCLUSION_GAP_EXCEEDED / TIME_BACKWARDS`。
- 不允许两条轨迹在**未标记合并**时复用同一时间路径（重叠遮挡窗口且不共享端点），报 `CONTOUR_REUSE`。

### 其他

- **时间倒流**：边的目标帧必须晚于源帧（`TIME_BACKWARDS`）。
- **环**：DFS 检测，异常数据也无法形成环（`CYCLE`）。
- **人工否定冲突**：边命中同形态否定报 `NEGATED_EDGE`。
- **缺失轮廓 / 数据集错配**：`MISSING_CONTOUR` 等。

## 数据模型与溯源

SQLite 表（`src/server/db.ts`）：

- `dataset`：名称、帧数、导入来源、**内容哈希**（唯一）。
- `contour`：帧、`external_id`、中心、面积、边界 JSON、原始 `meta`；`(dataset_id, external_id)` 唯一。工具保存原始轮廓，不做分割。
- `candidate`：外部候选，`(dataset_id, run_id, ext_key)` 唯一，保留 `raw` 与 `run_id`。**追加表**：自动重跑只新增候选，不覆盖任何已审核证据。
- `hypothesis` / `version` / `draft`：假设头、不可变版本（整图 JSON 快照 + `base_version_id`）、工作草稿（`rev` 乐观锁）。

幂等导入（`src/server/repo-datasets.ts`）：哈希只对名称/帧数/来源/轮廓计算（不含候选），因此同一份分割重复导入返回同一数据集；候选去重后追加。

### 发布是单个事务

`commitVersion`（`src/server/repo-hypotheses.ts`）在一个 `BEGIN IMMEDIATE … COMMIT` 中完成三件事：插入新版本行、把 `hypothesis.current_version_id` 指向新图、把草稿基线重绑到新版本。WAL 单事务保证崩溃时不会出现“谱系边已更新而版本头仍指向旧图”的中间状态（见 `is crash-atomic…` 测试，提交后关闭并重开数据库校验）。

有不变量违例的图不能发布（HTTP 422，且在事务开启前就拒绝）。

## 并发编辑与版本冲突

- 草稿保存带乐观锁 `rev`：后一次保存若基于过期 `rev` 会被拒绝（HTTP 409），**不会静默吃掉先前的链接**。
- 发布时若基线之后又有新版本，会做三路合并（`src/shared/merge.ts`）：互不相交的改动自动合并；同一轮廓/弧上的竞争编辑、“我方边 vs 对方新否定”、以及合并后产生的不变量违例都会报为冲突。
- 冲突接口返回**最小受影响子图**：由冲突引用的轮廓/边/遮挡/否定向外扩展一跳。
- 冲突页允许派生两种解：
  - **变基（rebase）**：无剩余冲突时，把自动合并结果发布到**同一假设**；
  - **并行假设（fork）**：从当前头派生一条**新的假设分支**，把“我的谱系”发布在分支上，两条竞争谱系都保留（`hypothesis.parent_id` 记录派生关系）。

## HTTP API（节选）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/datasets/import` | 幂等导入；返回 `created / insertedCandidates / skippedCandidates` |
| `GET` | `/api/datasets/:id` | 数据集 + 全部轮廓 + 全部候选（含 raw 来源） |
| `POST` | `/api/datasets/:id/hypotheses` | 新建假设（自动创建空草稿） |
| `GET/PUT` | `/api/hypotheses/:hid/draft` | 读取 / 乐观锁保存草稿（`expectedRev`） |
| `POST` | `/api/hypotheses/:hid/check` | 只校验不变量，不写入 |
| `POST` | `/api/hypotheses/:hid/publish` | 事务发布；冲突返回 409 + 三路合并结果 |
| `POST` | `/api/hypotheses/:hid/conflict-preview` | 计算冲突与最小受影响子图 |
| `POST` | `/api/hypotheses/:hid/resolve` | `mode: rebase | fork` 派生两种解 |
| `GET` | `/api/hypotheses/:hid/versions` · `/head` | 版本历史 / 当前已发布图 |

## 目录

```
src/shared/      类型、图不变量、三路合并、ID/哈希（前后端共用）
src/server/      SQLite schema、导入/假设仓储、Express API、播种
src/ui/          Vite 界面（帧带、谱系 SVG、候选面板、冲突/导入对话框）
fixtures/        demo-t0.json、demo-t1-rerun.json（小型时序夹具）
test/            Vitest：不变量 / 幂等导入 / 发布原子性 / 并发冲突 / HTTP
```

## 常用脚本

```bash
corepack pnpm test -- --run     # 单跑测试（也可 node_modules/.bin/vitest run）
corepack pnpm dev               # 开发服务器（端口 5335）
corepack pnpm build             # 生产构建到 dist/
corepack pnpm typecheck         # tsc --noEmit
```
