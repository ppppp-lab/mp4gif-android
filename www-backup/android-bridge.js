// ============================================================
// android-bridge.js — Capacitor AppBridge + Gifski 桥接层（手机版）
// ============================================================
// 作用：将 Android 原生 Capacitor 插件（AppBridge、Gifski）适配为
// 与原有 window.api 完全一致的接口。
// - AppBridge：文件选择、保存、分享、相机、剪贴板等通用能力
// - Gifski：视频探测、帧提取、GIF 编码、体积/耗时采样校准
// 加载顺序：必须先于 renderer.js 加载。
// ============================================================

(function (global) {
  'use strict';

  if (!global.Capacitor || !global.Capacitor.Plugins) {
    console.error('[android-bridge] Capacitor 未就绪，window.api 将不可用');
    return;
  }

  const appBridge = global.Capacitor.Plugins.AppBridge;
  const gifskiPlugin = global.Capacitor.Plugins.Gifski;

  if (!appBridge) {
    console.error('[android-bridge] AppBridge 插件未就绪');
    return;
  }
  if (!gifskiPlugin) {
    console.error('[android-bridge] Gifski 插件未就绪');
    return;
  }

  // ---- 事件订阅帮助函数 ----
  function subscribe(plugin, eventName, cb) {
    if (!plugin) return;
    plugin.addListener(eventName, (payload) => {
      try { cb(payload); } catch (e) { console.error('[android-bridge] ' + eventName + ' 回调异常:', e); }
    });
  }

  // 暴露 window.api，方法与原有接口保持一致
  global.api = {
    // Gifski 检测
    gifskiCheck: () => gifskiPlugin.gifskiCheck(),

    // 探测视频元数据（宽高/旋转/时长/帧率/体积）
    probeVideo: (path) => gifskiPlugin.probeVideo({ path }),

    // 文件选择对话框（multi: boolean）
    openVideoDialog: (multi) =>
      appBridge.openVideoDialog({ multi: !!multi }).then((r) => r && r.paths),

    // 图片选择对话框（PNG/JPG/WEBP/GIF）— 表情包工坊用
    openImageDialog: () =>
      appBridge.openImageDialog().then((r) => r && r.paths),

    // GIF 保存对话框（defaultName: string）
    saveGifDialog: (defaultName) =>
      appBridge.saveGifDialog({ defaultName }).then((r) => r && r.path),

    // Base64 图片保存到文件（用于表情包导出）
    saveBase64: (path, base64) =>
      appBridge.saveBase64({ path, base64 }).then((r) => r && r.success),

    // 读取本地文件为 Base64（GIF 解析兜底）
    readFileBase64: (path) =>
      appBridge.readFileBase64({ path }).then((r) => r && r.base64),

    // 表情包分享临时路径
    getMemeSharePath: (name) =>
      appBridge.getMemeSharePath({ name }).then((r) => r && r.path),

    // 通过 Intent 分享图片到其他应用
    shareImage: (path) =>
      appBridge.shareImage({ path }).then((r) => r && r.success),

    // 调用系统相机拍照
    openCamera: () =>
      appBridge.openCamera().then((r) => r && r.paths),

    // 读取剪贴板中的图片
    getClipboardImage: () =>
      appBridge.getClipboardImage().then((r) => r && r.path),

    // 启动转换（Gifski：系统解码提帧 + gifski 编码）
    startConversion: (params) =>
      gifskiPlugin.encodeGif({
        inputPath: params.inputPath,
        outputPath: params.outputPath,
        startSec: params.startSec || 0,
        durationSec: (params.endSec || 0) - (params.startSec || 0),
        width: params.width || 480,
        height: params.height || -1,
        fps: params.fps || 12,
        quality: params.quality || 85,
        loop: params.loop || 0,
        fast: (params.quality || 85) < 50,
        defaultName: params.defaultName || 'output.gif'
      }).then((r) => r && r.jobId),

    // 取消转换
    cancelConversion: (jobId) =>
      gifskiPlugin.cancelEncode({ jobId }).then((r) => r && r.cancelled),

    // 设备性能基准（Gifski 编码基准）
    benchmark: () =>
      gifskiPlugin.benchmark().then((r) => r && r.seconds),

    // 采样编码预估体积 + 耗时
    probeEstSize: (params) =>
      gifskiPlugin.probeEstSize(params).then((r) => r),

    // 屏幕常亮
    keepScreenOn: () => appBridge.keepScreenOn(),
    releaseScreenOn: () => appBridge.releaseScreenOn(),

    // 退出应用（隐私协议不同意时使用）
    exitApp: () => appBridge.exitApp().then(() => true),

    // 设备内存信息
    getDeviceMemory: () =>
      appBridge.getDeviceMemory().then((r) => r || { totalMB: 2048, availMB: 512 }),

    // 打开输出文件所在位置
    openInFolder: (path) =>
      appBridge.openInFolder({ path }).then((r) => (r && r.success) ? '' : 'error'),

    // 事件订阅（Gifski 事件）
    onProgress: (cb) => subscribe(gifskiPlugin, 'gifski:progress', cb),
    onLog: () => {},
    onDone: (cb) => subscribe(gifskiPlugin, 'gifski:done', cb),
    onError: (cb) => subscribe(gifskiPlugin, 'gifski:error', cb),

    // 表情包工坊：从帧 PNG 编码 GIF
    encodeGifFromFrames: (params) =>
      gifskiPlugin.encodeGifFromFrames(params).then((r) => r && r.jobId)
  };
})(window);
