# V2 验证记录

环境：macOS，Chrome 152.0.7977.84，Node.js 24.19.0。测试日期：2026-09-17（Asia/Shanghai）。

测试浏览器使用独立临时配置；加载的就是正式 manifest，没有增加主机权限。通过 Chrome 的 `Extensions.triggerAction` 授予 `activeTab`，实际截图使用扩展的 `captureVisibleTab`，实际拼图和下载使用 offscreen／downloads。浏览器自动化只负责驱动与断言，不替换截图引擎。测试图片、浏览器配置与下载均留在系统临时目录，不在仓库内。

## 自动化结果

| 检查 | 结果 |
| --- | --- |
| Node 几何与离屏生命周期单元测试 | 15/15 通过 |
| 导出释放画布、末片释放会话、Blob 撤销 | 通过 |
| 旧拼图消息、串行导出／关闭／新会话 | 通过，旧消息不影响新任务 |
| 解码失败、编码失败、文档 pagehide | 通过，资源释放且旧会话不再接受分片 |
| 1、1.25、1.5、2、2.5 比例的绝对边界舍入 | 通过，无累计缺行 |
| 1500×10337 测试页整页输出 | 通过，2 个分片，每行检查 3 个横向位置 |
| 横向视口拼接、纵向分片、最后不足一屏 | 通过，无遗漏、重复或空白行 |
| 点选左上角 → 滚动 → 点选右下角 → 开始 | 通过，输出 640×2156，逐行颜色匹配所选区域 |
| 浏览器原生缩放 125% | 通过，640×2160 CSS 选区输出 800×2700，无空白行 |
| 原生 2× backing scale | 通过，500×1600 CSS 选区输出 1000×3200，无空白行 |
| 仅 CDP 模拟 DPR 与截图实际比例不同 | 验证按实际 PNG／视口比例处理，不盲乘 DPR |
| 预滚动触发高度从 1800 增长到 2800 | 通过，输出包含最终 2800 像素高度 |
| 原始水平／垂直滚动与固定元素样式恢复 | 通过 |
| Esc 取消、并发启动拒绝、过期取消消息、新任务 | 通过 |
| 强制终止 service worker | 通过，重启后任务标记中断，页面恢复、offscreen 关闭 |
| 浏览器拒绝下载 | 通过，显示失败并恢复页面、清理 offscreen |

画布面积上限通过几何测试和实现检查验证；未声称测得浏览器总 RSS 的固定上限。GPU、编码器及网页自身仍有独立内存开销。

## 指定网页验收

| 页面／模式 | 结果与检查 |
| --- | --- |
| [5949](https://ixyzero.com/blog/archives/5949.html) 整页 | 通过：900×6294，9 帧、1 PNG；目视检查顶部正文及底部评论表单、页脚完整 |
| [5483](https://ixyzero.com/blog/archives/5483.html) 整页 | 通过：总计 900×26146，39 帧；4 PNG 高度分别为 8192、8192、8192、1570；目视检查第一处分片接缝与最终页脚 |
| 本地复杂页整页 | 通过：900×13510，20 帧、2 PNG；18 张延迟图片全部加载、定时插入内容及底部色标齐全 |
| 本地复杂页正文选区 | 通过：628×13034，19 帧、2 PNG；实际两次点选跨屏操作，逐行验证绿色正文边框，两侧区域排除 |
| 本地复杂页固定／sticky／恢复 | 通过：红色固定顶栏隐藏，侧栏转为普通流，负 z-index 背景和 4px 装饰保留；成功、失败、取消后内联值与优先级恢复 |
| 本地复杂页选区失效 | 通过：选择后增高（边界仍在页面内）、缩短后越界、选区预滚动期间增高均明确失败并恢复 |
| 本地复杂页取消和下一次截图 | 通过：离屏文档已创建后按 Esc，页面／offscreen 清理，新任务成功导出，旧取消消息被拒绝 |
| 离屏文档关闭偶发失败 | 通过：测试注入一次 closeDocument 拒绝，下一任务清理残留文档后成功导出 |

CSDN 外部场景已从验收集合中移除，以本地复杂页面替代。原环境的网络连接限制不视为实现失败，本次未重试该站点。

完整输出的所有文本未逐字核对。浏览器截图及选区界面已做视觉检查；代码并不包含针对上述站点的分支。

## 复现

```sh
node --test long-page-screenshot-v2/tests/*.test.mjs
node long-page-screenshot-v2/tests/browser.mjs
COMPLEX_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
NATIVE_DPR=2 node long-page-screenshot-v2/tests/browser.mjs
EXTRA_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
SITE_URL=https://ixyzero.com/blog/archives/5949.html node long-page-screenshot-v2/tests/browser.mjs
SITE_URL=https://ixyzero.com/blog/archives/5483.html node long-page-screenshot-v2/tests/browser.mjs
```

测试脚本需要测试环境已有 Playwright 和 pngjs；可用 `NODE_PATH` 指向其包目录、`CHROME_EXECUTABLE` 指定新版 Chrome 路径。`EXTRA_ONLY=1` 仅执行取消、懒加载、中断和失败恢复检查。`HEADED=1` 显示测试浏览器。脚本会打印临时产物目录。

## 本地手动复现

从仓库根目录执行 `python3 -m http.server 8000 --bind 127.0.0.1`，打开 [本地复杂页](http://127.0.0.1:8000/tests/fixtures/test-complex-page.html)。该文件所有文本和 SVG 均在本地生成，无外部依赖。

1. 打开页面后立即截取整页，检查 2 秒后插入的浅绿面板、18 张蓝色图片和最底部 `DOCUMENT END`，并检查 PNG 分片连接处。
2. 等待定时增高结束，沿绿色边框点选正文左上角，滚动后点选右下角；确认导出排除黄色侧栏及页脚，保留 `ARTICLE START` / `ARTICLE END`。
3. 选择界面打开后点击页面的增高按钮，再提交原选区。扩展应失败；重新打开扩展弹窗查看具体原因，等布局稳定后重新选择。
4. 截图时按 Esc，或用弹窗取消；检查原始滚动位置、顶栏透明度及 sticky 侧栏恢复，再次截图应成功。
5. 页面默认启用平滑滚动和 proximity scroll snap；截图期间自动关闭，结束后恢复。

复杂页面自动化通过实际 Chrome 扩展截图链路验证输出尺寸、每行边框和底部像素；原有彩色逐行页面继续覆盖精确拼接、横向溢出、缩放、工作线程终止和下载被拒绝。

## 验证边界

固定／sticky 的筛选是基于几何和样式的启发式，不保证识别所有遮挡；特别大的浮层、微小固定装饰可能保留并重复。选区模式采取保守策略：选择之后文档尺寸变化即停止，即使新增内容位于选区之外。相同文档尺寸下的内部换位、同尺寸异步内容替换、视频和 Canvas 动画仍不能保证一致。未覆盖 Shadow DOM／iframe 内部、独立滚动容器、无限信息流；未进行浏览器总 RSS 上限测量。
