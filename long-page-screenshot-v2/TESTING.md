# V2 验证记录

## 前一轮 Region Reliability Reset（历史基线）

2026-09-17，开发基线 `2677e2ce6e69e019cba7ba717cc42560c5d0d602`，已 fetch 并确认开始时本地与 origin/main 一致。仅修改 V2。Node 24.19.0，Chrome 152.0.7977.84，隔离临时 profile／下载目录；正式 manifest 未增加权限。

## 错误假设与测试重写

- CSDN 误报根因：Region 将 BEGIN 的 inner/client 宽高、DPR 一起永久冻结，把滚动条与正常文档布局变化误认为 viewport/zoom 改变。现在捕获布局建立后才创建环境基线，仅验证目标 tab、inner 宽高、真实 tab zoom 和 visual scale；scale 使用 epsilon。开始时仍不支持已启用的触控 pinch，保留明确的 CAPTURE_ENV_UNSUPPORTED 提示。client、document 尺寸及 DPR 为诊断数据。
- ChatGPT 同屏失败根因：点选后 PREPARE 改写 sticky position，再要求锚点尺寸与点选时相差不超过 1/64px。现在布局准备在点选前，Region fixed/sticky 只隐藏可见性并保留占位；提交后不再重写 position。
- `anchors.test.mjs` 将宽高增减及 0.5px resize「两次解析都必须失败」改为边缘跟随成功，新增内部点 ratio 测试；保留删除、平移及数字 fallback。
- `background.test.mjs` 将 Region DPR/client 精确相等、scope 字符串变化必须失败改为正常完成校验；保留真实环境字段、区域几何及 Full Page 严格规则。`geometry.test.mjs` 的 strict viewport 测试明确属于 Full Page。
- `dynamic.mjs` 将开始前、首帧位图期间、首帧提交后的稳定 resize 失败改为正确新尺寸及完整内容验证。无关内部节点替换不再消耗重启；重复 reflow 与锚点删除继续无 PNG。
- `complex.mjs` 去掉固定数字选区必须因外部 scope 改变重启的断言；保留越界、内容边框、恢复、取消及 offscreen 清理。

## 新运行模型与定向覆盖

首帧提交前最多三次有界采样，采用当前 coherent region。尺寸不变用 exact offset，resize 使用 crop-corner edge affinity 或 ratio。纯平移映射回本次画布坐标系，帧前／后几何移动最多重采两次。首次已建立画布后的尺寸变化先关闭 offscreen，再建立 Attempt 2；新尺寸可成为基线。Attempt 2 仍变化明确失败。

Region settle 只比较滚动与解析后的区域几何、可见图片就绪；不扫描全部 DOM，不要求 document 或 client 尺寸静止。真实 bitmap 决定 source scale。状态诊断保留 reasonCode、attempt、环境 baseline/actual/delta、anchor connected/before/current/point/mode 和区域 before/current。

| Fixture / 测试 | 验证内容 |
| --- | --- |
| dynamic region | banner 持续插删／平移、底部增长、向上平移、选区外变宽，全部参考像素一致 |
| dynamic region 容器 padding 锚点 | before/bitmap/committed 三种时机插入 300px，BOTTOM 仍完整，新增空间和尾部 padding 全行验证 |
| dynamic region repeated | Attempt 2 已提交帧后再次增高明确失败；150ms 持续 reflow 有界失败；零 PNG |
| CSDN-like | 长文章、fixed header、sticky sidebar、banner、lazy ad、外部延迟插删、overflow/scrollbar gutter、document 增高；同屏／跨屏成功 |
| CSDN-like client/DPR | 真实 overflow 改动之外，在 content 隔离世界模拟 clientWidth/clientHeight/DPR（兼容 macOS overlay scrollbar）；bitmap 保持有效，成功且诊断记录变化 |
| CSDN-like resize | 已提交帧后一次容器增高，Attempt 2 使用新区域，完整 marker／新增 300px／尾部 padding 验证 |
| CSDN-like environment | 实际窗口 innerWidth、Chrome tab zoom 变化失败；隔离世界模拟 visualScale 变化失败；断言 reasonCode、attempt、baseline/actual/delta；目标 tab 切换无 PNG |
| Chat-like | flex/grid shell、message 容器、fixed header、sticky composer；旧 position rewrite 确实使锚点宽度 500→499.5px，新策略保持尺寸 |
| Chat-like same view | 无用户滚动，两角都在当前视口，成功且所有输出像素与参考一致 |
| Chat-like cross screen | 多屏两角，TOP／三处 CHECKPOINT／BOTTOM 全部逐行逐像素一致 |
| anchor failure | 删除底部锚点后明确失败，诊断包含 connected=false、mode、原／当前 rect；清理 offscreen、恢复滚动 |

