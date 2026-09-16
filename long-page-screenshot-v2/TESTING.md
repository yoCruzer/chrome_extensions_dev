# V2 验证记录

环境：macOS，Chrome 152.0.7977.84，Node.js 24.19.0。测试日期：2026-09-16（Asia/Shanghai）。

测试浏览器使用独立临时配置；加载的就是正式 manifest，没有增加主机权限。通过 Chrome 的 `Extensions.triggerAction` 授予 `activeTab`，实际截图使用扩展的 `captureVisibleTab`，实际拼图和下载使用 offscreen／downloads。浏览器自动化只负责驱动与断言，不替换截图引擎。测试图片、浏览器配置与下载均留在系统临时目录，不在仓库内。

## 自动化结果

| 检查 | 结果 |
| --- | --- |
| Node 几何单元测试 | 8/8 通过 |
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
| [CSDN 156221142](https://blog.csdn.net/weixin_42376192/article/details/156221142) 整页 | **受阻，未通过验收**：隔离 Chrome 导航 `net::ERR_TIMED_OUT`；内置浏览器也超时。curl 能建立 TCP 但 HTTPS 握手超时，另两个 DNS 返回地址仍超时，尚未进入扩展截图流程 |
| 同一 CSDN 页面自选区域 | **受阻，未验证**：同上；不能用合成页的选区通过结果替代该页面验收 |

完整输出的所有文本未逐字核对。浏览器截图及选区界面已做视觉检查；代码并不包含针对上述站点的分支。

## 复现

```sh
node --test long-page-screenshot-v2/tests/geometry.test.mjs
node long-page-screenshot-v2/tests/browser.mjs
NATIVE_DPR=2 node long-page-screenshot-v2/tests/browser.mjs
EXTRA_ONLY=1 node long-page-screenshot-v2/tests/browser.mjs
SITE_URL=https://ixyzero.com/blog/archives/5949.html node long-page-screenshot-v2/tests/browser.mjs
SITE_URL=https://ixyzero.com/blog/archives/5483.html node long-page-screenshot-v2/tests/browser.mjs
```

测试脚本需要测试环境已有 Playwright 和 pngjs；可用 `NODE_PATH` 指向其包目录、`CHROME_EXECUTABLE` 指定新版 Chrome 路径。`EXTRA_ONLY=1` 仅执行取消、懒加载、中断和失败恢复检查。`HEADED=1` 显示测试浏览器。脚本会打印临时产物目录。

网络恢复后需要补做 CSDN 两种模式：先整页，再在页面中点选正文四条边界，检查两侧区域被排除且所选正文首尾齐全。也可通过 `SITE_URL` 加 `REGION_EDGES='{"left":...,"top":...,"right":...,"bottom":...}'` 运行测试；边界必须取自当时页面，不能预设网站布局。
