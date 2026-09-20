# Long Page Screenshot V2

无构建步骤、无运行时依赖的 Manifest V3 长截图扩展。图像全部在本机处理。V2 独立于相邻的 `long-page-screenshot/`（V0.1）。

## 安装与截图

1. Chrome 116+ 打开 `chrome://extensions`，启用开发者模式，加载本目录。
2. 在普通网页点击扩展图标，选择输出尺寸，然后选择「截取整页」或「选择截图区域」。Full Page 当前只沿**垂直方向**滚动；横向保持启动截图时的实际可见位置/宽度，不主动横向滚动。
3. 区域模式点选左上角，滚动后再点选右下角，两角跟随所选 DOM 内容；也可以填写四条 CSS 坐标边界，使用固定坐标模式。
4. 弹窗关闭后，页面右下角继续显示准备、等待内容稳定、截图帧数／进度、生成图片和保存状态。可点击面板「取消」或按 Esc。
5. 完成后得到 **一张 PNG**。面板保留实际文件名、完整保存路径、像素尺寸和文件大小，直到手动关闭；点击「在 Finder 中显示」定位文件。

截图时保持目标标签页在前台，窗口大小及缩放不变。本地 HTML 需要在扩展详情开启「允许访问文件网址」。

## 输出尺寸

| 选项 | 语义 |
| --- | --- |
| 自动 · 单图优先（默认） | 在安全预算内选尽可能高的比例，上限为 CSS 100% 和实际源图比例；超长页自动缩小 |
| 网页 100% | 1 CSS 像素约等于 1 输出像素，不随 Retina 默认翻倍 |
| 75% | CSS 宽高分别乘 0.75 |
| 50% | CSS 宽高分别乘 0.5 |
| 原始设备分辨率 | 按 `captureVisibleTab` 实际位图／视口比例输出，通常文件最大 |

尺寸按最终绝对边界四舍五入。单图最多 16,000,000 像素，任一边最多 16,384 像素。固定比例超限会明确提示改用自动、更低比例或缩小区域，**不会静默输出 part 文件**。Auto 需要缩到 CSS 25% 以下时明确失败，建议缩小区域。Full Page 设备模式先按页面 DPR 做保守预算检查；Region 不用 DPR 决定源像素比例，设备模式以实际首帧位图复核尺寸；浏览器模拟 DPR 与真实位图不同的场景以实际图像决定最终输出。

## 保存位置

`LongScreenshot/时间-标题.png` 只是建议文件名。扩展不覆盖 Chrome 的“下载前询问保存位置”设置，也不假设下载一定在 `~/Downloads`。

只有 Downloads API 确认下载完成后才显示成功，路径来自该下载记录的 **`DownloadItem.filename`**。如果选择了别的目录或文件名，面板显示 Chrome 返回的实际路径。「在 Finder 中显示」调用 `chrome.downloads.show(downloadId)`。保存窗口或下载超过两分钟未完成会提示失败；尚未完成的下载会被取消。

## 速度、正确性和资源

- 普通页面单遍处理：滚到当前块，等待几何和可见图片稳定，立即截图并绘制，再前往下一块；不再无条件完整预滚动一遍。
- 整页每块至少约 480 ms、区域约 240 ms 稳定等待；区域等待比较局部几何，不等待整个 document 静止。可见图片或局部几何在 5 秒内仍不稳定就有界重试／失败。截图调用间隔至少 550 ms，遵守 Chrome 限流。
- 整页允许底部追加和有界视觉位移：相邻帧保留重叠，通过 tile 共识对齐并只写新增像素。witness 移动／变形／删除作为证据，不直接触发整页重启。Robust 在两次有界 recovery 后若仍只是 `ambiguous`／`low-information`，可显式以 `probable` placement 完成：有 ≥3 个高质量 tile 同意同一候选时优先保留该 visual correction，否则使用经过前后截图验证的 observed scroll geometry；`failed`／强矛盾仍停止。Strict 不使用该 fallback。底部每 200ms 采样，连续 4 次高度稳定且可见图片加载完才结束，单次底部等待最多 3 秒。
- Full Page 只做纵向拼接：输出宽度等于正式截图开始时 CaptureTarget 的实际可见宽度，保持当时实际 x；document/target 的更大 scrollWidth 不会触发横向遍历或失败。Region 仍可截取用户明确选择的二维矩形。所有绘制按绝对输出边界取整，避免累计接缝误差。
- 页面状态面板使用 Shadow DOM。截图前隐藏，并等待两次动画帧重绘；截图后恢复，面板不进入最终 PNG。
- 通常仅保留当前帧和一个有界画布；动态扩展时短暂保留新旧两个画布，拷贝后立即释放旧画布。Auto 扩展超出原比例预算时会下采样已有像素；逐帧释放 ImageBitmap／data URL，不累积源截图数组。画布 RGBA 预算约 61 MiB，另有源帧、编码和浏览器自身开销；这不是浏览器总 RSS 上限。
- 编码完成后释放画布，下载完成后撤销 Blob URL。成功、失败、取消均恢复原始滚动及临时改动的内联样式与优先级。
- 任务 ID 隔离过期消息；worker 重启清理旧任务并提示中断。启动时残留 offscreen 关闭失败不会永久阻塞 ready，后续新任务会再次清理。页面端另有 30 秒租约恢复机制。
- 最多 1000 次截图、15 分钟、12 次终点扩展，终点不超过初始高度两倍与初始高度加 4 屏中的较大值；持续增长会提示改用选择区域。

