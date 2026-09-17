# V2 动态 Region 修复验证

2026-09-17；基线 `11b6ecb80ba8cd43ec84f8b1eab7ec2ab336a8de`（开始执行时已 fetch 并与 origin/main 核对）。macOS，Chrome 152，Node 24.19.0。

全部使用确定性本地 fixture，不访问 CSDN 或外部验收站点。Chrome 使用独立临时 profile／下载目录，通过正式 manifest、真实 activeTab 授权、captureVisibleTab、offscreen 和 downloads API 完成截图。测试产物不提交；变更仅位于 `long-page-screenshot-v2/`，V0.1 和其它扩展未修改。

## 根因与修复边界

旧 Region 同时存在两个问题：把全局 document width/height 当作不变量，以及在 prepare 改变布局后继续使用选择时的绝对矩形。前者误拒绝无关 banner／底部模块变化；后者可能输出完整尺寸却只覆盖原内容的一部分。

两角点选现保存运行时 Element 引用、局部 offset 和初始坐标；隐藏扩展 UI 后命中真实 DOM。prepare 生效后解析最终 Region，每帧重新解析锚点并校验局部节点身份、相对几何、直接文本、图片来源。正文整体平移时，实际视口映射回本次画布坐标系。截图调用过程中发生平移则丢弃未提交帧，最多重采两次。

局部 scope 实质变化会销毁临时画布并重试整个 Attempt 一次，再次变化明确失败。锚点删除／替换或不可见时要求重新选择；viewport／zoom 变化仍拒绝。全局尺寸变化本身不终止 Region，Full Page 保留原有全局尺寸保护。数字编辑清除两角锚点，使用 coordinate fallback；只点选一角也属于固定数字边界。

## 动态 fixture 与内容身份验收

文件：`long-page-screenshot-v2/tests/fixtures/test-dynamic-region-page.html`。

上方 `dynamic-banner-zone` 每 600 ms 替换 banner child，并在 120／220／40 px 间循环；稳定 `target-article` 包含五个固定 canvas 段：TOP_MARKER、CHECKPOINT_1/2/3、BOTTOM_MARKER。底部区独立增长，也测试选区外宽度变化。全部文字与逐行 RGB 编码由本地脚本绘制，不依赖网络资源。

测试通过实际两角 UI 选取 499×2399 CSS px 内容。开始点选前保存五段参考像素；成功输出解码后，**每一行的全部 RGBA 像素**与原始参考比较，包括 marker 文字、两侧、各拼接缝和尾部。不以 `complete`、尺寸或某个绝对 Y 代替内容身份验证。

| 场景 | 验收 |
| --- | --- |
| 点选后、开始前 banner 改高 | 单 PNG 与原始参考逐像素一致 |
| prepare 隐藏 fixed 元素引起 CSS 布局移动 | 最终 Region 在 prepare 后解析；PNG 一致，结束后样式恢复 |
| capturing 后启动持续 banner 插入／删除／改高 | 连续完成，各段与原始参考一致 |
| 选区外底部持续增长及变宽 | Region 成功，内容身份一致 |
| 在 captureVisibleTab 调用中注入平移 | 未提交帧重采一次，整图不重启，PNG 一致 |
| 正文内部节点一次替换（内容像素相同） | 检出 DOM 身份变化，丢弃画布并重启一次，PNG 一致 |
| 已提交首帧后删除底部锚点 | 明确失败、零 PNG、清理 offscreen、恢复滚动 |
| 点选后编辑数字，再改变 banner | 清除锚点；输出保持原 document 坐标，首部是新的 banner，证明 fallback 语义 |
| 截图前删除顶部锚点 | 明确提示锚点失效、零 PNG |
| 正文内部每 150 ms 改高 | 最多一次 Attempt 重试后以所选内容持续变化失败，零 PNG |
| 点选后改变 Chrome zoom | 以视口／缩放变化失败 |

## 完整回归矩阵

- **Node 25/25**：几何、横纵块、fractional scale／DPR、画布预算、五档输出、offscreen 解码／编码失败及串行清理、过期消息、background ready 恢复；新增 Region 全局尺寸容忍／局部 scope 拒绝和刚性平移后的视口换算测试。
- **基础 Chrome**：1500×10337 Full Page 单 PNG 逐行验证，实际跨屏两角点选，125% zoom、模拟 DPR 与 native bitmap 差异，取消／并发／stale message，lazy 高度 1800→2800，worker 强制终止恢复、下载拒绝恢复。
- **动态 Chrome**：上表 11 个场景。
- **输出／UI Chrome**：Auto、CSS 100%、75%、50%、Device；逐像素检查进度层不进入 PNG；实际保存路径、Finder 按钮正确 download ID、页面取消／完成后关闭；26,000 px 页 Auto 单图缩小到预算，固定比例和极端高度首帧前拒绝。
- **复杂 fixture Chrome**：保留根目录现有 `tests/fixtures/test-complex-page.html`；整页含 18 张 lazy 图片、动态插入内容、最终底部，正文区域绿色边框每行连续；fixed/sticky 样式及原滚动恢复，数字坐标在全局增长后仍有效，非法越界拒绝、一次 scope 变化自动重试，live offscreen 时取消、stale cancel、一次 close 失败后新任务恢复。
- **原生 Retina 2× Chrome**：设备输出 1000×3200，Auto／CSS 输出 500×1600、75% 为 375×1200、50% 为 250×800；逐行检查与真实 downloads.show 调用。

现有 complex 测试中「任何 document 增高都应拒绝 Region」的旧断言已按新语义替换；仍保留非法边界、局部变化与恢复保护，未修改原 fixture。

## 复跑命令

```sh
node --test long-page-screenshot-v2/tests/*.test.mjs
DYNAMIC_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
node long-page-screenshot-v2/tests/browser.mjs
OUTPUT_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
COMPLEX_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
NATIVE_DPR=2 node long-page-screenshot-v2/tests/browser.mjs
```

Node 22+；集成测试需要 Playwright、pngjs 和支持扩展调试协议的 Chrome。可通过 `NODE_PATH` 指定包目录，`CHROME_EXECUTABLE` 指定浏览器。`HEADED=1` 显示测试窗口；每组打印临时产物目录。原生 2× 的 `downloads.show` 会调用系统文件定位 API。

手动复现可在仓库根目录运行 `python3 -m http.server 8000 --bind 127.0.0.1`，打开 `/long-page-screenshot-v2/tests/fixtures/test-dynamic-region-page.html`，跨屏点选正文，在页面控制台执行 `startBanners()`，再开始截图。正文五个 marker 应连续出现且无外部红色 banner／青色底部模块。`stopBanners()` 停止定时器，刷新可重置 fixture。

## 剩余限制

锚点是 DOM 元素内的像素偏移，不是文字字符位置；点击空白容器不能推断正文语义。正文重新排版可触发一次重试或明确失败。每次检查比较当前局部 scope，不能证明两个检查之间瞬间变化后恢复的绘制一致性；Canvas／视频、仅 CSS 视觉变化、Shadow DOM 内部变化也不在保证范围。原有 fixed/sticky 启发式、虚拟列表、独立滚动容器和 iframe 限制保留。

没有测量浏览器总 RSS；验证的是单画布尺寸预算及资源释放。没有自动化驱动系统原生保存对话框或检查 Finder 窗口视觉状态；实际路径和 downloads.show API 已覆盖。性能历史对比见上一基线版本的 TESTING.md，本轮不以修复前的数据声称新性能收益。
