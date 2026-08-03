// ============================================================
// commands.js — FFmpeg 命令字符串拼接（纯函数，仅用于界面预览）
// ============================================================
// 挂载到 window.Commands 命名空间。
// 注意：此处拼接的命令字符串与原生层实际执行保持一致，仅用于在 UI 中
// 向用户展示"将要执行什么命令"。原生层独立构造真实执行参数，
// 本模块不参与实际转换流程。
// 加载顺序：先于 renderer.js。
// ============================================================

(function (global) {
  'use strict';

  // 工具：seek 段
  function seekArgs(startSec, endSec) {
    return `-ss ${startSec} -to ${endSec}`;
  }

  // 工具：scale 段，加 flags=lanczos 提升缩放画质
  function scaleFilter(width, height) {
    const s = height > 0 ? `scale=${width}:${height}` : `scale=${width}:-1`;
    return s + ':flags=lanczos';
  }

  // 工具：循环参数
  function loopArg(loop) {
    return `-loop ${loop}`;
  }

  /**
   * buildPaletteCommand(params) —— 第1步：生成调色板
   * 优化：
   *  - fps=8 降采样：调色板统计不需要每帧，8fps 采样即可，生成速度提升 30-50%
   *  - flags=lanczos：缩放质量优于默认 bicubic
   *  - -threads 0：自动多线程
   */
  function buildPaletteCommand(params) {
    const { inputPath, startSec, endSec, width, height, quality } = params;
    let paletteFilters = `fps=4,${scaleFilter(width, height)},palettegen=stats_mode=diff:reserve_transparent=0`;
    if (quality === 'smaller') {
      paletteFilters += ':max_colors=128';
    }
    return `ffmpeg -y ${seekArgs(startSec, endSec)} -i "${inputPath}" -vf "${paletteFilters}" -threads 0 palette.png`;
  }

  /**
   * buildGifCommand(params) —— 第2步：用调色板生成 GIF
   * 优化：
   *  - flags=lanczos：缩小后边缘更锐利
   *  - dither 算法：balanced → sierra2_4a，smaller → floyd_steinberg（限色下更自然）
   *  - -threads 0：自动多线程
   */
  function buildGifCommand(params) {
    const { inputPath, outputPath, startSec, endSec, width, height, fps, loop, quality } = params;
    const dither = quality === 'smaller' ? 'floyd_steinberg' : 'sierra2_4a';
    const gifFilters = `fps=${fps},${scaleFilter(width, height)}[x];[x][1:v]paletteuse=dither=${dither}`;
    return `ffmpeg -y ${seekArgs(startSec, endSec)} -i "${inputPath}" -i palette.png -filter_complex "${gifFilters}" -threads 0 ${loopArg(loop)} "${outputPath}"`;
  }

  /**
   * buildSimpleGifCommand(params) —— 调色板关闭时的单步命令
   * 不做调色板优化，直接用 GIF 默认 256 色编码器。
   * -threads 0：自动多线程
   */
  function buildSimpleGifCommand(params) {
    const { inputPath, outputPath, startSec, endSec, width, height, fps, loop } = params;
    const filters = `${scaleFilter(width, height)},fps=${fps}`;
    return `ffmpeg -y ${seekArgs(startSec, endSec)} -i "${inputPath}" -vf "${filters}" -threads 0 ${loopArg(loop)} "${outputPath}"`;
  }

  global.Commands = {
    buildPaletteCommand,
    buildGifCommand,
    buildSimpleGifCommand
  };
})(window);
