# Region Reliability Reset 验证

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

视觉点锚定不是文字语义锚定；元素被替换仍需重选。虚拟列表、独立滚动容器、iframe、Shadow DOM 内部捕获与无限 feed 不在本轮范围。相同区域外框内的语义替换或 Canvas／视频变化无法由几何验证保证一致；不再宣称全 DOM fingerprint 能证明内容稳定。固定数字坐标不跟随内容 reflow。可观察的持续区域几何变化会失败，不输出伪成功 PNG。

未自动化系统原生保存对话框和 Finder 窗口视觉状态；验证真实下载路径及 downloads.show API。未测量浏览器总 RSS；画布预算及释放仍有回归覆盖。测试均为确定性本地 fixture，不是外网实站认证。