## Full Page：自动选择主滚动目标

Document 有超过 64px 的实际垂直范围且没有 overflow hidden/clip 时优先 window。否则在可见的 auto/scroll/overlay 容器中选择主垂直目标：滚动余量至少 128px、可见宽度至少视口 45%、高度至少 50%、面积至少 30%，再按面积、内容长度和居中情况评分。小侧栏、菜单及显式 textbox/code/editor 不作为候选；没有站点 selector。没有符合条件的容器则回退 window。

Element Full Page 复用 Region 的 CaptureTarget、targetView、scroll restoration 和 bitmap crop：从容器内容坐标 0 开始，只滚动该容器，以 captureVisibleTab 为源裁出容器视口，输出一张 PNG，不包含外部 header/sidebar/composer。目标内 fixed/sticky 处理相对于容器视口。容器高度作为 adaptive end（scrollHeight），允许有界尾部增长；几何 witness 使用容器内容坐标，正常滚动不会被判为移动。

容器移除／替换失败并清理；已提交帧后的 viewport resize 最多重启一次，首帧前 resize 先有界重建基线。成功、取消、错误和 worker 中断均恢复原始 window 及容器滚动。自动检测是启发式，多栏同等大的滚动面板可能需要改用 Region 手选。

## Region：在捕获布局上选择视觉区域

进入 Region 时先建立捕获布局，再显示选择 UI：关闭平滑滚动、scroll snap、滚动锚定，暂停 CSS 动画／过渡并隐藏 caret。对符合启发式的 fixed/sticky 覆盖层仅隐藏可见性、保留占位，不改 `position`。点选后 PREPARE 只移除选择 UI 并锁定输入，不再重写普通文档流。取消、失败、成功均恢复样式、优先级和原始滚动位置。Window Full Page 保留原有 fixed 隐藏／sticky position 处理；Element Full Page 只处理目标内部覆盖层，沿用保留占位的隐藏方式。

两角先选择最内层共同可滚动祖先（auto/scroll/overlay 且内容超过 client 尺寸），否则使用 window。内部容器使用 `clientPoint - targetViewportOrigin + targetScroll` 坐标；容器边框、可见裁剪与 bitmap 比例参与逐帧取样，只拼所选内容。选择框监听捕获阶段 scroll 事件，数字字段在内部容器模式禁用并标明坐标语义。成功、取消、失败及 worker 中断恢复 window 与已选容器滚动；容器被移除或替换立即失败，容器视口 resize 最多重启一次。

两角保存当前 document 中的 Element 引用、原矩形、局部 offset、归一化比例及四边距离。尺寸未变时使用精确 offset；resize 后，左上角靠近左／上边缘、右下角靠近右／下边缘的轴保留该边 inset（边缘带为 24px 与原轴长度 10% 的较小值），其它轴使用比例。锚点消失、隐藏、零尺寸或选区无效才拒绝解析。这是视觉点锚定，不是字符或正文语义识别。修改数字会清除锚点，回到固定 document 坐标；window 模式只点选一角也使用数字边界。

