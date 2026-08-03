# 项目 Bug 与缺陷审查报告

审查时间：2026-07-13
审查范围：mp4-to-gif-android 全项目

## 一、严重 Bug（影响核心功能）

### 1. GifskiPlugin.kt - done 事件缺失（最严重）
- **现象**：Gifski 编码完成后只 `call.resolve(ret)`，从不触发 `gifski:done` 事件
- **影响**：前端 `onDone` 订阅了 `gifski:done` 但永远收不到，导致 Gifski 路径下 UI 永远卡在进度条状态
- **位置**：[GifskiPlugin.kt:240-244](android/app/src/main/java/com/local/mp4gif/GifskiPlugin.kt#L240-L244)
- **修复**：改为立即 resolve 返回 jobId，Thread 内部完成后触发 `gifski:done` 事件

### 2. GifskiPlugin.kt - SAF URI 不处理
- **现象**：`encodeGif` 的 outputPath 直接传给 gifski Rust 端
- **影响**：用户通过 SAF 选择保存路径时，outputPath 是 `content://` URI，gifski Rust 端无法写入，编码失败
- **位置**：[GifskiPlugin.kt:230](android/app/src/main/java/com/local/mp4gif/GifskiPlugin.kt#L230)
- **修复**：参考 FFmpegBridgePlugin，先写缓存文件，完成后复制到 SAF URI

### 3. GifskiPlugin.kt - cancelled 是单例
- **现象**：`private val cancelled = AtomicBoolean(false)` 是插件实例级别
- **影响**：批量转换时一个取消会影响所有任务；无法支持并发
- **位置**：[GifskiPlugin.kt:33](android/app/src/main/java/com/local/mp4gif/GifskiPlugin.kt#L33)
- **修复**：改为 ConcurrentHashMap<jobId, JobState> 管理

### 4. GifskiPlugin.kt - 取消不生效
- **现象**：`cancelEncode` 只设置 cancelled 标志，但前端 `cancelConversion` 只调用 FFmpegBridge
- **影响**：Gifski 任务无法取消
- **位置**：[android-bridge.js:101-102](www/android-bridge.js#L101-L102)
- **修复**：android-bridge.js 的 cancelConversion 同时调用 Gifski cancelEncode

### 5. GifskiPlugin.kt - progress 参数错误
- **现象**：`emitProgress(0.0, frameProgress * 0.7)` 第一参数应该是 frameProgress 而非 0.0；`emitProgress(0.7, 0.7 + frameProgress * 0.3)` 同样错误
- **影响**：frameProgress 字段始终显示 0% 或 70%，无法反映真实帧提取进度
- **位置**：[GifskiPlugin.kt:190, 224](android/app/src/main/java/com/local/mp4gif/GifskiPlugin.kt#L190)
- **修复**：传入正确的 frameProgress 值

### 6. GifskiPlugin.kt - resizeBitmapAspectFill 裁剪视频内容
- **现象**：使用 `maxOf(widthRatio, heightRatio)` 是 aspect-fill 模式
- **影响**：会裁掉视频内容，与 FFmpegBridge 的 `scale=w:-1`（保持宽高比不裁剪）不一致
- **位置**：[GifskiPlugin.kt:262](android/app/src/main/java/com/local/mp4gif/GifskiPlugin.kt#L262)
- **修复**：改为 aspect-fit（用 minOf）或直接等比缩放

### 7. GifskiPlugin.kt - OPTION_CLOSEST 太慢
- **现象**：使用 `MediaMetadataRetriever.OPTION_CLOSEST` 提取帧
- **影响**：OPTION_CLOSEST 需要解码到精确时间点，非常慢；长视频提取帧耗时极长
- **位置**：[GifskiPlugin.kt:163](android/app/src/main/java/com/local/mp4gif/GifskiPlugin.kt#L163)
- **修复**：改为 OPTION_CLOSEST_SYNC（同步最近帧，快很多）

### 8. GifskiPlugin.kt - 异常时 tempPngPaths 未清理
- **现象**：`encodeGifAsync` 抛异常时，临时 PNG 文件不会被清理
- **影响**：磁盘泄漏，长期使用积累大量临时文件
- **位置**：[GifskiPlugin.kt:84-95](android/app/src/main/java/com/local/mp4gif/GifskiPlugin.kt#L84-L95)
- **修复**：在 finally 块中清理

### 9. 批量转换 outputPath 是源文件路径
- **现象**：`outputPath = batch.items[i].path.replace(/\.[^.]+$/, '.gif')`
- **影响**：Android 10+ 沙箱下应用无法直接写入源文件同目录，FFmpeg 会因权限失败
- **位置**：[renderer.js:1178](www/renderer.js#L1178)
- **修复**：批量转换也调用 saveGifDialog 或写入公共 Movies 目录

### 10. FFmpegBridgePlugin.java - saveGifResult NPE 风险
- **现象**：`if (result.getResultCode() == ...)` 未检查 result 为 null
- **影响**：极少数情况下 result 为 null 时 NPE 崩溃
- **位置**：[FFmpegBridgePlugin.java:417](android/app/src/main/java/com/local/mp4gif/FFmpegBridgePlugin.java#L417)
- **修复**：添加 null 检查

### 11. FFmpegBridgePlugin.java - input 缓存文件不清理
- **现象**：`copyUriToCache` 复制到 `input_xxx.mp4`，但从不清理
- **影响**：长期使用积累大量缓存文件，占用存储
- **位置**：[FFmpegBridgePlugin.java:314-328](android/app/src/main/java/com/local/mp4gif/FFmpegBridgePlugin.java#L314-L328)
- **修复**：finalizeConversion 完成后清理输入缓存

### 12. FFmpegBridgePlugin.java - openInFolder 忽略 path 参数
- **现象**：方法接收 path 参数但完全未使用，硬编码打开 Movies 目录
- **影响**：如果用户保存到其他位置，"打开输出文件夹"按钮打开的是错误的目录
- **位置**：[FFmpegBridgePlugin.java:941-972](android/app/src/main/java/com/local/mp4gif/FFmpegBridgePlugin.java#L941-L972)
- **修复**：尝试解析 path 中的目录并打开

### 13. probeEstSize 的 smaller 参数永远 false
- **现象**：`smaller: eff.quality === 'smaller'`，但 eff.quality 是数字
- **影响**：用户降低质量时，采样预估不反映质量变化
- **位置**：[renderer.js:242, 915](www/renderer.js#L242)
- **修复**：FFmpeg 路径下根据 quality 数值映射 smaller 布尔值

### 14. togglePlay 中 play() Promise 未处理
- **现象**：`v.play()` 返回 Promise，未 catch
- **影响**：自动播放策略拒绝时无提示，UI 状态不同步
- **位置**：[renderer.js:622](www/renderer.js#L622)
- **修复**：添加 .catch 处理

## 二、次要 Bug / 代码质量问题

### 15. GifskiPlugin.kt - call.resolve 在 mainHandler.post 中
- 编码完成回调在主线程 post 执行，延迟 resolve，建议直接在 Worker 线程 resolve（Capacitor 支持）

### 16. GifskiPlugin.kt - inputPath 的 content:// 处理是死代码
- FFmpegBridge 总是返回文件绝对路径，content:// 分支永远不会触发

### 17. estimate.js - getQualityFactor 字符串分支是死代码
- renderer.js 中 quality 总是数字（parseInt），字符串分支永远不会触发

### 18. estimate.js - estimateTime 中 calibPixelsPerSec 可能为 0
- 如果 _calibWidth/_calibHeight/_calibFps 为 0，会除零，需保护

### 19. renderer.js - onProgress 用 UI 文本反推数据
- `parseFloat(dom.progressPct.textContent)` 是反模式，应该用 state 保存进度值

### 20. FFmpegBridgePlugin.java - cancelConversion 不等 session 真正结束
- FFmpegKit.cancel 是异步的，前端立即 finishConvertUI 可能出现 race condition

### 21. GifskiPlugin.kt - PNG 中间文件效率低
- 逐帧 PNG 编码 + gifski 再解码，性能瓶颈；但受 expo-gifski API 限制无法直接传 Bitmap

### 22. android-bridge.js - Gifski 失败回退 FFmpeg 时不清理 Gifski 临时文件
- 回退时会遗留 tempPngPaths

### 23. styles.css - .preview min-height 55vh 在小屏可能挤压参数面板

### 24. renderer.js - loadVideo 中 state.fps = state.fps || 12 冗余
- fps 是用户设置，不应在 loadVideo 时重置

### 25. estimate.js - shrinkDuration 中 fps 下降可能太快
- 每减 2 秒降一次 fps，长视频可能快速降到 5fps

## 三、修复优先级

**P0（必须修复，影响核心功能）**：1, 2, 3, 4, 5, 6, 7, 8, 9, 10
**P1（建议修复，改善体验）**：11, 12, 13, 14
**P2（可选修复，代码质量）**：15-25