成功场景读取真实 `captureVisibleTab` → offscreen → downloads 的 PNG。动态及新增 fixture 按全部 RGBA 行比较参考 canvas，含文字、裁剪边缘、拼接缝、底部，不能仅凭 complete 或尺寸通过。外部红色 banner、青色 sidebar 不得进入 crop。没有访问或声称真实 CSDN／ChatGPT 页面通过。

## 最终完整回归

开发期间仅运行相关 Node 和 Chrome fixture 组。最终统一执行完整矩阵一次，全部退出码 0：Node **33/33**；Chrome 基础、输出/UI、动态 Region、CSDN-like、Chat-like、复杂页面、原生 Retina **七组全部通过**。

最终日志目录：`/tmp/region-reset-final-k80h1zvg/`（本机临时产物，不入库）。每组日志含各断言通过记录及临时 PNG 目录。

```sh
node --test long-page-screenshot-v2/tests/*.test.mjs
node long-page-screenshot-v2/tests/browser.mjs
OUTPUT_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
DYNAMIC_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
RELIABILITY_ONLY=csdn node long-page-screenshot-v2/tests/browser.mjs
RELIABILITY_ONLY=chat node long-page-screenshot-v2/tests/browser.mjs
COMPLEX_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
NATIVE_DPR=2 node long-page-screenshot-v2/tests/browser.mjs
```

集成需要 Playwright、pngjs 和可加载扩展的 Chrome。用 NODE_PATH 指向包目录，CHROME_EXECUTABLE 指向浏览器，HEADED=1 可显示测试窗口。测试输出临时产物位置；不提交 profile、截图或下载文件。

保留基础 Full Page 横纵块及 10337 行、125% zoom、模拟 DPR 与 native bitmap 差异、Auto/CSS/75/50/device、单 PNG、进度层不入图、实际保存路径／Finder API、取消／stale message／worker 恢复、复杂 lazy 页面及 fixed/sticky 恢复、原生 Retina 2× 检查。

## 限制

视觉点锚定不是文字语义锚定；元素被替换仍需重选。此历史基线尚不支持独立滚动容器；下方 Modern Web Reliability 已增加垂直容器 Region 支持。虚拟列表、iframe、Shadow DOM 内部捕获与无限 feed 仍不支持。相同区域外框内的语义替换或 Canvas／视频变化无法由几何验证保证一致；不再宣称全 DOM fingerprint 能证明内容稳定。固定数字坐标不跟随内容 reflow。可观察的持续区域几何变化会失败，不输出伪成功 PNG。

未自动化系统原生保存对话框和 Finder 窗口视觉状态；验证真实下载路径及 downloads.show API。未测量浏览器总 RSS；画布预算及释放仍有回归覆盖。测试均为确定性本地 fixture，不是外网实站认证。

## Modern Web Reliability — Phase A 定向验证