点击开始后，在捕获布局上建立环境基线：目标 tab、`innerWidth/innerHeight`、`chrome.tabs.getZoom()` 和 `visualViewport.scale`。scale 使用 `0.0001` epsilon；clientWidth/clientHeight、document 宽高和 DPR 仅记录诊断，不是 Region fatal invariant。不会拿最初 BEGIN 的页面快照永久比较。真实位图决定源像素比例，拼图仍拒绝不一致的实际 bitmap 尺寸。

开始截图前最后一次解析 anchors 后，Region 的输出宽高与 Target-local Scope 被冻结。捕获期间继续尝试解析 anchors，但只用于估计 rigid translation 并将实际帧映回 frozen Scope；不会因为两角距离变化而扩大／缩小输出。anchor 临时失效时沿用最后一次可用 runtime region（若无则 frozen region）并记录诊断，不把它当成已提交画布的致命错误。captureVisibleTab 前后的纯平移采用最接近截图时刻的 post-capture mapping，不再仅因平移丢弃帧。目标滚动位置、目标容器可见尺寸、窗口／zoom 等真正环境变化仍保留失败／重建保护。Region 尺寸比较使用 0.5 CSS px epsilon，避免亚像素 jitter。

等待仅检查当前滚动、解析后的区域几何和当前选区内可见图片，每次最多 5 秒。截图前隐藏扩展 UI，并复核位图前后几何。不再遍历整个 DOM 构建 scope 指纹，无关节点替换、广告变化或文档增长不会单独终止 Region。

状态接口及 `chrome.storage.session` 中的 `status` 保留 `reasonCode`、`attempt`、`diagnostics`：环境 baseline/actual、具体差异字段、两角 connected／原始及当前 rect／resolved point／resolver mode、区域 before/current，以及 `regionDiagnostics.anchorResolutions / anchorFallbacks / shapeChanges`、background 的 `regionRebases / regionCaptureRebases`。例：`CAPTURE_ENV_CHANGED: innerWidth 900 -> 880`。开始冻结前仍可能出现 `ANCHOR_UNRESOLVABLE`／`REGION_INVALID`；冻结后这些 anchor 事件降为 fallback 证据。不会记录 DOM 或正文文本。

Full Page diagnostics 包含 `initialHeight`、`maxObservedHeight`、`endExtensions`、`bottomStableSamples`、`fullPageRestarts`、`terminationReason`。正常结束为 `BOTTOM_QUIESCENT`，无限增长预算为 `FULL_GROWTH_LIMIT`，无法建立视觉连续性为 `VISUAL_CONTINUITY_FAILED`；不记录正文或 DOM dump。

## 已知限制

fixed/sticky 仍采用原有可见性、尺寸及位置启发式，结束后恢复。Full Page 的普通流叶元素矩形仅提供几何警告；普通中间帧最终由相邻图像的有界视觉连续性决定拼接，严格底部小尾段另见下方 terminal anchor。DOM mutation 只标记 dirty 并触发几何复核，不构建语义 DOM 或全文指纹；最多记录 20,000 个几何见证。初始普通元素在滚动后才变为 fixed/sticky 的网站仍可能重复吸顶栏。

不支持虚拟列表、无限 feed、iframe 内部独立滚动、任意二维嵌套滚动、触控捏合缩放及浏览器受限页面。不遍历 Shadow DOM 内部固定元素，不展开折叠内容。不冻结页面 JavaScript；相同外框内的语义替换、视频、Canvas 动画、仅 CSS 绘制变化、Shadow DOM 内部变化及检查间瞬间变化后恢复的内容无法保证跨帧一致性。Region 是用户确认时冻结的视觉矩形：截图中途若内部内容增删／重排，输出不会自动扩展去追踪新的语义边界，因此可能形成时间复合图或截掉后来新增的尾部内容；固定数字坐标同样不承诺跟随内容重排。锚点是帮助解析与 rebase 的视觉点，不是字符或语义位置。没有 AI、OCR、正文识别、网站适配器或编辑器。

## 开发与测试

`background.js` 协调任务；`content.js` 负责页面 UI、测量、滚动及恢复；`offscreen.js` 串行拼图；`capture/` 集中处理几何及块规划。保留内部 PART 协议，但默认流程只创建一个完整输出画布并下载一次。

