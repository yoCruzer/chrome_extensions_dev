# Long Page Screenshot Chrome Extension 开发任务书

## 1. 项目目标

开发一个原生 Manifest V3 Chrome 扩展，用于对普通网页进行“自动滚动长截图”。用户通过扩展 popup 按钮或页面右键菜单触发后，插件从页面顶部滚动到底部，分段截取当前可视区域，最终导出 PNG。

当前版本的定位是本地可加载、结构清楚、普通网页可用，不以 Chrome Web Store 发布为第一目标。

核心成功标准：

- 支持 popup 按钮触发截图。
- 支持页面右键菜单触发截图。
- 截图期间自动滚动页面，并在完成后恢复用户原始滚动位置。
- 普通长页面输出一张 PNG。
- 超长页面自动输出多张连续 PNG，避免浏览器 canvas 或下载 URL 限制导致失败。
- 截图过程中显示进度，但进度浮层不能出现在最终截图里。

## 2. 技术约束

- 使用 Manifest V3。
- 使用原生 HTML/CSS/JavaScript，无 npm、无构建步骤。
- 权限尽量克制，当前使用：
  - `activeTab`
  - `scripting`
  - `downloads`
  - `contextMenus`
  - `offscreen`
- 不默认申请 `<all_urls>`。
- 第一版优先支持普通主文档页面，不承诺完整支持复杂 iframe、虚拟列表、内部滚动容器、无限加载页面。

## 3. 推荐文件结构

```text
long-page-screenshot/
  manifest.json
  background.js
  content.js
  offscreen.html
  offscreen.js
  popup.html
  popup.css
  popup.js
```

职责划分：

- `background.js`：任务编排、权限入口、右键菜单、调用 `captureVisibleTab`、触发下载。
- `content.js`：页面测量、滚动控制、进度浮层、恢复滚动位置。
- `offscreen.js`：用 canvas 拼接截图分片，生成 Blob URL。
- `popup.*`：用户手动启动入口和基础状态提示。

## 4. 截图流程设计

1. 用户点击 popup 按钮或页面右键菜单。
2. `background.js` 校验当前 tab 是否是普通 `http/https/file` 页面。
3. `background.js` 注入 `content.js`。
4. `content.js` 记录原始滚动位置，显示进度浮层。
5. `content.js` 测量：
   - 页面总高度
   - 视口宽高
   - `devicePixelRatio`
   - 每次截图的滚动位置和裁剪区域
6. `background.js` 循环执行：
   - 通知 content script 滚动到指定位置。
   - 等页面稳定、懒加载有时间触发。
   - 隐藏进度浮层并等待重绘。
   - 调用 `chrome.tabs.captureVisibleTab` 获取当前可视区域 PNG。
   - 重新显示进度。
7. `background.js` 把所有截图分片交给 offscreen document。
8. `offscreen.js` 根据页面高度决定导出一张或多张 PNG。
9. `background.js` 调用 `chrome.downloads.download` 下载结果。
10. `content.js` 清理浮层，并恢复原始滚动位置。

## 5. 已踩坑点和规避方案

### 5.1 超长页面不能只依赖单张大 canvas

问题：如果直接创建一张完整页面高度的 canvas，超长页面容易超过浏览器 canvas 总像素或单边尺寸上限，导致生成失败、空白或 PNG 损坏。

规避：

- 设置总像素上限，例如 `MAX_CANVAS_PIXELS = 120_000_000`。
- 设置单边尺寸上限，例如 `MAX_CANVAS_DIMENSION = 30_000`。
- 超过单张可承受范围时，自动拆成 `part-01-of-N`、`part-02-of-N` 等多张 PNG。
- 分段之间保留一段重叠区域，例如 `160 CSS px`，避免文字刚好被切到图片边缘，影响 OCR。

### 5.2 超大 PNG 不要用 data URL 下载

问题：早期实现把 canvas 结果转成 base64 `data:` URL 再下载。超长页面下字符串非常大，容易触发浏览器内部长度或内存限制，结果出现 PNG 无法正常打开。

规避：

- `offscreen.js` 中使用 `canvas.convertToBlob({ type: "image/png" })`。
- 使用 `URL.createObjectURL(blob)` 返回 Blob URL。
- `background.js` 下载 Blob URL，而不是下载巨大 data URL。
- 下载启动后一段时间再释放 Blob URL，避免过早 revoke。

