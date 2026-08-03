// ============================================================
// renderer.js — 渲染进程主入口（移动端 · Capacitor）
// MP4 转 GIF 限大小工具 · 全部界面交互逻辑
// ============================================================
// 依赖（普通 <script> 顺序加载，先于此文件）：
//   android-bridge.js → window.api（桥接 Capacitor FFmpegBridge 插件）
//   estimate.js       → window.Estimate
//   commands.js        → window.Commands
// 与桌面版差异：移除全部拖拽逻辑（移动端无拖拽），新增移动端 DOM 重排。
// ============================================================

(function () {
  'use strict';

  // ============ DOM 引用 ============
  const $ = (id) => document.getElementById(id);
  const dom = {
    ffmpegStatus: $('ffmpegStatus'), ffmpegVer: $('ffmpegVer'),
    dropzone: $('dropzone'), dropzoneText: $('dropzoneText'),
    btnSelectFile: $('btnSelectFile'),
    resSelect: $('resSelect'), customWhWrap: $('customWhWrap'),
    customWidth: $('customWidth'), customHeight: $('customHeight'),
    fpsRange: $('fpsRange'), fpsVal: $('fpsVal'),
    qualityRange: $('qualityRange'), qualityVal: $('qualityVal'),
    loopInfinite: $('loopInfinite'), loopCustom: $('loopCustom'), loopCount: $('loopCount'),
    paletteToggle: $('paletteToggle'),
    btnReset: $('btnReset'),

    previewWrap: $('previewWrap'), emptyState: $('emptyState'),
    videoPlayer: $('videoPlayer'), previewControls: $('previewControls'), playBtn: $('playBtn'),
    timelineWrap: $('timelineWrap'),
    timelineStartLabel: $('timelineStartLabel'), timelineEndLabel: $('timelineEndLabel'),
    startSlider: $('startSlider'), endSlider: $('endSlider'), trackFill: $('trackFill'),
    startInput: $('startInput'), endInput: $('endInput'),
    fileInfo: $('fileInfo'), infoName: $('infoName'), infoRes: $('infoRes'),
    infoDuration: $('infoDuration'), infoFps: $('infoFps'), infoSize: $('infoSize'),
    btnChangeVideo: $('btnChangeVideo'),

    gaugeValue: $('gaugeValue'), gaugeStatus: $('gaugeStatus'),
    gaugeFill: $('gaugeFill'), gaugePalette: $('gaugePalette'),
    gaugeEstText: $('gaugeEstText'), btnRecompute: $('btnRecompute'),
    limitToggle: $('limitToggle'), limitMB: $('limitMB'), strategyGroup: $('strategyGroup'),
    btnDockLimit: $('btnDockLimit'),
    btnExport: $('btnExport'), progressFill: $('progressFill'),
    progressPct: $('progressPct'),
    btnCancel: $('btnCancel'),
    logPre: $('logPre'), btnClearLog: $('btnClearLog'),

    modalOverlay: $('modalOverlay'), modalBox: $('modalBox'),
    modalTitle: $('modalTitle'), modalBody: $('modalBody'), modalActions: $('modalActions'),
    toastWrap: $('toastWrap'),
  };

  // ============ 应用状态 ============
  // 集中持有用户意图参数；recompute 时派生 effective（实际导出参数）。
  const state = {
    sourcePath: null,
    sourceMeta: { width: 0, height: 0, duration: 0, fps: 0, sizeBytes: 0 },
    startSec: 0,
    endSec: 0,
    width: 480,        // 输出宽（预设值=宽度）
    height: -1,        // -1 表示等比（命令 scale=w:-1）
    fps: 12,
    loop: 0,
    palette: true,
    quality: 85,
    limit20: false,
    sizeLimitMB: parseFloat(localStorage.getItem('sizeLimitMB')) || Estimate.DEFAULT_MAX_MB,
    strategy: 1,
    ffmpegAvailable: false,
    effective: null,   // recompute 派生的实际导出参数
    converting: false,
    jobId: null,
    convertStartMs: 0,   // 转换开始的时间戳（Date.now()）
  };

  // 计时器（保留结构，实际功能已移除）
  let _timerInterval = null;
  function startTimer() { stopTimer(); }
  function stopTimer() {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  }

  // 支持的视频扩展名
  const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm'];
  const MAX_SRC_MB = 150;

  // ============ 工具函数 ============
  function pathToFileUrl(p) {
    if (!p) return '';
    if (/^file:/i.test(p)) return p;
    // Capacitor Android：用 convertFileSrc 把本地文件路径转为 WebView 可加载的
    // https://localhost/_capacitor_file_/... URL，避免 https→file 混合内容拦截
    if (window.Capacitor && window.Capacitor.convertFileSrc) {
      return window.Capacitor.convertFileSrc(p);
    }
    // 桌面 Electron 兜底：file:/// + 路径
    const cleaned = String(p).replace(/\\/g, '/');
    if (cleaned.startsWith('/')) return 'file://' + cleaned;
    return 'file:///' + cleaned;
  }
  function basename(p) { return String(p).replace(/[\\/]/g, '/').split('/').pop(); }
  function stripExt(name) { return name.replace(/\.[^.]+$/, ''); }
  function hasVideoExt(name) {
    const lower = name.toLowerCase();
    return VIDEO_EXTS.some((e) => lower.endsWith(e));
  }
  function formatBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
  }
  function fmtTime(s) {
    if (!isFinite(s)) return '0.0';
    return s.toFixed(1) + 's';
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ============ 启动流程 ============
  async function init() {
    // 1. FFmpeg 检测：更新状态灯；失败禁用导入与导出。
    try {
      const res = await window.api.ffmpegCheck();
      state.ffmpegAvailable = !!res.available;
      if (res.available) {
        dom.ffmpegStatus.classList.add('ok');
        dom.ffmpegVer.textContent = res.version || '已就绪';
      } else {
        dom.ffmpegStatus.classList.remove('ok');
        dom.ffmpegVer.textContent = '未安装';
        showModal({
          title: '未找到系统 FFmpeg',
          body: '未检测到系统 FFmpeg，请先安装并将 <strong>ffmpeg</strong> 加入环境变量 PATH，再重启本工具。<br><br>导入与导出功能已禁用。',
          actions: [{ label: '我知道了', type: 'primary' }],
        });
        setImportEnabled(false);
        dom.btnExport.disabled = true;
      }
    } catch (e) {
      state.ffmpegAvailable = false;
      dom.ffmpegStatus.classList.remove('ok');
      dom.ffmpegVer.textContent = '检测失败';
      showToast('FFmpeg 检测失败：' + (e.message || e), 'error');
    }

    bindEvents();
    resetGaugeAndCmd();

    // 2. 后台运行性能校准（不阻塞启动，校准完成后自动刷新预估耗时）
    if (state.ffmpegAvailable && window.api.benchmark) {
      window.api.benchmark().then((benchSec) => {
        if (benchSec && benchSec > 0) {
          Estimate.setDeviceBench(benchSec);
          appendLog('info', '性能校准完成：基准编码 ' + benchSec.toFixed(2) + 's');
          // 若已有视频导入，刷新预估
          if (state.sourcePath) recompute();
        } else {
          appendLog('info', '性能校准不可用，使用保守估算');
        }
      }).catch(() => {
        // 校准失败，不影响使用，退化为公式估算
      });
    }

    // 初始化体积上限值（从 localStorage 恢复）
    dom.limitMB.value = state.sizeLimitMB;
    updateDockLimitDisplay();
  }

  function setImportEnabled(en) {
    dom.dropzone.style.opacity = en ? '1' : '0.5';
    dom.btnSelectFile.disabled = !en;
  }

  // ============ 采样校准：用真实编码测体积+耗时 ============
  function runContentCalibration() {
    if (!state.ffmpegAvailable || !state.sourcePath || !window.api.probeEstSize) return;
    // 取当前输出参数（与 recompute 中 effective 一致）
    const src = state.sourceMeta;
    const outW = state.width;
    const outH = state.height > 0 ? state.height : Estimate.computeHeight(outW, src.width, src.height);
    const fps = state.fps;
    const palette = state.palette;
    const quality = state.quality;

    const videoDur = state.endSec - state.startSec;
    // 采样时长：取 2 秒或视频时长的 30%（取较小值），最少 1 秒
    // 2 秒采样比 1 秒更准：FFmpeg 初始化开销分摊更合理
    const sampleSec = Math.max(1.0, Math.min(2.0, videoDur * 0.3));
    if (videoDur < 1.0) return; // 视频太短，不校准

    // 采样位置：截取区间中间（更代表平均复杂度，避免开头黑屏/logo）
    const sampleStart = state.startSec + (videoDur - sampleSec) / 2;

    dom.gaugeEstText.innerHTML = '校准中…';

    window.api.probeEstSize({
      inputPath: state.sourcePath,
      startSec: sampleStart,
      width: outW,
      height: outH,
      fps: fps,
      palette: palette,
      // 直接传质量值（1-100），原生层据此自动选择抖动/缩放算法和 max_colors
      qualityValue: typeof quality === 'number' ? quality : (quality === 'smaller' ? 30 : 85),
      sampleSec: sampleSec
    }).then((r) => {
      if (r && r.bytes > 0 && r.elapsedMs > 0) {
        // 每秒视频输出的字节数 = 实际字节数 / 采样秒数
        // 体积预估偏高 15%，略微保守避免实际超限
        const bytesPerSec = r.bytes / r.sampleSec * 1.15;
        // 每秒视频的编码耗时 = 实际耗时 / 采样秒数
        // 不加额外系数，由 estimateTime 中的 durationScale 修正长视频误差
        const timePerSec = (r.elapsedMs / 1000) / r.sampleSec;
        Estimate.setContentCalibration(
          bytesPerSec, timePerSec,
          outW, outH, fps,
          palette, quality
        );
        appendLog('info', '采样校准完成：' + (r.bytes / 1024).toFixed(1) + 'KB/' + r.sampleSec + 's，编码耗时 ' + (r.elapsedMs / 1000).toFixed(2) + 's，每秒耗时 ' + timePerSec.toFixed(2) + 's/s');
        // 刷新预估
        if (state.sourcePath) recompute();
      } else {
        appendLog('info', '采样校准失败，使用公式估算');
        if (state.sourcePath) recompute();
      }
    }).catch(() => {
      appendLog('info', '采样校准异常，使用公式估算');
      if (state.sourcePath) recompute();
    });
  }

  // 更新 Dock 上限制数字的显示
  function updateDockLimitDisplay() {
    dom.btnDockLimit.textContent = state.sizeLimitMB + ' MB';
  }

  // 修改体积上限（带校验和持久化）
  function setSizeLimit(mb) {
    const val = clamp(parseFloat(mb) || Estimate.DEFAULT_MAX_MB, 1, 100);
    state.sizeLimitMB = val;
    dom.limitMB.value = val;
    localStorage.setItem('sizeLimitMB', String(val));
    updateDockLimitDisplay();
    recompute();
  }

  // ============ 事件绑定 ============
  function bindEvents() {
    // ---- 点击拖拽区 = 选择文件（移动端：点击/触摸触发选择器） ----
    dom.dropzone.addEventListener('click', () => {
      if (!state.ffmpegAvailable || dom.btnSelectFile.disabled) return;
      dom.btnSelectFile.click();
    });

    dom.btnSelectFile.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!state.ffmpegAvailable) return;
      const paths = await window.api.openVideoDialog(false);
      if (paths && paths.length) loadVideo(paths[0]);
    });

    // ---- 移动端：点击空状态区 / 预览区触发导入 ----
    // 移动端 topbar 的 dropzone-wrap 被隐藏，"点击导入视频" 空状态需可点击
    dom.emptyState.addEventListener('click', () => {
      if (!state.ffmpegAvailable) return;
      window.api.openVideoDialog(false).then((paths) => {
        if (paths && paths.length) loadVideo(paths[0]);
      });
    });
    // 视频已加载后，双击预览区可更换视频
    dom.previewWrap.addEventListener('dblclick', () => {
      if (!state.ffmpegAvailable || !state.sourcePath) return;
      if (state.converting) { showToast('正在转换中，请先中断或等待完成', 'warn'); return; }
      window.api.openVideoDialog(false).then((paths) => {
        if (paths && paths.length) loadVideo(paths[0]);
      });
    });

    // ---- 移动端"更换视频"按钮 ----
    if (dom.btnChangeVideo) {
      dom.btnChangeVideo.addEventListener('click', () => {
        if (!state.ffmpegAvailable) return;
        if (state.converting) { showToast('正在转换中，请先中断或等待完成', 'warn'); return; }
        window.api.openVideoDialog(false).then((paths) => {
          if (paths && paths.length) loadVideo(paths[0]);
        });
      });
    }

    // ---- 点击视频区域：显示/隐藏播放控制 ----
    dom.previewWrap.addEventListener('click', (e) => {
      if (!state.sourcePath) return; // 无视频时不处理（空状态有自己的点击逻辑）
      if (e.target === dom.playBtn) return; // 按钮自身点击由 togglePlay 处理
      const v = dom.videoPlayer;
      if (!v.src) return;
      if (dom.previewControls.classList.contains('show-ctrl')) {
        // 控制按钮可见时，点击视频切换播放/暂停
        togglePlay();
      } else {
        // 控制按钮隐藏时，先显示出来
        dom.previewControls.classList.add('show-ctrl');
        clearTimeout(togglePlay._hideTimer);
        if (!v.paused) {
          // 正在播放中，短暂显示后自动隐藏
          togglePlay._hideTimer = setTimeout(() => {
            dom.previewControls.classList.remove('show-ctrl');
          }, 1200);
        }
        // 暂停状态下按钮一直显示
      }
    });

    // ---- 参数面板 ----
    dom.resSelect.addEventListener('change', () => {
      dom.customWhWrap.classList.toggle('hidden', dom.resSelect.value !== 'custom');
      recompute();
    });
    dom.customWidth.addEventListener('input', recompute);
    dom.customHeight.addEventListener('input', recompute);
    dom.fpsRange.addEventListener('input', () => {
      dom.fpsVal.textContent = dom.fpsRange.value;
      recompute();
    });
    dom.loopInfinite.addEventListener('change', recompute);
    dom.loopCustom.addEventListener('change', recompute);
    dom.loopCount.addEventListener('input', recompute);
    dom.paletteToggle.addEventListener('change', recompute);
    dom.qualityRange.addEventListener('input', () => {
      dom.qualityVal.textContent = dom.qualityRange.value;
      recompute();
    });
    dom.btnReset.addEventListener('click', resetParams);

    // ---- 限制/策略 ----
    dom.limitToggle.addEventListener('change', () => {
      dom.strategyGroup.classList.toggle('hidden', !dom.limitToggle.checked);
      recompute();
    });
    dom.limitMB.addEventListener('change', () => {
      setSizeLimit(dom.limitMB.value);
    });
    dom.limitMB.addEventListener('input', () => {
      // 实时预览但不持久化（change 时才存）
      const val = clamp(parseFloat(dom.limitMB.value) || state.sizeLimitMB, 1, 100);
      state.sizeLimitMB = val;
      updateDockLimitDisplay();
      recompute();
    });
    // Dock 上的限制按钮：点击弹窗修改
    dom.btnDockLimit.addEventListener('click', async () => {
      const choice = await showChoice(
        '体积上限',
        '当前上限 ' + state.sizeLimitMB + ' MB，选择新上限：',
        [
          { label: '5 MB', value: '5' },
          { label: '10 MB', value: '10' },
          { label: '20 MB', value: '20' },
          { label: '50 MB', value: '50' },
          { label: '100 MB', value: '100' },
        ]
      );
      if (choice) setSizeLimit(choice);
    });
    document.querySelectorAll('input[name="strategy"]').forEach((r) =>
      r.addEventListener('change', recompute)
    );
    dom.btnRecompute.addEventListener('click', recompute);

    // ---- 时间轴：双滑块 ----
    dom.startSlider.addEventListener('input', onStartSliderInput);
    dom.endSlider.addEventListener('input', onEndSliderInput);
    dom.startInput.addEventListener('change', onStartInputChange);
    dom.endInput.addEventListener('change', onEndInputChange);
    // 快捷截取
    document.querySelectorAll('[data-cut]').forEach((b) =>
      b.addEventListener('click', () => {
        const n = parseInt(b.dataset.cut, 10);
        setRange(0, Math.min(n, state.sourceMeta.duration));
      })
    );

    // ---- 预览播放 ----
    dom.playBtn.addEventListener('click', togglePlay);

    // ---- 导出 / 中断 / 日志 ----
    dom.btnExport.addEventListener('click', onExportClick);
    dom.btnCancel.addEventListener('click', onCancelClick);
    dom.btnClearLog.addEventListener('click', () => {
      dom.logPre.innerHTML = '<span class="log-empty">暂无日志</span>';
    });

    // ---- 主进程回调注册（仅注册一次） ----
    window.api.onProgress((p) => {
      const pct = Math.round(clamp(p.percent || 0, 0, 100));
      dom.progressFill.style.width = pct + '%';
      dom.progressPct.textContent = pct + '%';
    });
    window.api.onLog((l) => appendLog(l.stream, l.line));
    window.api.onDone((d) => onConversionDone(d));
    window.api.onError((e) => onConversionError(e));

    // 双滑块 z-index：endSlider 在上，便于拇指重叠时优先抓取终点
    dom.endSlider.style.zIndex = '3';
    dom.startSlider.style.zIndex = '2';
  }

  // ============ 文件导入 ============
  async function loadVideo(path) {
    if (!state.ffmpegAvailable) return;
    if (state.converting) {
      showToast('正在转换中，请先中断或等待完成', 'warn');
      return;
    }
    try {
      const meta = await window.api.probeVideo(path);
      state.sourcePath = path;
      state.sourceMeta = meta;
      state.startSec = 0;
      state.endSec = meta.duration;
      state.fps = state.fps || 12;

      // 视频元素
      dom.videoPlayer.src = pathToFileUrl(path);
      dom.videoPlayer.style.display = 'block';
      dom.emptyState.style.display = 'none';
      dom.previewWrap.classList.add('has-video');
      dom.previewControls.style.display = 'flex';
      dom.previewControls.classList.add('show-ctrl');
      dom.timelineWrap.style.display = 'block';
      dom.fileInfo.style.display = 'flex';

      // 时间轴范围
      const dur = meta.duration;
      dom.startSlider.min = 0; dom.startSlider.max = dur; dom.startSlider.step = 0.1; dom.startSlider.value = 0;
      dom.endSlider.min = 0; dom.endSlider.max = dur; dom.endSlider.step = 0.1; dom.endSlider.value = dur;
      dom.startInput.max = dur; dom.endInput.max = dur;
      dom.startInput.value = '0'; dom.endInput.value = dur.toFixed(1);

      // 文件信息卡片
      dom.infoName.textContent = basename(path);
      dom.infoRes.textContent = meta.width + ' × ' + meta.height;
      dom.infoDuration.textContent = meta.duration.toFixed(2) + 's';
      dom.infoFps.textContent = meta.fps.toFixed(2) + ' fps';
      const sizeMB = meta.sizeBytes / 1024 / 1024;
      dom.infoSize.textContent = formatBytes(meta.sizeBytes);
      dom.infoSize.classList.toggle('warn', sizeMB > MAX_SRC_MB);
      if (sizeMB > MAX_SRC_MB) {
        showToast('源文件过大（' + sizeMB.toFixed(1) + 'MB > 150MB），不建议转换，但可继续', 'warn');
      }

      // 导入成功提示 + 启用导出
      dom.btnExport.disabled = false;
      // 重置色样为中性
      setPaletteSwatches(neutralPalette());
      // 清除旧校准，用新视频重新采样
      Estimate.clearContentCalibration();
      recompute();

      // 3. 后台采样校准：编码 0.5 秒 GIF 测得真实体积 + 耗时，替换硬编码系数
      runContentCalibration();
    } catch (e) {
      // 探测失败：文件损坏或格式不支持（非转换上下文，直接弹模态）
      appendLog('stderr', '探测失败：' + (e.message || e));
      showModal({
        title: '源文件损坏',
        body: '文件无法读取，可能已损坏或格式不支持。<br><span class="muted mono">' + escapeHtml(e.message || String(e)) + '</span>',
        actions: [{ label: '知道了', type: 'primary' }],
        error: true,
      });
    }
  }

  // ============ 时间轴：双滑块与输入 ============
  function onStartSliderInput() {
    let s = parseFloat(dom.startSlider.value);
    if (s >= state.endSec - 0.1) s = state.endSec - 0.1;
    if (s < 0) s = 0;
    state.startSec = s;
    dom.startInput.value = s.toFixed(1);
    seekVideo(s);
    updateTimelineVisual();
    recompute();
  }
  function onEndSliderInput() {
    let e = parseFloat(dom.endSlider.value);
    if (e <= state.startSec + 0.1) e = state.startSec + 0.1;
    if (e > state.sourceMeta.duration) e = state.sourceMeta.duration;
    state.endSec = e;
    dom.endInput.value = e.toFixed(1);
    seekVideo(e);
    updateTimelineVisual();
    recompute();
  }
  function onStartInputChange() {
    let s = parseFloat(dom.startInput.value);
    if (isNaN(s)) s = 0;
    s = clamp(s, 0, state.endSec - 0.1);
    state.startSec = s;
    dom.startSlider.value = s;
    dom.startInput.value = s.toFixed(1);
    seekVideo(s);
    updateTimelineVisual();
    recompute();
  }
  function onEndInputChange() {
    let e = parseFloat(dom.endInput.value);
    if (isNaN(e)) e = state.sourceMeta.duration;
    e = clamp(e, state.startSec + 0.1, state.sourceMeta.duration);
    state.endSec = e;
    dom.endSlider.value = e;
    dom.endInput.value = e.toFixed(1);
    seekVideo(e);
    updateTimelineVisual();
    recompute();
  }

  function setRange(start, end) {
    state.startSec = clamp(start, 0, state.sourceMeta.duration);
    state.endSec = clamp(end, state.startSec + 0.1, state.sourceMeta.duration);
    dom.startSlider.value = state.startSec;
    dom.endSlider.value = state.endSec;
    dom.startInput.value = state.startSec.toFixed(1);
    dom.endInput.value = state.endSec.toFixed(1);
    seekVideo(state.startSec);
    updateTimelineVisual();
    recompute();
  }

  // 仅更新视觉（滑块/输入/填充），不触发 recompute
  function updateTimelineVisual() {
    const dur = state.sourceMeta.duration || 1;
    const s = state.startSec;
    const e = state.endSec;
    dom.timelineStartLabel.textContent = s.toFixed(1) + 's';
    dom.timelineEndLabel.textContent = e.toFixed(1) + 's';
    dom.trackFill.style.left = (s / dur) * 100 + '%';
    dom.trackFill.style.width = ((e - s) / dur) * 100 + '%';
  }

  // 策略2 应用时反映实际截取区间（不修改 state.endSec，仅视觉）
  function renderTimelineDisplay() {
    const dur = state.sourceMeta.duration || 1;
    const showEnd = (state.limit20 && state.strategy === 2 && state.effective)
      ? state.effective.endSec : state.endSec;
    dom.startSlider.value = state.startSec;
    dom.endSlider.value = showEnd;
    dom.startInput.value = state.startSec.toFixed(1);
    dom.endInput.value = showEnd.toFixed(1);
    dom.timelineStartLabel.textContent = state.startSec.toFixed(1) + 's';
    dom.timelineEndLabel.textContent = showEnd.toFixed(1) + 's';
    dom.trackFill.style.left = (state.startSec / dur) * 100 + '%';
    dom.trackFill.style.width = ((showEnd - state.startSec) / dur) * 100 + '%';
  }

  function seekVideo(t) {
    try { dom.videoPlayer.currentTime = t; } catch (_) { /* ignore */ }
  }
  function togglePlay() {
    const v = dom.videoPlayer;
    if (!v.src) return;
    if (v.paused) {
      // play() 返回 Promise，自动播放策略可能拒绝（如非用户手势触发）
      // 必须捕获，否则会抛出未处理的 Promise 警告，且 UI 状态不同步
      const playPromise = v.play();
      if (playPromise && typeof playPromise.then === 'function') {
        playPromise.then(() => {
          dom.playBtn.textContent = '❚❚';
          dom.previewControls.classList.add('show-ctrl');
          clearTimeout(togglePlay._hideTimer);
          togglePlay._hideTimer = setTimeout(() => {
            dom.previewControls.classList.remove('show-ctrl');
          }, 800);
        }).catch((err) => {
          // 自动播放被拒绝：保持暂停状态，显示播放按钮
          dom.playBtn.textContent = '▶';
          dom.previewControls.classList.add('show-ctrl');
          clearTimeout(togglePlay._hideTimer);
        });
      } else {
        dom.playBtn.textContent = '❚❚';
        dom.previewControls.classList.add('show-ctrl');
        clearTimeout(togglePlay._hideTimer);
        togglePlay._hideTimer = setTimeout(() => {
          dom.previewControls.classList.remove('show-ctrl');
        }, 800);
      }
    } else {
      v.pause();
      dom.playBtn.textContent = '▶';
      dom.previewControls.classList.add('show-ctrl');
      clearTimeout(togglePlay._hideTimer);
    }
  }

  // ============ 参数同步：UI → state ============
  function syncUItoState() {
    // 输出分辨率（预设值=宽度，高度等比）
    const resVal = dom.resSelect.value;
    if (resVal === 'custom') {
      let w = parseInt(dom.customWidth.value, 10);
      if (!w || w < 32) w = state.sourceMeta.width || 480;
      if (w % 2 !== 0) w -= 1;
      let h = parseInt(dom.customHeight.value, 10);
      if (isNaN(h) || h <= 0) h = -1;
      else if (h % 2 !== 0) h -= 1;
      state.width = w;
      state.height = h;
    } else {
      state.width = parseInt(resVal, 10);
      state.height = -1;
    }
    state.fps = parseInt(dom.fpsRange.value, 10) || 12;
    state.loop = dom.loopCustom.checked ? (parseInt(dom.loopCount.value, 10) || 0) : 0;
    state.palette = dom.paletteToggle.checked;
    state.quality = parseInt(dom.qualityRange.value, 10) || 85;
    state.limit20 = dom.limitToggle.checked;
    const sRadio = document.querySelector('input[name="strategy"]:checked');
    state.strategy = sRadio ? parseInt(sRadio.value, 10) : 1;
  }

  // ============ recompute：核心刷新 ============
  // 职责：1) 估算体积 2) 更新预算计 3) 应用限制策略派生 effective 4) 更新命令预览
  function recompute() {
    if (!state.sourcePath) { resetGaugeAndCmd(); return; }
    syncUItoState();

    const src = state.sourceMeta;
    // 实际输出高度：height=-1 时等比计算（用于预估；命令仍用 -1）
    const outW = state.width;
    const outH = state.height > 0 ? state.height : Estimate.computeHeight(outW, src.width, src.height);
    const duration = Math.max(0.01, state.endSec - state.startSec);

    // 原始预估（用户当前参数，未应用策略）
    const rawEst = Estimate.estimateGifSize(outW, outH, duration, state.fps, state.palette, state.quality);

    // effective：实际用于命令与导出的参数
    let effective = {
      width: outW, height: state.height,
      startSec: state.startSec, endSec: state.endSec,
      fps: state.fps, loop: state.loop,
      palette: state.palette, quality: state.quality,
      estMB: rawEst, failed: false,
    };
    let strategyNote = '';

    if (state.limit20) {
      if (state.strategy === 1) {
        // 策略1：固定时长缩分辨率
        const r = Estimate.shrinkResolution(
          state.startSec, state.endSec, outW, src.width, src.height,
          state.fps, state.palette, state.quality, state.sizeLimitMB
        );
        effective.width = r.width;
        effective.height = r.height;
        effective.estMB = r.estMB;
        effective.failed = !!r.failed;
        strategyNote = `策略1 · 适配至 ${r.width}×${r.height}` + (r.failed ? '（已到下限仍超限）' : ' · 达标');
      } else {
        // 策略2：固定分辨率缩时长
        const r = Estimate.shrinkDuration(
          state.startSec, state.endSec, outW, outH,
          state.fps, state.palette, state.quality, state.sizeLimitMB
        );
        effective.endSec = r.newEndSec;
        effective.fps = r.fps;
        effective.estMB = r.estMB;
        effective.failed = !!r.failed;
        strategyNote = `策略2 · 时长缩至 ${r.newEndSec.toFixed(1)}s，FPS ${r.fps}` + (r.failed ? '（已到下限仍超限）' : ' · 达标');
      }
    }
    state.effective = effective;

    // 更新预算计
    updateGauge(effective.estMB);

    // 更新预估文本
    let estText;
    if (state.limit20) {
      estText = `目标上限 ${state.sizeLimitMB}MB · ${strategyNote} · 预估 <strong>${effective.estMB.toFixed(2)} MB</strong>`;
    } else {
      estText = `预估输出 <strong>${effective.estMB.toFixed(2)} MB</strong>（未启用限制）`;
    }
    dom.gaugeEstText.innerHTML = estText;

    // 预估转换耗时（传入 quality 参数，内容采样校准 > 设备校准 > 公式）
    const estSeconds = Estimate.estimateTime(effective.width, outH, duration, effective.fps, effective.palette, effective.quality);
    // 策略2 时反映实际截取区间
    renderTimelineDisplay();
  }

  // ============ 体积预算计更新 ============
  function updateGauge(estMB) {
    const ratio = estMB / state.sizeLimitMB;
    const fillPct = clamp(ratio * 100, 0, 100);
    dom.gaugeFill.style.width = fillPct + '%';

    // 颜色：<0.7 绿、0.7~0.95 琥珀、>0.95 红
    let cls = '';
    if (ratio > 0.95) cls = 'over';
    else if (ratio > 0.7) cls = 'near';
    dom.gaugeFill.classList.toggle('near', cls === 'near');
    dom.gaugeFill.classList.toggle('over', cls === 'over');

    dom.gaugeValue.textContent = estMB.toFixed(2);
    dom.gaugeValue.classList.toggle('over', cls === 'over');
    dom.gaugeValue.classList.toggle('near', cls === 'near');

    // 状态标签
    let status, statusCls = '';
    if (ratio > 1) { status = '超限'; statusCls = 'over'; }
    else if (ratio > 0.95) { status = '接近上限'; statusCls = 'over'; }
    else if (ratio > 0.7) { status = '预算紧'; statusCls = 'near'; }
    else { status = '预算内'; statusCls = ''; }
    dom.gaugeStatus.textContent = status;
    dom.gaugeStatus.classList.toggle('over', statusCls === 'over');
    dom.gaugeStatus.classList.toggle('near', statusCls === 'near');
  }

  function resetGaugeAndCmd() {
    updateGauge(0);
    dom.gaugeValue.textContent = '0.00';
    dom.gaugeStatus.textContent = state.sourcePath ? '计算中' : '待导入';
    dom.gaugeEstText.innerHTML = state.sourcePath ? '计算中…' : '导入视频后显示预估';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ============ 调色板色样 ============
  function neutralPalette() {
    return ['#2E333D', '#33384a', '#3a4150', '#424b5c', '#4a5366', '#525c75', '#5b6685', '#677090'];
  }
  function vibrantPalette() {
    return ['#FF6B3D', '#F59E0B', '#FACC15', '#4ADE80', '#22D3EE', '#60A5FA', '#A78BFA', '#F472B6'];
  }
  function setPaletteSwatches(colors) {
    const swatches = dom.gaugePalette.querySelectorAll('.gauge-swatch');
    swatches.forEach((el, i) => { el.style.background = colors[i] || '#2E333D'; });
  }

  // ============ 重置参数 ============
  function resetParams() {
    dom.resSelect.value = '480';
    dom.customWhWrap.classList.add('hidden');
    dom.customWidth.value = '';
    dom.customHeight.value = '';
    dom.fpsRange.value = 12; dom.fpsVal.textContent = '12';
    dom.loopInfinite.checked = true;
    dom.loopCount.value = 0;
    dom.paletteToggle.checked = true;
    dom.qualityRange.value = 85; dom.qualityVal.textContent = '85';
    if (state.sourcePath) {
      // 保留文件，恢复起止为全长
      state.startSec = 0;
      state.endSec = state.sourceMeta.duration;
      dom.startSlider.value = 0;
      dom.endSlider.value = state.sourceMeta.duration;
      dom.startInput.value = '0';
      dom.endInput.value = state.sourceMeta.duration.toFixed(1);
      updateTimelineVisual();
    }
    recompute();
    showToast('参数已重置', 'ok');
  }

  // ============ 导出流程 ============
  async function onExportClick() {
    if (!state.sourcePath) { showToast('请先导入视频', 'warn'); return; }
    if (state.converting) return;
    if (!state.ffmpegAvailable) { showToast('FFmpeg 不可用', 'error'); return; }

    // 开限制且策略失败 → 弹兜底对话框
    if (state.limit20 && state.effective && state.effective.failed) {
      const choice = await showChoice(
        `无法在 ${state.sizeLimitMB}MB 内达标`,
        `当前参数即使在最低限制下仍超出 ${state.sizeLimitMB}MB 上限。请选择处理方式：`,
        [
          { label: '手动裁剪时长', value: 'cut' },
          { label: '手动降分辨率', value: 'res' },
          { label: '关闭限制直接导出', value: 'off', type: 'primary' },
        ]
      );
      if (choice === 'cut') { dom.timelineWrap.scrollIntoView({ behavior: 'smooth' }); dom.endSlider.focus(); return; }
      if (choice === 'res') { dom.resSelect.scrollIntoView({ behavior: 'smooth' }); dom.resSelect.focus(); return; }
      if (choice === 'off') { dom.limitToggle.checked = false; dom.strategyGroup.classList.add('hidden'); }
      else return; // 取消
    }

    recompute();
    const eff = state.effective;

    // 导出前用当前最终参数重新校准（确保预估准确）
    await ensureCalibrated(eff);

    // 弹出 SAF 让用户选保存路径
    const defaultName = stripExt(basename(state.sourcePath)) + '.gif';
    const outputPath = await window.api.saveGifDialog(defaultName);
    if (!outputPath) return; // 用户取消

    // 组装 params（height 为等比计算值或 -1）
    const params = {
      inputPath: state.sourcePath,
      outputPath: outputPath, // SAF URI 或缓存路径
      startSec: eff.startSec,
      endSec: eff.endSec,
      width: eff.width,
      height: eff.height, // -1 表示等比，主进程用 scale=w:-1
      fps: eff.fps,
      loop: eff.loop,
      palette: eff.palette,
      quality: eff.quality,
      defaultName: defaultName,
    };

    // 启动转换
    startConvertUI(params, outputPath);
  }

  // 确保校准数据与当前参数匹配，不匹配则重新校准
  async function ensureCalibrated(eff) {
    if (!window.api.probeEstSize || !state.sourceMeta) return;
    const src = state.sourceMeta;
    const outH = eff.height > 0 ? eff.height : Estimate.computeHeight(eff.width, src.width, src.height);
    const videoDur = eff.endSec - eff.startSec;
    if (videoDur < 1.0) return;

    // 采样时长：取 2 秒或视频时长的 30%（取较小值），最少 1 秒
    const sampleSec = Math.max(1.0, Math.min(2.0, videoDur * 0.3));
    // 采样位置：截取区间中间（更代表平均复杂度）
    const sampleStart = eff.startSec + (videoDur - sampleSec) / 2;

    // 检查当前校准是否匹配（参数变化即重新校准）
    const needCalib = !Estimate.hasContentCalibration() ||
      Math.abs(eff.width - Estimate._calibWidth()) > 2 ||
      Math.abs(outH - Estimate._calibHeight()) > 2 ||
      Math.abs(eff.fps - Estimate._calibFps()) > 0 ||
      eff.palette !== Estimate._calibPalette() ||
      eff.quality !== Estimate._calibQuality();

    if (!needCalib) return;

    try {
      const r = await window.api.probeEstSize({
        inputPath: state.sourcePath,
        startSec: sampleStart,
        width: eff.width,
        height: outH,
        fps: eff.fps,
        palette: eff.palette,
        // 直接传质量值（1-100），原生层据此自动选择抖动/缩放算法和 max_colors
        qualityValue: typeof eff.quality === 'number' ? eff.quality : (eff.quality === 'smaller' ? 30 : 85),
        sampleSec: sampleSec
      });
      if (r && r.bytes > 0 && r.elapsedMs > 0) {
        const bytesPerSec = r.bytes / r.sampleSec * 1.15;
        const timePerSec = (r.elapsedMs / 1000) / r.sampleSec;
        Estimate.setContentCalibration(
          bytesPerSec, timePerSec,
          eff.width, outH, eff.fps,
          eff.palette, eff.quality
        );
        appendLog('info', '最终校准完成：' + (r.bytes / 1024).toFixed(1) + 'KB/' + r.sampleSec + 's，编码耗时 ' + (r.elapsedMs / 1000).toFixed(2) + 's，每秒耗时 ' + timePerSec.toFixed(2) + 's/s');
        // 刷新预估显示
        recompute();
      }
    } catch (e) {
      appendLog('info', '最终校准失败，使用现有预估');
    }
  }

  // 启动单次转换 UI + 调用
  // 导出期间需禁用的控件列表（除 btnCancel 外全部禁用）
  const interactiveControls = () => [
    dom.btnSelectFile,
    dom.resSelect, dom.customWidth, dom.customHeight,
    dom.fpsRange,
    dom.loopInfinite, dom.loopCustom, dom.loopCount,
    dom.paletteToggle,
    dom.btnReset,
    dom.playBtn,
    dom.startSlider, dom.endSlider, dom.startInput, dom.endInput,
    dom.btnChangeVideo,
    dom.btnRecompute,
    dom.limitToggle, dom.limitMB,
    dom.btnExport,
    dom.btnClearLog,
    // 质量滑块
    dom.qualityRange,
    // 策略单选按钮
    document.querySelector('input[name="strategy"][value="1"]'),
    document.querySelector('input[name="strategy"][value="2"]'),
  ];

  function lockUI() {
    interactiveControls().forEach(el => { if (el) el.disabled = true; });
  }

  function unlockUI() {
    interactiveControls().forEach(el => { if (el) el.disabled = false; });
    // btnExport 由 finishConvertUI 单独控制
  }

  async function startConvertUI(params, outputPath) {
    state.converting = true;
    state.convertStartMs = Date.now();
    startTimer();
    lockUI();
    dom.btnCancel.classList.remove('hidden');
    document.getElementById('progressWrap').classList.remove('hidden');
    dom.progressFill.style.width = '0%';
    dom.progressPct.textContent = '0%';
    showToast('导出中，除终止按键外已锁定，无法操作', 'info');
    appendLog('info', '开始转换：' + params.outputPath);
    // 保持屏幕常亮
    if (window.api.keepScreenOn) { try { await window.api.keepScreenOn(); } catch(e) {} }

    // 注册降级时 jobId 更新回调（Gifski→FFmpeg 自动降级后新 jobId 需同步到 state）
    window._updateConversionJobId = (newJobId) => {
      if (state.converting) {
        state.jobId = newJobId;
        appendLog('info', '引擎降级，新任务ID：' + newJobId);
      }
    };

    try {
      const jobId = await window.api.startConversion(params);
      state.jobId = jobId;
    } catch (e) {
      onConversionError({ kind: 'generic', message: e.message || String(e), raw: e });
    }
  }

  function onConversionDone(d) {
    appendLog('info', '转换完成：' + d.outputPath);
    dom.progressFill.style.width = '100%';
    dom.progressPct.textContent = '100%';

    setPaletteSwatches(vibrantPalette());

    finishConvertUI();

    showToast('导出完成', 'ok', 2000);

    // 弹出跳转按钮：导出完成后可一键跳转到表情包工坊继续加工
    const outputPath = d.outputPath || '';
    const encodedPath = encodeURIComponent(outputPath);
    showModal({
      title: '导出完成',
      body: 'GIF 已成功导出。<br>可以去表情包工坊继续加工，加文字、贴纸等。',
      actions: [
        {
          label: '去工坊加工',
          type: 'primary',
          onClick: () => {
            location.href = 'meme.html?gif=' + encodedPath;
            return false; // 不关闭弹窗，直接跳转
          },
        },
        { label: '完成', type: 'ghost' },
      ],
    });
  }

  // 异常分发：按 kind 弹友好错误
  function onConversionError(e) {
    // 用户主动取消的 error 不弹框，静默处理
    if (e.kind === 'cancelled') {
      finishConvertUI();
      return;
    }
    appendLog('stderr', '错误：' + (e.message || e.raw || '未知错误'));

    const kind = e.kind || 'generic';
    let title = '转换出错';
    let body = e.message || '发生未知错误。';
    switch (kind) {
      case 'ffmpeg-missing':
        title = 'FFmpeg 不可用';
        body = '未找到系统 FFmpeg，请安装并配置环境变量后重启。';
        break;
      case 'source-corrupt':
        title = '源文件损坏';
        body = '文件无法读取，可能已损坏或格式不支持。';
        break;
      case 'disk':
        title = '保存失败';
        body = '保存路径不可写，请检查磁盘权限或更换路径。';
        break;
      case 'timeout':
        title = '转换超时';
        body = '转换超时，可尝试缩短时长或降低分辨率后重试。';
        break;
      default:
        break;
    }

    finishConvertUI();
    showModal({ title, body, actions: [{ label: '知道了', type: 'primary' }], error: true });
  }

  function finishConvertUI() {
    state.converting = false;
    state.jobId = null;
    stopTimer();
    unlockUI();
    dom.btnExport.disabled = !state.sourcePath;
    dom.btnCancel.classList.add('hidden');
    document.getElementById('progressWrap').classList.add('hidden');
    // 清理降级回调
    window._updateConversionJobId = null;
    // 取消屏幕常亮
    if (window.api.releaseScreenOn) { try { window.api.releaseScreenOn(); } catch(e) {} }
  }

  async function onCancelClick() {
    if (!state.jobId) return;
    // 立即标记为非转换状态并更新 UI，防止残余进度事件继续刷新
    state.converting = false;
    dom.progressPct.textContent = '中断中…';
    appendLog('info', '正在中断…');
    const jobId = state.jobId;  // 保存 jobId，finishConvertUI 会清空
    finishConvertUI();
    dom.progressFill.style.width = '0%';
    dom.progressPct.textContent = '0%';
    // 异步发送取消请求到原生端
    try { await window.api.cancelConversion(jobId); }
    catch (e) { /* ignore */ }
    appendLog('info', '已中断转换');
  }

  // ============ 日志 ============
  function appendLog(stream, line) {
    if (dom.logPre.querySelector('.log-empty')) dom.logPre.innerHTML = '';
    const span = document.createElement('span');
    const isErr = stream === 'stderr' || stream === 'error';
    span.className = isErr ? 'log-stderr' : 'log-stdout';
    span.textContent = (stream === 'stderr' ? '[err] ' : stream === 'info' ? '[i]  ' : '[out] ') + line + '\n';
    dom.logPre.appendChild(span);
    dom.logPre.scrollTop = dom.logPre.scrollHeight;
  }

  // ============ 模态对话框 ============
  function showModal({ title, body, actions, error }) {
    dom.modalTitle.textContent = title || '提示';
    dom.modalBody.innerHTML = body || '';
    dom.modalBox.classList.toggle('modal-error', !!error);
    dom.modalActions.innerHTML = '';
    (actions || [{ label: '确定', type: 'primary' }]).forEach((a) => {
      const btn = document.createElement('button');
      btn.className = 'btn ' + (a.type === 'primary' ? 'btn-primary' : a.type === 'danger' ? 'btn-danger' : a.type === 'ghost' ? 'btn-ghost' : '');
      btn.textContent = a.label;
      btn.addEventListener('click', () => {
        const close = a.onClick ? a.onClick() : true;
        if (close !== false) hideModal();
      });
      dom.modalActions.appendChild(btn);
    });
    dom.modalOverlay.classList.add('show');
  }
  function hideModal() { dom.modalOverlay.classList.remove('show'); }
  dom.modalOverlay && dom.modalOverlay.addEventListener('click', (e) => {
    if (e.target === dom.modalOverlay) hideModal();
  });

  // 带选择的模态：返回 Promise<value>
  function showChoice(title, body, options) {
    return new Promise((resolve) => {
      dom.modalTitle.textContent = title;
      dom.modalBody.innerHTML = body;
      dom.modalBox.classList.remove('modal-error');
      dom.modalActions.innerHTML = '';
      options.forEach((o) => {
        const btn = document.createElement('button');
        btn.className = 'btn ' + (o.type === 'primary' ? 'btn-primary' : '');
        btn.textContent = o.label;
        btn.addEventListener('click', () => { hideModal(); resolve(o.value); });
        dom.modalActions.appendChild(btn);
      });
      dom.modalOverlay.classList.add('show');
    });
  }

  // ============ toast ============
  function showToast(msg, type, duration) {
    const t = document.createElement('div');
    t.className = 'toast ' + (type || '');
    t.textContent = msg;
    dom.toastWrap.appendChild(t);
    const ms = duration || 3200;
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, ms);
  }

  // ============ 启动 ============
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 横竖屏切换时无需特殊处理（单列布局自适应）
})();