```sh
node --test long-page-screenshot-v2/tests/*.test.mjs
node long-page-screenshot-v2/tests/browser.mjs
VISUAL_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
BOTTOM_TAIL_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
OUTPUT_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
DYNAMIC_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
RELIABILITY_ONLY=csdn node long-page-screenshot-v2/tests/browser.mjs
RELIABILITY_ONLY=chat node long-page-screenshot-v2/tests/browser.mjs
COMPLEX_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
NESTED_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
ADAPTIVE_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
PROOF_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
FULL_NESTED_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
DIAGNOSTICS_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
NATIVE_DPR=2 node long-page-screenshot-v2/tests/browser.mjs
```

测试需要 Node 22+，Chrome 集成另需 Playwright 和 pngjs；可通过 `NODE_PATH` 和 `CHROME_EXECUTABLE` 指定。使用临时配置及下载目录，正式 manifest 不增加主机权限；通过真实扩展 `captureVisibleTab`、offscreen 和 downloads 验证，不以自动化截图替代截图引擎。

本地复杂 fixture：`tests/fixtures/test-complex-page.html`，包含固定顶栏、sticky 侧栏、18 张延迟图片、定时增高和正文边框。新增动态 fixture：`long-page-screenshot-v2/tests/fixtures/test-dynamic-region-page.html`，以完整参考像素验证动态 banner、一次 resize 及重复 reflow。`test-csdn-like-page.html` 和 `test-chat-like-page.html` 分别复现 scrollbar／动态文章和 flex/grid 聊天布局中的两类误报。详见 [TESTING.md](TESTING.md)。

API 依据：[Tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs)、[Offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)、[Downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads)。

### Full Page 诊断

截图结束（成功或失败）后，页面状态面板可点击 **复制诊断信息**，无需 DevTools。JSON 复用结束状态，包含 attempt、metrics、高度/扩展/重启统计及 `diagnostics.fullProof`：

- `trigger`：`WITNESS_MOVED`、`WITNESS_RESIZED`、`WITNESS_REMOVED`；终点缩短更新 DOM 终点并由视觉对齐验证。没有 witness 警告时为 `null`；成功截图也可保留警告。witness 失效不再抛出 `FULL_REFLOW`，trace 记录 `visual-continuity-required`。
- `counters`：从首次 FULL_RESET 起累计跨 attempt 的 mutation 记录总数、忽略数、命中 captured prefix 数，以及 fullProof 验证调用次数；新增 `dirtyMutations`、`harmlessAfterGeometryCheck`、`witnessMoved`、`witnessResized`、`witnessRemoved`、`baselineRebasesBeforeFirstFrame`。每条 mutation 只计一次；mutations = ignoredMutations + dirtyMutations，capturedPrefixMutations 为 dirty 的子集。
- `trace`：最多保留最近 150 条，跨重启保留；每条包含 attempt、scrollY、documentHeight、viewportHeight、proofEnd／committedEnd、witnessCount 和已提交 frameCount，以及 targetKind、targetScrollY、targetHeight。记录 attempt 开始、witness 建立、mutation 命中、视觉验证请求及结束。验证失败另外包含几何 before/current/delta 和 connected。

为避免 DOM 属性包含账号或凭据，descriptor 的 `id` / `className` 使用加盐匿名标签（class 输入最多 120 字符），同一页面注入期间可关联；不导出原始值或 data-testid。不同页面报告的匿名标签不能直接对照。JSON 不包含 URL、正文、HTML、图片、下载路径、Cookie 或页面 storage；自由文本错误使用固定安全提示，详细分类以 reasonCode/trigger 为准。几何 epsilon 仍为 0.5px。Mutation 不直接宣布重排：trace 区分 mutation-observed、mutation-marked-dirty、dirty-verified-harmless 和 dirty-verified-invalid。只有 offscreen FRAME 确认成功后才推进 committedEnd；截图前 pending witnesses 不代表已提交像素。首帧前几何改变走有界重采样／基线重建并计入 baselineRebasesBeforeFirstFrame，不消耗 Attempt restart。已提交 witness 移动、resize 或消失保留数值证据并要求视觉验证，不消耗整页 restart。绝对定位、fixed/sticky UI 不作为普通流见证；它们导致的普通流内容移动仍会被复核发现。


### Full Page Visual Continuity

