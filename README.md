# nioengine · P0 车机音频能力探测

一个**单文件、零外部依赖**的车机浏览器能力探测页。目标不是做完整声浪应用，而是先用真车回答几个决定性问题：

- 车机浏览器能不能稳定加载 `AudioWorklet`？
- 采样率、声道数、浏览器上报的 `baseLatency` / `outputLatency` 是多少？
- 轰油门 / 切后台 / 切导航后，声音会不会断、爆、回不来？
- 横屏和竖屏布局是否都能用？全屏、屏幕常亮是否可用？
- 车机 GPU / Canvas / 音频焦点有什么限制？

页面不会上传任何数据，报告只保存在本机 `localStorage`，由你手动复制或下载。

---

## 快速开始

```bash
npm run build          # 生成 dist/index.html + dist/worklet.js
npm run serve          # 本地静态服务 http://127.0.0.1:4173
```

本地用 Chrome / Edge 打开即可。`localhost` 也算安全上下文，`AudioWorklet` 可用。

### 部署到你的服务器

把 `dist/` 里的两个文件上传到同一个 HTTPS 目录：

```text
/var/www/nioengine-p0/
├── index.html
└── worklet.js
```

`index.html` 是单文件应用（CSS / JS / Worklet 源码都已内联）；`worklet.js` 用于“同源 URL 加载”诊断，也是 Blob 加载失败时的备用路径。**两个都上传**，才能同时测 Blob 和同源 URL 两条路径。

Nginx 示例：

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.example.com;
    root /var/www/nioengine-p0;

    location / {
        try_files $uri $uri/ /index.html;
        add_header Cache-Control "no-store";
    }

    location = /worklet.js {
        default_type application/javascript;
        add_header Cache-Control "no-store";
    }
}