新增独立 `test-nested-page.html`，html/body 固定高度且 overflow:hidden，620px conversation 内有 4800px 确定性 canvas 内容。`NESTED_ONLY=1` 真实 Chrome 定向通过：同屏、4180px 跨屏（window.scrollY 始终为 0）、全部 RGBA 行包含 TOP/MIDDLE/BOTTOM、外部 header/composer 排除、成功/取消恢复、容器删除/替换无 PNG、offscreen 清理。日志产物：`screenshot-v2-test-oyIcfj` 临时目录。此阶段没有运行完整回归。

Region 支持 window 与 scrollable element CaptureTarget：两锚点最内共同可滚动祖先，无站点 selector；坐标为容器内容坐标，截图按浏览器中的容器可见 rect 加实际 bitmap 比例裁剪。数字字段对内部容器禁用，滚动捕获监听更新边框；容器尺寸变化有界重试一次，消失立即失败。已有文档坐标模式保持兼容。

## Modern Web Reliability — Phase B 定向验证

`ADAPTIVE_ONLY=1` 已在真实 Chrome 通过静态、单次追加、三次追加、插入已捕获区、重复插入、无限增长六组。成功 PNG 与整个 fixture 的参考 RGBA 每行比较，包含延迟加载图片、recommendation 及最终 bottom marker。静态 2400px 零重启；2400→3220 一次扩展；2400→4860 三次扩展且零重启；上方插入一次重启后正确；重复插入第二次失败；增长至 5680 超预算失败，均无伪成功 PNG、offscreen 残留。定向产物 `screenshot-v2-test-FPjDs7`。此前没有运行完整回归。

旧规则 `stableHeight`／任意高度变化重试与 warm 预加载路径已删除。现在基于已观察的叶元素几何和捕获区 DOM 变更区分底部追加与旧坐标失效；底部追加 EXTEND 保留像素，失效只允许一次丢弃并重启。200ms × 4 次稳定采样且可见图片就绪，底部等待上限 3 秒。增长上限 `max(initialHeight*2, initialHeight+4*viewportHeight)`、12 次扩展、1000 次 capture、15 分钟。Auto 扩展时仍维持画布预算，必要时缩放既有画布；新旧画布仅在扩展拷贝期间短暂共存。Node 补充增长量／扩展次数／缩短、canvas 扩展／stale 隔离测试。

Phase A 扩展验证 `screenshot-v2-test-KW1Ujd`：容器高度 620→500px 后一次重启、全行像素正确；真实关闭 service worker 后，原始 element/window scroll 恢复且 offscreen 清空。目标检测 Node 覆盖最内共同祖先、window fallback、border/local mapping、原始滚动记录和 detached target。

## Modern Web Reliability — 最终统一回归（2026-09-17）

两个阶段定向通过后，仅运行一次完整矩阵，全部退出码 0。日志：`/tmp/modern-web-final-nilplzfg/`，Node 24.19.0、Chrome 152.0.7977.84。生产 manifest 无修改，截图仍来自真实 captureVisibleTab → offscreen → downloads。

| 组 | 结果与主要证据 |
| --- | --- |
| Node | 39/39；含目标检测/坐标、增长预算、源比例、画布扩展/stale、资源清理 |
| base | 10337 行横纵块逐行正确、125% zoom、模拟 DPR、取消/stale、lazy reflow、真实 worker 中断、下载失败恢复 |
| output | Auto/CSS/75/50/device、进度 UI 不入图、保存路径/Finder 调用、取消、26000px 自动缩小及超限拒绝 |
| dynamic | banner 平移、bitmap 时变更、resize 前/中/后、两次 reflow 失败、锚点删除与真实环境诊断 |
| csdn | 同屏/跨屏逐像素、client/DPR 非 fatal、一次 resize、window/zoom/visualScale/tab 改变失败 |
| chat | 旧聊天布局同屏/跨屏逐像素；保留 sticky 布局行为 |
| complex | 18 张 lazy 图片、定时增长、fixed/sticky 恢复、正文边框连续、取消/stale/offscreen 故障恢复 |
| nested | window.scrollY=0、element.scrollTop=4180、同屏/跨屏全像素及 TOP/MIDDLE/BOTTOM、排除 shell；resize 一次重启、取消/移除/替换、真实 worker 中断 |
| adaptive | 2400→3220 与 2400→4860（3 次扩展）全 RGBA 正确；图片/最终 marker 完整；一次重排正确重启、二次重排失败、5680px 无限增长预算失败；静态零重启 |
| retina | 原生 2× 位图 device 1000×3200；Auto/CSS/75/50 尺寸和像素检查，真实 downloads.show API |