Popup「整页连续性」默认使用 **Robust / 智能容错**，保留原多数 tile 共识和 terminal bottom-tail 行为。用户可显式选择 **Strict / 全宽严格**：同一 matcher 的 Robust candidate 成功后，对同一 offset 追加左／中／右（tiles 0–2／3–8／9–11）检查；每个有信息分区至少 2/3 tiles 同意，无信息分区中立通过（agreementRatio 为 null）。Strict 只增加门槛，不改变搜索或放宽匹配；失败沿用最多两次恢复，最终 `VISUAL_CONTINUITY_FAILED` 且不保存 PNG。Strict 不使用 terminal bottom fallback，因此动态页面可能更容易失败。Region 不受影响。

「记住此域名」仅在 `chrome.storage.local.continuitySitePoliciesV1` 保存 lowercase exact hostname → robust/strict；不存 URL、路径、标题，不做 wildcard，也没有 GitHub/CSDN 硬编码。勾选立即保存，已勾选时切换立即更新，取消则删除；未记忆时下次恢复 Robust。保存失败只提示，不影响本次所选截图模式。

最终 diagnostics 保留 `continuityPolicy`；`diagnostics.visual` 另含 `continuityPolicy`、`strictCoverageChecks`、`strictCoverageFailures`。Strict trace 记录 `policy` 和三个 zones 的 informativeTiles、agreeingTiles、agreementRatio、pass；只统计最终返回的 matcher 检查，不含 hostname 或图像内容。

原则：证明相邻截图可可靠对齐，不证明网页从未变化。Region 的滚动、锚点、裁剪和重试流程不使用 matcher。没有 OCR、AI/ML、第三方 CV、正文识别或站点 selector。

- 重叠：`min(clientHeight - 32, clamp(clientHeight * 0.25, 160, 320))` CSS px；常规 700px 视口每次前进 525px。小视口保留至少 32px 前进空间。
- 表示：offscreen 从实际 bitmap 裁出 CaptureTarget 条带，横向约 4 CSS px 一采样，宽度最多 384；纵向保留 1 CSS px 精度。灰度用于搜索，额外紧凑 RGB 样本仅核验最佳候选，防止不同彩色渐变出现灰度别名。条带高度最多 `overlap + 2*96 + 64`，即 576 行；底部大重叠时移动当前条带采样起点。
- 搜索：12 个横向 tiles，预计位移 ±96 CSS px，每个候选使用相同的行区间；不做旋转、缩放或横向注册。稳定几何 fast path 每 tile 最多采 24 行、横向每 6 个表示像素一取样。发现 witness／extent 变化、非零修正或快速检查不通过，改为最多 64 行、横向每 2 个表示像素取样。两条路径均检查第二候选；普通中间帧不能用 geometry 绕过低信息或歧义拒绝。
- 共识：灰度标准差至少 5，采样行间的平均垂直变化至少 0.05（排除只在横向有边框、纵向恒定的 tile）；至少 3 个 informative tiles，且至少 60% 同意同一个整数 CSS 位移。最佳归一化平均绝对误差 ≤0.04，灰度及最佳候选 RGB 平均误差均 ≤0.5（0–255）。第二候选误差差距至少 `min(0.018, max(0.005, bestError * 0.5))`；近乎精确匹配允许较小差距，噪声近似匹配不能靠相邻 offset 猜测。分数为 `1/(1+error)`，confidence 为 agreementRatio × bestScore。
- canonical 坐标：首帧起点 0；后续为上一帧 canonicalY + matchedOffset。只绘制上次 committed end 之后的部分，源裁剪仍使用当前目标视口。文档高度用于滚动终点和增长保护，最终 PNG 高度按 canonical end 裁定，不加入因坐标修正产生的空白尾带。
- 失败：第一次重试在原位置重新 settle/capture；第二次后退一个有界 overlap（最多 320px），增加共享内容。两次后仍无可靠匹配则停止，不重启整个截图、不输出部分 PNG；Robust 的唯一例外是下方经过验证的 terminal bottom tail。目标丢失、导航、环境变化和无限增长保护继续生效；容器 viewport resize 仍使用原有一次重建策略。
- 横向语义：Full Page 不再遍历横向超宽内容；visual matcher 只在当前可见水平切片内部取 12 个横向 tiles 来判断**纵向**位移。需要页面其它横向区域时，先由用户把页面横向滚到希望的位置后再开始 Full Page，或使用 Region。