# 可选但建议：HTTP 自动跳 HTTPS
server {
    listen 80;
    server_name your-domain.example.com;
    return 301 https://$host$request_uri;
}
```

要点：

- **必须 HTTPS**（或 localhost）。非安全上下文下 `AudioWorklet` 可能直接不可用。
- `.js` 的 MIME 必须是 `application/javascript`（或 `text/javascript`），否则 `addModule` 会失败。
- P0 阶段建议 `Cache-Control: no-store`，避免车机浏览器缓存旧版本。
- 如果部署在子路径（如 `/p0/`），`worklet.js` 的相对路径会自动解析为 `/p0/worklet.js`，无需改代码。
- 页面没有 CDN、字体、图片等外部请求，断网也能打开（只要文件已加载）。

---

## 本地验证记录（2026-10-25）

在 macOS + Headless Chrome 156 上跑过一轮自测，仅用于确认代码路径，**不能替代真车结果**：

| 项目 | 结果 |
|---|---|
| 采样率 / 声道 | 48000 Hz / 2 ch |
| Blob Worklet | pass（约 3–4 ms） |
| 同源 Worklet URL | 曾 pass；第二个 AudioContext 可能超时/受限，非主路径 |
| WorkletNode | pass |
| baseLatency / outputLatency | 5.3 ms + 16.0 ms（浏览器上报） |
| 1 分钟稳定性 | 592 次心跳，最大间隔 106.5 ms，60 fps，pass |
| 页面异常 | 0 |

真车重点看的是：车机 SoC 下的 Worklet 加载、DSP/ANC 后的实际听感、切导航/语音助手后的音频焦点恢复，以及 10 分钟长稳。

### 首次真车结果（摘要）

| 项目 | 结果 |
|---|---|
| 浏览器 | NioBrowser/1.1 · Chrome 128 · Linux armv81 |
| 部署 | HTTP + IP（非 HTTPS） |
| AudioWorklet | 被 secure-context 禁用（`AudioWorkletNode` 仍存在） |
| AudioContext | 48000 Hz / 2 ch / running |
| 上报延迟 | 10 + 80 = 90 ms |
| 10 分钟降级发声 | 完整跑完，0 异常标记，59.7 fps，音频状态稳定 |
| 详细分析 | [docs/p0-field-report.md](docs/p0-field-report.md) |

**结论：HTTP 是这次 Worklet 失败的直接原因；车机本身是现代 Chromium，换 HTTPS 后预期可用。** P0.1 已增加非 HTTPS 红色提示、Worklet “被浏览器禁用”状态，以及后台长帧不计入 FPS 的修正。

---

## 车机实测清单

建议**驻车**或由乘客操作。测试声可能较大，先把车机音量调到较低水平。

1. **打开页面**，确认右上角显示 `HTTPS · 安全上下文`。
2. 点 **开始能力检测**，确认：
   - 听到两声短确认音（660 Hz / 880 Hz）；
   - `AudioWorklet` 显示 `OK`；
   - `AudioContext` 为 `running`，采样率通常为 48 kHz；
   - `Worklet (Blob)`、`Worklet (同源 URL)`、`WorkletNode` 都是 `通过`。
3. 依次点 **发动机 / 自动轰油门 / 正弦 440Hz / 左声道 / 右声道 / 节拍器 / 停止**：
   - 确认左右声道真的分开了；
   - 调音量，确认没有爆音、破音；
   - 用节拍器主观判断“画面闪”和“听到 click”的先后。声音明显晚于画面，说明链路延迟偏大。
4. 选 **10 分钟**，点 **开始稳定性测试**。测试中做这些事：
   - 切到导航 / 语音助手 / 其他车机应用，再切回来；
   - 旋转屏幕或切换横竖屏（如果车机支持）；
   - 点 **进入全屏**、**保持屏幕常亮**；
   - 听到断音、爆音、明显卡顿时，立刻点 **我听到断音 / 爆音**（会记录时间点）。
5. 结束后看 **稳定性结论**，点 **下载 JSON** 或 **复制 JSON**，连同以下信息一起回传：
   - 车型、车机系统版本、浏览器版本（如果看得到）；
   - 是否听到确认音；
   - 主观延迟感受（跟手 / 轻微延迟 / 明显延迟）；
   - 现场照片（横屏 + 竖屏各一张）。

> 建议至少跑一次 10 分钟完整测试，再跑一次 1 分钟快速测试做对比。提前结束的测试会被标记为“未完成 / 告警”，不代表音频失败。

---

## 怎么读报告

报告 schema：`nioengine.p0/1`。

| 字段 | 含义 | 关注点 |
|---|---|---|
| `audio.worklet.blob` | 内联 Worklet 通过 Blob URL 加载 | 失败则最终应用要考虑同源 URL 或降级 |
| `audio.worklet.url` | 同源 `worklet.js` 加载 | 失败常见于 MIME / 路径 / 缓存问题 |
| `audio.worklet.node` | `AudioWorkletNode` 创建并连接 | 失败则 Worklet 路径不可用 |
| `audio.context.sampleRate` | 实际采样率 | 常见 48000；不要强行指定 44100 |
| `audio.latency.baseMs/outputMs` | 浏览器**上报值** | 不是声学实测；`outputLatency` 可能为 0 或缺失 |
| `audio.heartbeat` | Worklet 每 100 ms 心跳 | 正常约 100 ms 一次；`maxGapMs` 很大说明主线程或音频线程被卡 |
| `stability.maxGapMs` | 测试期间最大心跳间隔 | > 500 ms 标警告，但需结合“我听到断音”标记判断 |
| `stability.summary` | 完成度、状态、异常标记、FPS、内存、结论 | 完整跑完、Worklet 有心跳、无标记 = pass |
| `display.webgl` | WebGL 支持 | 不支持不影响当前 UI（用 Canvas 2D） |
| `display.wakeLockApi` | 屏幕常亮 API | 车机可能不支持，失败不影响声音 |
| `events` | 带时间戳的事件流 | 看 `audio-state`、`visibility`、`heartbeat-gap` |

**判定建议：**

- `WorkletNode = pass` + `AudioContext = running` + 能听到声音：技术路径可行，可以进入 P1。
- 延迟 < 30 ms：良好；30–80 ms：可接受；> 80 ms：需要重新设计交互（自动演示 / 视觉补偿），或考虑原生方案。
- 完整 10 分钟、无用户标记、结束时 `audioState = running` 且 `heartbeatCount > 0`：通过。
- 出现 `audio-state = suspended` 且没有自动恢复：记录车机音频焦点策略，P1 必须做恢复 UX。
- `outputLatency = 0` 不一定代表零延迟，只代表浏览器没上报；以节拍器主观听感为准。

---

## 开发说明

```text
src/
├── index.html     页面骨架 + 所有 data-i18n 文案挂点
├── styles.css     深色车机 UI、横竖屏响应式、大触控目标
├── i18n.js        中 / 英文案字典（P0 先搭好多语言结构）
├── app.js         能力探测、UI、报告、稳定性测试
└── worklet.js     AudioWorklet 内的简易发动机合成器
build.mjs          把 CSS / JS / Worklet 内联成单文件
dist/              构建产物（已 gitignore）
```

### 隐藏的诊断参数

- `?autorun=1`：页面加载后自动跑能力检测，把结果写进页面；用于开发 / 无头浏览器。
- `?autorun=full`：自动检测 + 播放 2.5 秒发动机声 + 生成报告。
- `?lang=zh` / `?lang=en`：强制语言。
- 控制台可用 `window.__P0__` 读取 `state`、`buildReport()`、`playMode()`、`startStability()` 等，方便远程排查。
- 报告 JSON 中的 `partial: true` 表示测试中途保存的快照；浏览器崩溃 / 刷新后可在“报告”卡片点 **载入上次报告**。

### 声音测试信号

- **发动机**：4 缸四冲程简化模型，点火频率 `rpm / 60 * 2`，叠加谐波、燃烧脉冲、低通噪声；不是一个纯振荡器。
- **自动轰油门**：900 → 5600 → 900 rpm 的预设序列。
- **正弦 / 左 / 右**：检查扬声器、声道映射、破音。
- **节拍器**：每 500 ms 一次，视觉闪屏同步触发，用于主观判断链路延迟。
- **确认音**：660 Hz + 880 Hz 两短音，检测结束自动播放。

所有输出经过软削波、`DynamicsCompressor` 和主增益；默认音量 35%，避免意外过响。

### 局限

- **浏览器拿不到车速 / 转速 / 油门**。P0 与后续 P1 的声浪都由页面内部虚拟驾驶模型驱动，不跟随真实驾驶。若要做真实联动，需要车机提供 JS Bridge / SDK，或改为原生车机应用。
- **无法测真实声学延迟**。只能读浏览器上报值 + 用节拍器主观判断；车机 DSP、ANC、蓝牙链路都会叠加额外延迟。
- **车机可能限制** 全屏、屏幕常亮、后台音频、第二路 `AudioContext`；这些都会被记录，不作为失败硬条件。
- **ANC 可能抵消低频**。如果深沉的 V8 低频在车内明显变薄，P1 需要把主要能量放到 150 Hz 以上，或确认能否走座椅扬声器。
- **纯电车型**没有真实发动机；这是车内娱乐声浪，不是车外 AVAS 行人提示音，浏览器也无法路由到车外扬声器。

---

## 排查

**Q：报告里 `secureContext=false`，`audioWorklet=false`，但 `AudioWorkletNode` 是 true？**

这是 Chrome 的 secure-context 规则，不是车机不支持。NioBrowser/Chrome 128 在 `http://IP` 下会隐藏 `AudioWorklet`，只保留 `AudioWorkletNode` 构造函数。把同一份文件放到 HTTPS 域名下重新打开即可。页面 P0.1 会直接显示红色“需要 HTTPS”提示，并把 Worklet 标成“被浏览器禁用”。