仅修改 V2 的 runtime、README/TESTING 和 V2 tests/fixtures。没有 V0.1、SmartWebCapture 或其它扩展修改；没有新增站点 selector、权限、框架或构建系统，临时 profile/PNG/日志均未入库。

剩余边界：主目标是普通垂直内部容器；不支持虚拟列表、iframe 内滚动、任意二维嵌套滚动和无限 feed。Full Page 的几何见证/DOM 观察不是像素冻结，Canvas/视频与未观察的绘制变化仍不能保证跨帧一致性；Auto 多次扩展缩放可能降低已有内容清晰度，扩展时短暂需要双画布内存。底部稳定是有界时间判定，不承诺捕获稳定窗口之后才出现的内容。未访问真实 CSDN/ChatGPT，本报告仅证明本地确定性 fixture 与回归矩阵通过。

## Diagnostic-only Full Page trace（2026-09-17）

基线为最新 origin/main `039db09081850417764d85ebd6e503e9875536d7`。仅新增诊断、结束面板复制按钮及测试/说明；未修改截图算法、mutation 条件、0.5px threshold 或两次 attempt 策略。planner 的缩短分支只增加 `DOCUMENT_SHRANK` 错误元数据。

定向 Node **11/11**：`diagnostics.test.mjs`（6）、`adaptive.test.mjs`（2）、`background.test.mjs`（3）。覆盖 150 条 trace 上限/跨 attempt、格式化 JSON/敏感字段排除、mutation 计数及四种原因、witness moved/removed/unchanged/阈值边界；既有增长预算、重启错误语义和 worker 结束状态保持通过。

Chrome 152.0.7977.84，`DIAGNOSTICS_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs`，仅运行两个场景：

- 成功：4 帧、零重启，900×2400 PNG 全 RGBA 等于参考图；trigger=null，mutation 8/ignored 8/captured-prefix 0，验证调用 32 次。
- 两次顶部插入：attempt=2、一次重启、FULL_REFLOW/MUTATION_INVALIDATION，无 PNG；两个 attempt 的 mutation 原因及最终触发均保留，mutation 6/ignored 4/captured-prefix 2，验证调用 17 次。
- 两种结束状态都点击真实「复制诊断信息」按钮，再从 Chrome clipboard 读回并解析、与结束 status 对照；复制时没有预授予 clipboard-write 权限。末条 frameCount 与最终状态一致，offscreen 已清理。

首次运行因测试提前授予 clipboard-read 导致写入失败，改为点击成功后才授权读取用于断言，重新运行此 smoke 通过。生产 manifest/权限无修改。日志：`/tmp/full-diagnostics-smoke.log`；成功 smoke 临时产物目录：`screenshot-v2-test-bXZOvK`。未运行重型完整矩阵，也未把本地 fixture 结果当作真实 GitHub/CSDN 实站结论。


## Evidence-based Full Page — Phase A

基线 `3e990f16bdf563caf5f0ee64f7114f1b0fde09c1`。删除 mutation → invalid 分支，保留 0.5px 几何阈值及一次重启策略。pending 的采样矩形只在 offscreen FRAME 成功后按实际 tile 相交范围提升为 committed witnesses；commit 时继续比较采样前坐标，防止绘制期间变化被新基线掩盖。没有 mutation 的 CSS 布局变化也始终复核。

