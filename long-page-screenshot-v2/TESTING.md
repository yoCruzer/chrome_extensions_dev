# V2 本轮验证记录

2026-09-17，macOS，Chrome 152.0.7977.84，Node 24.19.0。基线为 `41e0f507c8adc1100eca074d0a8670de1cba6734`。

所有 Chrome 测试使用独立临时 profile 和下载目录，加载正式 manifest，经 `Extensions.triggerAction` 授予 activeTab。截图、离屏画布和下载均走真实扩展 API；Playwright 只负责驱动和断言。测试文件不进入仓库。未访问 CSDN，V0.1 未修改。

## 性能对比

同一确定性彩色逐行 fixture，CSS 1500×10337、视口 900×700、100% 缩放，逐行检查 x=0/800/1499，验证横向拼接、纵向拼接、最终底部，无遗漏、重复或空白。

| 指标 | 基线双遍／分片 | 本轮单遍／单 PNG |
| --- | ---: | ---: |
| 总耗时 | 26,357 ms | 17,512 ms |
| captureVisibleTab 次数 | 32 | 30 |
| scroll/settle 次数 | 48 | 30 |
| PNG 编码累计 | 265 ms | 220 ms |
| 保存累计 | 529 ms | 273 ms |
| 最终 PNG 数量 | 2 | 1 |
| 输出尺寸合计 | 1500×10337 | 1500×10337 |

总耗时降低约 **33.6%**，settle 减少 37.5%。截图间隔仍至少 550 ms。基线复制到临时目录后仅增加计时和计数；编码时间只累计 EXPORT，保存时间只累计下载等待，不把两次编码之间的截图时间算入编码。当前代码直接在结果 `metrics` 返回 captures、settles、encodeMs、saveMs、retries、totalMs。数据是本机单次确定性比较，不是所有网站的速度保证。

## 自动化覆盖

- Node：23/23 通过。保留几何/DPR/边界、offscreen 解码／编码失败、串行清理、过期消息测试；新增五档比例、源像素与输出像素分离、Auto 预算取整，以及首次启动 closeDocument 拒绝后仍可 STATUS／START 并完成新任务的测试。
- 基础 Chrome：1500×10337 单 PNG 逐行检查、实际点选跨屏选区、125% 原生缩放、模拟 DPR 与实际 bitmap 不一致、动态高度 1800→2800、Esc 取消、并发拒绝、过期消息、worker 强制终止及下载拒绝恢复。
- 输出／UI Chrome：800×1800 CSS 选区五档输出分别 800×1800、800×1800、600×1350、400×900、800×1800（本组原生 1×）；逐像素恒定蓝通道证明进度面板、空白和遮挡没有进入输出。真实弹窗关闭后页面面板仍可见；页面取消及完成态手动关闭有效。
- 实际路径：对比 PNG 下载记录的 filename 与面板文本，实际路径为测试下载目录下 Chrome 返回的文件名，并非建议的 LongScreenshot 路径。Node 测试另用 `/custom/chosen/result.png` 验证自选目录；页面按钮用 spy 验证传入正确下载 ID，原生 Retina 组另外调用真实 downloads.show API。
- 超长输出：CSS 1500×26000，100% 在首帧前明确失败（captures=0）；Auto 输出一张 945×16384 PNG，检查预算、每行无空白和底部颜色。高度 1,000,000 CSS px 的极端页面 Auto 在首帧前建议缩小区域。

## 复杂页面与原生 Retina

- `tests/fixtures/test-complex-page.html`：整页单 PNG 900×13510，18 张延迟图片和底部色标完整；定时增高触发一次安全重试（最终 20 帧，实际截图 23 次、settle 44 次，总耗时 23,934 ms）。逐行检查排除固定顶栏。
- 正文选区通过实际两角点选，验证连续绿色边框及排除侧栏；选区后增高、缩短、截图等待期间增高均明确失败并恢复。
- 成功、失败、取消均检查原滚动位置、fixed/sticky 内联样式和优先级；验证 live offscreen 时取消、过期取消不影响新任务、一次关闭失败后下个任务完成并清理。
- 原生设备 2×：500×1600 CSS 区域，设备模式输出 1000×3200；Auto／CSS 100% 为 500×1600，75% 为 375×1200，50% 为 250×800，各输出逐行检查无空白。
- 真实 `chrome.downloads.show` 调用成功；没有要求用户改变 Chrome 下载偏好。

## 外部页面

| 页面 | 本轮结果 |
| --- | --- |
| https://ixyzero.com/blog/archives/5949.html | Chrome 单次导航等待 DOMContentLoaded 60 秒超时，未进入截图；没有重试 |
| https://ixyzero.com/blog/archives/5483.html | 同站网络未正常响应，按任务要求不反复等待，未继续访问 |

因此本轮不声称外部两页截图验收通过，也不沿用旧版本的通过记录。本地 Node、基础 Chrome、输出/UI、复杂页面和原生 Retina 五组均通过；矩阵脚本最终因外部导航超时退出 1，而非扩展截图断言失败。

## 完整矩阵命令

```sh
node --test long-page-screenshot-v2/tests/*.test.mjs
node long-page-screenshot-v2/tests/browser.mjs
OUTPUT_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
COMPLEX_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
NATIVE_DPR=2 node long-page-screenshot-v2/tests/browser.mjs
SITE_URL=https://ixyzero.com/blog/archives/5949.html node long-page-screenshot-v2/tests/browser.mjs
SITE_URL=https://ixyzero.com/blog/archives/5483.html node long-page-screenshot-v2/tests/browser.mjs
```

测试环境需要 Playwright、pngjs，可用 `NODE_PATH` 指定其包目录，`CHROME_EXECUTABLE` 指定支持扩展调试协议的新 Chrome 路径。`HEADED=1` 可显示测试窗口；`EXTRA_ONLY=1` 可仅复验取消和异常恢复。脚本打印临时产物目录。

## 手动复现

从仓库根目录运行 `python3 -m http.server 8000 --bind 127.0.0.1`，打开 `http://127.0.0.1:8000/tests/fixtures/test-complex-page.html`。

1. 打开后立即整页截图，检查定时插入面板、18 张蓝色延迟图片和 DOCUMENT END；输出应为一张 PNG。
2. 等布局稳定后沿绿色正文边框跨屏点选，检查选区排除侧栏和页脚、边框连续。
3. 选区界面打开后用页面按钮增高，再提交旧边界，应明确失败并恢复。
4. 截图时按面板取消或 Esc，检查原滚动、fixed/sticky 内联值恢复，随后新任务能成功。
5. Chrome 开启“下载前询问每个文件的保存位置”，选择不同目录／文件名，核对完成面板与 Finder。自动化没有驱动 macOS 原生保存对话框；下载选项不设置 saveAs，保留浏览器偏好，结果始终以完成后的 DownloadItem 为准。

## 验证边界

没有测量浏览器总 RSS，仅验证画布尺寸预算及资源释放。fixed/sticky 是既有启发式，滚动后才切换 class/style 的吸顶元素不在本轮范围。未支持虚拟列表、无限 feed、iframe 内滚动、视频时序一致性、同尺寸异步内容替换或同尺寸内部换位。真实保存路径和 downloads.show API 已自动化覆盖；不声称自动化检查了 Finder 窗口的视觉状态或原生保存对话框。