**Q：`Worklet (Blob)` 通过，但 `Worklet (同源 URL)` 失败？**

同源 URL 测试会新建第二个 `AudioContext`，部分车机会限制第二路上下文或缓存策略。只要 Blob 和 `WorkletNode` 通过，应用主路径就可用；URL 测试失败只说明备用路径不可用，不影响声音。

**Q：`fps.min` 很低，但 `fps.avg` 正常？**

看 `events` 里是否有 `visibility hidden` / `visible`。切后台时 `requestAnimationFrame` 会暂停，恢复后的第一个间隔被误算成极低 FPS。P0.1 已把隐藏期间排除，并把可见状态 >2 s 的间隔单独记为 `longFrames`，不再混入 `min`。

**Q：`outputLatency` 是 0 或 80 ms，哪个是真的？**

都是浏览器上报值，不是声学实测。`0` 可能是未上报；`80` 可能是车机音频 HAL 的真实缓冲。最终以节拍器主观听感为准。

---

## P0 通过之后

1. **P1 发声原型**：曲轴角 / 点火顺序驱动的发动机模型，启动 → 怠速 → 轰油门，先跑通“像”和“跟手”。
2. **P2 声音设计**：负载音色、进排气、回火、涡轮、限转、换挡、车厢 IR，3 个预设。
3. **P3 车机 UI**：虚拟驾驶 / 自动换挡、演示模式、横竖屏、全屏、安全提示。
4. **P4 上车调音**：性能、降级、长时间稳定性、真车 A/B。

如果 P0 发现延迟过大或 Worklet 不可用，先不要投入声音设计，优先换交互模型或技术路线。

---

## 隐私

- 无网络请求、无统计、无上传。
- 报告只写入本机 `localStorage`；点“下载 / 复制”才离开浏览器。
- 语言和音量偏好也仅保存在本机。