定向 Node 命令：`node --test long-page-screenshot-v2/tests/{diagnostics,adaptive,background}.test.mjs`。14/14 通过，含首帧前重建基线、绘制期间 shift、resized/moved/removed、dirty 计数及 150 条上限。Chrome 使用 `PROOF_ONLY=1`、`ADAPTIVE_ONLY=1`、`DIAGNOSTICS_ONLY=1` 分组；不在此阶段运行完整矩阵。

新增 `test-proof-page.html` / `proof.mjs`：GitHub-like class、style、固定图片 src、固定尺寸文字节点、absolute/fixed overlay、CSDN-like carousel（x=-525/-225/75/375）、sidebar style。成功输出逐行比较全部 RGBA（TOP、ROW、BOTTOM、seams），而非只看 complete。另验证首帧 bitmap 期间 +200px 插入不消耗 restart、提交三帧后在 500px 插入 +200px 由 witness 证实、第二次插入/删除 witness 无 PNG。原 adaptive 追加、重复追加、真实重排、无限增长预算保留；诊断复制仍由 Chrome clipboard 读回验证。


Phase A 定向实际结果：Node 14/14；Chrome proof 11/11、adaptive 6/6、diagnostics 2/2。日志 `/tmp/proof-targeted.log`、`/tmp/proof-adaptive.log`、`/tmp/proof-diagnostics.log`，均使用真实 captureVisibleTab / offscreen / downloads。初次 overlay fixture 缺少原有启发式要求的 z-index 导致固定浮层进入图片；补齐 fixture 的 overlay 样式后全行验证通过。诊断测试原先错误地把合法 tagName=ARTICLE 当作正文泄露，已改为检测实际正文标记 ARTICLE + 数字；隐私字段断言保留。

## Full Page CaptureTarget — Phase B

使用同一个 scrollableElement/selectTarget/targetView/targetPoint 和已有 scroll/crop/restoration。document 优先；否则按可见尺寸、面积和垂直内容长度选择 dominant target，排除小侧栏和显式编辑器/菜单。Full Page witness、mutation 位置、底部 quiescence 均使用目标内容坐标；外部 lazy image 不阻塞内部容器捕获。

复用真正的 `test-nested-page.html`（html/body overflow:hidden，620px conversation，4800px 内容），新增 `FULL_NESTED_ONLY=1` / `full-nested.mjs`。原始 scrollTop=317；static、首帧 resize、tail growth 4800→5280、提交后 resize、一次插入重启均逐行验证完整 500px 宽 PNG、TOP/MIDDLE/BOTTOM 和所有 seams。第二次插入、cancel、target remove/replace 均无 PNG；真实 service worker 关闭后恢复滚动并清理 offscreen。硬断言所有滚动记录 window.scrollY=0、conversation 到达底部、结束恢复 317；所有外部 shell 像素均排除。已有 NESTED_ONLY Region 同屏/跨屏/resize/取消/删除/替换/worker 恢复定向全部通过。

Node 目标检测补充 document 优先、dominant fallback、sidebars、horizontal-only、不可见及 editor/menu 排除；proof 与 background 针对性合计 16/16 通过。此阶段不运行完整矩阵。


Phase B 最终定向：Full Page nested 10/10，通过首帧容器 resize 不消耗 restart、已提交后 resize 一次重启、tail growth、真实双次 reflow 和所有恢复路径。日志 `/tmp/full-nested-targeted.log`、`/tmp/region-nested-targeted.log`。共享代码复核后再次运行 proof 12/12，新增首帧前未提交尾部缩短直接采用新高度；已提交之后的终点缩短仍走原有有界重建策略，但独立标记 `FULL_EXTENT_SHRANK`，不再冒充 witness 已证实的 FULL_REFLOW。相关 Node 18/18。两个阶段未各自运行完整回归。


## Evidence-based Proof + Full Page CaptureTarget — 最终统一回归（2026-09-18）

