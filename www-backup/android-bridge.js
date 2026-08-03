// ============================================================
// android-bridge.js — Capacitor FFmpegBridge + Gifski 双引擎桥接层
// ============================================================
// 作用：将 Android 原生 Capacitor 插件（FFmpegBridge、Gifski）适配为
// 与桌面 Electron preload.js 一致的 window.api 接口。
// 优先使用 Gifski（FFmpeg 提帧 + Gifski 编码），不可用时回退 FFmpeg 两步调色板。
// 加载顺序：必须先于 renderer.js 加载（在 index.html 中置于首位）。
// ============================================================

(function (global) {
  'use strict';

  // 检测 Capacitor 运行环境
  if (!global.Capacitor || !global.Capacitor.Plugins) {
    console.error('[android-bridge] Capacitor 未就绪，window.api 将不可用');
    return;
  }

  const ffmpegPlugin = global.Capacitor.Plugins.FFmpegBridge;
  const gifskiPlugin = global.Capacitor.Plugins.Gifski;

  if (!ffmpegPlugin) {
    console.error('[android-bridge] FFmpegBridge 插件未就绪');
    return;
  }

  // ---- 事件订阅帮助函数 ----
  function subscribe(plugin, eventName, cb) {
    if (!plugin) return;
    plugin.addListener(eventName, (payload) => {
      try { cb(payload); } catch (e) { console.error('[android-bridge] ' + eventName + ' 回调异常:', e); }
    });
  }

  // 检测 Gifski 是否可用（异步）
  let gifskiAvailable = false;
  async function checkGifski() {
    if (!gifskiPlugin) return false;
    try {
      const res = await gifskiPlugin.gifskiCheck();
      gifskiAvailable = res && res.available;
      if (gifskiAvailable) {
        console.log('[android-bridge] Gifski 已就绪，将优先使用');
      }
      return gifskiAvailable;
    } catch (e) {
      console.warn('[android-bridge] Gifski 检测失败，回退 FFmpeg:', e);
      return false;
    }
  }

  // Gifski → FFmpeg 自动降级机制
  let _fallbackParams = null;
  let _isFallingBack = false;

  // 暴露 window.api，方法签名与桌面 preload.js 一致
  global.api = {
    // FFmpeg 环境检测
    ffmpegCheck: () => ffmpegPlugin.ffmpegCheck(),

    // Gifski 检测
    gifskiCheck: () => checkGifski(),

    // 探测视频元数据（宽高/时长/帧率/体积）
    probeVideo: (filePath) => ffmpegPlugin.probeVideo({ path: filePath }),

    // 文件选择对话框（multi: boolean）
    openVideoDialog: (multi) =>
      ffmpegPlugin.openVideoDialog({ multi: !!multi }).then((r) => r && r.paths),

    // 自定义视频选择器（MediaStore扫描+缩略图+对勾多选）
    openVideoPicker: () =>
      ffmpegPlugin.openVideoPicker().then((r) => r && r.paths),

    // 图片选择对话框（PNG/JPG/WEBP/GIF）— 表情包工坊用
    openImageDialog: () =>
      ffmpegPlugin.openImageDialog().then((r) => r && r.paths),

    // GIF 保存对话框（defaultName: string）
    saveGifDialog: (defaultName) =>
      ffmpegPlugin.saveGifDialog({ defaultName }).then((r) => r && r.path),

    // Base64 图片保存到文件（用于表情包导出）
    saveBase64: (path, base64) =>
      ffmpegPlugin.saveBase64({ path, base64 }).then((r) => r && r.success),

    // 表情包分享临时路径
    getMemeSharePath: (name) =>
      ffmpegPlugin.getMemeSharePath({ name }).then((r) => r && r.path),

    // 通过 Intent 分享图片到其他应用
    shareImage: (path) =>
      ffmpegPlugin.shareImage({ path }).then((r) => r && r.success),

    // 调用系统相机拍照
    openCamera: () =>
      ffmpegPlugin.openCamera().then((r) => r && r.paths),

    // 读取剪贴板中的图片
    getClipboardImage: () =>
      ffmpegPlugin.getClipboardImage().then((r) => r && r.path),

    // 启动转换（双引擎：Gifski 优先，FFmpeg 回退）
    // Gifski 引擎：FFmpeg 批量提帧 + Gifski 编码（帧率由 FFmpeg fps 滤镜控制，画质由 Gifski quality 控制）
    // FFmpeg 引擎：两步调色板流程（palettegen → paletteuse）
    startConversion: async (params) => {
      _isFallingBack = false;
      const canUseGifski = gifskiAvailable || await checkGifski();
      if (canUseGifski) {
        // Gifski 参数映射
        const gifskiParams = {
          inputPath: params.inputPath,
          outputPath: params.outputPath,
          startSec: params.startSec || 0,
          durationSec: (params.endSec || 0) - (params.startSec || 0),
          width: params.width || 480,
          height: params.height || -1,
          fps: params.fps || 12,
          quality: params.quality || 85,
          palette: params.palette !== false,  // 默认 true，传递给 GifskiPlugin 用于 quality 映射
          loop: params.loop || 0,
          fast: (params.quality || 85) < 50,
          defaultName: params.defaultName || 'output.gif'
        };
        // 保存原始参数用于降级
        _fallbackParams = params;
        try {
          const r = await gifskiPlugin.encodeGif(gifskiParams);
          return r && r.jobId ? r.jobId : ('gifski-' + Date.now());
        } catch (e) {
          console.warn('[android-bridge] Gifski 启动失败，回退 FFmpeg:', e);
          _fallbackParams = null;
        }
      }
      // 回退 FFmpeg
      return ffmpegPlugin.startConversion(params).then((r) => r.jobId);
    },

    // 中断转换（同时通知两个引擎）
    cancelConversion: (jobId) => {
      const tasks = [];
      tasks.push(ffmpegPlugin.cancelConversion({ jobId }).then((r) => r && r.cancelled).catch(() => false));
      if (gifskiPlugin) {
        tasks.push(gifskiPlugin.cancelEncode({ jobId }).then((r) => r && r.cancelled).catch(() => false));
      }
      return Promise.all(tasks).then((results) => results.some((x) => x === true));
    },

    // 在文件管理器中打开输出所在目录
    openInFolder: (path) =>
      ffmpegPlugin.openInFolder({ path }).then((r) => (r && r.success ? '' : 'error')),

    // ---- 主进程 → 渲染进程 事件订阅 ----
    onProgress: (cb) => {
      subscribe(ffmpegPlugin, 'conv:progress', cb);
      subscribe(gifskiPlugin, 'gifski:progress', cb);
    },
    onLog: (cb) => subscribe(ffmpegPlugin, 'conv:log', cb),
    onDone: (cb) => {
      subscribe(ffmpegPlugin, 'conv:done', (d) => {
        _fallbackParams = null;
        cb(d);
      });
      subscribe(gifskiPlugin, 'gifski:done', (d) => {
        _fallbackParams = null;
        cb(d);
      });
    },
    onError: (cb) => {
      subscribe(ffmpegPlugin, 'conv:error', (e) => {
        _fallbackParams = null;
        cb(e);
      });
      subscribe(gifskiPlugin, 'gifski:error', (e) => {
        // Gifski 编码失败自动降级到 FFmpeg
        if (_fallbackParams && !_isFallingBack &&
            e.kind !== 'cancelled' && e.kind !== 'invalid' && e.kind !== 'no-frames') {
          _isFallingBack = true;
          console.warn('[android-bridge] Gifski 编码失败，自动降级到 FFmpeg:', e.message);
          const params = _fallbackParams;
          _fallbackParams = null;
          ffmpegPlugin.startConversion(params).then((r) => {
            console.log('[android-bridge] FFmpeg 降级启动成功，jobId:', r && r.jobId);
            if (r && r.jobId && typeof global._updateConversionJobId === 'function') {
              global._updateConversionJobId(r.jobId);
            }
          }).catch((err) => {
            console.error('[android-bridge] FFmpeg 降级启动失败:', err);
            cb(e);
          });
          return;  // 不通知前端，等待 FFmpeg 结果
        }
        _fallbackParams = null;
        cb(e);
      });
    },

    // 性能校准：返回基准编码耗时（秒）
    benchmark: () => ffmpegPlugin.benchmark().then((r) => r && r.seconds),

    // 采样预估：编码 sampleSec 秒 GIF
    probeEstSize: (params) => ffmpegPlugin.probeEstSize(params).then((r) => r),

    // 屏幕常亮控制（导出期间保持屏幕不关）
    keepScreenOn: () => ffmpegPlugin.keepScreenOn(),
    releaseScreenOn: () => ffmpegPlugin.releaseScreenOn(),

    // 获取设备内存信息（总内存MB + 可用内存MB）
    getDeviceMemory: () => ffmpegPlugin.getDeviceMemory().then((r) => r || { totalMB: 2048, availMB: 512 }),

    // 从帧PNG路径列表编码GIF（表情包工坊用）
    encodeGifFromFrames: (params) => {
      if (!gifskiPlugin) return Promise.reject(new Error('Gifski 不可用'));
      return gifskiPlugin.encodeGifFromFrames(params).then((r) => r && r.jobId);
    },
  };

  // 启动时检测 Gifski（不阻塞后续加载）
  checkGifski();
})(window);