`diagnostics.visual` 包含 `visualChecks`、`visualFastPath`、`visualRecoveries`、`visualRecoveryRetries`、`visualFailures`、`ambiguousMatches`、`lowInformationRejects`，及最近 150 次匹配 trace（预计／实际位移、修正、搜索半径、重叠、tile 数、共识比例、两候选分数、confidence、path、result）。复制诊断包含这些安全数值，不包含像素、页面文本、HTML、URL、图片数据。

复杂度为 O(T × R × N)，T≤12、R≤193、N 为每 tile 的有界采样数，另有每 tile 的候选排序 O(R log R)。只长期保留上一帧 ≤384×576 的灰度 Float32 与 RGB Uint8 条带，约 1.48 MiB；匹配期间另有当前条带和临时 canvas/ImageData，帧后可回收。不保留全部截图；ImageBitmap 在 finally 中关闭。输出画布预算仍为 16M 像素，扩展／裁定尺寸期间短暂双画布。

边界：超过 ±96px 的真实位移、过少纹理、重复内容、显著亚像素变化或不足 60% 的一致证据可能安全失败。已经捕获区域后来新插入的内容不会追溯添加到 PNG；这是连续浏览路径的记录，不是网页最终时刻的全局快照。不会保证动态侧栏本身时序一致，也不能保证虚拟列表或大范围重绘可拼接。确定性 fixture 通过不等于已认证真实登录态 GitHub/CSDN。


### Full Page Terminal Bottom Tail

最后只能滚动几像素时，大面积 overlap 可能缺乏唯一视觉证据。保留原 matcher 的 ±96、12 tiles、至少 3 tiles、60% 共识、margin 及 RGB 验证；正常匹配始终优先。仅在 Robust 首列视觉匹配失败／ambiguous／low-information 后，才检查 terminal bottom anchor：

- CaptureTarget 当前可见底边与最终 extent 相差不超过 0.01 CSS px；window 和 element 使用同一目标坐标检查，底边在 bitmap 外的裁剪容器不能通过。
- `0 < finalExtent - canonicalCommittedEnd <= min(overlapCSS(clientHeight), 320)`，已有非空提交内容；普通中间帧和大缺口不能使用此路径。
- 调用原 bottom quiescence，连续四次 200ms 高度稳定且可见 lazy image 就绪。增长、目标移动或未提交帧重排撤销本次锚定资格，回到有界重采样和 adaptive extension。
- 稳定后重新截图；截图前后 extent 必须仍一致，截图后再检查目标位置／高度和 visible lazy image。新 bitmap 再次优先运行 matcher，仍失败才使用 anchor，不复用等待前缓存的帧。

Canonical 映射为 `canonicalY = finalExtent - viewportHeight`、`novelTop = canonicalCommittedEnd`。例如 finalExtent=6428、committedEnd=6384、viewport=912，只取当前 bitmap 中 868…912 的最后 44px，写到 canonical 6384…6428；不重写 868px overlap。最终 PNG 按已提交 canonical end 裁定。增长后的最终稳定高度参与判断，初始高度不能授权提前结束。

`diagnostics.visual` 新增 `bottomTailChecks`、`bottomTailAccepted`、`bottomTailRejected`；一次检查未使用 anchor（包括新截图已视觉匹配）计入 rejected。接受时 trace 记录 `event=bottom-tail-anchored`、`result=BOTTOM_ANCHORED_TAIL`、原 `visualResult`、finalExtent、canonicalEndBefore、remainingTail、actualTargetScrollY、maxTargetScrollY、viewportHeight 和 novelPixels。正常视觉成功不标记 fallback，任务仍以正常成功结束；原复制诊断入口保留。

GitHub 多数 tiles 确定的一维全局对齐可能让少数动态 sidebar／toolbar 留下局部 seam artifact。Robust 保留底部小尾段策略；Strict 可拒绝此类局部冲突，但不增加 per-tile 坐标、seam carving 或语义侧栏识别。底部稳定仍是有界时间观测，不保证未来不再加载；不追溯改写已提交前缀，也不保证任意动态内容的最终时刻快照。Region runtime 和 CaptureTarget detection 未改变。

## Completion-First Reset — Phase 1（Robust probable placement）

开发分支：`feature/completion-first-reset`，基线 `5c86a5962676caadbfc78819e7742c25984afc33`。