完成两个连续阶段后只运行一轮完整矩阵，全部退出码 0。Node 24.19.0、Chrome 152.0.7977.84。日志与机器可读结果：`/tmp/full-proof-target-final-jkd1w7m7/`（`results.json`）；所有 profile/PNG/日志均在临时目录，未入库。

| 组 | 最终结果 |
| --- | --- |
| Node | **50/50** |
| base | 完整 10337 行横纵拼接、125% zoom、模拟 DPR、cancel/stale、lazy growth、真实 worker 恢复、下载失败清理 |
| output/UI | Auto/CSS/75/50/device、真实文件路径/show、面板不入图、取消、26000px 自动缩小和超限预检 |
| dynamic Region | 原有平移、bitmap 期间变化、首帧及提交后 resize、二次 reflow/锚点删除失败、环境诊断 |
| CSDN-like Region | 同屏/跨屏、client/DPR、resize、真实窗口/zoom/visualScale/tab 改变 |
| Chat-like Region | 同屏与跨屏逐像素、TOP/middle/BOTTOM、原 sticky 布局保留 |
| complex | lazy 图片、增长、正文连续、fixed/sticky 恢复、取消/stale/offscreen 故障清理 |
| Region nested | 7 个场景；同屏/跨屏/resize、cancel/remove/replace、真实 worker 中断 |
| Full Page adaptive | 6 个场景；static、once、multiple、reflow、repeated、infinite，全行验证或明确无 PNG |
| Full Page proof | **12/12**；7 类 harmless mutation、首帧 rebase/尾部缩短、+200px committed shift、重复 shift、删除 witness；全 RGBA 和 committedEnd 断言 |
| Full Page nested | **10/10**；static、首帧 resize、tail growth、提交后 resize、一次/两次 reflow、cancel/remove/replace、真实 worker 中断 |
| diagnostics | **2/2**；成功/失败点击复制并读回 clipboard，counter/trace/隐私断言 |
| Retina | 原生 2× device 及 Auto/CSS/75/50、真实 downloads.show |

合计 **12 个 Chrome 分组全部通过**，没有重跑完整矩阵。最后仅更新说明及测试结果。变更仅限 V2；没有生产 manifest/权限、其它扩展、框架或站点适配器修改。

真实 GitHub/CSDN 的旧诊断只证明 mutation 命中，不证明 committed 坐标失效；本轮通过确定性 fixture 验证修正，不声称已重测用户登录态的外网网站。保留虚拟列表、iframe inner scroll、任意二维 nested、无限 feed、Shadow DOM 深层捕获限制；same-box 语义/Canvas/video 变化不是几何证明可保证的像素冻结。全绝对定位内容及多栏同等大滚动目标仍是启发式边界；必要时使用 Region 手选。终点缩短保留有界重建，独立 reasonCode 为 FULL_EXTENT_SHRANK。

## Full Page Visual Continuity（2026-09-18）

开发基线为最新 `origin/main` `20c7fc6b4f7c18cf27f568167096589b22dc5e50`。本节取代历史记录中 Full Page witness → FULL_REFLOW／整页重启的预期；Region 的原有预期保持不变。

Matcher 独立测试覆盖精确位移、−45/−80/+20/+96 修正、sidebar/ad/双侧动态区域、无关内容、重复纹理、低信息拒绝、截断条带，以及不同彩色渐变的灰度别名。开发中先跑 matcher，再跑 visual/static/adaptive/nested/proof/diagnostics 定向组，没有中途反复运行完整矩阵。

`VISUAL_ONLY=1` 使用真实 captureVisibleTab → offscreen → downloads：

