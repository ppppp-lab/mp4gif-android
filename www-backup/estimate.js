// ============================================================
// estimate.js — GIF 体积预估与双策略降级算法（纯函数）
// ============================================================
// 挂载到 window.Estimate 命名空间，供 renderer.js 调用。
// 不依赖任何外部模块，仅做纯计算，便于单测与替换。
// 加载顺序：先于 renderer.js（普通 <script> 顺序加载）。
// ============================================================

(function (global) {
  'use strict';

  // ====== 阈值常量（集中放置，便于调优） ======
  const DEFAULT_MAX_MB = 20;    // 默认上限（MB）
  const MIN_WIDTH = 160;        // 策略1宽度下限（px）：低于此值画质已不可接受
  const MIN_DURATION = 1;       // 策略2时长下限（秒）：至少保留1秒可观看内容
  const SIZE_COEFF = 0.00000040;  // 体积预估系数（经验值，略偏保守）

  /*
   * 体积预估公式来源与系数含义：
   * ---------------------------------
   * GIF 体积 ≈ 每帧像素数 × 帧总数 × 单像素平均字节数
   *   帧总数 = duration(秒) × fps
   *   每帧像素数 = width × height
   * 单像素平均字节数受 LZW 压缩效率、颜色复杂度、抖动算法影响，
   * 经验上 256 色带调色板优化的 GIF 每像素约 3.5e-7 字节量级（MB）。
   * 故 SIZE_COEFF 直接给出 MB 量级结果：
   *   预估MB = width × height × (duration × fps) × SIZE_COEFF
   * 该系数已综合考虑调色板优化开启时的体积折减（见下方档位系数）。
   * 这是一个保守的粗估值，用于在转换前给用户预期，而非精确预测。
   */

  // 质量档位对体积的影响系数（支持字符串和数字）
  // 反映不同质量档位下的实际参数差异（max_colors、抖动算法、缩放算法等）
  // 以 85 为基准 1.0，各档位系数基于实测校准：
  //   quality<40 → max_colors=64, bayer抖动, bilinear缩放 → 体积约 0.35
  //   quality<60 → max_colors=128, floyd_steinberg抖动, bicubic缩放 → 体积约 0.58
  //   quality<70 → 256色, floyd_steinberg抖动, bicubic缩放 → 体积约 0.75
  //   quality<90 → 256色, sierra2_4a抖动, bicubic缩放 → 体积约 0.95
  //   quality<95 → 256色, sierra2_4a抖动, lanczos缩放 → 体积约 1.0
  //   quality≥95 → 256色, sierra3抖动, lanczos缩放 → 体积约 1.12
  function getQualityFactor(quality) {
    if (typeof quality === 'number') {
      // 分档位映射，比纯线性更准确地反映参数变化对体积的影响
      if (quality < 40) return 0.25 + (quality / 40) * 0.10;   // 0.25~0.35
      if (quality < 60) return 0.35 + ((quality - 40) / 20) * 0.23;  // 0.35~0.58
      if (quality < 70) return 0.58 + ((quality - 60) / 10) * 0.17;  // 0.58~0.75
      if (quality < 90) return 0.75 + ((quality - 70) / 20) * 0.20;  // 0.75~0.95
      if (quality < 95) return 0.95 + ((quality - 90) / 5) * 0.05;   // 0.95~1.0
      return 1.0 + ((quality - 95) / 5) * 0.12;               // 1.0~1.12
    }
    // 字符串质量（兼容旧版 FFmpeg）
    if (quality === 'balanced') return 1.0;
    if (quality === 'smaller') return 0.58;
    return 1.0;
  }

  // 关闭调色板优化时体积上浮系数
  const PALETTE_FACTOR_OFF = 1.15;

  // ====== 内容校准数据（采样编码实测） ======
  var _calibBytesPerSec = null;   // 校准设置下每秒视频输出的字节数
  var _calibTimePerSec = null;    // 校准设置下每秒视频的编码耗时（秒）
  var _calibWidth = 0, _calibHeight = 0, _calibFps = 0;  // 校准时的输出参数
  var _calibPalette = true, _calibQuality = 85;   // 校准时的质量设置（默认 85）

  /**
   * 设置内容校准值（由 renderer.js 在采样编码完成后调用）。
   */
  function setContentCalibration(bytesPerSec, timePerSec, width, height, fps, palette, quality) {
    _calibBytesPerSec = bytesPerSec;
    _calibTimePerSec = timePerSec;
    _calibWidth = width;
    _calibHeight = height;
    _calibFps = fps;
    _calibPalette = palette;
    _calibQuality = quality;
  }

  /** 清除内容校准（切换视频时调用）。 */
  function clearContentCalibration() {
    _calibBytesPerSec = null;
    _calibTimePerSec = null;
  }

  /** 内容校准是否可用。 */
  function hasContentCalibration() { return _calibBytesPerSec != null; }

  /**
   * 估算 GIF 输出体积（MB）。
   *
   * ── 校准模式（_calibBytesPerSec 可用）──
   * 从采样实测值外推。GIF 体积近似线性随 duration 增长，
   * 但 LZW 压缩在高分辨率下效率略高，用 pow(ratio, 0.92) 修正。
   *
   * ── 退化模式 ──
   * 用保守经验常数估算。
   */
  function estimateGifSize(width, height, duration, fps, palette, quality) {
    if (!width || !height || height < 0 || !duration || !fps) return 0;
    const frames = duration * fps;

    if (_calibBytesPerSec != null) {
      // —— 校准模式 ——
      const pixelRatio = (width * height * fps) / (_calibWidth * _calibHeight * _calibFps);
      const sizeScale = Math.pow(pixelRatio, 0.90);
      // 质量修正
      const qRatio = getQualityFactor(quality) / getQualityFactor(_calibQuality);
      // 调色板修正
      let pRatio = 1.0;
      if (!palette && _calibPalette) pRatio = PALETTE_FACTOR_OFF;
      if (palette && !_calibPalette) pRatio = 1.0 / PALETTE_FACTOR_OFF;
      const bytes = _calibBytesPerSec * duration * sizeScale * qRatio * pRatio;
      return bytes / (1024 * 1024);
    }

    // —— 退化模式 ——
    let est = width * height * frames * SIZE_COEFF;
    est *= getQualityFactor(quality);
    if (!palette) est *= PALETTE_FACTOR_OFF;
    return est;
  }

  /**
   * 等比计算高度，并保证结果为偶数（GIF 编码要求宽高均为偶数）。
   */
  function computeHeight(width, srcWidth, srcHeight) {
    if (!srcWidth) return -1;
    return Math.round(width * srcHeight / srcWidth / 2) * 2;
  }

  /**
   * 策略1：固定时长缩分辨率 shrinkResolution（二分查找优化）
   * 在 [MIN_WIDTH, startWidth] 范围内二分查找满足体积限制的最大宽度。
   * 相比线性遍历（逐次减 40px，可能迭代十几次），二分查找仅需 3~4 次即可命中。
   */
  function shrinkResolution(startSec, endSec, startWidth, srcWidth, srcHeight, fps, palette, quality, maxMB) {
    const duration = endSec - startSec;
    let lo = MIN_WIDTH;
    let hi = startWidth;
    if (hi % 2 !== 0) hi -= 1;
    // 确保偶数
    if (lo % 2 !== 0) lo += 1;

    // 先检查最大宽度是否已经满足
    const hiH = computeHeight(hi, srcWidth, srcHeight);
    const hiEst = estimateGifSize(hi, hiH, duration, fps, palette, quality);
    if (hiEst <= maxMB) {
      return { width: hi, height: hiH, estMB: hiEst, failed: false };
    }

    // 二分查找：找到满足 est <= maxMB 的最大宽度
    let bestW = lo;
    let bestH = computeHeight(lo, srcWidth, srcHeight);
    let bestEst = estimateGifSize(lo, lo, duration, fps, palette, quality);

    while (hi - lo > 2) {
      const mid = Math.floor((lo + hi) / 2);
      const midAligned = mid % 2 === 0 ? mid : mid - 1;  // 确保偶数
      const midH = computeHeight(midAligned, srcWidth, srcHeight);
      const midEst = estimateGifSize(midAligned, midH, duration, fps, palette, quality);

      if (midEst <= maxMB) {
        // mid 满足限制，可以尝试更大
        bestW = midAligned;
        bestH = midH;
        bestEst = midEst;
        lo = midAligned + 2;  // 保持偶数
      } else {
        // mid 超限，需要更小
        hi = midAligned - 2;  // 保持偶数
      }
    }

    // 最终检查 lo 和 hi
    for (let w = hi; w >= lo; w -= 2) {
      const h = computeHeight(w, srcWidth, srcHeight);
      const est = estimateGifSize(w, h, duration, fps, palette, quality);
      if (est <= maxMB) {
        return { width: w, height: h, estMB: est, failed: false };
      }
    }

    // 全部超限，返回最小宽度
    const h = computeHeight(MIN_WIDTH, srcWidth, srcHeight);
    const est = estimateGifSize(MIN_WIDTH, h, duration, fps, palette, quality);
    return { width: MIN_WIDTH, height: h, estMB: est, failed: true };
  }

  const FPS_STEPS = [24, 20, 15, 12, 10, 8];

  function nextFpsStep(currentFps) {
    for (let i = FPS_STEPS.length - 1; i >= 0; i--) {
      if (FPS_STEPS[i] < currentFps) return FPS_STEPS[i];
    }
    return 5;
  }

  /**
   * 策略2：固定分辨率缩时长 shrinkDuration（二分查找优化）
   * 
   * 分两阶段：
   * 1. 对每个 fps 档位，二分查找该 fps 下满足体积限制的最大时长
   * 2. 从高 fps 到低 fps 逐级尝试，找到 fps 最高且时长最长的组合
   * 
   * 相比线性遍历（逐次减 1 秒 + 每 2 次降 1 级 fps，可能迭代几十次），
   * 二分查找每个 fps 档位仅需 3~4 次，总迭代次数大幅减少。
   */
  function shrinkDuration(startSec, endSec, width, height, fps, palette, quality, maxMB) {
    const maxDuration = endSec - startSec;

    // 构建要尝试的 fps 序列（从高到低）
    const fpsCandidates = [fps];
    let curFps = fps;
    while (curFps > 5) {
      curFps = nextFpsStep(curFps);
      fpsCandidates.push(curFps);
    }
    fpsCandidates.push(5);

    // 从高 fps 开始，对每个 fps 二分查找最大满足限制的时长
    for (let i = 0; i < fpsCandidates.length; i++) {
      const tryFps = fpsCandidates[i];
      let lo = MIN_DURATION;
      let hi = maxDuration;
      let bestDur = 0;
      let bestEst = 0;

      while (hi - lo > 0.5) {
        const mid = (lo + hi) / 2;
        const est = estimateGifSize(width, height, mid, tryFps, palette, quality);
        if (est <= maxMB) {
          bestDur = mid;
          bestEst = est;
          lo = mid + 0.1;  // 尝试更长
        } else {
          hi = mid - 0.1;  // 需要更短
        }
      }

      // 检查边界值
      const hiEst = estimateGifSize(width, height, hi, tryFps, palette, quality);
      if (hiEst <= maxMB && hi > bestDur) {
        bestDur = hi;
        bestEst = hiEst;
      }

      if (bestDur >= MIN_DURATION) {
        return { newEndSec: startSec + bestDur, fps: tryFps, estMB: bestEst, failed: false };
      }
    }

    // 全部超限，返回最保守值
    const est = estimateGifSize(width, height, MIN_DURATION, 5, palette, quality);
    return { newEndSec: startSec + MIN_DURATION, fps: 5, estMB: est, failed: true };
  }

  // ====== 设备校准数据 ======
  var _deviceBenchSec = null;
  var BENCH_W = 480, BENCH_H = 270, BENCH_DUR = 1, BENCH_FPS = 12;

  function setDeviceBench(seconds) { _deviceBenchSec = seconds; }
  function getDeviceBench() { return _deviceBenchSec; }

  /**
   * 预估 GIF 转换耗时（秒）。
   *
   * ══════════════════════════════════════════════════════════
   * 核心思路：编码耗时 ≈ 每秒视频的编码耗时 × 视频时长 × 修正
   * ══════════════════════════════════════════════════════════
   *
   * 优先级：
   * 1. 内容采样校准（_calibTimePerSec）—— 编码真实视频片段实测
   * 2. 设备基准校准（_deviceBenchSec）—— 仅含设备速度
   * 3. 退化公式 —— 保守经验常数
   *
   * 关键修正 — durationScale：
   * 短采样(2s)的每秒编码耗时远低于长视频的实际每秒耗时，原因：
   * - 短采样受益于 CPU 缓存预热、OS 文件缓存
   * - 长视频受 GC 压力、热降频、内存分配、I/O 瓶颈影响
   * - 实测：2秒采样的 timePerSec 可能是实际每秒耗时的 1/10 ~ 1/30
   * 修正公式：durationScale = pow(duration, 0.6)
   *   duration=2  → 1.32  （采样自身附近，轻微修正）
   *   duration=10 → 3.98
   *   duration=30 → 8.70
   *   duration=60 → 13.1
   *   duration=120 → 19.9
   *   duration=300 → 34.3
   */
  function estimateTime(width, height, duration, fps, palette, quality) {
    if (!width || !height || height < 0 || !duration || !fps) return 0;

    var totalPixels = width * height * duration * fps;
    // 质量对编码时间的影响：质量越高，编码越慢
    var qualityFactor = typeof quality === 'number'
      ? 0.6 + (quality / 85) * 0.4  // q=1 → 0.61, q=85 → 1.0, q=100 → 1.07
      : (quality === 'smaller' ? 0.88 : 1.0);

    // 时长修正：短视频采样偏快，长视频实际更慢
    var durationScale = Math.pow(Math.max(1, duration), 0.6);

    // 1. 内容采样校准（防御除零：校准参数异常时跳过此分支）
    var calibPixelsPerSec = _calibWidth * _calibHeight * _calibFps;
    if (_calibTimePerSec != null && _calibTimePerSec > 0 && calibPixelsPerSec > 0) {
      var targetPixelsPerSec = width * height * fps;
      var pixelRatio = targetPixelsPerSec / calibPixelsPerSec;
      // 像素量外推：线性
      var time = _calibTimePerSec * duration * pixelRatio;
      // 时长修正
      time *= durationScale;
      // 采样时长修正：2秒采样已包含初始化开销，除以 pow(2, 0.6)=1.32 抵消对采样自身的修正
      time /= Math.pow(2, 0.6);
      // 调色板/质量修正
      if (!palette && _calibPalette) time *= 0.45;
      if (palette && !_calibPalette) time /= 0.45;
      time *= qualityFactor;
      // 数字质量：已通过 qualityFactor 处理，无需额外修正
      if (typeof quality === 'string' && typeof _calibQuality === 'string') {
        if (quality === 'smaller' && _calibQuality !== 'smaller') time /= 0.88;
        if (quality !== 'smaller' && _calibQuality === 'smaller') time *= 0.88;
      }
      return Math.max(1, Math.round(time));
    }

    // 2. 设备基准校准（lavfi 纯色源，不含视频解码开销）
    var benchPixels = BENCH_W * BENCH_H * BENCH_DUR * BENCH_FPS;
    if (_deviceBenchSec != null && _deviceBenchSec > 0) {
      var benchRatio = totalPixels / benchPixels;
      var time2 = _deviceBenchSec * benchRatio;
      // 纯色源不含视频解码开销，真实视频额外慢 3 倍
      time2 *= 3.0;
      // 时长修正
      time2 *= durationScale;
      if (!palette) time2 *= 0.45;
      time2 *= qualityFactor;
      return Math.max(1, Math.round(time2));
    }

    // 3. 退化模式（保守经验常数）
    var resFactor = (width * height) / (BENCH_W * BENCH_H);
    var fpsFactor = fps / BENCH_FPS;
    var baseSpeed = palette ? 5.5 : 2.5;
    var time3 = duration * baseSpeed * resFactor * fpsFactor;
    time3 *= qualityFactor;
    return Math.max(1, Math.round(time3));
  }

  global.Estimate = {
    DEFAULT_MAX_MB,
    MIN_WIDTH,
    MIN_DURATION,
    SIZE_COEFF,
    estimateGifSize,
    computeHeight,
    shrinkResolution,
    shrinkDuration,
    estimateTime,
    setDeviceBench,
    getDeviceBench,
    setContentCalibration,
    clearContentCalibration,
    hasContentCalibration,
    // 导出校准参数供检查是否需要重新校准
    _calibWidth: () => _calibWidth,
    _calibHeight: () => _calibHeight,
    _calibFps: () => _calibFps,
    _calibPalette: () => _calibPalette,
    _calibQuality: () => _calibQuality
  };
})(window);