### 5.3 进度浮层会被截图捕获

问题：进度浮层是页面里的 fixed DOM，如果截图前只是更新状态或刚设置隐藏，浏览器可能还没重绘，`captureVisibleTab` 会把浮层截进去。

规避：

- 截图前把浮层设为 `display: none`。
- 等待至少两次 `requestAnimationFrame` 后再通知 background 截图。
- 当前分片截图完成后，再恢复浮层显示并更新进度。

### 5.4 最后一屏需要裁剪

问题：页面底部通常不足一整屏，如果直接拼接整张可视截图，会产生重复内容或多余空白。

规避：

- content script 为每一步记录 `sourceY` 和 `sourceHeight`。
- offscreen 拼接时只绘制有效区域。
- 对最后一个滚动位置计算实际剩余高度。

### 5.5 popup 不能承担长任务

问题：Chrome popup 可能因为失焦被关闭，如果截图任务完全依赖 popup，就可能中断。

规避：

- popup 只发送 `START_LONG_SCREENSHOT`。
- `background.js` 作为任务协调者继续执行。

### 5.6 固定/吸顶元素的重复问题

当前策略：第一版保持页面原样，不主动隐藏页面自己的 fixed/sticky 元素。

原因：

- 隐藏 fixed/sticky 元素可能破坏页面布局。
- 不同站点的吸顶导航、悬浮按钮、广告、聊天组件行为差异很大。

后续可选优化：

- 仅在后续分片中隐藏明显位于顶部/底部的 fixed 元素。
- 做成可选开关，而不是默认行为。

## 6. 关键实现细节

### 6.1 页面尺寸和 DPR

截图坐标要区分 CSS 像素和实际位图像素：

- 页面测量使用 CSS 像素。
- `captureVisibleTab` 得到的是设备像素图片。
- `sourceY`、`sourceHeight`、canvas 宽高需要乘以 `devicePixelRatio`。

### 6.2 分段输出逻辑

当 `captureWidth * captureHeight` 超过单张上限时：

- 按 `MAX_CANVAS_PIXELS / captureWidth` 计算每张 PNG 的最大高度。
- 再用 `MAX_CANVAS_DIMENSION` 限制单边高度。
- 每个 part 记录：
  - `startY`
  - `height`
- 相邻 part 之间保留 overlap。

### 6.3 offscreen 拼接逻辑

offscreen 不应该一次性解码所有截图，否则超长页面会消耗大量内存。

推荐策略：

- 按输出 part 循环。
- 每个 part 内按需解码相关 capture。
- 只绘制 capture 与当前 part 的交集区域。
- 用完 `ImageBitmap` 后立刻 `bitmap.close()`。

## 7. 测试清单

基础测试：

- 普通短页面截图，输出一张 PNG。
- 普通长文章页截图，输出一张完整 PNG。
- popup 入口可用。
- 右键菜单入口可用。
- 截图完成后页面滚动位置恢复。

超长页面测试：

- 超过单张 canvas 上限时，不再报“页面过大”。
- 自动下载多张 `part-X-of-N` PNG。
- 每张 PNG 可以被系统预览或图片应用正常打开。
- 相邻分段之间存在少量重叠，方便 OCR。

浮层测试：

- 截图时页面右上角显示进度。
- 最终 PNG 内不出现插件进度浮层。
- 失败时浮层能显示错误，然后自动消失。

异常页面测试：

- `chrome://` 页面应提示不支持。
- Chrome Web Store 等受限页面应提示失败。
- 文件页面 `file://` 需要用户在扩展详情里允许访问文件网址。

## 8. 后续可选增强

- 增加“隐藏页面固定元素”选项，减少导航栏重复。
- 增加“只截当前位置到页面底部”模式。
- 增加“预览后下载”页面。
- 增加取消按钮。
- 为无限滚动页面增加最大高度或手动停止机制。
- 支持用户自定义分段重叠高度，服务 OCR 场景。

## 9. 当前版本注意事项

- 当前版本适合普通网页和静态长页面。
- 虚拟列表页面可能只能截到当前渲染出来的内容。
- 页面滚动时触发的新懒加载内容可能改变页面高度，第一版不会在中途重新规划全部步骤。
- 超长页面会下载多张 PNG，这是为了避免浏览器 canvas 和下载 URL 限制，比强行生成单张更稳定。