- static：900×3200，全部 RGBA 与独立参考图逐行一致，全部视觉修正为 0。
- GitHub-like：滚动后 extent +45、普通流 witness +45；matcher 修正 −45，不重启，PNG 仍为原始内容高度；稳定内容 TOP/MIDDLE/BOTTOM、所有行及 seams 与参考一致。
- CSDN-like：正常流 ASIDE 子树（SPAN/IMG）移动约 20.617px、extent 不变，左侧 20% 画面改变；共识排除少数 tiles，稳定文章区域逐像素完整。
- ad：左侧约 27% 完全改变；islands：两侧各约 11% 改变，稳定中央内容逐像素一致。
- global：整体下移 80px，高置信度修正 −80；全图像素与原始参考一致，不追加空白尾带。
- transient：第二次 capture 改变画面、第三次恢复；第一次被拒绝的位图不进入画布，重采后输出逐像素正确。
- unrelated／ambiguous／low：每例两次重试后 `VISUAL_CONTINUITY_FAILED`，无 PNG、无 offscreen 残留、恢复滚动；纯白 tiles 不计入有效共识，重复纹理不能依赖预计坐标猜测。

`FULL_NESTED_ONLY=1` 增加目标内容 +45px 的视觉恢复，并保留 window.scrollY 始终为 0、目标滚动恢复 317、完整像素及 shell 排除、增长／resize／target 删除替换／worker 中断验证。

旧测试语义调整有明确原因：

- adaptive 的 +400px、nested 的 +480px、proof 的 +200px 与连续两次大插入超出 ±96px 模型，改为有界视觉失败，不再等待 Attempt 2。小位移的成功由新的 +45/+80 fixture 与 nested +45 fixture 覆盖。
- 已提交 witness 移除但替代 canvas 像素相同：保留 WITNESS_REMOVED 警告，视觉连续则成功；不再把 DOM 身份本身当作致命错误。
- basic 将整幅 canvas 从 1800 拉伸到 2800 CSS px 的变更会改变缩放，无法通过平移对齐：现在要求明确失败，然后对稳定后的页面重新截图成功。普通底部追加仍由 adaptive 的 once/multiple 覆盖。
- diagnostics 继续点击真实「复制诊断信息」并从 Chrome clipboard 读回，新增 visual 对象一致性验证；失败为视觉失败，trace 保留 witness 数值警告。

性能微基准：Node 24.19.0，225×431 条带（900px 宽／700px 高目标），预热 5 次后测量 20 次，快速路径中位数约 1.9ms（最大 4.7ms）、恢复路径约 3.9ms（最大 7.0ms）；这是纯 matcher，不包含 capture、decode、canvas 和浏览器总开销。该条带占 678,825 字节；上限 384×576×7 = 1,548,288 字节。匹配需当前条带及临时采样画布；不保存全帧历史。未测量 Chrome 总 RSS。

### 最终回归与修复补验

Node 24.19.0、Chrome 152.0.7977.84。只运行了一轮完整矩阵（Node + 13 个 Chrome 分组），原始日志与 `results.json` 位于本机临时目录 `visual-final-5bx2jrgd`。没有再次运行整套矩阵。

完整轮发现并定向修复了两处实现边界及一处新增测试设置：

1. 输出/UI：首列在恢复时后退成功，后续横向列误用了原滚动坐标。现在所有列沿用成功 band 的实际 documentY；新增独立 background 单元测试验证失败两次后的整行坐标一致。
2. complex：纵向恒定的边框不该因为横向色差而算作有效注册信息。增加平均垂直变化量 ≥0.05，并将最终恢复后退距离设为一个有界 overlap（最多 320px）。没有放宽 tile 共识／quality／margin 阈值。增加竖直边框排除单测；真实复杂页面重新验证全部通过。
3. 新增 Retina Full Page fixture 只设 canvas 高度，CSS auto width 随纵横比缩小；明确设置 1500px 宽度后，CSS/device 两种 Full Page 均通过。原有 Retina Region 项在完整轮已通过。

