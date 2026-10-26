# P0 首次真车运行记录与分析

- 日志：`p0run.log`（JSON 报告，schema `nioengine.p0/1`）
- 运行时间：2026-10-25 16:34 UTC（北京时间 10-26 00:34）
- 构建版本：`0.1.0`（build 2026-10-25T16:01:10Z）
- 部署地址：HTTP + IP，非 HTTPS（具体地址略）
- 结论先行：**这次 AudioWorklet 失败，直接原因是页面跑在 HTTP 上，不是 NioBrowser 不支持。**
- 后续验证：第二次 HTTPS 运行已确认 Worklet 可用，见 [p0-field-report-2.md](p0-field-report-2.md)。

---

## 1. 车机与浏览器

| 项目 | 值 |
|---|---|
| 浏览器 UA | `Chrome/128.0.0.0 ... NioBrowser/1.1` |
| 平台 | Linux armv81 |
| GPU | Qualcomm Adreno 690（WebGL2 可用） |
| 屏幕 | 1920 × 1200，DPR 1.5 |
| 视口 | 1152 × 956 / 1152 × 876（浏览器 UI 收起/展开） |
| 方向 | 横屏 · 0° |
| 触控 | 5 点，coarse pointer |
| CPU 线程 | 5 |
| 安全上下文 | **false**（HTTP） |
| 网络 | 4G，RTT 200 ms |

整体是一套现代 Chromium 运行时：WebGL2、Canvas 2D、全屏 API、方向锁定、dvh 都可用；`navigator.userAgentData` 不可用，`deviceMemory` 不可用，Wake Lock API 不可用。

---

## 2. 音频能力

| 项目 | 结果 | 解读 |
|---|---|---|
| `AudioContext` | 可用，`running` | 音频链路通 |
| 采样率 / 声道 | 48000 Hz / 2 ch | 正常 |
| `baseLatency` | 10 ms | 正常 |
| `outputLatency` | 80 ms | **偏高**；总上报 90 ms |
| `AudioWorklet` | **不可用** | 非安全上下文导致 |
| `AudioWorkletNode` | 构造函数存在 | 说明 API 本身在，只是被 secure-context 挡住 |
| Blob / 同源 URL / Node | 全部失败 | 错误均为 `AudioWorklet not supported` |
| `ScriptProcessor` | 可用 | 可作降级，但延迟/性能更差 |
| `OfflineAudioContext` | 可用 | 可做预渲染循环降级 |
| 编解码 | mp3 / wav / ogg / opus / aac / flac 均可用 | 采样方案有退路 |

**关键判断：** Chrome 128 的 `AudioWorklet` 只在安全上下文（HTTPS 或 localhost）暴露。日志里 `AudioWorkletNode` 存在、`AudioContext` 正常、`secureContext=false`，这是典型的 secure-context 门禁，不是浏览器缺能力。换 HTTPS 后再测，预期 Worklet 会变成可用。

---

## 3. 10 分钟稳定性测试（降级发声）

由于 Worklet 不可用，页面自动用了单振荡器降级音，仍然完整跑了 10 分钟：

| 指标 | 结果 |
|---|---|
| 实际时长 | 600 s（完整） |
| 结束状态 | `audioState = running` |
| 用户异常标记 | 0 |
| 音频状态变化 | 0 |
| 心跳 | 0（降级模式没有 Worklet 心跳，符合预期） |
| 平均 FPS | 59.7 |
| FPS 采样数 | 564 |
| JS 堆内存 | 9.5 MB → 9.5 MB |
| 页面错误 | 0 |
| 结论 | 基本通过，唯一告警是“Worklet 不可用，使用降级发声” |

测试期间有多次切前后台（`visibility hidden/visible`、`blur/focus`、视口高度变化），音频上下文始终保持 `running`，没有出现焦点丢失或恢复失败。这个结果说明页面容器、降级音频和 UI 长稳都没问题，但**不能代表 Worklet 路径**。

### 关于 `fps.min = 0.09`

这是切后台造成的测量伪影：页面隐藏时 `requestAnimationFrame` 暂停，恢复后第一个 `dt` 覆盖了整段后台时间，被算成一次 0.09 fps 的采样。平均 59.7 fps、564 个样本（约 0.94 个/秒）是健康的。P0.1 已修正：

- 隐藏期间不计入 FPS；
- 可见状态下 >2 s 的间隔单独记为 `longFrames`，不再混入 `min`。

---

## 4. 延迟 90 ms 怎么理解

- 10 ms `baseLatency` 正常，80 ms `outputLatency` 是主要来源，通常是车机 Android 音频 HAL / DSP / 功放链路决定的；
- 浏览器上报值不等于真实声学延迟，实际可能更高；需要节拍器主观确认；
- 换 Worklet 不会降低这部分输出延迟，它只改善合成质量与主线程稳定性；
- 对“连续发动机声浪”，90 ms 的参数变化延迟可以被发动机惯性/涡轮感部分掩盖；对“踩下就轰”的瞬时响应，会明显偏慢；
- 若最终要求 <30 ms 的踏板响应，浏览器方案可能不够，需要原生音频或 OEM 音频接口。这个判断要等 HTTPS 下用节拍器再确认一次。

---

## 5. 还需要补的测试

- [ ] 用 **HTTPS 域名**重新打开，确认 `secureContext=true`；
- [ ] 确认 `AudioWorklet` / Blob / 同源 URL / Node 四项通过，且 `heartbeatCount > 0`；
- [ ] 1 分钟快速稳定性 + 10 分钟完整稳定性各跑一次；
- [ ] 节拍器主观判断：画面闪与 click 的先后，是否明显晚于画面；
- [ ] 竖屏/旋转后的布局与可读性（本次只有横屏 1152 × 956）；
- [ ] 全屏按钮是否真的能隐藏 NioBrowser 的地址栏/工具栏（本次 `fullscreen=false`，未点）；
- [ ] 切导航/语音助手时声音是否继续，或暂停后能否点页面恢复；
- [ ] 拍横屏 + 竖屏照片，确认字体/按钮在车机上的实际观感；
- [ ] 主观听感：确认音、发动机、左/右声道是否都听到；降级音只用于稳定性，不代表最终音色。

---

## 6. 下一步

1. **先解决部署**：把同一份 `dist/` 放到 HTTPS 域名下，不要在车机上用 `http://IP` 测试。NioBrowser/Chrome 128 在 HTTP 下一定会隐藏 `AudioWorklet`。
2. **重跑 1 分钟**：看 Worklet 是否 pass、心跳是否约 100 ms 一次。
3. **再跑 10 分钟**：重点看切后台/导航后的 `audio-state`、`heartbeat-gap` 和用户标记。
4. **确认延迟主观感受**：如果 90 ms 可接受，进入 P1；如果明显不跟手，先决定是接受“连续声浪”交互，还是走原生方案。

> 备注：本次降级发声是一个单锯齿波，只用于验证链路和稳定性，不能用来评价最终声浪质量。