本阶段只改变 Full Page Robust 的最终 admission policy，不修改 Region、Strict、Warm-up、Multi-part、权限或 manifest。

流程仍然是 visual-first：

1. normal matcher；
2. 同位置重采；
3. 增大共享上下文的最终 recovery；
4. 最终结果若为 `matched`，沿用原 visual canonical placement；
5. 最终仍为 `ambiguous` 时：
   - 若至少 `VISUAL.minTiles` 个高质量 tiles 对同一 candidate offset 达成一致，记录 `continuity=probable / fallbackMethod=probable-visual` 并使用该 bounded correction；
   - 否则 Robust 使用 observed geometry，记录 `fallbackMethod=geometry`；
6. `low-information` 在 observed geometry coherent 时可走 geometry probable；
7. `failed`、真实 gap、target/environment/viewport/zoom 变化仍 fail closed；
8. Strict 完全保持 verified-only，不接受 Robust fallback。

Diagnostics 新增 `probablePlacements`、`geometryFallbacks`、`probableVisualCorrections`；trace 保留原 visual result，同时记录 `continuity`、`fallbackMethod`、`placementOffset`、`placementCorrection`，避免把 fallback 冒充成 verified match。

### Completion-First Reset — Phase 1.1（Bounded Warm-up + evidence diagnostics）

Full Page 在正式建立 proof/canvas 之前先做一次**有界预滚**，用于触发首轮 lazy load、sticky/layout 状态和有限尾部增长：

- 从 CaptureTarget 顶部开始，以约 0.9 viewport 步进；
- 最多 24 步、15 秒、6 次增长事件；
- 高度超过 warmup 初始高度的 2× 或 +4 viewport 中较大值时停止追增长；
- 到达物理底部且下一次 settle 不再增长时记为 `bottom-stable`；
- warmup 的普通 settle 超时是 discovery failure，不直接宣告截图失败；返回顶部后仍进入正式 capture；
- target/environment/cancel 等真正环境错误仍立即终止；
- warmup 完成后回到顶部，随后才 `FULL_RESET` 并建立正式 proof，因此 warmup 帧不会进入画布或 committed witness。

复制 diagnostics 新增安全数值 `warmup`；visual trace 新增 `qualityTiles`、`qualityRatio` 和 `failureReason`（`low-information / insufficient-consensus / insufficient-quality / width-mismatch / insufficient-overlap / strict-zone`）。本阶段仍**不**把 `insufficient-quality` 自动放行，只用于确认 GitHub/CSDN 当前的真实失败类型。

## Completion-First Reset — Phase 2（Vertical-only Full Page + Region Scope Freeze/Rebase）

### Full Page

Full Page 的 Scope 现在明确为“**当前水平切片 × 完整垂直范围**”：

- warm-up 记录启动时实际 `view.x`，整个预滚和正式 capture 只改变 y；
- 正式起点以 warm-up 返回顶部后的实际 x 为准；
- 输出 `region.x = actual view.x`，`region.width = actual clientWidth`；
- `scrollWidth` 仅作为 diagnostics，不作为输出宽度，不规划第二横向 column；
- offscreen 不再因为“未到达计划横向位置”终止；
- 页面/容器的 reported width 变化本身不再使 Full Page 失败；
- diagnostics `full.horizontal` 记录 `mode=viewport-slice / x / visibleWidth / reportedWidth`。

### Region

Region 在 preparation 后最后一次解析 anchors，并冻结 `s.region` 的目标坐标/宽高作为本次输出 Scope。capture 期间：

- anchors 若仍可解析，只提供当前平移量；实际截图 view 通过 `relativeView` 映回 frozen Scope；
- anchor separation/尺寸变化只记 `shapeChanges`，不再自动改变输出尺寸；
- anchor 临时失效时使用最后一次可用 runtime region／frozen region，记录 `anchorFallbacks`，不立即宣告失败；
- 帧与帧之间的 rigid translation 可直接 rebase；
- captureVisibleTab 前后的 region/viewportRect 平移使用 post-capture mapping 作为最近观测值并记录 `regionCaptureRebases`；
- 真正的 target/viewport/zoom/滚动位置变化仍保留环境或 FRAME_MOVED 保护；
- 尺寸比较使用 0.5 CSS px epsilon，避免亚像素 jitter 误判。