| 分组 | 最终证据 |
| --- | --- |
| Node | 完整轮 64/64；新增横向恢复、纵向无信息边框两个边界单测及 background/offscreen 定向验证全部通过（总计 66 个独立测试） |
| Chrome basic | 10337 行横纵像素、单 PNG、Region 选区、125% zoom、模拟 DPR、cancel/stale、全局缩放失败后稳定重采、worker 中断、下载失败恢复 |
| output/UI | Auto/CSS/75/50/device、面板/路径/show、取消、26000px Auto→16384px、超限预检；修复后定向组全部通过 |
| dynamic Region | 平移、一次 resize、两次 reflow 失败、锚点丢失、环境诊断 |
| nested Region | 同屏/跨屏完整像素、window 不动、resize、cancel/remove/replace、worker 恢复 |
| CSDN-like Region | 同屏/跨屏、client/DPR 非致命变化、resize、窗口/zoom/visualScale/tab 环境失败 |
| Chat-like Region | 同屏/跨屏完整像素与 marker、sticky 布局保持 |
| complex | 18 lazy images、定时增长、底部、fixed/sticky 恢复、Region 边框连续、数字范围、cancel/stale/export/offscreen 故障；修复后全部通过 |
| Full Page adaptive | 6 场景：static、once、multiple、两类超范围插入有界失败、infinite growth 保护 |
| Full Page proof | 12 场景：harmless mutations、首帧 rebase/shrink、大位移失败、witness 移除但视觉连续成功 |
| Full Page nested | 11 场景：完整像素/目标恢复、增长、resize、+45px 视觉修正、大位移失败、cancel/remove/replace/worker |
| Visual continuity | 10 场景：static、GitHub +45、CSDN sidebar、ad、islands、global +80、transient retry、unrelated、ambiguous、low-information；成功图逐行比较稳定区域，失败无 PNG |
| diagnostics | 2 场景：成功/失败，真实 clipboard 读回，visual 与 fullProof 内容一致、隐私与清理断言 |
| Retina | 原生 2× Region 各输出模式及 downloads.show；新增 Full Page CSS 1500×1800、device 3000×3600，视觉检查通过 |

定向修复日志：`/tmp/visual-target-complex.log`、`/tmp/visual-target-output.log`、`/tmp/visual-target-retina.log`。最终视觉 fixture 复验：`/tmp/visual-final-fixtures.log`，低信息场景为大面积白色加一条窄纹理，确认不足 3 个有效 tiles 时拒绝而非利用白色猜测。瞬时变化 fixture 在注入绘制变更后等待两次 requestAnimationFrame，确保 captureVisibleTab 真正取得变更画面，避免把 compositor 尚未刷新的旧帧误当作一次重试。资源审查另外释放调用者对首帧 data URL 的多余引用，并直接复制 RGB 通道避免逐像素临时 typed-array view。

变更仅限以下 19 个 V2 文件；没有修改生产 manifest、权限或其它扩展，没有提交临时 profile、PNG、debug dump：

- Runtime：`background.js`、`content.js`、`offscreen.js`、`capture/planner.js`、`capture/visual.js`。
- Tests：`tests/adaptive.mjs`、`tests/adaptive.test.mjs`、`tests/background.test.mjs`、`tests/browser.mjs`、`tests/diagnostics.mjs`、`tests/diagnostics.test.mjs`、`tests/full-nested.mjs`、`tests/offscreen.test.mjs`、`tests/proof.mjs`、`tests/visual.mjs`、`tests/visual.test.mjs`、`tests/fixtures/test-visual-page.html`。
- Documentation：`README.md`、`TESTING.md`。

剩余限制以 README 的 Visual Continuity 一节为准：有界 1D 整数 CSS 注册、低信息/重复内容/大范围变化安全失败；不追溯更新已捕获前缀，不保证动态 outlier 自身时序一致；宽页面以首列注册每个 band；不支持虚拟列表、iframe 内独立滚动或任意二维变形。没有重测真实登录态 GitHub/CSDN，也没有测量浏览器总 RSS。
