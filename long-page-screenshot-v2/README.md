# Long Page Screenshot V2

无构建步骤、无运行时依赖的 Manifest V3 长截图扩展。图像全部在本机处理。V2 独立于相邻的 `long-page-screenshot/`（V0.1）。

## 安装与截图

1. Chrome 116+ 打开 `chrome://extensions`，启用开发者模式，加载本目录。
2. 在普通网页点击扩展图标，选择输出尺寸，然后选择「截取整页」或「选择截图区域」。
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
- 整页截图中发现文档高度变化时，丢弃当前画布，最多重试一次保守预加载路径；重试后仍变化则失败。不会把旧坐标拼成成功结果。Region 的规则见下节。
- 支持横向及纵向拼接，以实际可见坐标裁剪、按绝对输出边界取整，避免累计接缝误差。
- 页面状态面板使用 Shadow DOM。截图前隐藏，并等待两次动画帧重绘；截图后恢复，面板不进入最终 PNG。
- 一次仅保留当前帧和一个有界画布；逐帧释放 ImageBitmap／data URL，不累积源截图数组。画布 RGBA 预算约 61 MiB，另有源帧、编码和浏览器自身开销；这不是浏览器总 RSS 上限。
- 编码完成后释放画布，下载完成后撤销 Blob URL。成功、失败、取消均恢复原始滚动及临时改动的内联样式与优先级。
- 任务 ID 隔离过期消息；worker 重启清理旧任务并提示中断。启动时残留 offscreen 关闭失败不会永久阻塞 ready，后续新任务会再次清理。页面端另有 30 秒租约恢复机制。
- 单阶段最多 1000 步，任务最多 15 分钟；持续增长的页面会被停止。

## Region：在捕获布局上选择视觉区域

进入 Region 时先建立捕获布局，再显示选择 UI：关闭平滑滚动、scroll snap、滚动锚定，暂停 CSS 动画／过渡并隐藏 caret。对符合启发式的 fixed/sticky 覆盖层仅隐藏可见性、保留占位，不改 `position`。点选后 PREPARE 只移除选择 UI 并锁定输入，不再重写普通文档流。取消、失败、成功均恢复样式、优先级和原始滚动位置。Full Page 保留原有 fixed 隐藏／sticky position 处理。

两角保存当前 document 中的 Element 引用、原矩形、局部 offset、归一化比例及四边距离。尺寸未变时使用精确 offset；resize 后，左上角靠近左／上边缘、右下角靠近右／下边缘的轴保留该边 inset（边缘带为 24px 与原轴长度 10% 的较小值），其它轴使用比例。锚点消失、隐藏、零尺寸或选区无效才拒绝解析。这是视觉点锚定，不是字符或正文语义识别。修改数字会清除锚点，回到固定 document 坐标；只点选一角也使用数字边界。

点击开始后，在捕获布局上建立环境基线：目标 tab、`innerWidth/innerHeight`、`chrome.tabs.getZoom()` 和 `visualViewport.scale`。scale 使用 `0.0001` epsilon；clientWidth/clientHeight、document 宽高和 DPR 仅记录诊断，不是 Region fatal invariant。不会拿最初 BEGIN 的页面快照永久比较。真实位图决定源像素比例，拼图仍拒绝不一致的实际 bitmap 尺寸。

首帧提交前，当前可解析且稳定的区域成为 Attempt 1 基线；未提交的首帧布局变化最多重新采样两次。捕获期间重新解析锚点，纯平移重定位滚动及帧坐标，不重启整个画布；位图获取前后发生平移会丢弃未提交帧，最多重采两次。画布建立后首次区域宽高实质变化，销毁临时 canvas/offscreen，自动建立 Attempt 2 并采用稳定的新区域尺寸，不要求重新点选。Attempt 2 再次出现尺寸变化或无法稳定时，提示「所选区域持续发生布局变化，请稍后重试」，不输出 PNG。

等待仅检查当前滚动、解析后的区域几何和当前选区内可见图片，每次最多 5 秒。截图前隐藏扩展 UI，并复核位图前后几何。不再遍历整个 DOM 构建 scope 指纹，无关节点替换、广告变化或文档增长不会单独终止 Region。

状态接口及 `chrome.storage.session` 中的 `status` 保留 `reasonCode`、`attempt`、`diagnostics`：环境 baseline/actual、具体差异字段、两角 connected／原始及当前 rect／resolved point／resolver mode，以及区域 before/current。例：`CAPTURE_ENV_CHANGED: innerWidth 900 -> 880`。其它代码包括 `ANCHOR_UNRESOLVABLE`、`REGION_INVALID`、`REGION_REFLOW`、`FRAME_NOT_SETTLED` 和目标 tab 变化；不记录 DOM 或正文文本。

## 已知限制

fixed/sticky 仍采用原有可见性、尺寸及位置启发式，结束后恢复；未增加全页面 class/style 监听。初始普通元素在滚动后才变为 fixed/sticky 的网站仍可能重复吸顶栏。

不支持虚拟列表、无限 feed、iframe 内部独立滚动、独立滚动容器、触控捏合缩放及浏览器受限页面。不遍历 Shadow DOM 内部固定元素，不展开折叠内容。不冻结页面 JavaScript；相同外框内的语义替换、视频、Canvas 动画、仅 CSS 绘制变化、Shadow DOM 内部变化及检查间瞬间变化后恢复的内容无法保证跨帧一致性。持续可观察的选区 reflow 会有界失败；固定数字坐标不承诺跟随内容重排。锚点是按边缘距离／比例解析的视觉点，不是字符或语义位置；请点在目标内容上，空白页面容器不是正文锚点。没有 AI、OCR、正文识别、网站适配器或编辑器。

## 开发与测试

`background.js` 协调任务；`content.js` 负责页面 UI、测量、滚动及恢复；`offscreen.js` 串行拼图；`capture/` 集中处理几何及块规划。保留内部 PART 协议，但默认流程只创建一个完整输出画布并下载一次。

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

测试需要 Node 22+，Chrome 集成另需 Playwright 和 pngjs；可通过 `NODE_PATH` 和 `CHROME_EXECUTABLE` 指定。使用临时配置及下载目录，正式 manifest 不增加主机权限；通过真实扩展 `captureVisibleTab`、offscreen 和 downloads 验证，不以自动化截图替代截图引擎。

本地复杂 fixture：`tests/fixtures/test-complex-page.html`，包含固定顶栏、sticky 侧栏、18 张延迟图片、定时增高和正文边框。新增动态 fixture：`long-page-screenshot-v2/tests/fixtures/test-dynamic-region-page.html`，以完整参考像素验证动态 banner、一次 resize 及重复 reflow。`test-csdn-like-page.html` 和 `test-chat-like-page.html` 分别复现 scrollbar／动态文章和 flex/grid 聊天布局中的两类误报。详见 [TESTING.md](TESTING.md)。

API 依据：[Tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs)、[Offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)、[Downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads)。
