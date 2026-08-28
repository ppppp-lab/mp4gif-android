/* ============================================================
   meme.js — 表情包工坊（专业版 + 增强功能）
   ============================================================
   架构：
   - layers[] 统一管理文字层和涂鸦图层（有序，后添加的在上方）
   - drawPaths[] 管理画笔涂鸦路径
   - filter {preset, brightness, contrast, saturate}
   - history[] + historyIndex 实现撤销/重做
   - 渲染管线：底图(滤镜) → 边框 → 涂鸦 → 图层 → 选中标记
   
   增强功能：
   - 相机拍摄导入、多格式图片导入、剪贴板导入
   - 橡皮擦、模糊笔刷
   - 平台适配预设、一键加白边、一键圆角、去底色（魔棒抠图）
   - 表情包拼接（横向/纵向）
   - 目标体积精准压缩
   - 用户参数预设
   ============================================================ */

(function () {
  'use strict';

  // ============================================================
  // 模块：字体映射 & 滤镜预设
  // ============================================================

  // ========== 字体映射 ==========
  const FONT_MAP = {
    heavy: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
    impact: 'Impact, "Arial Black", "PingFang SC", sans-serif',
    song: '"Songti SC", "SimSun", "Noto Serif SC", serif',
    kai: '"Kaiti SC", "KaiTi", cursive', // 楷书用cursive回退，Android上有手写感
    mono: '"SF Mono", "Cascadia Code", Consolas, monospace',
  };

  // ========== 滤镜预设 ==========
  const FILTER_PRESETS = {
    none: '',
    gray: 'grayscale(1)',
    sepia: 'sepia(0.8)',
    cold: 'hue-rotate(180deg) saturate(1.2)',
    warm: 'sepia(0.3) saturate(1.3) hue-rotate(-10deg)',
    invert: 'invert(1)',
  };

  const FILTER_PRESET_VALUES = {
    none: { preset: 'none', brightness: 100, contrast: 100, saturate: 100 },
    gray: { preset: 'none', brightness: 100, contrast: 100, saturate: 0 },
    sepia: { preset: 'none', brightness: 105, contrast: 90, saturate: 50 },
    cold: { preset: 'none', brightness: 95, contrast: 110, saturate: 70 },
    warm: { preset: 'none', brightness: 110, contrast: 95, saturate: 130 },
    invert: { preset: 'invert', brightness: 100, contrast: 100, saturate: 100 },
  };

  // ========== 平台预设配置 ==========
  const PLATFORM_PRESETS = {
    wechat:     { width: 300, height: 300, maxSizeKB: 1024, label: t('meme.platform.wechat.name') },
    qq:         { width: 240, height: 240, maxSizeKB: 512,  label: t('meme.platform.qq.name') },
    xiaohongshu:{ width: 360, height: 360, maxSizeKB: 2048, label: t('meme.platform.xiaohongshu.name') },
    douyin:     { width: 360, height: 360, maxSizeKB: 1024, label: t('meme.platform.douyin.name') },
  };

  // ============================================================
  // 模块：常量定义
  // ============================================================
  const ADV_LAYER_LIMIT = 10;        // 高级编辑图层上限
  const MAX_CANVAS_SIZE = 800;       // 画布最大尺寸（提升画质）
  const GIF_MAX_FRAMES = 200;        // GIF 最大帧数
  const MAX_HISTORY = 30;            // 历史记录上限
  const TEXT_DEFAULT_SIZE = 32;      // 默认文字大小
  const TEXT_MAX_SIZE = 80;          // 最大文字大小
  const TEXT_MIN_SIZE = 12;          // 最小文字大小
  const STROKE_DEFAULT = 3;          // 默认描边宽度
  const STROKE_MAX = 8;              // 最大描边宽度
  const BRUSH_DEFAULT = 4;           // 默认画笔粗细
  const BRUSH_MAX = 20;              // 最大画笔粗细
  const BRUSH_MIN = 1;               // 最小画笔粗细
  const MOSAIC_DEFAULT = 10;         // 默认马赛克块大小
  const MOSAIC_MIN = 4;              // 最小马赛克块
  const MOSAIC_MAX = 30;             // 最大马赛克块
  const FILTER_DEFAULT = 100;        // 默认滤镜值
  const FILTER_MAX = 200;            // 最大滤镜值
  const FILTER_MIN = 0;              // 最小滤镜值
  const FPS_DEFAULT = 12;            // 默认帧率
  const QUALITY_DEFAULT = 85;       // 默认质量
  const UNDO_LIMIT = 20;             // 撤销栈上限

  // ============================================================
  // 模块：状态管理
  // ============================================================
  const state = {
    sourceImage: null,
    sourcePath: '',
    sourceName: '',
    canvasWidth: 0,
    canvasHeight: 0,
    layers: [],           // [{type:'text'|'draw', id, ...}]
    drawPaths: [],        // [{type:'pen'|'mosaic'|'eraser'|'blur', shape, color, width, points, size}]
    filter: { preset: 'none', brightness: FILTER_DEFAULT, contrast: FILTER_DEFAULT, saturate: FILTER_DEFAULT },
    border: { style: 'none', width: 8 },
    cropRatio: 'free',
    selectedId: null,     // 选中的图层 ID
    nextId: 1,
    // 画笔
    drawMode: false,            // 是否在画笔 Tab
    drawToolMode: 'pen',        // 'pen' | 'eraser' | 'blur' | 'mosaic'
    drawShape: 'free',          // 'free' | 'line' | 'arrow' | 'rect' | 'ellipse'
    drawColor: '#FF4747',
    brushWidth: BRUSH_DEFAULT,
    mosaicSize: MOSAIC_DEFAULT,
    currentPath: null,
    mosaicCache: null,          // 像素化底图缓存（Canvas）
    mosaicCacheKey: '',         // 缓存键（filter+border+sourcePath）
    // 模糊笔刷底图像素缓存
    blurSourceData: null,
    blurSourceKey: '',
    // 历史
    history: [],
    historyIndex: -1,
    maxHistory: MAX_HISTORY,
    advOverlay: null,
    advLayers: [],
    advCanvasW: 0,
    advCanvasH: 0,
    advDuration: 0,
    gifCurrentTime: 0,
    // GIF 播放（由 index.html/renderer.js 管理，meme 页面只做安全检查）
    isGif: false,
    gifFrames: [],
    gifParsedGif: null,
    gifFrameIdx: 0,
    gifPlaying: false,
    gifRafId: null,
    gifLastTime: 0,
  };

  // ============================================================
  // 模块：DOM 引用
  // ============================================================
  // ========== DOM ==========
  const $ = id => document.getElementById(id);
  const dom = {
    btnBack: $('btnBack'), btnUndo: $('btnUndo'), btnRedo: $('btnRedo'),
    btnShare: $('btnShare'),
    btnExport: $('btnExportMeme'),
    memeEmpty: $('memeEmpty'),
    btnImportGif: $('btnImportGif'),
    canvasWrap: $('canvasWrap'), canvas: $('memeCanvas'),
    memeSource: $('memeSource'), sourceName: $('sourceName'), btnChangeSource: $('btnChangeSource'),
    aiFab: $('aiFab'), aiPanel: $('aiPanel'),
    // 侧边栏
    memeSidebar: $('memeSidebar'),
    // 底部弹出面板
    memePanelOverlay: $('memePanelOverlay'),
    memePanel: $('memePanel'),
    memePanelTitle: $('memePanelTitle'),
    memePanelClose: $('memePanelClose'),
    // 滤镜
    brightnessRange: $('brightnessRange'), brightnessVal: $('brightnessVal'),
    contrastRange: $('contrastRange'), contrastVal: $('contrastVal'),
    saturateRange: $('saturateRange'), saturateVal: $('saturateVal'),
    // 裁剪
    btnApplyCrop: $('btnApplyCrop'), btnResetCrop: $('btnResetCrop'),
    // 平台工具
    btnAddWhiteBorder: $('btnAddWhiteBorder'), btnAddRoundCorner: $('btnAddRoundCorner'),
    // 文字全屏编辑
    textFullscreen: $('textFullscreen'),
    textFsBack: $('textFsBack'), textFsDone: $('textFsDone'),
    textFsCanvas: $('textFsCanvas'),
    textFsInput: $('textFsInput'),
    textFsAdd: $('textFsAdd'), textFsList: $('textFsList'),
    textFsFontChips: $('textFsFontChips'),
    textFsColorChips: $('textFsColorChips'),
    btnTextFsAddColor: $('btnTextFsAddColor'), textFsColorPicker: $('textFsColorPicker'),
    textFsSizeRange: $('textFsSizeRange'), textFsSizeVal: $('textFsSizeVal'),
    textFsStrokeRange: $('textFsStrokeRange'), textFsStrokeVal: $('textFsStrokeVal'),
    textFsRotateRange: $('textFsRotateRange'), textFsRotateVal: $('textFsRotateVal'),
    textFsShadowToggle: $('textFsShadowToggle'),
    textFsDelete: $('textFsDelete'),
    // 画笔全屏编辑
    drawFullscreen: $('drawFullscreen'),
    drawFsBack: $('drawFsBack'), drawFsDone: $('drawFsDone'),
    drawFsCanvas: $('drawFsCanvas'),
    drawFsModeChips: $('drawFsModeChips'),
    drawFsShapeChips: $('drawFsShapeChips'), drawFsShapeGroup: $('drawFsShapeGroup'),
    drawFsColorChips: $('drawFsColorChips'), drawFsColorGroup: $('drawFsColorGroup'),
    btnDrawFsAddColor: $('btnDrawFsAddColor'), drawFsColorPicker: $('drawFsColorPicker'),
    drawFsBrushGroup: $('drawFsBrushGroup'),
    drawFsBrushRange: $('drawFsBrushRange'), drawFsBrushVal: $('drawFsBrushVal'),
    drawFsMosaicGroup: $('drawFsMosaicGroup'),
    drawFsMosaicRange: $('drawFsMosaicRange'), drawFsMosaicVal: $('drawFsMosaicVal'),
    drawFsClear: $('drawFsClear'),
    // 高级剪辑全屏编辑
    advancedFullscreen: $('advancedFullscreen'),
    advFsBack: $('advFsBack'),
    advFsUndo: $('advFsUndo'),
    // advFsAutoKf removed
    // advFsOnion removed
    advFsAddImage: $('advFsAddImage'),
    advFsEmptyAdd: $('advFsEmptyAdd'),
    advFsEmpty: $('advFsEmpty'),
    advFsCanvas: $('advFsCanvas'),
    advFsPlayBtn: $('advFsPlayBtn'),
    advFsTimecode: $('advFsTimecode'),
    advFsDuration: $('advFsDuration'),
    advLayerStrip: $('advLayerStrip'),
    advModeTabs: $('advModeTabs'),
    advModeKeyframe: $('advModeKeyframe'),
    advModeTrack: $('advModeTrack'),
    // advModeRecord removed
    advTrackHint: $('advTrackHint'),
    advTrackStartBtn: $('advTrackStartBtn'),
    advTrackAnchor: $('advTrackAnchor'),
    advFsPosXRange: $('advFsPosXRange'),
    advFsPosYRange: $('advFsPosYRange'),
    advFsScaleRange: $('advFsScaleRange'),
    advFsRotateRange: $('advFsRotateRange'),
    // advFsOpacity removed
    advFsPosXVal: $('advFsPosXVal'),
    advFsPosYVal: $('advFsPosYVal'),
    advFsScaleVal: $('advFsScaleVal'),
    advFsRotateVal: $('advFsRotateVal'),
    // advFsOpacityVal removed
    advFsPosKfBtn: $('advFsPosKfBtn'),
    advFsScaleKfBtn: $('advFsScaleKfBtn'),
    advFsRotateKfBtn: $('advFsRotateKfBtn'),
    advFsTimelineCanvas: $('advFsTimelineCanvas'),
    // 裁剪全屏编辑
    cropFullscreen: $('cropFullscreen'),
    cropFsBack: $('cropFsBack'), cropFsDone: $('cropFsDone'),
    cropFsCanvas: $('cropFsCanvas'),
    cropFsChips: $('cropFsChips'),
    cropFsReset: $('cropFsReset'),
    // 模态
    modalOverlay: $('modalOverlay'), modalTitle: $('modalTitle'),
    modalBody: $('modalBody'), modalActions: $('modalActions'),
    toastWrap: $('toastWrap'),
  };

  const ctx = dom.canvas.getContext('2d');
  const textFsCtx = dom.textFsCanvas.getContext('2d');
  const drawFsCtx = dom.drawFsCanvas.getContext('2d');

  // 裁剪全屏状态
  let cropFs = {
    x: 0, y: 0, w: 0, h: 0,  // 裁剪区域（画布坐标系）
    ratio: 'free',
    dragging: false,
    dragMode: null,  // 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
    startX: 0, startY: 0,
    origX: 0, origY: 0, origW: 0, origH: 0,
  };
  const cropFsCtx = document.getElementById('cropFsCanvas').getContext('2d');

  // 高级剪辑状态
  let adv = {
    bgImage: null,
    videoEl: null,
    videoSrc: null,
    videoDuration: 0,
    videoStart: 0,
    videoEnd: 0,
    layers: [],
    selectedLayerId: null,
    currentTime: 0,
    playing: false,
    playRafId: null,
    playLastTime: 0,
    canvasWidth: MAX_CANVAS_SIZE,
    canvasHeight: MAX_CANVAS_SIZE,
    tlZoom: 1,
    tlScrollX: 0,
    frameCanvas: null,
    frameCtx: null,
    lastFrameTime: -1,
    autoKeyframe: true,
    undoStack: [],
    undoLimit: UNDO_LIMIT,
    isGif: false,
    gifFrameCanvases: [],
    gifFrameTimes: [],
    gifDuration: 0,
    // 新增：模式系统
    mode: 'keyframe',        // 'keyframe' | 'track' | 'record'
    // 新增：洋葱皮
    onionSkin: false,
    // 新增：追踪系统
    trackAnchorX: -1,        // 追踪锚点画布坐标X（-1=未设置）
    trackAnchorY: -1,        // 追踪锚点画布坐标Y
    trackSearchRadius: 30,   // 追踪搜索半径（像素）
    trackTemplateData: null,  // 追踪模板像素数据
    trackTemplateOriginalData: null,  // 追踪原始模板，防止长期更新后漂移
    trackAnchorGifX: -1,     // 锚点在GIF帧坐标系中的位置
    trackAnchorGifY: -1,
    tracking: false,          // 是否正在追踪中
    trackInterval: 1,         // 追踪间隔：每N帧追踪一次（1=每帧，精度最高）
    trackRelativeMode: false, // 相对位置模式：追踪锚点，图层保持相对偏移
    trackRelativeOffsetX: 0,  // 相对位置偏移X（图层位置 - 锚点位置）
    trackRelativeOffsetY: 0,  // 相对位置偏移Y
    trackPointSet: false,     // 是否已设置追踪点（相对模式下）
    // 新增：录制系统
  };
  const advFsCtx = $('advFsCanvas').getContext('2d');
  const advFsTlCtx = $('advFsTimelineCanvas').getContext('2d');

  // ========== 高级剪辑：关键帧系统 ==========

  function addAdvKeyframe(layerId, type, time, value) {
    const layer = adv.layers.find(l => l.id === layerId);
    if (!layer) return;
    const kfs = layer.keyframes[type];
    if (!kfs) return;
    const idx = kfs.findIndex(k => Math.abs(k.t - time) < 0.01);
    if (idx >= 0) {
      Object.assign(kfs[idx], value);
    } else {
      const kf = Object.assign({ t: time }, value);
      kfs.push(kf);
      kfs.sort((a, b) => a.t - b.t);
    }
  }

  function removeAdvKeyframe(layerId, type, time) {
    const layer = adv.layers.find(l => l.id === layerId);
    if (!layer) return;
    const kfs = layer.keyframes[type];
    if (!kfs) return;
    const idx = kfs.findIndex(k => Math.abs(k.t - time) < 0.01);
    if (idx >= 0 && kfs.length > 1) { kfs.splice(idx, 1); }
  }

  /**
   * 精简关键帧：移除位置变化太小的中间关键帧（保留首尾和转折点）
   * 算法：计算每个中间关键帧相对于前后连线的偏移量，偏移量小于阈值的移除
   * @param {Array} kfs - 关键帧数组 [{t, x, y, ...}]
   * @param {string} field - 要精简的字段 'x'|'y'|'s'|'r'
   * @param {number} threshold - 偏移阈值（像素/度），小于此值视为冗余
   * @returns {Array} 精简后的关键帧数组
   */
  function simplifyKeyframes(kfs, field, threshold) {
    if (!kfs || kfs.length <= 2) return kfs;
    // 先提取 {t, val} 对
    const pts = kfs.map(k => ({ t: k.t, val: k[field], ref: k }));
    const keep = new Array(pts.length).fill(false);
    keep[0] = true;
    keep[pts.length - 1] = true;

    // 递归 Douglas-Peucker 式精简
    function dpSimplify(start, end) {
      if (end - start <= 1) return;
      let maxDev = 0, maxIdx = -1;
      const t0 = pts[start].t, v0 = pts[start].val;
      const t1 = pts[end].t, v1 = pts[end].val;
      const dt = t1 - t0;
      if (dt === 0) return;
      for (let i = start + 1; i < end; i++) {
        const ratio = (pts[i].t - t0) / dt;
        const expected = v0 + ratio * (v1 - v0);
        const dev = Math.abs(pts[i].val - expected);
        if (dev > maxDev) { maxDev = dev; maxIdx = i; }
      }
      if (maxDev >= threshold && maxIdx > 0) {
        keep[maxIdx] = true;
        dpSimplify(start, maxIdx);
        dpSimplify(maxIdx, end);
      }
    }
    dpSimplify(0, pts.length - 1);

    const result = pts.filter((_, i) => keep[i]).map(p => p.ref);
    return result;
  }

  /**
   * 对图层的所有关键帧类型执行精简（追踪后调用）
   * @param {object} layer - 图层对象
   */
  function simplifyLayerKeyframes(layer) {
    if (!layer || !layer.keyframes) return;
    // pos 类型需要同时考虑 x 和 y 的偏移
    if (layer.keyframes.pos && layer.keyframes.pos.length > 2) {
      const kfs = layer.keyframes.pos;
      const pts = kfs.map(k => ({ t: k.t, x: k.x, y: k.y, ref: k }));
      const keep = new Array(pts.length).fill(false);
      keep[0] = true; keep[pts.length - 1] = true;
      const threshold = 0.3; // 0.3像素偏移阈值（保留更多关键帧）

      function dpPos(start, end) {
        if (end - start <= 1) return;
        let maxDev = 0, maxIdx = -1;
        const t0 = pts[start].t, x0 = pts[start].x, y0 = pts[start].y;
        const t1 = pts[end].t, x1 = pts[end].x, y1 = pts[end].y;
        const dt = t1 - t0;
        if (dt === 0) return;
        for (let i = start + 1; i < end; i++) {
          const ratio = (pts[i].t - t0) / dt;
          const ex = x0 + ratio * (x1 - x0);
          const ey = y0 + ratio * (y1 - y0);
          const dev = Math.sqrt((pts[i].x - ex) ** 2 + (pts[i].y - ey) ** 2);
          if (dev > maxDev) { maxDev = dev; maxIdx = i; }
        }
        if (maxDev >= threshold && maxIdx > 0) {
          keep[maxIdx] = true;
          dpPos(start, maxIdx);
          dpPos(maxIdx, end);
        }
      }
      dpPos(0, pts.length - 1);
      layer.keyframes.pos = pts.filter((_, i) => keep[i]).map(p => p.ref);
    }
    // scale、rot 用单值精简
    if (layer.keyframes.scale && layer.keyframes.scale.length > 2) {
      layer.keyframes.scale = simplifyKeyframes(layer.keyframes.scale, 's', 0.02);
    }
    if (layer.keyframes.rot && layer.keyframes.rot.length > 2) {
      layer.keyframes.rot = simplifyKeyframes(layer.keyframes.rot, 'r', 1.0);
    }
  }

  function interpolateKf(kfs, time, field) {
    if (!kfs || kfs.length === 0) return 0;
    if (kfs.length === 1) return kfs[0][field];
    if (time <= kfs[0].t) return kfs[0][field];
    if (time >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1][field];
    for (let i = 0; i < kfs.length - 1; i++) {
      if (time >= kfs[i].t && time <= kfs[i + 1].t) {
        const ratio = (time - kfs[i].t) / (kfs[i + 1].t - kfs[i].t);
        return kfs[i][field] + ratio * (kfs[i + 1][field] - kfs[i][field]);
      }
    }
    return kfs[kfs.length - 1][field];
  }

  function getAdvLayerState(layer, time) {
    return {
      x: interpolateKf(layer.keyframes.pos, time, 'x'),
      y: interpolateKf(layer.keyframes.pos, time, 'y'),
      scale: interpolateKf(layer.keyframes.scale, time, 's'),
      rotation: interpolateKf(layer.keyframes.rot, time, 'r'),
      opacity: interpolateKf(layer.keyframes.opacity, time, 'o'),
    };
  }

  function syncAdvancedSliders() {
    const layer = adv.layers.find(l => l.id === adv.selectedLayerId);
    if (!layer) {
      if (dom.advFsPosXVal) dom.advFsPosXVal.textContent = '0';
      if (dom.advFsPosYVal) dom.advFsPosYVal.textContent = '0';
      if (dom.advFsScaleVal) dom.advFsScaleVal.textContent = '100%';
      if (dom.advFsRotateVal) dom.advFsRotateVal.textContent = '0°';
      if (dom.advFsPosKfBtn) dom.advFsPosKfBtn.classList.remove('kf-active');
      if (dom.advFsScaleKfBtn) dom.advFsScaleKfBtn.classList.remove('kf-active');
      if (dom.advFsRotateKfBtn) dom.advFsRotateKfBtn.classList.remove('kf-active');
      return;
    }
    const st = getAdvLayerState(layer, adv.currentTime);
    if (dom.advFsPosXRange) { dom.advFsPosXRange.max = adv.canvasWidth; dom.advFsPosXRange.value = Math.round(st.x); }
    if (dom.advFsPosYRange) { dom.advFsPosYRange.max = adv.canvasHeight; dom.advFsPosYRange.value = Math.round(st.y); }
    if (dom.advFsScaleRange) dom.advFsScaleRange.value = Math.round(st.scale * 100);
    if (dom.advFsRotateRange) dom.advFsRotateRange.value = Math.round(st.rotation);
    if (dom.advFsPosXVal) dom.advFsPosXVal.textContent = Math.round(st.x);
    if (dom.advFsPosYVal) dom.advFsPosYVal.textContent = Math.round(st.y);
    if (dom.advFsScaleVal) dom.advFsScaleVal.textContent = Math.round(st.scale * 100) + '%';
    if (dom.advFsRotateVal) dom.advFsRotateVal.textContent = Math.round(st.rotation) + '°';
    const hasPosKf = layer.keyframes.pos.some(k => Math.abs(k.t - adv.currentTime) < 0.01);
    const hasScaleKf = layer.keyframes.scale.some(k => Math.abs(k.t - adv.currentTime) < 0.01);
    const hasRotKf = layer.keyframes.rot.some(k => Math.abs(k.t - adv.currentTime) < 0.01);
    if (dom.advFsPosKfBtn) dom.advFsPosKfBtn.classList.toggle('kf-active', hasPosKf);
    if (dom.advFsScaleKfBtn) dom.advFsScaleKfBtn.classList.toggle('kf-active', hasScaleKf);
    if (dom.advFsRotateKfBtn) dom.advFsRotateKfBtn.classList.toggle('kf-active', hasRotKf);
  }

  function bindAdvSliders() {
    if (dom.advFsPosXRange) dom.advFsPosXRange.addEventListener('input', () => {
      const layer = adv.layers.find(l => l.id === adv.selectedLayerId);
      if (!layer) return;
      const st = getAdvLayerState(layer, adv.currentTime);
      const newX = parseFloat(dom.advFsPosXRange.value);
      if (dom.advFsPosXVal) dom.advFsPosXVal.textContent = Math.round(newX);
      if (adv.autoKeyframe) addAdvKeyframe(layer.id, 'pos', adv.currentTime, { t: adv.currentTime, x: newX, y: st.y });
      renderAdvancedFs(); renderAdvancedTimeline();
    });
    if (dom.advFsPosYRange) dom.advFsPosYRange.addEventListener('input', () => {
      const layer = adv.layers.find(l => l.id === adv.selectedLayerId);
      if (!layer) return;
      const st = getAdvLayerState(layer, adv.currentTime);
      const newY = parseFloat(dom.advFsPosYRange.value);
      if (dom.advFsPosYVal) dom.advFsPosYVal.textContent = Math.round(newY);
      if (adv.autoKeyframe) addAdvKeyframe(layer.id, 'pos', adv.currentTime, { t: adv.currentTime, x: st.x, y: newY });
      renderAdvancedFs(); renderAdvancedTimeline();
    });
    if (dom.advFsScaleRange) dom.advFsScaleRange.addEventListener('input', () => {
      const layer = adv.layers.find(l => l.id === adv.selectedLayerId);
      if (!layer) return;
      const newS = parseFloat(dom.advFsScaleRange.value) / 100;
      if (dom.advFsScaleVal) dom.advFsScaleVal.textContent = Math.round(newS * 100) + '%';
      if (adv.autoKeyframe) addAdvKeyframe(layer.id, 'scale', adv.currentTime, { t: adv.currentTime, s: newS });
      renderAdvancedFs(); renderAdvancedTimeline();
    });
    if (dom.advFsRotateRange) dom.advFsRotateRange.addEventListener('input', () => {
      const layer = adv.layers.find(l => l.id === adv.selectedLayerId);
      if (!layer) return;
      const newR = parseFloat(dom.advFsRotateRange.value);
      if (dom.advFsRotateVal) dom.advFsRotateVal.textContent = Math.round(newR) + '°';
      if (adv.autoKeyframe) addAdvKeyframe(layer.id, 'rot', adv.currentTime, { t: adv.currentTime, r: newR });
      renderAdvancedFs(); renderAdvancedTimeline();
    });
  }

  // ========== 高级剪辑：模式切换系统 ==========

  function switchAdvMode(mode) {
    adv.mode = mode;
    // 更新标签样式
    document.querySelectorAll('.adv-mode-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.mode === mode);
    });
    // 更新画布区域data属性（光标样式）
    const canvasArea = dom.advFsCanvas ? dom.advFsCanvas.parentElement : null;
    if (canvasArea) canvasArea.setAttribute('data-mode', mode);
    // 显示/隐藏模式提示条
    if (dom.advTrackHint) dom.advTrackHint.classList.toggle('hidden', mode !== 'track');
    // 隐藏追踪锚点
    if (mode !== 'track' && dom.advTrackAnchor) dom.advTrackAnchor.classList.add('hidden');
    // 停止追踪
    if (mode !== 'track') {
      adv.tracking = false;
      adv.trackTemplateData = null;
      adv.trackTemplateOriginalData = null;
    }
    // 重置相对位置模式状态
    if (mode !== 'track') {
      adv.trackRelativeMode = false;
      adv.trackPointSet = false;
      const cb = document.getElementById('advTrackRelativeMode');
      if (cb) cb.checked = false;
      const hintEl = document.getElementById('advTrackHint');
      if (hintEl) hintEl.classList.remove('relative-mode');
    }
    renderAdvancedFs();
  }

  // ========== 高级剪辑：简单特征追踪系统 ==========

  function setTrackAnchor(canvasX, canvasY) {
    adv.trackAnchorX = canvasX;
    adv.trackAnchorY = canvasY;
    // 提取追踪模板（锚点周围的像素块）
    const r = adv.trackSearchRadius;
    const templateCanvas = document.createElement('canvas');
    templateCanvas.width = r * 2;
    templateCanvas.height = r * 2;
    const tctx = templateCanvas.getContext('2d');
    // 从当前背景帧提取模板（需要将编辑器坐标转换为GIF帧坐标）
    if (adv.isGif && advGifAccCanvas) {
      getAdvGifFrameCanvas(adv.currentTime);
      const frameW = advGifAccCanvas.width;
      const frameH = advGifAccCanvas.height;
      // 编辑器坐标 → GIF帧坐标
      const gifX = canvasX * (frameW / adv.canvasWidth);
      const gifY = canvasY * (frameH / adv.canvasHeight);
      adv.trackAnchorGifX = gifX;
      adv.trackAnchorGifY = gifY;
      tctx.drawImage(advGifAccCanvas,
        gifX - r, gifY - r, r * 2, r * 2,
        0, 0, r * 2, r * 2);
    } else if (adv.bgImage) {
      tctx.drawImage(adv.bgImage,
        canvasX - r, canvasY - r, r * 2, r * 2,
        0, 0, r * 2, r * 2);
    }
    adv.trackTemplateData = tctx.getImageData(0, 0, r * 2, r * 2);
    adv.trackTemplateOriginalData = tctx.getImageData(0, 0, r * 2, r * 2);
    // 显示锚点标记
    if (dom.advTrackAnchor) {
      const canvasRect = dom.advFsCanvas.getBoundingClientRect();
      const containerRect = dom.advFsCanvas.parentElement.getBoundingClientRect();
      // 计算canvas相对于容器的偏移（canvas可能居中显示）
      const offsetX = canvasRect.left - containerRect.left;
      const offsetY = canvasRect.top - containerRect.top;
      const scaleX = canvasRect.width / adv.canvasWidth;
      const scaleY = canvasRect.height / adv.canvasHeight;
      dom.advTrackAnchor.style.left = (offsetX + canvasX * scaleX) + 'px';
      dom.advTrackAnchor.style.top = (offsetY + canvasY * scaleY) + 'px';
      dom.advTrackAnchor.classList.remove('hidden');
    }
  }


  function matchTemplate(frameCanvas, startX, startY) {
    // NCC（归一化互相关）模板匹配 + 多级搜索 + 亚像素精化
    // NCC 对光照变化、亮度偏移具有鲁棒性，比 SSD 稳定得多
    const r = adv.trackSearchRadius;
    const template = adv.trackTemplateData;
    if (!template) return { x: startX, y: startY, score: 0 };
    const tw = template.width, th = template.height;
    const tData = template.data;
    const fw = frameCanvas.width, fh = frameCanvas.height;

    const fullImgData = frameCanvas.getContext('2d').getImageData(0, 0, fw, fh);
    const fullData = fullImgData.data;

    // 预计算模板灰度值 & 均值 & 模板归一化项
    const sampleStep = 2; // 采样步长，平衡速度和精度
    const tGray = [];
    let tSum = 0, tCount = 0;
    for (let py = 0; py < th; py += sampleStep) {
      const tRowBase = py * tw * 4;
      for (let px = 0; px < tw; px += sampleStep) {
        const tidx = tRowBase + px * 4;
        const g = (tData[tidx] * 0.299 + tData[tidx + 1] * 0.587 + tData[tidx + 2] * 0.114);
        tGray.push(g);
        tSum += g;
        tCount++;
      }
    }
    const tMean = tSum / tCount;
    let tNormSq = 0;
    for (let i = 0; i < tGray.length; i++) {
      tNormSq += (tGray[i] - tMean) ** 2;
    }
    if (tNormSq < 1e-6) return { x: startX, y: startY, score: 0 };

    // NCC 分数计算（返回 -1 ~ 1，越大越好）
    function computeNCC(cx, cy) {
      if (cx < 0 || cy < 0 || cx + tw > fw || cy + th > fh) return -1;
      let iSum = 0, iCount = 0;
      const iGray = [];
      for (let py = 0; py < th; py += sampleStep) {
        const rowBase = ((cy + py) * fw + cx) * 4;
        for (let px = 0; px < tw; px += sampleStep) {
          const fidx = rowBase + px * 4;
          const g = (fullData[fidx] * 0.299 + fullData[fidx + 1] * 0.587 + fullData[fidx + 2] * 0.114);
          iGray.push(g);
          iSum += g;
          iCount++;
        }
      }
      const iMean = iSum / iCount;
      let iNormSq = 0, crossCorr = 0;
      for (let i = 0; i < tGray.length; i++) {
        const td = tGray[i] - tMean;
        const id = iGray[i] - iMean;
        crossCorr += td * id;
        iNormSq += id * id;
      }
      if (iNormSq < 1e-6) return -1;
      return crossCorr / Math.sqrt(tNormSq * iNormSq);
    }

    // 搜索起点：将中心坐标转为左上角坐标
    const sx = Math.round(startX - r), sy = Math.round(startY - r);

    // 搜索范围：与运动约束对齐，避免“搜到了但判定为越界”导致漂移
    const searchRange = Math.max(80, r * 3);
    const coarseStep = 2;

    // 第1级：粗搜索
    let bestX = sx, bestY = sy, bestScore = computeNCC(sx, sy);
    for (let dy = -searchRange; dy <= searchRange; dy += coarseStep) {
      for (let dx = -searchRange; dx <= searchRange; dx += coarseStep) {
        const cx = sx + dx, cy = sy + dy;
        const score = computeNCC(cx, cy);
        if (score > bestScore) { bestScore = score; bestX = cx; bestY = cy; }
      }
    }

    // 第2级：精搜索（逐像素）
    const fineRange = coarseStep * 2;
    let fineBestX = bestX, fineBestY = bestY, fineBestScore = bestScore;
    for (let dy = -fineRange; dy <= fineRange; dy += 1) {
      for (let dx = -fineRange; dx <= fineRange; dx += 1) {
        const cx = bestX + dx, cy = bestY + dy;
        const score = computeNCC(cx, cy);
        if (score > fineBestScore) { fineBestScore = score; fineBestX = cx; fineBestY = cy; }
      }
    }

    // 亚像素精化：抛物线拟合，在最优位置附近用3点拟合抛物线求极值
    // 限制偏移在 [-1, 1] 范围内，防止分母接近0时产生巨大偏移
    let subX = fineBestX, subY = fineBestY;
    // X方向
    const sLeft = computeNCC(fineBestX - 1, fineBestY);
    const sRight = computeNCC(fineBestX + 1, fineBestY);
    const denomX = sLeft - 2 * fineBestScore + sRight;
    if (Math.abs(denomX) > 1e-6) {
      const offset = 0.5 * (sLeft - sRight) / denomX;
      subX = fineBestX + Math.max(-1, Math.min(1, offset));
    }
    // Y方向
    const sUp = computeNCC(fineBestX, fineBestY - 1);
    const sDown = computeNCC(fineBestX, fineBestY + 1);
    const denomY = sUp - 2 * fineBestScore + sDown;
    if (Math.abs(denomY) > 1e-6) {
      const offset = 0.5 * (sUp - sDown) / denomY;
      subY = fineBestY + Math.max(-1, Math.min(1, offset));
    }

    // 将左上角坐标转回中心坐标
    const resultX = subX + r, resultY = subY + r;
    return { x: resultX, y: resultY, score: fineBestScore };
  }

  function runTracking() {
    const layer = adv.layers.find(l => l.id === adv.selectedLayerId);
    if (!layer) {
      showToast(t('meme.track.needLayer'), 'warn');
      return;
    }
    if (!adv.isGif || !advGifAccCanvas) {
      showToast(t('meme.track.needGif'), 'warn');
      return;
    }
    // 相对位置模式：检查是否已设置追踪点
    if (adv.trackRelativeMode && !adv.trackPointSet) {
      showToast(t('meme.track.needPoint'), 'warn');
      return;
    }

    // 自动从图层当前位置提取追踪模板
    const r = adv.trackSearchRadius;
    const gifW = advGifAccCanvas.width, gifH = advGifAccCanvas.height;
    const scaleX = gifW / adv.canvasWidth;
    const scaleY = gifH / adv.canvasHeight;
    // 图层当前位置（编辑器坐标）
    const st = getAdvLayerState(layer, adv.currentTime);

    // 追踪点坐标（编辑器坐标）
    let trackPointEditorX, trackPointEditorY;
    if (adv.trackRelativeMode && adv.trackPointSet) {
      // 相对模式：追踪用户设置的点
      trackPointEditorX = adv.trackAnchorX;
      trackPointEditorY = adv.trackAnchorY;
      // 计算图层相对于追踪点的偏移
      adv.trackRelativeOffsetX = st.x - trackPointEditorX;
      adv.trackRelativeOffsetY = st.y - trackPointEditorY;
    } else {
      // 普通模式：追踪图层中心位置
      trackPointEditorX = st.x;
      trackPointEditorY = st.y;
    }

    // 编辑器坐标 → GIF帧坐标
    const gifX = trackPointEditorX * scaleX;
    const gifY = trackPointEditorY * scaleY;
    adv.trackAnchorGifX = gifX;
    adv.trackAnchorGifY = gifY;
    // 从当前帧提取模板
    let frameIdx = getGifFrameIdxAtTime(adv.currentTime);
    getAdvGifFrameCanvas(adv.currentTime);
    const templateCanvas = document.createElement('canvas');
    templateCanvas.width = r * 2;
    templateCanvas.height = r * 2;
    const tctx = templateCanvas.getContext('2d');
    tctx.drawImage(advGifAccCanvas,
      gifX - r, gifY - r, r * 2, r * 2,
      0, 0, r * 2, r * 2);
    adv.trackTemplateData = tctx.getImageData(0, 0, r * 2, r * 2);
    adv.trackTemplateOriginalData = tctx.getImageData(0, 0, r * 2, r * 2);

    saveUndoState();
    adv.tracking = true;
    if (dom.advTrackStartBtn) dom.advTrackStartBtn.disabled = true;
    
    // 相对位置模式：在起始帧添加关键帧锁定图层位置
    if (adv.trackRelativeMode && adv.trackPointSet) {
      addAdvKeyframe(layer.id, 'pos', adv.currentTime, { t: adv.currentTime, x: st.x, y: st.y });
    }
    
    // 立即显示反馈弹框
    showModal(t('meme.track.title'), '<div style="text-align:center;padding:16px 0"><div style="font-size:14px;color:#aaa" id="trackProgressText">' + t('meme.track.progress') + '</div></div>', []);

    // 用 setTimeout 让弹框先渲染，再执行耗时追踪
    setTimeout(() => {
      // 追踪在GIF帧坐标系中进行，结果转换回编辑器坐标
      const scaleX = gifW / adv.canvasWidth;
      const scaleY = gifH / adv.canvasHeight;

      let lastX = adv.trackAnchorGifX, lastY = adv.trackAnchorGifY;
      let prevX = lastX, prevY = lastY;
      let velX = 0, velY = 0; // 速度向量，用于运动预测
      const total = _advFrameTimes.length;
      const BATCH_SIZE = 5;
      const TRACK_INTERVAL = adv.trackInterval || 1;
      let trackedFrames = 0;
      // 从当前帧的下一帧开始追踪
      let startFrame = getGifFrameIdxAtTime(adv.currentTime);
      let fi = startFrame + 1;
      if (fi >= total) fi = total - 1;
      // 初始化上一帧编辑器坐标为起始位置
      let prevEditorX = st.x, prevEditorY = st.y;
      // 运动约束：最大允许每帧跳跃的像素数（GIF帧坐标系）
      // 必须不小于搜索范围，否则目标移动稍快就会被误判为不可靠匹配
      const maxFrameJump = Math.max(80, r * 2);
      // NCC 置信度阈值：低于此值认为匹配不可靠
      const NCC_THRESHOLD = 0.25;

      // 模板更新：小幅吸收当前帧外观变化，同时向原始模板回拉，
      // 防止长期追踪时模板逐渐漂移到错误特征上
      function updateTemplate(matchCenterX, matchCenterY, frameCanvas) {
        trackedFrames++;
        const blendRatio = 0.05;
        // 前期允许模板适应外观变化，后期逐渐收紧到原始模板，抑制累积漂移
        const driftCorrection = adv.trackTemplateOriginalData
          ? Math.min(0.35, 0.10 + trackedFrames * 0.01)
          : 0;
        const keepRatio = 1 - blendRatio - driftCorrection;
        const tw = adv.trackTemplateData.width;
        const th = adv.trackTemplateData.height;
        const fc = document.createElement('canvas');
        fc.width = tw; fc.height = th;
        const fctx = fc.getContext('2d');
        fctx.drawImage(frameCanvas,
          matchCenterX - tw / 2, matchCenterY - th / 2, tw, th,
          0, 0, tw, th);
        const newData = fctx.getImageData(0, 0, tw, th);
        const tData = adv.trackTemplateData.data;
        const nData = newData.data;
        const oData = adv.trackTemplateOriginalData ? adv.trackTemplateOriginalData.data : null;
        for (let i = 0; i < tData.length; i += 4) {
          tData[i]     = tData[i]     * keepRatio + nData[i]     * blendRatio + (oData ? oData[i]     * driftCorrection : 0);
          tData[i + 1] = tData[i + 1] * keepRatio + nData[i + 1] * blendRatio + (oData ? oData[i + 1] * driftCorrection : 0);
          tData[i + 2] = tData[i + 2] * keepRatio + nData[i + 2] * blendRatio + (oData ? oData[i + 2] * driftCorrection : 0);
        }
      }

      function trackBatch() {
        const end = Math.min(fi + BATCH_SIZE, total);
        for (; fi < end; fi++) {
          // 只在 TRACK_INTERVAL 的倍数帧执行追踪，其余帧跳过
          if ((fi - startFrame) % TRACK_INTERVAL !== 0 && fi !== total - 1) continue;
          const t = _advFrameTimes[fi];
          // 一阶运动预测：位置 + 速度
          const predictedX = lastX + velX;
          const predictedY = lastY + velY;
          // seek到当前帧
          seekAdvGifToFrame(fi);
          const result = matchTemplate(advGifAccCanvas, predictedX, predictedY);

          // 置信度检查：NCC 分数低于阈值时使用预测位置
          if (result.score < NCC_THRESHOLD) {
            result.x = predictedX;
            result.y = predictedY;
          } else {
            // 运动约束：如果匹配位置距离上一帧位置太远，使用预测位置
            const jumpDist = Math.sqrt((result.x - lastX) ** 2 + (result.y - lastY) ** 2);
            if (jumpDist > maxFrameJump) {
              result.x = predictedX;
              result.y = predictedY;
            } else {
              // 匹配可靠，更新模板以适应外观变化
              updateTemplate(result.x, result.y, advGifAccCanvas);
            }
          }
          // 最终边界检查：确保结果在画面范围内且有效
          if (isNaN(result.x) || isNaN(result.y)) {
            result.x = lastX;
            result.y = lastY;
          }
          result.x = Math.max(r, Math.min(gifW - r, result.x));
          result.y = Math.max(r, Math.min(gifH - r, result.y));

          // 更新速度向量（低通滤波平滑）
          const newVelX = result.x - lastX;
          const newVelY = result.y - lastY;
          velX = velX * 0.3 + newVelX * 0.7;
          velY = velY * 0.3 + newVelY * 0.7;

          prevX = lastX; prevY = lastY;
          lastX = result.x; lastY = result.y;
          // GIF帧坐标 → 编辑器坐标
          const editorX = lastX / scaleX;
          const editorY = lastY / scaleY;
          // 相对位置模式：图层位置 = 追踪点位置 + 偏移量
          const finalX = adv.trackRelativeMode && adv.trackPointSet
            ? editorX + adv.trackRelativeOffsetX
            : editorX;
          const finalY = adv.trackRelativeMode && adv.trackPointSet
            ? editorY + adv.trackRelativeOffsetY
            : editorY;
          // 跳过位置变化太小的帧（避免冗余关键帧）
          const dist = Math.sqrt((finalX - prevEditorX) ** 2 + (finalY - prevEditorY) ** 2);
          if (dist < 0.1 && fi !== total - 1) continue; // 小于0.1像素变化，跳过
          prevEditorX = finalX;
          prevEditorY = finalY;
          addAdvKeyframe(layer.id, 'pos', t, { t: t, x: finalX, y: finalY });
        }
        // 更新进度
        const progressEl = document.getElementById('trackProgressText');
        if (progressEl) progressEl.textContent = t('meme.track.percent', { percent: Math.round(fi / total * 100) });

        if (fi < total) {
          // 还有帧要处理，让出UI线程后继续
          setTimeout(trackBatch, 0);
        } else {
          // 追踪完成
          // 精简关键帧
          const beforeCount = layer.keyframes.pos.length;
          simplifyLayerKeyframes(layer);
          const afterCount = layer.keyframes.pos.length;
          dom.modalOverlay.classList.remove('show');
          adv.tracking = false;
          if (dom.advTrackStartBtn) dom.advTrackStartBtn.disabled = false;
          syncAdvancedSliders();
          renderAdvancedFs();
          renderAdvancedTimeline();
          showToast(t('meme.track.done'), 'success');
        }
      }

      trackBatch();
    }, 30);
  }

  function renderAdvLayerStrip() {
    if (!dom.advLayerStrip) return;
    const strip = dom.advLayerStrip;
    strip.innerHTML = '';
    adv.layers.forEach(layer => {
      const card = document.createElement('div');
      card.className = 'adv-layer-card' + (layer.id === adv.selectedLayerId ? ' selected' : '');
      const tc = document.createElement('canvas');
      tc.width = 48; tc.height = 48;
      const tctx = tc.getContext('2d');
      const iw = layer.image.width, ih = layer.image.height;
      const s = Math.min(48 / iw, 48 / ih);
      const dw = iw * s, dh = ih * s;
      tctx.drawImage(layer.image, (48 - dw) / 2, (48 - dh) / 2, dw, dh);
      card.appendChild(tc);
      const name = document.createElement('div');
      name.className = 'adv-layer-card-name';
      name.textContent = layer.name.slice(0, 4);
      card.appendChild(name);
      card.onclick = () => {
        adv.selectedLayerId = layer.id;
        syncAdvancedSliders(); renderAdvancedFs(); renderAdvLayerStrip(); renderAdvancedTimeline();
      };
      let pressTimer;
      card.addEventListener('touchstart', () => {
        pressTimer = setTimeout(() => {
          showModal(t('meme.layer.deleteTitle'), t('meme.layer.deleteBody', { name: escapeHtml(layer.name) }), [
          { label: t('common.cancel'), type: 'ghost', onClick: () => {} },
          { label: t('common.delete'), type: 'primary', onClick: () => { removeAdvancedLayer(layer.id); renderAdvLayerStrip(); }},
          ]);
        }, 600);
      });
      card.addEventListener('touchmove', () => clearTimeout(pressTimer));
      card.addEventListener('touchend', () => clearTimeout(pressTimer));
      strip.appendChild(card);
    });
    const addBtn = document.createElement('button');
    addBtn.className = 'adv-layer-card-add';
    addBtn.textContent = '＋';
    addBtn.onclick = addAdvancedImage;
    strip.appendChild(addBtn);
  }

  function formatTimecode(seconds) {
    if (!seconds || seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return String(m).padStart(2, '0') + ':' + s.toFixed(2).padStart(5, '0');
  }

  function updateAdvancedTimecode() {
    if (dom.advFsTimecode) dom.advFsTimecode.textContent = formatTimecode(adv.currentTime);
    if (dom.advFsDuration) dom.advFsDuration.textContent = '/ ' + formatTimecode(adv.videoDuration || 0);
  }

  function saveUndoState() {
    const snapshot = adv.layers.map(l => ({
      id: l.id, name: l.name, startTime: l.startTime, endTime: l.endTime, visible: l.visible,
      keyframes: JSON.parse(JSON.stringify(l.keyframes)),
    }));
    adv.undoStack.push(snapshot);
    if (adv.undoStack.length > adv.undoLimit) adv.undoStack.shift();
  }

  function undoAdvanced() {
    if (adv.undoStack.length === 0) return;
    const snapshot = adv.undoStack.pop();
    snapshot.forEach(s => {
      const layer = adv.layers.find(l => l.id === s.id);
      if (layer) {
        layer.startTime = s.startTime;
        layer.endTime = s.endTime;
        layer.visible = s.visible;
        layer.keyframes = s.keyframes;
      }
    });
    syncAdvancedSliders(); renderAdvancedFs(); renderAdvLayerStrip(); renderAdvancedTimeline();
  }

  // ============================================================
  // 模块：事件绑定与初始化
  // ============================================================
  // ========== 初始化 ==========
  function init() {
    bindEvents();
    bindAdvancedFsEvents();
    updateDrawUI();
    const params = new URLSearchParams(location.search);
    const gifPath = params.get('gif');
    const sharedPath = params.get('shared');
    if (gifPath) loadSource(gifPath, true);
    else if (sharedPath) loadSource(sharedPath, true);

    // 监听虚拟键盘弹出/收起，自动调整画布区域
    if (window.visualViewport) {
      const vv = window.visualViewport;
      const app = document.querySelector('.meme-app');
      const handleVvResize = () => {
        app.style.height = vv.height + 'px';
        // 全屏编辑层也要跟随调整
        const tf = document.getElementById('textFullscreen');
        const df = document.getElementById('drawFullscreen');
        const cf = document.getElementById('cropFullscreen');
        if (tf && tf.style.display !== 'none') tf.style.height = vv.height + 'px';
        if (df && df.style.display !== 'none') df.style.height = vv.height + 'px';
        if (cf && cf.style.display !== 'none') cf.style.height = vv.height + 'px';
        const af = document.getElementById('advancedFullscreen');
        if (af && af.style.display !== 'none') af.style.height = vv.height + 'px';
      };
      vv.addEventListener('resize', handleVvResize);
      vv.addEventListener('scroll', handleVvResize);
    }
  }

  // ========== 事件绑定 ==========
  function bindEvents() {
    dom.btnBack.onclick = () => location.href = 'index.html';
    dom.btnImportGif.onclick = importSource;
    dom.btnChangeSource.onclick = importSource;
    // 侧边栏底部按钮
    dom.btnExport.onclick = exportMeme;
    dom.btnShare.onclick = shareMeme;
    dom.btnUndo.onclick = undo;
    dom.btnRedo.onclick = redo;

    // ========== 侧边栏图标点击 ==========
    const TOOL_NAMES = {
      text: t('meme.tool.text'), filter: t('meme.tool.filter'),
      draw: t('meme.tool.draw'), crop: t('meme.tool.crop'), platform: t('meme.tool.platform')
    };
    let currentTool = 'text';

    document.querySelectorAll('.meme-sidebar-btn').forEach(btn => {
      btn.onclick = () => {
        const tool = btn.dataset.tool;
        // 文字 → 打开文字全屏编辑
        if (tool === 'text') {
          openTextFs();
          return;
        }
        // 画笔 → 打开画笔全屏编辑
        if (tool === 'draw') {
          openDrawFs();
          return;
        }
        // 裁剪 → 打开裁剪全屏编辑
        if (tool === 'crop') {
          openCropFs();
          return;
        }
        // 高级 → 打开高级剪辑全屏编辑
        if (tool === 'advanced') {
          openAdvancedFs();
          return;
        }
        // 再次点击同一图标 → 关闭面板
        if (currentTool === tool && dom.memePanel.classList.contains('open')) {
          closePanel();
          return;
        }
        // 切换工具
        currentTool = tool;
        document.querySelectorAll('.meme-sidebar-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        // 切换面板内容
        document.querySelectorAll('.panel-section').forEach(p => {
          p.classList.toggle('active', p.dataset.panel === tool);
        });
        // 更新面板标题
        dom.memePanelTitle.textContent = TOOL_NAMES[tool] || tool;
        // 打开面板
        openPanel();
        // 退出画笔/魔棒模式
        if (state.drawMode) { state.drawMode = false; dom.canvas.classList.remove('drawing'); }
        render();
      };
    });

    // 面板关闭按钮
    dom.memePanelClose.onclick = closePanel;
    // 遮罩层点击关闭面板
    dom.memePanelOverlay.onclick = closePanel;

    function openPanel() {
      dom.memePanel.classList.add('open');
      dom.memePanelOverlay.classList.add('show');
    }

    function closePanel() {
      dom.memePanel.classList.remove('open');
      dom.memePanelOverlay.classList.remove('show');
      if (state.drawMode) {
        state.drawMode = false;
        dom.canvas.classList.remove('drawing');
        render();
      }
    }

    // ========== 文字全屏编辑事件 ==========
    dom.textFsBack.onclick = closeTextFs;
    dom.textFsDone.onclick = closeTextFs;
    dom.textFsAdd.onclick = () => {
      // 添加新文字层并切换选中
      const textLayer = makeText(t('meme.text.default'), state.canvasWidth / 2, state.canvasHeight / 2);
      state.layers.push(textLayer);
      state.selectedId = textLayer.id;
      fillTextFsControls(textLayer);
      renderTextFsList();
      renderTextFs();
      pushHistory();
    };

    // 文字内容输入
    dom.textFsInput.oninput = () => {
      const layer = getSelected();
      if (layer && layer.type === 'text') {
        layer.text = dom.textFsInput.value || ' ';
        renderTextFsList();
        renderTextFs();
      }
    };
    dom.textFsInput.onchange = () => pushHistory();

    // 字体选择
    dom.textFsFontChips.querySelectorAll('.font-chip').forEach(chip => {
      chip.onclick = () => {
        dom.textFsFontChips.querySelectorAll('.font-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        const layer = getSelected();
        if (layer && layer.type === 'text') { layer.font = chip.dataset.font; renderTextFs(); pushHistory(); }
      };
    });

    // 颜色选择（文字全屏）
    dom.textFsColorChips.querySelectorAll('.color-chip').forEach(chip => {
      chip.onclick = () => {
        dom.textFsColorChips.querySelectorAll('.color-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        const layer = getSelected();
        if (layer && layer.type === 'text') { layer.color = chip.dataset.color; renderTextFs(); pushHistory(); }
      };
    });

    // 文字全屏自定义颜色
    dom.btnTextFsAddColor.onclick = () => dom.textFsColorPicker.click();
    dom.textFsColorPicker.oninput = () => {
      const color = dom.textFsColorPicker.value.toUpperCase();
      addCustomColorChipToContainer(dom.textFsColorChips, 'textFs', color);
      const layer = getSelected();
      if (layer && layer.type === 'text') { layer.color = color; renderTextFs(); pushHistory(); }
    };

    // 描边/大小/旋转（文字全屏）
    dom.textFsStrokeRange.oninput = () => {
      dom.textFsStrokeVal.textContent = dom.textFsStrokeRange.value;
      const layer = getSelected();
      if (layer && layer.type === 'text') { layer.stroke = +dom.textFsStrokeRange.value; renderTextFs(); }
    };
    dom.textFsStrokeRange.onchange = () => pushHistory();

    dom.textFsSizeRange.oninput = () => {
      dom.textFsSizeVal.textContent = dom.textFsSizeRange.value;
      const layer = getSelected();
      if (layer && layer.type === 'text') { layer.size = +dom.textFsSizeRange.value; renderTextFs(); }
    };
    dom.textFsSizeRange.onchange = () => pushHistory();

    dom.textFsRotateRange.oninput = () => {
      dom.textFsRotateVal.textContent = dom.textFsRotateRange.value + '°';
      const layer = getSelected();
      if (layer) { layer.rotation = (+dom.textFsRotateRange.value) * Math.PI / 180; renderTextFs(); }
    };
    dom.textFsRotateRange.onchange = () => pushHistory();

    // 阴影（文字全屏）
    dom.textFsShadowToggle.onchange = () => {
      const layer = getSelected();
      if (layer && layer.type === 'text') { layer.shadow = dom.textFsShadowToggle.checked; renderTextFs(); pushHistory(); }
    };

    // 删除/复制文字（文字全屏）
    dom.textFsDelete.onclick = () => {
      if (state.selectedId !== null) {
        state.layers = state.layers.filter(l => l.id !== state.selectedId);
        state.selectedId = null;
        renderTextFsList();
        renderTextFs();
        pushHistory();
      }
    };

    // ========== 画笔全屏编辑事件 ==========
    dom.drawFsBack.onclick = closeDrawFs;
    dom.drawFsDone.onclick = closeDrawFs;

    // 画笔模式切换
    dom.drawFsModeChips.querySelectorAll('.draw-mode-chip').forEach(chip => {
      chip.onclick = () => {
        dom.drawFsModeChips.querySelectorAll('.draw-mode-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.drawToolMode = chip.dataset.mode;
        updateDrawFsUI();
      };
    });

    // 画笔形状切换
    dom.drawFsShapeChips.querySelectorAll('.draw-shape-chip').forEach(chip => {
      chip.onclick = () => {
        dom.drawFsShapeChips.querySelectorAll('.draw-shape-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.drawShape = chip.dataset.shape;
        updateDrawFsUI();
      };
    });

    // 画笔颜色（全屏）
    dom.drawFsColorChips.querySelectorAll('.color-chip').forEach(chip => {
      chip.onclick = () => {
        dom.drawFsColorChips.querySelectorAll('.color-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.drawColor = chip.dataset.color;
      };
    });

    // 画笔全屏自定义颜色
    dom.btnDrawFsAddColor.onclick = () => dom.drawFsColorPicker.click();
    dom.drawFsColorPicker.oninput = () => {
      const color = dom.drawFsColorPicker.value.toUpperCase();
      addCustomColorChipToContainer(dom.drawFsColorChips, 'drawFs', color);
      state.drawColor = color;
    };

    // 画笔粗细
    dom.drawFsBrushRange.oninput = () => {
      dom.drawFsBrushVal.textContent = dom.drawFsBrushRange.value;
      state.brushWidth = +dom.drawFsBrushRange.value;
    };

    // 马赛克块大小
    dom.drawFsMosaicRange.oninput = () => {
      dom.drawFsMosaicVal.textContent = dom.drawFsMosaicRange.value;
      state.mosaicSize = +dom.drawFsMosaicRange.value;
    };

    // 清除涂鸦
    dom.drawFsClear.onclick = () => {
      state.drawPaths = [];
      renderDrawFs();
      pushHistory();
    };

    // 画笔全屏画布触摸事件
    dom.drawFsCanvas.addEventListener('touchstart', onDrawFsTouchStart, { passive: false });
    dom.drawFsCanvas.addEventListener('touchmove', onDrawFsTouchMove, { passive: false });
    dom.drawFsCanvas.addEventListener('touchend', onDrawFsTouchEnd);

    // ========== 裁剪全屏编辑事件 ==========
    dom.cropFsBack.onclick = closeCropFs;
    dom.cropFsDone.onclick = applyCropFs;

    dom.cropFsChips.querySelectorAll('.crop-chip').forEach(chip => {
      chip.onclick = () => {
        dom.cropFsChips.querySelectorAll('.crop-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        cropFs.ratio = chip.dataset.crop;
        // 应用比例约束
        applyCropRatio();
        renderCropFs();
      };
    });

    dom.cropFsReset.onclick = resetCropFs;

    // 裁剪画布触摸事件
    dom.cropFsCanvas.addEventListener('touchstart', onCropFsTouchStart, { passive: false });
    dom.cropFsCanvas.addEventListener('touchmove', onCropFsTouchMove, { passive: false });
    dom.cropFsCanvas.addEventListener('touchend', onCropFsTouchEnd);

    // ========== 其他面板事件（保留不变） ==========

    // 滤镜预设
    document.querySelectorAll('.filter-preset').forEach(preset => {
      preset.onclick = () => {
        document.querySelectorAll('.filter-preset').forEach(p => p.classList.remove('active'));
        preset.classList.add('active');
        const presetKey = preset.dataset.preset;
        const vals = FILTER_PRESET_VALUES[presetKey];
        if (vals) {
          state.filter.preset = vals.preset;
          state.filter.brightness = vals.brightness;
          state.filter.contrast = vals.contrast;
          state.filter.saturate = vals.saturate;
          // 同步滑块
          if (dom.brightnessRange) { dom.brightnessRange.value = vals.brightness; dom.brightnessVal.textContent = vals.brightness; }
          if (dom.contrastRange) { dom.contrastRange.value = vals.contrast; dom.contrastVal.textContent = vals.contrast; }
          if (dom.saturateRange) { dom.saturateRange.value = vals.saturate; dom.saturateVal.textContent = vals.saturate; }
        } else {
          state.filter.preset = presetKey;
        }
        render(); pushHistory();
      };
    });

    // 滤镜滑块
    dom.brightnessRange.oninput = () => {
      dom.brightnessVal.textContent = dom.brightnessRange.value;
      state.filter.brightness = +dom.brightnessRange.value; render();
    };
    dom.brightnessRange.onchange = () => pushHistory();
    dom.contrastRange.oninput = () => {
      dom.contrastVal.textContent = dom.contrastRange.value;
      state.filter.contrast = +dom.contrastRange.value; render();
    };
    dom.contrastRange.onchange = () => pushHistory();
    dom.saturateRange.oninput = () => {
      dom.saturateVal.textContent = dom.saturateRange.value;
      state.filter.saturate = +dom.saturateRange.value; render();
    };
    dom.saturateRange.onchange = () => pushHistory();

    // 裁剪
    document.querySelectorAll('.crop-chip').forEach(chip => {
      chip.onclick = () => {
        document.querySelectorAll('.crop-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        state.cropRatio = chip.dataset.crop;
      };
    });
    dom.btnApplyCrop.onclick = applyCrop;
    dom.btnResetCrop.onclick = resetCrop;

    // 平台预设
    document.querySelectorAll('.platform-chip').forEach(chip => {
      chip.onclick = () => {
        document.querySelectorAll('.platform-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        applyPlatformPreset(chip.dataset.platform);
      };
    });

    // 快捷工具
    dom.btnAddWhiteBorder.onclick = addWhiteBorder;
    dom.btnAddRoundCorner.onclick = addRoundCorner;

    // 主画布触摸事件
    dom.canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    dom.canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    dom.canvas.addEventListener('touchend', onTouchEnd);
  }

  // ============================================================
  // 模块：图片导入
  // ============================================================
  // ========== 导入素材（GIF / 图片优先，也支持视频） ==========
  function updateAiFab() {
    if (!dom.aiFab) return;
    const hasSource = !!state.sourceImage;
    dom.aiFab.classList.toggle('hidden', !hasSource);
    if (!hasSource && dom.aiPanel) dom.aiPanel.classList.add('hidden');
  }

  async function importSource() {
    try {
      // 表情包工坊主要用 GIF/图片，用 openImageDialog
      if (window.api && window.api.openImageDialog) {
        const paths = await window.api.openImageDialog();
        if (paths && paths.length > 0) {
          await loadSource(paths[0]);
          updateAiFab();
          return;
        }
        updateAiFab();
        return;
      }
      // 降级：用 openVideoDialog
      const paths = await window.api.openVideoDialog(false);
      if (paths && paths.length > 0) {
        await loadSource(paths[0]);
        updateAiFab();
      } else {
        updateAiFab();
      }
    } catch (e) {
      showToast(t('meme.import.fail', { error: e.message || e }), 'error');
      updateAiFab();
    }
  }

  // 解析图片路径：Capacitor 环境下转换为可访问的 src
  function resolveImgSrc(path) {
    return (window.Capacitor && window.Capacitor.convertFileSrc)
      ? window.Capacitor.convertFileSrc(path) : path;
  }

  // ========== 内存预估与保护 ==========
  // 缓存设备内存信息（启动时从原生获取一次）
  let _cachedMemInfo = null;

  // 获取设备内存信息（异步，优先使用原生方法）
  async function getDeviceMemInfo() {
    if (_cachedMemInfo) return _cachedMemInfo;
    // 优先使用原生插件获取准确内存
    if (window.api && window.api.getDeviceMemory) {
      try {
        const info = await window.api.getDeviceMemory();
        _cachedMemInfo = { totalMB: info.totalMB || 2048, availMB: info.availMB || 512 };
        return _cachedMemInfo;
      } catch (e) {
        console.warn('[meme] 原生内存获取失败，使用fallback:', e);
      }
    }
    // fallback: navigator.deviceMemory 或保守默认值
    let totalMB = 2048;
    if (navigator.deviceMemory) totalMB = navigator.deviceMemory * 1024;
    _cachedMemInfo = { totalMB: totalMB, availMB: Math.round(totalMB / 3) };
    return _cachedMemInfo;
  }

  // 预估GIF解码所需内存（MB）
  // = 文件大小 + 帧数 × 帧宽 × 帧高 × 4字节(RGBA)
  // 安全系数2.0：解码过程中会有临时buffer、canvas等额外开销
  function estimateGifMemMB(fileSize, frameCount, w, h) {
    const framesMem = frameCount * w * h * 4;
    return ((fileSize + framesMem) * 2.0) / (1024 * 1024);
  }

  // 检查内存是否够用（异步），不够就提示用户
  async function checkMemEnough(neededMB) {
    const info = await getDeviceMemInfo();
    // WebView可用内存取当前可用内存的60%（保守估计，其他进程也在用）
    const availableMB = Math.round(info.availMB * 0.6);
    if (neededMB > availableMB) {
      showToast(t('meme.file.tooLarge', { needed: Math.round(neededMB), available: availableMB }), 'error');
      return false;
    }
    return true;
  }

  // ============================================================
  // 模块：素材加载
  // ============================================================

  function loadSource(path, forceTryGif) {
    return new Promise(async resolve => {
      // 停止旧的 GIF 播放
      stopGifPlayback();

      state.sourcePath = path;
      state.sourceName = (path.split('/').pop() || path).split('\\').pop() || path;

      // 判断是否为 GIF 文件
      // forceTryGif=true 时（从转换器跳转过来），无论扩展名都尝试 GIF 解析
      const isGifFile = forceTryGif || /\.gif($|\?|#)/i.test(path);
      if (isGifFile && window.gifuct) {
        // 显示导入中弹框
        showModal(t('meme.import.loading'), '<div style="text-align:center;padding:20px 0"><div style="font-size:14px;color:#aaa">' + t('meme.import.waiting') + '</div></div>', []);
        try {
          // 读取并解码GIF
          // 尝试多种路径加载：convertFileSrc → 原始路径
          let arrayBuffer = null;
          const convertedSrc = resolveImgSrc(path);
          const tryPaths = convertedSrc !== path ? [convertedSrc, path] : [path];
          for (const tryPath of tryPaths) {
            try {
              const resp = await fetch(tryPath);
              if (resp.ok) {
                arrayBuffer = await resp.arrayBuffer();
                break;
              }
            } catch (fetchErr) {
              // 继续尝试下一个路径
            }
          }
          // Android 本地文件偶尔 fetch 不到，改用原生读取兜底
          if ((!arrayBuffer || arrayBuffer.byteLength === 0) && window.api && window.api.readFileBase64) {
            try {
              const b64 = await window.api.readFileBase64(path);
              if (b64) {
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) {
                  bytes[i] = bin.charCodeAt(i);
                }
                arrayBuffer = bytes.buffer;
              }
            } catch (readErr) {
              // 继续走静态加载
            }
          }
          if (!arrayBuffer || arrayBuffer.byteLength === 0) {
            throw new Error('所有路径 fetch 均失败');
          }

          // 检查 GIF 魔数（GIF87a 或 GIF89a）
          const magic = new Uint8Array(arrayBuffer, 0, Math.min(6, arrayBuffer.byteLength));
          const isGifMagic = magic[0] === 0x47 && magic[1] === 0x49 && magic[2] === 0x46;
          if (!isGifMagic) {
            // 不是 GIF 文件，跳到静态加载
            throw new Error('非 GIF 格式（魔数不匹配）');
          }

          // 先解析头信息，预估内存
          const gif = gifuct.parseGIF(arrayBuffer);
          const gw = gif.lsd ? gif.lsd.width : 0;
          const gh = gif.lsd ? gif.lsd.height : 0;
          const frameCount = gif.frames ? gif.frames.length : 0;
          const neededMB = estimateGifMemMB(arrayBuffer.byteLength, frameCount, gw, gh);
          if (!(await checkMemEnough(neededMB))) {
            dom.modalOverlay.classList.remove('show');
            arrayBuffer = null;
            resolve();
            return;
          }

          const frames = gifuct.decompressFrames(gif, true);
          // 释放原始buffer
          arrayBuffer = null;

          // 诊断信息
          const f0 = frames[0];
          const diagInfo = 'GIF尺寸:' + (gif.lsd ? gif.lsd.width + 'x' + gif.lsd.height : '?') +
            ' 帧数:' + frames.length +
            ' 首帧dims:' + f0.dims.width + 'x' + f0.dims.height +
            ' 首帧patch长度:' + (f0.patch ? f0.patch.length : '无') +
            ' 首帧pixels长度:' + (f0.pixels ? f0.pixels.length : '无') +
            ' colorTable:' + (f0.colorTable ? f0.colorTable.length + '色' : '无') +
            ' disposal:' + f0.disposalType +
            ' delay:' + f0.delay;
          console.log('[GIF诊断]', diagInfo);

          // 关闭"导入中"弹框
          dom.modalOverlay.classList.remove('show');

          if (frames && frames.length > 0) {
            state.isGif = true;
            state.gifFrames = frames;
            state.gifFrameIdx = 0;
            state.gifPlaying = false;

            const firstFrame = frames[0];
            const fw = gif.lsd ? gif.lsd.width : firstFrame.dims.width;
            const fh = gif.lsd ? gif.lsd.height : firstFrame.dims.height;
            const accCanvas = document.createElement('canvas');
            accCanvas.width = fw;
            accCanvas.height = fh;
            const accCtx = accCanvas.getContext('2d');
            // 填充GIF背景色（避免透明区域变黑）
            if (gif.gct) {
              const bgColorIdx = gif.lsd && gif.lsd.backgroundColorIndex;
              if (bgColorIdx !== undefined && bgColorIdx < gif.gct.length) {
                const bg = gif.gct[bgColorIdx];
                _gifBgColor = 'rgb(' + bg[0] + ',' + bg[1] + ',' + bg[2] + ')';
                accCtx.fillStyle = _gifBgColor;
              } else {
                _gifBgColor = '#000000';
                accCtx.fillStyle = _gifBgColor;
              }
            } else {
              _gifBgColor = '#000000';
              accCtx.fillStyle = _gifBgColor;
            }
            accCtx.fillRect(0, 0, fw, fh);
            drawGifFrameToCanvas(accCtx, firstFrame, null, fw, fh);

            applySourceImage(accCanvas, path);
            resolve();
            return;
          }
        } catch (e) {
          // 关闭解码弹框
          dom.modalOverlay.classList.remove('show');
          console.warn('[meme] GIF 解析失败，回退静态加载:', e);
          state.isGif = false;
          state.gifFrames = [];
        }
      }

      // 非GIF 或 GIF解析失败：判断是视频还是图片
      state.isGif = false;
      state.gifFrames = [];
      const src = resolveImgSrc(path);
      const isVideoFile = /\.(mp4|mov|avi|mkv|webm|3gp)($|\?|#)/i.test(path);
      if (isVideoFile) {
        // 视频文件：创建 <video> 提取首帧
        showModal(t('meme.import.loading'), '<div style="text-align:center;padding:20px 0"><div style="font-size:14px;color:#aaa">' + t('meme.import.loadingVideo') + '</div></div>', []);
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.src = src;
        video.onloadeddata = () => {
          // 跳到0.1秒处截图（避免黑帧）
          video.currentTime = 0.1;
        };
        video.onseeked = () => {
          const c = document.createElement('canvas');
          c.width = video.videoWidth;
          c.height = video.videoHeight;
          c.getContext('2d').drawImage(video, 0, 0);
          dom.modalOverlay.classList.remove('show');
          applySourceImage(c, path);
          resolve();
        };
        video.onerror = () => {
          dom.modalOverlay.classList.remove('show');
          showToast(t('meme.video.loadFail'), 'error');
          resolve();
        };
      } else {
        // 静态图片
        const img = new Image();
        img.onload = () => { applySourceImage(img, path); resolve(); };
        img.onerror = () => { showToast(t('meme.image.loadFail'), 'error'); resolve(); };
        img.src = src;
      }
    });
  }

  function applySourceImage(img, path) {
    state.sourceImage = img;
    const maxSize = MAX_CANVAS_SIZE;
    // 兼容canvas和Image：canvas用width/height，Image用naturalWidth/naturalHeight
    let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (w > maxSize || h > maxSize) {
      if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
      else { w = Math.round(w * maxSize / h); h = maxSize; }
    }
    state.canvasWidth = w; state.canvasHeight = h;
    dom.canvas.width = w; dom.canvas.height = h;

    dom.memeEmpty.classList.add('hidden');
    dom.canvasWrap.classList.remove('hidden');
    dom.canvasWrap.style.display = 'flex';
    dom.memeSource.classList.remove('hidden');
    dom.memeSource.style.display = 'flex';
    dom.memeSidebar.classList.remove('hidden');
    dom.memeSidebar.style.display = 'flex';
    updateAiFab();
    if (dom.btnExport) dom.btnExport.disabled = false;
    dom.btnShare.disabled = false;
    dom.sourceName.textContent = state.sourceName;

    // 重置状态
    state.layers = []; state.drawPaths = []; state.selectedId = null;
    state.advLayers = []; state.advOverlay = null; state.advCanvasW = 0; state.advCanvasH = 0; state.advDuration = 0; state.gifCurrentTime = 0;
    state.filter = { preset: 'none', brightness: FILTER_DEFAULT, contrast: FILTER_DEFAULT, saturate: FILTER_DEFAULT };
    state.history = []; state.historyIndex = -1;
    // 清除模糊缓存
    state.blurSourceData = null; state.blurSourceKey = '';

    render();
    pushHistory();

    // GIF 自动播放
    if (state.isGif && state.gifFrames.length > 1) {
      startGifPlayback();
    }
  }

  // ============================================================
  // 模块：涂鸦系统
  // ============================================================
  // ========== 涂鸦离屏 Canvas（橡皮擦只擦涂鸦，不擦底图） ==========
  let drawCanvas = null; // 离屏涂鸦 Canvas
  let drawCtx = null;

  // ============================================================
  // 模块：GIF 播放
  // ============================================================
  // ========== GIF 帧累积 Canvas（主界面 GIF 动画播放） ==========
  let gifAccCanvas = null;
  let gifAccCtx = null;
  let _gifBgColor = '#000000';  // GIF 背景色（从 GIF 头信息解析）

  // 复用临时canvas（避免每帧createElement）
  let _gifPatchCanvas = null;
  let _gifPatchCtx = null;
  let _gifPatchW = 0, _gifPatchH = 0;
  let _gifDisposal3Saved = null;  // disposal=3的画布快照（普通播放用）

  // 共用：将单帧绘制到累积 canvas（处理 disposal + patch 绘制）
  // accCtx 为累积画布上下文，frame 为当前帧，prevFrame 为上一帧（用于 disposal）
  function drawGifFrameToCanvas(accCtx, frame, prevFrame, canvasW, canvasH) {
    // 1. 处理前一帧的 disposal
    if (prevFrame) {
      if (prevFrame.disposalType === 3 && _gifDisposal3Saved) {
        // disposal=3：恢复到前一帧绘制前的快照
        accCtx.putImageData(_gifDisposal3Saved, 0, 0);
        _gifDisposal3Saved = null;
      } else if (prevFrame.disposalType === 2) {
        // disposal=2：清除上一帧区域
        accCtx.clearRect(prevFrame.dims.left, prevFrame.dims.top, prevFrame.dims.width, prevFrame.dims.height);
      }
    }
    // 2. 如果当前帧 disposal=3，保存绘制前的快照（供下一帧恢复用）
    if (frame.disposalType === 3 && canvasW && canvasH) {
      _gifDisposal3Saved = accCtx.getImageData(0, 0, canvasW, canvasH);
    } else {
      _gifDisposal3Saved = null;
    }
    // 3. 绘制当前帧
    const pw = frame.dims.width, ph = frame.dims.height;
    if (!_gifPatchCanvas || _gifPatchW < pw || _gifPatchH < ph) {
      _gifPatchCanvas = document.createElement('canvas');
      _gifPatchW = pw; _gifPatchH = ph;
      _gifPatchCanvas.width = pw; _gifPatchCanvas.height = ph;
      _gifPatchCtx = _gifPatchCanvas.getContext('2d');
    }
    _gifPatchCtx.clearRect(0, 0, pw, ph);
    // 不使用frame.patch，直接从pixels和colorTable生成ImageData
    const imgData = _gifPatchCtx.createImageData(pw, ph);
    const data = imgData.data;
    const pixels = frame.pixels;
    const ct = frame.colorTable;
    const transIdx = frame.transparentIndex;
    for (let i = 0, j = 0; i < pixels.length; i++, j += 4) {
      const idx = pixels[i];
      const c = ct[idx];
      if (c) {
        data[j] = c[0];
        data[j+1] = c[1];
        data[j+2] = c[2];
      }
      data[j+3] = (idx !== transIdx) ? 255 : 0;
    }
    _gifPatchCtx.putImageData(imgData, 0, 0);
    accCtx.drawImage(_gifPatchCanvas, 0, 0, pw, ph, frame.dims.left, frame.dims.top, pw, ph);
  }

  function startGifPlayback() {
    if (!state.isGif || state.gifFrames.length < 2 || state.gifPlaying) return;
    state.gifPlaying = true;
    state.gifFrameIdx = 0;
    state.gifLastTime = 0;
    state.gifCurrentTime = 0;
    const gw = state.sourceImage.naturalWidth || state.sourceImage.width || state.canvasWidth;
    const gh = state.sourceImage.naturalHeight || state.sourceImage.height || state.canvasHeight;
    gifAccCanvas = document.createElement('canvas');
    gifAccCanvas.width = gw;
    gifAccCanvas.height = gh;
    gifAccCtx = gifAccCanvas.getContext('2d');
    gifAccCtx.fillStyle = _gifBgColor;
    gifAccCtx.fillRect(0, 0, gw, gh);
    drawGifFrameToCanvas(gifAccCtx, state.gifFrames[0], null, gw, gh);

    function tick(ts) {
      if (!state.gifPlaying || !state.isGif) return;
      if (!state.gifLastTime) state.gifLastTime = ts;
      const frame = state.gifFrames[state.gifFrameIdx];
      const delay = (frame && frame.delay) || 100;
      if (ts - state.gifLastTime >= delay) {
        // 推进帧
        state.gifLastTime = ts;
        const prevFrame = state.gifFrames[state.gifFrameIdx];
        state.gifFrameIdx = (state.gifFrameIdx + 1) % state.gifFrames.length;
        const curFrame = state.gifFrames[state.gifFrameIdx];

        // 处理 disposal 并绘制当前帧（复用共用函数）
        drawGifFrameToCanvas(gifAccCtx, curFrame, prevFrame, gw, gh);

        // 更新当前 GIF 播放时间（秒）
        state.gifCurrentTime += delay / 1000;
        // 循环时重置时间
        if (state.gifFrameIdx === 0) state.gifCurrentTime = 0;

        // 直接将累积canvas赋值为sourceImage，避免toDataURL开销
        state.sourceImage = gifAccCanvas;
        render();
      }
      state.gifRafId = requestAnimationFrame(tick);
    }
    state.gifRafId = requestAnimationFrame(tick);
  }

  function stopGifPlayback() {
    state.gifPlaying = false;
    if (state.gifRafId) { cancelAnimationFrame(state.gifRafId); state.gifRafId = null; }
  }

  function ensureDrawCanvas(w, h) {
    if (!drawCanvas || drawCanvas.width !== w || drawCanvas.height !== h) {
      drawCanvas = document.createElement('canvas');
      drawCanvas.width = w;
      drawCanvas.height = h;
      drawCtx = drawCanvas.getContext('2d');
    }
  }

  // ============================================================
  // 模块：高级剪辑
  // ============================================================
  // ========== 高级剪辑：GIF 智能关键帧 + 单画布状态机 ==========

  let advGifAccCanvas = null;     // 单累积canvas
  let advGifAccCtx = null;
  let advGifLastIdx = -1;         // 当前累积canvas对应的帧索引
  let _advFrameTimes = [];        // 每帧的时间戳
  let _advGifKeyframes = [];      // [{idx, imageData}] — 安全关键帧快照
  let _advGifKeyframeIdxs = [];   // 关键帧索引列表
  let _advGifKeyframeMap = {};    // idx → imageData 的快速查找映射
  let _disposal3Saved = null;     // disposal=3的画布快照（只保留一份）

  function initAdvGifRenderer() {
    _advFrameTimes = [];
    _advGifKeyframes = [];
    _advGifKeyframeIdxs = [];
    _advGifKeyframeMap = {};
    _disposal3Saved = null;
    advGifLastIdx = -1;
    adv.gifDuration = 0;

    if (!state.isGif || state.gifFrames.length < 2) return;

    const gw = state.sourceImage.naturalWidth || state.sourceImage.width || state.canvasWidth;
    const gh = state.sourceImage.naturalHeight || state.sourceImage.height || state.canvasHeight;

    // 计算每帧的时间戳
    let cumTime = 0;
    _advFrameTimes = state.gifFrames.map(f => {
      const t = cumTime;
      cumTime += (f.delay || 100) / 1000;
      return t;
    });
    adv.gifDuration = cumTime;

    // 创建单累积canvas，同步渲染第一帧
    advGifAccCanvas = document.createElement('canvas');
    advGifAccCanvas.width = gw; advGifAccCanvas.height = gh;
    advGifAccCtx = advGifAccCanvas.getContext('2d');
    advGifAccCtx.fillStyle = '#000000';
    advGifAccCtx.fillRect(0, 0, gw, gh);
    renderFrameFull(advGifAccCtx, 0, gw, gh);
    advGifLastIdx = 0;

    // 保存帧0为关键帧
    _advGifKeyframes.push({ idx: 0, imageData: advGifAccCtx.getImageData(0, 0, gw, gh) });
    _advGifKeyframeIdxs.push(0);
    _advGifKeyframeMap[0] = _advGifKeyframes[0].imageData;

    // 异步扫描识别关键帧（用单独的canvas，不影响主canvas）
    const scanCanvas = document.createElement('canvas');
    scanCanvas.width = gw; scanCanvas.height = gh;
    const scanCtx = scanCanvas.getContext('2d');
    scanCtx.fillStyle = '#000000';
    scanCtx.fillRect(0, 0, gw, gh);

    let _scanDis3 = null;
    const total = state.gifFrames.length;
    const MAX_GAP = 30;
    let lastKfIdx = 0;
    let fi = 1;

    // 帧渲染函数（扫描用，含disposal=3处理）
    function scanRenderFrame(ctx, frameIdx) {
      const frame = state.gifFrames[frameIdx];
      const prev = frameIdx > 0 ? state.gifFrames[frameIdx - 1] : null;
      if (prev) {
        if (prev.disposalType === 3 && _scanDis3) {
          ctx.putImageData(_scanDis3, 0, 0);
          _scanDis3 = null;
        } else if (prev.disposalType === 2) {
          ctx.clearRect(prev.dims.left, prev.dims.top, prev.dims.width, prev.dims.height);
        }
      }
      const pw = frame.dims.width, ph = frame.dims.height;
      if (!_gifPatchCanvas || _gifPatchW < pw || _gifPatchH < ph) {
        _gifPatchCanvas = document.createElement('canvas');
        _gifPatchW = pw; _gifPatchH = ph;
        _gifPatchCanvas.width = pw; _gifPatchCanvas.height = ph;
        _gifPatchCtx = _gifPatchCanvas.getContext('2d');
      }
      _gifPatchCtx.clearRect(0, 0, pw, ph);
      _gifPatchCtx.putImageData(new ImageData(new Uint8ClampedArray(frame.patch), pw, ph), 0, 0);
      ctx.drawImage(_gifPatchCanvas, 0, 0, pw, ph, frame.dims.left, frame.dims.top, pw, ph);
      if (frame.disposalType === 3) {
        _scanDis3 = ctx.getImageData(0, 0, gw, gh);
      } else {
        _scanDis3 = null;
      }
    }

    // 先渲染帧0到扫描canvas
    scanRenderFrame(scanCtx, 0);

    const BATCH = 30;
    function scanBatch() {
      const end = Math.min(fi + BATCH, total);
      for (; fi < end; fi++) {
        scanRenderFrame(scanCtx, fi);
        // 判断是否为安全关键帧
        const prev = state.gifFrames[fi - 1];
        const isSafe = (prev && prev.disposalType === 2) ||
          (state.gifFrames[fi].dims.left === 0 && state.gifFrames[fi].dims.top === 0 &&
           state.gifFrames[fi].dims.width >= gw && state.gifFrames[fi].dims.height >= gh);
        const isForced = (fi - lastKfIdx >= MAX_GAP);
        if (isSafe || isForced) {
          const kfd = scanCtx.getImageData(0, 0, gw, gh);
          _advGifKeyframes.push({ idx: fi, imageData: kfd });
          _advGifKeyframeIdxs.push(fi);
          _advGifKeyframeMap[fi] = kfd;
          lastKfIdx = fi;
        }
      }
      if (fi < total) {
        requestAnimationFrame(scanBatch);
      } else {
        if (_advGifKeyframeIdxs[_advGifKeyframeIdxs.length - 1] !== total - 1) {
          const lastKfd = scanCtx.getImageData(0, 0, gw, gh);
          _advGifKeyframes.push({ idx: total - 1, imageData: lastKfd });
          _advGifKeyframeIdxs.push(total - 1);
          _advGifKeyframeMap[total - 1] = lastKfd;
        }
      }
    }
    requestAnimationFrame(scanBatch);
  }

  // 完整帧渲染（含disposal=3处理）
  function renderFrameFull(ctx, frameIdx, canvasW, canvasH) {
    const frame = state.gifFrames[frameIdx];
    const prevFrame = frameIdx > 0 ? state.gifFrames[frameIdx - 1] : null;
    if (prevFrame) {
      if (prevFrame.disposalType === 3 && _disposal3Saved) {
        ctx.putImageData(_disposal3Saved, 0, 0);
        _disposal3Saved = null;
      } else if (prevFrame.disposalType === 2) {
        ctx.clearRect(prevFrame.dims.left, prevFrame.dims.top, prevFrame.dims.width, prevFrame.dims.height);
      }
    }
    const pw = frame.dims.width, ph = frame.dims.height;
    if (!_gifPatchCanvas || _gifPatchW < pw || _gifPatchH < ph) {
      _gifPatchCanvas = document.createElement('canvas');
      _gifPatchW = pw; _gifPatchH = ph;
      _gifPatchCanvas.width = pw; _gifPatchCanvas.height = ph;
      _gifPatchCtx = _gifPatchCanvas.getContext('2d');
    }
    _gifPatchCtx.clearRect(0, 0, pw, ph);
    _gifPatchCtx.putImageData(new ImageData(new Uint8ClampedArray(frame.patch), pw, ph), 0, 0);
    ctx.drawImage(_gifPatchCanvas, 0, 0, pw, ph, frame.dims.left, frame.dims.top, pw, ph);
    if (frame.disposalType === 3) {
      _disposal3Saved = ctx.getImageData(0, 0, canvasW, canvasH);
    } else {
      _disposal3Saved = null;
    }
  }

  function getGifFrameIdxAtTime(t) {
    const times = _advFrameTimes;
    if (!times || times.length === 0) return 0;
    if (t <= times[0]) return 0;
    if (t >= times[times.length - 1]) return times.length - 1;
    let lo = 0, hi = times.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid; else hi = mid;
    }
    return lo;
  }

  function findNearestKeyframeBefore(targetIdx) {
    // 二分查找：在已排序的 _advGifKeyframeIdxs 中找 <= targetIdx 的最大值
    const arr = _advGifKeyframeIdxs;
    if (arr.length === 0) return 0;
    let lo = 0, hi = arr.length - 1, best = arr[0];
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= targetIdx) { best = arr[mid]; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return best;
  }

  function seekAdvGifToFrame(targetIdx, maxRender) {
    if (!advGifAccCanvas || !state.gifFrames || state.gifFrames.length < 2) return;
    if (targetIdx === advGifLastIdx) return;
    if (targetIdx < 0) targetIdx = 0;
    if (targetIdx >= state.gifFrames.length) targetIdx = state.gifFrames.length - 1;
    const gw = advGifAccCanvas.width, gh = advGifAccCanvas.height;
    const MAX_RENDER = maxRender || 999; // 默认不限制

    // 前进小跳：从当前位置继续渲染
    if (targetIdx > advGifLastIdx && targetIdx - advGifLastIdx <= MAX_RENDER) {
      for (let i = advGifLastIdx + 1; i <= targetIdx; i++) {
        renderFrameFull(advGifAccCtx, i, gw, gh);
      }
      advGifLastIdx = targetIdx;
      return;
    }

    // 后退或大跳：从最近关键帧开始渲染（用 Map O(1) 查找）
    const kfIdx = findNearestKeyframeBefore(targetIdx);
    const kfData = _advGifKeyframeMap[kfIdx];
    if (kfData) {
      advGifAccCtx.putImageData(kfData, 0, 0);
      advGifLastIdx = kfIdx;
      _disposal3Saved = null;
      for (let i = kfIdx + 1; i <= targetIdx; i++) {
        renderFrameFull(advGifAccCtx, i, gw, gh);
      }
      advGifLastIdx = targetIdx;
    }
  }

  function getAdvGifFrameCanvas(targetTime) {
    if (!advGifAccCanvas || !state.gifFrames || state.gifFrames.length < 2) return null;
    const targetIdx = getGifFrameIdxAtTime(targetTime);
    seekAdvGifToFrame(targetIdx);
    return advGifAccCanvas;
  }

  // ============================================================
  // 模块：渲染管线
  // ============================================================
  // ========== 渲染 ==========
  function render() {
    if (!state.sourceImage) return;
    const w = state.canvasWidth, h = state.canvasHeight;

    ctx.clearRect(0, 0, w, h);

    // 滤镜
    const f = state.filter;
    let filterStr = FILTER_PRESETS[f.preset] || '';
    if (f.brightness !== FILTER_DEFAULT) filterStr += ` brightness(${f.brightness}%)`;
    if (f.contrast !== FILTER_DEFAULT) filterStr += ` contrast(${f.contrast}%)`;
    if (f.saturate !== FILTER_DEFAULT) filterStr += ` saturate(${f.saturate}%)`;
    ctx.filter = filterStr || 'none';

    // 底图
    ctx.drawImage(state.sourceImage, 0, 0, w, h);
    ctx.filter = 'none';

    // 边框
    drawBorder(w, h);

    // 涂鸦：渲染到离屏 Canvas（橡皮擦 destination-out 只影响涂鸦层）
    // 马赛克需要底图像素，直接画到主 ctx
    ensureDrawCanvas(w, h);
    drawCtx.clearRect(0, 0, w, h);
    state.drawPaths.forEach(p => {
      if (p.type === 'mosaic') {
        drawPath(p); // 马赛克直接画主 ctx
      } else {
        drawPath(p, drawCtx); // 画笔/橡皮/模糊画涂鸦层
      }
    });
    ctx.drawImage(drawCanvas, 0, 0);

    // 图层
    state.layers.forEach(l => drawLayer(l));

    // 高级编辑图层（静态图取 t=0，GIF 取当前播放时间）
    if (state.advLayers && state.advLayers.length > 0) {
      renderAdvLayersToCtx(ctx, state.gifCurrentTime || 0);
    }

    // 选中标记
    if (state.selectedId !== null && !state.drawMode) {
      const layer = state.layers.find(l => l.id === state.selectedId);
      if (layer) drawSelectionBox(layer);
    }
  }

  // 把当前所有叠加内容（边框/涂鸦/文字/高级图层）画到指定上下文，用于导出或预览
  function renderOverlaysToCtx(targetCtx, w, h, time) {
    drawBorder(w, h, targetCtx);
    ensureDrawCanvas(w, h);
    drawCtx.clearRect(0, 0, w, h);
    state.drawPaths.forEach(p => {
      if (p.type === 'mosaic') drawPath(p, targetCtx);
      else drawPath(p, drawCtx);
    });
    targetCtx.drawImage(drawCanvas, 0, 0);
    state.layers.forEach(l => drawLayerToCtx(l, targetCtx));
    if (state.advLayers && state.advLayers.length > 0) {
      renderAdvLayersToCtx(targetCtx, time || 0);
    }
  }

  function drawBorder(w, h, targetCtx) {
    if (state.border.style === 'none') return;
    const c = targetCtx || ctx;
    const colors = { white: '#FFFFFF', black: '#000000', red: '#FF4747' };
    c.strokeStyle = colors[state.border.style] || '#FFFFFF';
    c.lineWidth = state.border.width * 2;
    c.strokeRect(0, 0, w, h);
  }

  function drawPath(p, targetCtx) {
    if (!p || !p.points || p.points.length < 1) return;
    // 涂鸦路径用 targetCtx（离屏涂鸦 Canvas），马赛克用主 ctx（需要底图像素）
    const c = targetCtx || ctx;

    // 马赛克路径：必须用 targetCtx 或主 ctx（需要底图马赛克缓存）
    if (p.type === 'mosaic') {
      const mosaicCtx = targetCtx || ctx;
      const cache = getMosaicCache();
      if (!cache) return;
      const size = p.size || MOSAIC_DEFAULT;
      mosaicCtx.save();
      p.points.forEach(pt => {
        const sx = Math.max(0, Math.floor(pt.x / size) * size);
        const sy = Math.max(0, Math.floor(pt.y / size) * size);
        mosaicCtx.drawImage(cache, sx, sy, size, size, sx, sy, size, size);
        mosaicCtx.drawImage(cache, sx, sy, size, size, sx, sy, size, size);
      });
      mosaicCtx.restore();
      return;
    }

    // 橡皮擦路径：在涂鸦层上 destination-out，只擦涂鸦不擦底图
    if (p.type === 'eraser') {
      c.save();
      c.globalCompositeOperation = 'destination-out';
      c.strokeStyle = 'rgba(0,0,0,1)';
      c.lineWidth = p.width;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      if (p.points.length < 2) {
        c.beginPath();
        c.arc(p.points[0].x, p.points[0].y, p.width / 2, 0, Math.PI * 2);
        c.fill();
      } else {
        c.beginPath();
        c.moveTo(p.points[0].x, p.points[0].y);
        for (let i = 1; i < p.points.length; i++) {
          c.lineTo(p.points[i].x, p.points[i].y);
        }
        c.stroke();
      }
      c.restore();
      // 橡皮擦逻辑确认：destination-out 在离屏Canvas上正确擦除涂鸦层，不会影响底图
      return;
    }

    // 模糊路径
    if (p.type === 'blur') {
      // 模糊效果在绘制时已经应用到模糊缓存上，这里不重复绘制
      return;
    }

    // 画笔路径（按形状）
    const shape = p.shape || 'free';
    c.save();
    c.strokeStyle = p.color;
    c.fillStyle = p.color;
    c.lineWidth = p.width;
    c.lineCap = 'round';
    c.lineJoin = 'round';

    if (shape === 'free') {
      if (p.points.length < 2) {
        c.beginPath();
        c.arc(p.points[0].x, p.points[0].y, p.width / 2, 0, Math.PI * 2);
        c.fill();
      } else {
        c.beginPath();
        c.moveTo(p.points[0].x, p.points[0].y);
        for (let i = 1; i < p.points.length; i++) {
          c.lineTo(p.points[i].x, p.points[i].y);
        }
        c.stroke();
      }
    } else if (p.points.length >= 2) {
      const a = p.points[0], b = p.points[p.points.length - 1];
      if (shape === 'line') {
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
      } else if (shape === 'arrow') {
        drawArrow(c, a.x, a.y, b.x, b.y, p.width);
      } else if (shape === 'rect') {
        c.beginPath();
        c.rect(Math.min(a.x, b.x), Math.min(a.y, b.y),
                 Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        c.stroke();
      } else if (shape === 'ellipse') {
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        const rx = Math.max(1, Math.abs(b.x - a.x) / 2);
        const ry = Math.max(1, Math.abs(b.y - a.y) / 2);
        c.beginPath();
        c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        c.stroke();
      }
    }
    c.restore();
  }

  function drawArrow(c, x1, y1, x2, y2, w) {
    const headLen = Math.max(10, w * 3);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
    c.beginPath();
    c.moveTo(x2, y2);
    c.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6),
             y2 - headLen * Math.sin(angle - Math.PI / 6));
    c.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6),
             y2 - headLen * Math.sin(angle + Math.PI / 6));
    c.closePath();
    c.fill();
  }

  // ============================================================
  // 模块：滤镜系统（马赛克 / 模糊笔刷缓存）
  // ============================================================
  // 马赛克缓存：把底图按当前滤镜+边框生成一个像素化的离屏 Canvas
  function getMosaicCache() {
    if (!state.sourceImage) return null;
    const w = state.canvasWidth, h = state.canvasHeight;
    const key = state.sourcePath + '|' + JSON.stringify(state.filter) + '|' + w + 'x' + h;
    if (state.mosaicCache && state.mosaicCacheKey === key) return state.mosaicCache;

    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext('2d');
    const f = state.filter;
    let filterStr = FILTER_PRESETS[f.preset] || '';
    if (f.brightness !== FILTER_DEFAULT) filterStr += ` brightness(${f.brightness}%)`;
    if (f.contrast !== FILTER_DEFAULT) filterStr += ` contrast(${f.contrast}%)`;
    if (f.saturate !== FILTER_DEFAULT) filterStr += ` saturate(${f.saturate}%)`;
    tctx.filter = filterStr || 'none';
    tctx.drawImage(state.sourceImage, 0, 0, w, h);
    tctx.filter = 'none';

    const blockSize = MOSAIC_DEFAULT;
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.ceil(w / blockSize));
    small.height = Math.max(1, Math.ceil(h / blockSize));
    const sctx = small.getContext('2d');
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(tmp, 0, 0, small.width, small.height);

    const pix = document.createElement('canvas');
    pix.width = w; pix.height = h;
    const pctx = pix.getContext('2d');
    pctx.imageSmoothingEnabled = false;
    pctx.drawImage(small, 0, 0, w, h);

    state.mosaicCache = pix;
    state.mosaicCacheKey = key;
    return pix;
  }

  // 模糊笔刷：获取底图像素数据缓存
  function getBlurSourceData() {
    if (!state.sourceImage) return null;
    const w = state.canvasWidth, h = state.canvasHeight;
    const key = state.sourcePath + '|' + JSON.stringify(state.filter) + '|' + w + 'x' + h;
    if (state.blurSourceData && state.blurSourceKey === key) return state.blurSourceData;

    // 先渲染底图到离屏 canvas
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext('2d');
    const f = state.filter;
    let filterStr = FILTER_PRESETS[f.preset] || '';
    if (f.brightness !== FILTER_DEFAULT) filterStr += ` brightness(${f.brightness}%)`;
    if (f.contrast !== FILTER_DEFAULT) filterStr += ` contrast(${f.contrast}%)`;
    if (f.saturate !== FILTER_DEFAULT) filterStr += ` saturate(${f.saturate}%)`;
    tctx.filter = filterStr || 'none';
    tctx.drawImage(state.sourceImage, 0, 0, w, h);
    tctx.filter = 'none';

    const imgData = tctx.getImageData(0, 0, w, h);
    state.blurSourceData = imgData;
    state.blurSourceKey = key;
    return imgData;
  }

  // 模糊笔刷：对指定区域做 box blur
  function applyBlurAtPoint(cx, cy, radius) {
    const w = state.canvasWidth, h = state.canvasHeight;
    const imgData = getBlurSourceData();
    if (!imgData) return;
    const data = imgData.data;
    const r = Math.max(2, radius);

    // 对底图当前渲染结果取像素，做简易 box blur
    // 获取当前画布像素（含之前的修改）
    const currentData = ctx.getImageData(0, 0, w, h);
    const cd = currentData.data;

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const px = Math.round(cx + dx);
        const py = Math.round(cy + dy);
        if (px < 0 || px >= w || py < 0 || py >= h) continue;

        // 对该像素做简易均值模糊
        let sumR = 0, sumG = 0, sumB = 0, count = 0;
        const blurR = 2;
        for (let by = -blurR; by <= blurR; by++) {
          for (let bx = -blurR; bx <= blurR; bx++) {
            const bpx = px + bx, bpy = py + by;
            if (bpx < 0 || bpx >= w || bpy < 0 || bpy >= h) continue;
            const idx = (bpy * w + bpx) * 4;
            sumR += cd[idx]; sumG += cd[idx + 1]; sumB += cd[idx + 2];
            count++;
          }
        }
        if (count > 0) {
          const idx = (py * w + px) * 4;
          cd[idx] = Math.round(sumR / count);
          cd[idx + 1] = Math.round(sumG / count);
          cd[idx + 2] = Math.round(sumB / count);
        }
      }
    }

    ctx.putImageData(currentData, 0, 0);
    // 同步更新模糊缓存底图
    state.blurSourceData = ctx.getImageData(0, 0, w, h);
  }

  function drawLayer(l) {
    ctx.save();
    ctx.translate(l.x, l.y);
    ctx.rotate(l.rotation || 0);
    if (l.flipped) ctx.scale(-1, 1);

    if (l.type === 'text') {
      const fontFamily = FONT_MAP[l.font] || FONT_MAP.heavy;
      // 粗黑用900，impact用bold，楷书用italic+normal
      let weight, fontStyle;
      if (l.font === 'impact') { weight = 'bold'; fontStyle = ''; }
      else if (l.font === 'kai') { weight = 'normal'; fontStyle = 'italic '; }
      else { weight = '900'; fontStyle = ''; }
      ctx.font = fontStyle + weight + ' ' + l.size + 'px ' + fontFamily;
      // 楷书加倾斜变换模拟手写效果
      if (l.font === 'kai') { ctx.transform(1, 0, -0.14, 1, 0, 0); }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';

      if (l.shadow) {
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = 4;
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 2;
      }

      const lines = l.text.split('\n');
      const lineHeight = l.size * 1.2;
      const totalH = lines.length * lineHeight;
      const startY = -totalH / 2 + lineHeight / 2;

      lines.forEach((line, i) => {
        const y = startY + i * lineHeight;
        if (l.stroke > 0) {
          ctx.shadowColor = 'transparent';
          ctx.strokeStyle = l.color === '#000000' ? '#FFFFFF' : '#000000';
          ctx.lineWidth = l.stroke * 2;
          ctx.strokeText(line, 0, y);
          if (l.shadow) {
            ctx.shadowColor = 'rgba(0,0,0,0.6)';
            ctx.shadowBlur = 4;
            ctx.shadowOffsetX = 2;
            ctx.shadowOffsetY = 2;
          }
        }
        ctx.fillStyle = l.color;
        ctx.fillText(line, 0, y);
      });
    } else if (l.type === 'draw' && l.image) {
      ctx.drawImage(l.image, -l.width / 2, -l.height / 2, l.width, l.height);
    }
    ctx.restore();
  }

  // 把一条画笔笔迹栅格化成独立图层（可选中、拖动、缩放、旋转）
  function penPathToLayer(p) {
    const pts = p && p.points;
    if (!pts || pts.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(pt => {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    });
    const pad = Math.max(8, (p.width || 4) * 2);
    const w = Math.max(4, Math.ceil(maxX - minX) + pad * 2);
    const h = Math.max(4, Math.ceil(maxY - minY) + pad * 2);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const c = canvas.getContext('2d');
    c.translate(pad - minX, pad - minY);
    drawPath(p, c);
    return {
      type: 'draw', id: state.nextId++,
      image: canvas,
      x: (minX + maxX) / 2, y: (minY + maxY) / 2,
      width: w, height: h,
      rotation: 0, flipped: false,
    };
  }

  // ========== 高级编辑图层动态渲染 ==========

  function renderAdvLayersToCtx(targetCtx, time) {
    if (!state.advLayers || state.advLayers.length === 0) return;
    const scaleX = state.advCanvasW > 0 ? state.canvasWidth / state.advCanvasW : 1;
    const scaleY = state.advCanvasH > 0 ? state.canvasHeight / state.advCanvasH : 1;
    state.advLayers.forEach(layer => {
      if (!layer.visible) return;
      if (time < layer.startTime || time > layer.endTime) return;
      const st = getAdvLayerState(layer, time);
      targetCtx.save();
      targetCtx.globalAlpha = Math.max(0, Math.min(1, st.opacity));
      targetCtx.translate(st.x * scaleX, st.y * scaleY);
      const s = st.scale * Math.min(scaleX, scaleY);
      targetCtx.scale(s, s);
      targetCtx.rotate(st.rotation * Math.PI / 180);
      const iw = layer.image.width, ih = layer.image.height;
      targetCtx.drawImage(layer.image, -iw / 2, -ih / 2, iw, ih);
      targetCtx.restore();
    });
  }

  // ========== 高级剪辑全屏 ==========

  async function openAdvancedFs() {
    // GIF高级模式内存预检
    if (state.isGif && state.gifFrames.length > 1) {
      const gw = state.canvasWidth || 300, gh = state.canvasHeight || 300;
      const frameCount = state.gifFrames.length;
      // 帧数据本身已经在内存中（每帧patch ≈ w*h*4）
      const framesDataMB = (frameCount * gw * gh * 4) / (1024 * 1024);
      // 关键帧快照（约每30帧一个+首末帧）
      const estKeyframes = Math.ceil(frameCount / 30) + 2;
      const keyframesMB = (estKeyframes * gw * gh * 4) / (1024 * 1024);
      // 累积canvas + 临时canvas等 ≈ 3 * w*h*4
      const canvasMB = (3 * gw * gh * 4) / (1024 * 1024);
      // 安全系数1.5
      const advMemMB = (framesDataMB + keyframesMB + canvasMB) * 1.5;
      const info = await getDeviceMemInfo();
      const availableMB = Math.round(info.availMB * 0.4);
      if (advMemMB > availableMB) {
        showToast(t('meme.adv.memTooLarge', { needed: Math.round(advMemMB), available: availableMB }), 'error');
        return;
      }
    }

    dom.advancedFullscreen.classList.remove('hidden');
    dom.advancedFullscreen.style.display = 'flex';
    // 重置模式
    switchAdvMode('keyframe');
    adv.onionSkin = false;
    if (state.sourceImage) {
      adv.canvasWidth = state.canvasWidth || MAX_CANVAS_SIZE;
      adv.canvasHeight = state.canvasHeight || MAX_CANVAS_SIZE;
      dom.advFsCanvas.width = adv.canvasWidth;
      dom.advFsCanvas.height = adv.canvasHeight;
      if (state.isGif && state.gifFrames.length > 1) {
        adv.isGif = true;
        initAdvGifRenderer();
        adv.videoDuration = adv.gifDuration || 3;
        adv.videoEnd = adv.videoDuration;
        adv.bgImage = null;
      } else {
        adv.isGif = false;
        adv.bgImage = state.sourceImage;
        if (!adv.videoDuration) { adv.videoDuration = 3; adv.videoEnd = 3; }
      }
      adv.layers = adv.layers.filter(l => !l.id.startsWith('adv_import_'));
      importMainCanvasLayers();
    }
    if (!adv.layers.length) { dom.advFsEmpty.style.display = ''; } else { dom.advFsEmpty.style.display = 'none'; }
    updateAdvancedTimecode();
    renderAdvancedFs();
    renderAdvLayerStrip();
    renderAdvancedTimeline();
  }

  function importMainCanvasLayers() {
    const w = state.canvasWidth, h = state.canvasHeight;
    const duration = adv.videoDuration || 3;
    state.layers.forEach(l => {
      if (adv.layers.length >= ADV_LAYER_LIMIT) return;
      if (l.type === 'text') {
        const lines = l.text.split('\n');
        let cw = Math.max(...lines.map(line => line.length)) * l.size * 1.2 + l.stroke * 4 + 20;
        let ch = lines.length * l.size * 1.2 + l.stroke * 4 + 20;
        cw = Math.ceil(cw); ch = Math.ceil(ch);
        const tc = document.createElement('canvas');
        tc.width = cw; tc.height = ch;
        const tctx = tc.getContext('2d');
        tctx.translate(cw / 2, ch / 2);
        const origX = l.x, origY = l.y;
        l.x = 0; l.y = 0;
        drawLayerToCtx(l, tctx);
        l.x = origX; l.y = origY;
        const img = new Image();
        const layerData = { name: t('meme.text.prefix', { text: l.text.substring(0, 10) }), origX, origY, rotation: l.rotation || 0 };
        img.onload = () => {
          const id = 'adv_import_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
          const layer = { id, image: img, name: layerData.name, startTime: 0, endTime: duration, visible: true, keyframes: { pos: [{ t: 0, x: layerData.origX, y: layerData.origY }], scale: [{ t: 0, s: 1 }], rot: [{ t: 0, r: layerData.rotation * 180 / Math.PI }], opacity: [{ t: 0, o: 1 }] } };
          adv.layers.push(layer);
          if (adv.layers.length > 0) { dom.advFsEmpty.style.display = 'none'; if (!adv.selectedLayerId) adv.selectedLayerId = id; }
          syncAdvancedSliders(); renderAdvLayerStrip(); renderAdvancedFs(); renderAdvancedTimeline();
        };
        img.src = tc.toDataURL('image/png');
      }
    });
    if (state.drawPaths && state.drawPaths.length > 0) {
      state.drawPaths.forEach((p, pIdx) => {
        if (adv.layers.length >= ADV_LAYER_LIMIT) return;
        if (!p.points || p.points.length === 0) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        p.points.forEach(pt => { if (pt.x < minX) minX = pt.x; if (pt.y < minY) minY = pt.y; if (pt.x > maxX) maxX = pt.x; if (pt.y > maxY) maxY = pt.y; });
        const pad = (p.width || p.size || 4) + 6;
        minX = Math.max(0, Math.floor(minX - pad)); minY = Math.max(0, Math.floor(minY - pad));
        maxX = Math.min(w, Math.ceil(maxX + pad)); maxY = Math.min(h, Math.ceil(maxY + pad));
        const cw2 = maxX - minX, ch2 = maxY - minY;
        if (cw2 <= 0 || ch2 <= 0) return;
        const dc = document.createElement('canvas');
        dc.width = cw2; dc.height = ch2;
        const dctx = dc.getContext('2d');
        dctx.translate(-minX, -minY);
        drawPath(p, dctx);
        const img = new Image();
        const cx = minX + cw2 / 2, cy = minY + ch2 / 2;
        img.onload = () => {
          const id = 'adv_import_draw_' + Date.now() + '_' + pIdx;
          const layer = { id, image: img, name: t('meme.brush.prefix', { index: pIdx + 1 }), startTime: 0, endTime: duration, visible: true, keyframes: { pos: [{ t: 0, x: cx, y: cy }], scale: [{ t: 0, s: 1 }], rot: [{ t: 0, r: 0 }], opacity: [{ t: 0, o: 1 }] } };
          adv.layers.push(layer);
          dom.advFsEmpty.style.display = 'none';
          if (!adv.selectedLayerId) adv.selectedLayerId = id;
          syncAdvancedSliders(); renderAdvLayerStrip(); renderAdvancedFs(); renderAdvancedTimeline();
        };
        img.src = dc.toDataURL('image/png');
      });
    }
  }

  function closeAdvancedFs() {
    adv.playing = false;
    if (adv.playRafId) { cancelAnimationFrame(adv.playRafId); adv.playRafId = null; }
    if (adv.layers.length > 0 && adv.canvasWidth > 0) {
      state.advLayers = adv.layers.map(l => ({
        id: l.id, image: l.image, name: l.name, startTime: l.startTime, endTime: l.endTime, visible: l.visible,
        keyframes: { pos: JSON.parse(JSON.stringify(l.keyframes.pos)), scale: JSON.parse(JSON.stringify(l.keyframes.scale)), rot: JSON.parse(JSON.stringify(l.keyframes.rot)), opacity: JSON.parse(JSON.stringify(l.keyframes.opacity || [{ t: 0, o: 1 }])) },
      }));
      state.advCanvasW = adv.canvasWidth;
      state.advCanvasH = adv.canvasHeight;
      state.advDuration = adv.videoDuration || 3;
    } else { state.advLayers = []; }
    state.advOverlay = null;
    dom.advancedFullscreen.classList.add('hidden');
    dom.advancedFullscreen.style.display = 'none';
    render();
  }

  async function addAdvancedImage() {
    try {
      if (adv.layers.length >= ADV_LAYER_LIMIT) { showToast(t('meme.adv.layerLimit', { limit: ADV_LAYER_LIMIT }), 'warn'); return; }
      if (window.api && window.api.openImageDialog) {
        const paths = await window.api.openImageDialog();
        if (paths && paths.length > 0) {
          const img = await loadImageAsync(paths[0]);
          if (img) {
            saveUndoState();
            const id = 'adv_img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
            const name = (paths[0].split('/').pop() || paths[0].split('\\').pop() || t('meme.adv.imageName')).substring(0, 10);
            const layer = {
              id, image: img, name, startTime: 0, endTime: adv.videoDuration || 3, visible: true,
              keyframes: {
                pos: [{ t: 0, x: adv.canvasWidth / 2, y: adv.canvasHeight / 2 }],
                scale: [{ t: 0, s: 1 }],
                rot: [{ t: 0, r: 0 }],
                opacity: [{ t: 0, o: 1 }],
              },
            };
            adv.layers.push(layer);
            adv.selectedLayerId = id;
            dom.advFsEmpty.style.display = 'none';
            syncAdvancedSliders(); renderAdvLayerStrip(); renderAdvancedFs(); renderAdvancedTimeline();
          }
        }
      } else {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = 'image/*';
        input.onchange = async () => {
          const file = input.files[0];
          if (!file) return;
          const url = URL.createObjectURL(file);
          const img = await loadImageAsync(url);
          if (img) {
            saveUndoState();
            const id = 'adv_img_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
            const name = file.name.substring(0, 10);
            const layer = {
              id, image: img, name, startTime: 0, endTime: adv.videoDuration || 3, visible: true,
              keyframes: {
                pos: [{ t: 0, x: adv.canvasWidth / 2, y: adv.canvasHeight / 2 }],
                scale: [{ t: 0, s: 1 }],
                rot: [{ t: 0, r: 0 }],
                opacity: [{ t: 0, o: 1 }],
              },
            };
            adv.layers.push(layer);
            adv.selectedLayerId = id;
            dom.advFsEmpty.style.display = 'none';
            syncAdvancedSliders(); renderAdvLayerStrip(); renderAdvancedFs(); renderAdvancedTimeline();
          }
        };
        input.click();
      }
    } catch (e) {
      showToast(t('meme.adv.addImageFail', { error: e.message || e }), 'error');
    }
  }

  function removeAdvancedLayer(layerId) {
    saveUndoState();
    adv.layers = adv.layers.filter(l => l.id !== layerId);
    if (adv.selectedLayerId === layerId) {
      adv.selectedLayerId = adv.layers.length > 0 ? adv.layers[0].id : null;
    }
    if (!adv.layers.length) { dom.advFsEmpty.style.display = ''; } else { dom.advFsEmpty.style.display = 'none'; }
    syncAdvancedSliders(); renderAdvLayerStrip(); renderAdvancedFs(); renderAdvancedTimeline();
  }

  function renderAdvancedFs() {
    const w = adv.canvasWidth, h = adv.canvasHeight;
    if (!w || !h) return;
    advFsCtx.clearRect(0, 0, w, h);

    // 背景
    if (adv.isGif && advGifAccCanvas) {
      const gifCanvas = getAdvGifFrameCanvas(adv.currentTime);
      if (gifCanvas) {
        advFsCtx.drawImage(gifCanvas, 0, 0, w, h);
      } else if (adv.bgImage) {
        advFsCtx.drawImage(adv.bgImage, 0, 0, w, h);
      }
    } else if (adv.bgImage) {
      advFsCtx.drawImage(adv.bgImage, 0, 0, w, h);
    }

    // 图层
    adv.layers.forEach(layer => {
      if (!layer.visible) return;
      if (adv.currentTime < layer.startTime || adv.currentTime > layer.endTime) return;
      const st = getAdvLayerState(layer, adv.currentTime);
      advFsCtx.save();
      advFsCtx.globalAlpha = Math.max(0, Math.min(1, st.opacity));
      advFsCtx.translate(st.x, st.y);
      advFsCtx.scale(st.scale, st.scale);
      advFsCtx.rotate(st.rotation * Math.PI / 180);
      const iw = layer.image.width, ih = layer.image.height;
      advFsCtx.drawImage(layer.image, -iw / 2, -ih / 2, iw, ih);
      advFsCtx.restore();
    });

    // 选中图层边框
    if (adv.selectedLayerId) {
      const layer = adv.layers.find(l => l.id === adv.selectedLayerId);
      if (layer && layer.visible && adv.currentTime >= layer.startTime && adv.currentTime <= layer.endTime) {
        const st = getAdvLayerState(layer, adv.currentTime);
        advFsCtx.save();
        advFsCtx.translate(st.x, st.y);
        advFsCtx.scale(st.scale, st.scale);
        advFsCtx.rotate(st.rotation * Math.PI / 180);
        const iw = layer.image.width, ih = layer.image.height;
        advFsCtx.strokeStyle = '#FF6B3D';
        advFsCtx.lineWidth = 2 / st.scale;
        advFsCtx.setLineDash([6 / st.scale, 4 / st.scale]);
        advFsCtx.strokeRect(-iw / 2 - 4 / st.scale, -ih / 2 - 4 / st.scale, iw + 8 / st.scale, ih + 8 / st.scale);
        advFsCtx.setLineDash([]);
        advFsCtx.restore();
      }
    }
  }

  // 缓存时间轴canvas尺寸，避免每次重设触发重排
  let _tlCanvasW = 0, _tlCanvasH = 0;

  function renderAdvancedTimeline() {
    const canvas = dom.advFsTimelineCanvas;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const dispW = rect.width || 320, dispH = rect.height || 60;
    // 只在尺寸变化时重设canvas尺寸（重设会清空canvas+触发重排，非常昂贵）
    const needW = Math.round(dispW * dpr), needH = Math.round(dispH * dpr);
    if (canvas.width !== needW || canvas.height !== needH) {
      canvas.width = needW;
      canvas.height = needH;
      _tlCanvasW = needW; _tlCanvasH = needH;
    }
    advFsTlCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const tlW = dispW, tlH = dispH;
    advFsTlCtx.clearRect(0, 0, tlW, tlH);

    const duration = adv.videoDuration || 3;
    const pxPerSec = (tlW * adv.tlZoom) / duration;
    const scrollX = adv.tlScrollX;

    // 刻度区高度（顶部留出空间给时间标签）
    const scaleH = 14;

    // 先画图层条（在刻度区下方）
    const barH = Math.max(16, (tlH - scaleH) / Math.max(adv.layers.length, 1));
    adv.layers.forEach((layer, i) => {
      const y = scaleH + i * barH;
      const x1 = layer.startTime * pxPerSec - scrollX;
      const x2 = layer.endTime * pxPerSec - scrollX;
      const barW = Math.max(4, x2 - x1);
      advFsTlCtx.fillStyle = layer.id === adv.selectedLayerId ? 'rgba(255,107,61,0.5)' : 'rgba(100,140,200,0.35)';
      advFsTlCtx.fillRect(x1, y, barW, barH - 2);

      // 关键帧菱形
      const drawDiamond = (kf, color) => {
        const kx = kf.t * pxPerSec - scrollX;
        if (kx < x1 - 4 || kx > x2 + 4) return;
        advFsTlCtx.fillStyle = color;
        advFsTlCtx.beginPath();
        advFsTlCtx.moveTo(kx, y + 1);
        advFsTlCtx.lineTo(kx + 3, y + (barH - 2) / 2);
        advFsTlCtx.lineTo(kx, y + barH - 3);
        advFsTlCtx.lineTo(kx - 3, y + (barH - 2) / 2);
        advFsTlCtx.closePath();
        advFsTlCtx.fill();
      };
      layer.keyframes.pos.forEach(kf => drawDiamond(kf, '#FF6B3D'));
      layer.keyframes.scale.forEach(kf => drawDiamond(kf, '#4CAF50'));
      layer.keyframes.rot.forEach(kf => drawDiamond(kf, '#2196F3'));
    });

    // 最后画时间刻度线和文字（在最上层，不会被图层条遮挡）
    advFsTlCtx.font = '9px sans-serif';
    advFsTlCtx.textBaseline = 'top';
    const step = duration > 10 ? 2 : duration > 3 ? 1 : 0.5;
    for (let t = 0; t <= duration; t += step) {
      const x = t * pxPerSec - scrollX;
      if (x < -20 || x > tlW + 20) continue;
      // 刻度线（只在刻度区内）
      advFsTlCtx.fillStyle = '#555';
      advFsTlCtx.fillRect(x, 0, 1, scaleH);
      // 时间文字（白色背景半透明，确保可读）
      const label = t.toFixed(t >= 1 ? 0 : 1) + 's';
      const tw = advFsTlCtx.measureText(label).width;
      advFsTlCtx.fillStyle = 'rgba(8,9,13,0.85)';
      advFsTlCtx.fillRect(x + 2, 1, tw + 2, 11);
      advFsTlCtx.fillStyle = '#aaa';
      advFsTlCtx.fillText(label, x + 3, 2);
    }

    // 播放头用HTML div显示，canvas不再绘制
    updatePlayheadDiv();
  }

  // 快速更新播放头位置（拖动时用）- 现在只更新div位置
  let _lastPlayheadX = -999;
  function updatePlayheadOnly() {
    updatePlayheadDiv();
  }

  function advancedPlayToggle() {
    if (adv.playing) {
      adv.playing = false;
      if (adv.playRafId) { cancelAnimationFrame(adv.playRafId); adv.playRafId = null; }
      if (dom.advFsPlayBtn) dom.advFsPlayBtn.textContent = '▶';
    } else {
      adv.playing = true;
      adv.playLastTime = performance.now();
      if (dom.advFsPlayBtn) dom.advFsPlayBtn.textContent = '⏸';
      advPlayLoop();
    }
  }

  function advPlayLoop() {
    if (!adv.playing) return;
    const now = performance.now();
    const dt = (now - adv.playLastTime) / 1000;
    adv.playLastTime = now;
    adv.currentTime += dt;
    if (adv.currentTime > (adv.videoDuration || 3)) { adv.currentTime = 0; }
    updateAdvancedTimecode();
    syncAdvancedSliders();
    renderAdvancedFs();
    // 播放时降低时间轴渲染频率（每3帧渲染一次），提升主画面帧率
    if (!adv._tlRenderSkip) adv._tlRenderSkip = 0;
    adv._tlRenderSkip++;
    if (adv._tlRenderSkip >= 3) {
      adv._tlRenderSkip = 0;
      renderAdvancedTimeline();
    }
    adv.playRafId = requestAnimationFrame(advPlayLoop);
  }

  // ========== 时间轴拖动：像视频进度条一样 ==========
  // 红线用HTML div，拖动时只改CSS left，零canvas开销
  let _tlRenderRafPending = false;
  let _advPlayheadDiv = null; // 红线div引用

  function updatePlayheadDiv() {
    if (!_advPlayheadDiv) _advPlayheadDiv = document.getElementById('advPlayhead');
    if (!_advPlayheadDiv) return;
    const canvas = dom.advFsTimelineCanvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const duration = adv.videoDuration || 3;
    const pxPerSec = (rect.width * adv.tlZoom) / duration;
    const x = adv.currentTime * pxPerSec - adv.tlScrollX;
    _advPlayheadDiv.style.left = x + 'px';
  }

  let _tlDragActive = false;  // 拖动状态标记
  let _tlLastRenderTime = 0;  // 上次渲染时间戳
  const TL_DRAG_RENDER_INTERVAL = 80; // 拖动时帧渲染间隔(ms)，平衡流畅度和性能

  function advTimelineSeek(clientX, isDragging) {
    const canvas = dom.advFsTimelineCanvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const duration = adv.videoDuration || 3;
    const pxPerSec = (rect.width * adv.tlZoom) / duration;
    const t = Math.max(0, Math.min((x + adv.tlScrollX) / pxPerSec, duration));
    // 红线立刻跟随手指（只改CSS，零开销）
    adv.currentTime = t;
    updatePlayheadDiv();
    updateAdvancedTimecode();
    syncAdvancedSliders();

    // 拖动中降低渲染频率，松手时完整渲染
    const now = performance.now();
    if (isDragging && (now - _tlLastRenderTime) < TL_DRAG_RENDER_INTERVAL) {
      return; // 节流：拖动中跳过部分帧渲染
    }
    _tlLastRenderTime = now;

    // 视频帧渲染用RAF节流，不阻塞红线
    if (!_tlRenderRafPending) {
      _tlRenderRafPending = true;
      requestAnimationFrame(() => {
        _tlRenderRafPending = false;
        if (adv.isGif && advGifAccCanvas) {
          const targetIdx = getGifFrameIdxAtTime(adv.currentTime);
          seekAdvGifToFrame(targetIdx);
        }
        renderAdvancedFs();
      });
    }
  }

  // ========== 高级剪辑事件绑定 ==========

  function bindAdvancedFsEvents() {
    if (dom.advFsBack) dom.advFsBack.onclick = closeAdvancedFs;
    if (dom.advFsUndo) dom.advFsUndo.onclick = undoAdvanced;
    if (dom.advFsAddImage) dom.advFsAddImage.onclick = addAdvancedImage;
    if (dom.advFsEmptyAdd) dom.advFsEmptyAdd.onclick = addAdvancedImage;
    if (dom.advFsPlayBtn) dom.advFsPlayBtn.onclick = advancedPlayToggle;

    // 模式切换
    document.querySelectorAll('.adv-mode-tab').forEach(tab => {
      tab.onclick = () => switchAdvMode(tab.dataset.mode);
    });

    // 追踪开始按钮
    if (dom.advTrackStartBtn) dom.advTrackStartBtn.onclick = runTracking;
    // 追踪密度输入
    const trackPrecisionInput = document.getElementById('advTrackPrecision');
    if (trackPrecisionInput) {
      trackPrecisionInput.addEventListener('input', () => {
        let v = parseInt(trackPrecisionInput.value, 10);
        if (isNaN(v) || v < 1) v = 1;
        if (v > 10) v = 10;
        adv.trackInterval = v;
      });
      trackPrecisionInput.addEventListener('blur', () => {
        let v = parseInt(trackPrecisionInput.value, 10);
        if (isNaN(v) || v < 1) v = 1;
        if (v > 10) v = 10;
        trackPrecisionInput.value = v;
        adv.trackInterval = v;
      });
    }
    // 相对位置模式开关
    const trackRelativeCheckbox = document.getElementById('advTrackRelativeMode');
    if (trackRelativeCheckbox) {
      trackRelativeCheckbox.addEventListener('change', () => {
        adv.trackRelativeMode = trackRelativeCheckbox.checked;
        adv.trackPointSet = false; // 重置追踪点状态
        // 更新UI样式
        const hintEl = document.getElementById('advTrackHint');
        const hintTextEl = document.getElementById('advTrackHintText');
        if (adv.trackRelativeMode) {
          if (hintEl) hintEl.classList.add('relative-mode');
          if (hintTextEl) hintTextEl.textContent = t('meme.adv.hint.relativeSelect');
          // 隐藏锚点标记（等待用户重新设置）
          if (dom.advTrackAnchor) dom.advTrackAnchor.classList.add('hidden');
        } else {
          if (hintEl) hintEl.classList.remove('relative-mode');
          if (hintTextEl) hintTextEl.textContent = t('meme.adv.hint.place');
          if (dom.advTrackAnchor) dom.advTrackAnchor.classList.add('hidden');
        }
      });
    }

    // 关键帧按钮
    if (dom.advFsPosKfBtn) dom.advFsPosKfBtn.onclick = () => {
      const layer = adv.layers.find(l => l.id === adv.selectedLayerId);
      if (!layer) return;
      saveUndoState();
      const hasKf = layer.keyframes.pos.some(k => Math.abs(k.t - adv.currentTime) < 0.01);
      if (hasKf) { removeAdvKeyframe(layer.id, 'pos', adv.currentTime); }
      else {
        const st = getAdvLayerState(layer, adv.currentTime);
        addAdvKeyframe(layer.id, 'pos', adv.currentTime, { t: adv.currentTime, x: st.x, y: st.y });
      }
      syncAdvancedSliders(); renderAdvancedFs(); renderAdvancedTimeline();
    };
    if (dom.advFsScaleKfBtn) dom.advFsScaleKfBtn.onclick = () => {
      const layer = adv.layers.find(l => l.id === adv.selectedLayerId);
      if (!layer) return;
      saveUndoState();
      const hasKf = layer.keyframes.scale.some(k => Math.abs(k.t - adv.currentTime) < 0.01);
      if (hasKf) { removeAdvKeyframe(layer.id, 'scale', adv.currentTime); }
      else {
        const st = getAdvLayerState(layer, adv.currentTime);
        addAdvKeyframe(layer.id, 'scale', adv.currentTime, { t: adv.currentTime, s: st.scale });
      }
      syncAdvancedSliders(); renderAdvancedFs(); renderAdvancedTimeline();
    };
    if (dom.advFsRotateKfBtn) dom.advFsRotateKfBtn.onclick = () => {
      const layer = adv.layers.find(l => l.id === adv.selectedLayerId);
      if (!layer) return;
      saveUndoState();
      const hasKf = layer.keyframes.rot.some(k => Math.abs(k.t - adv.currentTime) < 0.01);
      if (hasKf) { removeAdvKeyframe(layer.id, 'rot', adv.currentTime); }
      else {
        const st = getAdvLayerState(layer, adv.currentTime);
        addAdvKeyframe(layer.id, 'rot', adv.currentTime, { t: adv.currentTime, r: st.rotation });
      }
      syncAdvancedSliders(); renderAdvancedFs(); renderAdvancedTimeline();
    };
    // 时间轴交互：轻点跳转，长按拖动跟随手指，双指缩放
    if (dom.advFsTimelineCanvas) {
      let _tlPointerId = null;
      let _tlDownTime = 0;
      let _tlDownX = 0;
      let _tlMoved = false;
      let _tlDragBaseTime = 0;   // 长按拖动起始时的当前时间
      let _tlDragBasePxPerSec = 1; // 拖动起始时的像素/秒比
      const TAP_THRESHOLD = 8;    // 移动超过8px算拖动
      const TAP_TIME = 250;       // 250ms内松手算轻点

      // 双指缩放状态
      let _tlPinchStartDist = 0;
      let _tlPinchStartZoom = 1;
      let _tlPinchActive = false;
      let _tlActivePointers = new Map(); // 跟踪所有活跃指针

      function _tlGetDist(e1, e2) {
        const dx = e1.clientX - e2.clientX;
        const dy = e1.clientY - e2.clientY;
        return Math.sqrt(dx * dx + dy * dy);
      }

      dom.advFsTimelineCanvas.addEventListener('pointerdown', (e) => {
        _tlActivePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (_tlActivePointers.size === 2) {
          // 进入双指缩放模式
          const pts = Array.from(_tlActivePointers.values());
          _tlPinchStartDist = _tlGetDist({ clientX: pts[0].x, clientY: pts[0].y }, { clientX: pts[1].x, clientY: pts[1].y });
          _tlPinchStartZoom = adv.tlZoom;
          _tlPinchActive = true;
          _tlDragActive = false;
          _tlMoved = false;
          try { dom.advFsTimelineCanvas.setPointerCapture(e.pointerId); } catch(_) {}
          e.preventDefault();
          return;
        }
        _tlPointerId = e.pointerId;
        _tlDownTime = Date.now();
        _tlDownX = e.clientX;
        _tlMoved = false;
        _tlDragActive = false;
        // 记录拖动起始时的当前时间和像素比
        _tlDragBaseTime = adv.currentTime;
        const rect = dom.advFsTimelineCanvas.getBoundingClientRect();
        const duration = adv.videoDuration || 3;
        _tlDragBasePxPerSec = (rect.width * adv.tlZoom) / duration;
        // 锁定指针到canvas，确保拖动过程中 pointermove 不丢失
        try { dom.advFsTimelineCanvas.setPointerCapture(e.pointerId); } catch(_) {}
        e.preventDefault();
      });

      dom.advFsTimelineCanvas.addEventListener('pointermove', (e) => {
        if (_tlActivePointers.has(e.pointerId)) {
          _tlActivePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        }
        if (_tlPinchActive && _tlActivePointers.size >= 2) {
          // 双指缩放时间轴
          const pts = Array.from(_tlActivePointers.values());
          const dist = _tlGetDist({ clientX: pts[0].x, clientY: pts[0].y }, { clientX: pts[1].x, clientY: pts[1].y });
          const newZoom = Math.max(0.5, Math.min(20, _tlPinchStartZoom * (dist / _tlPinchStartDist)));
          adv.tlZoom = newZoom;
          renderAdvancedTimeline();
          updatePlayheadDiv();
          e.preventDefault();
          return;
        }
        if (e.pointerId !== _tlPointerId) return;
        if (Math.abs(e.clientX - _tlDownX) > TAP_THRESHOLD) {
          _tlMoved = true;
          _tlDragActive = true;
        }
        if (_tlMoved) {
          // 相对位移拖动：时间轴从当前位置偏移，不跟随手指绝对位置
          const dx = e.clientX - _tlDownX;
          const deltaTime = dx / _tlDragBasePxPerSec;
          const duration = adv.videoDuration || 3;
          const newTime = Math.max(0, Math.min(_tlDragBaseTime + deltaTime, duration));
          adv.currentTime = newTime;
          updatePlayheadDiv();
          updateAdvancedTimecode();
          syncAdvancedSliders();
          // 节流渲染
          const now = performance.now();
          if ((now - _tlLastRenderTime) >= TL_DRAG_RENDER_INTERVAL) {
            _tlLastRenderTime = now;
            if (!_tlRenderRafPending) {
              _tlRenderRafPending = true;
              requestAnimationFrame(() => {
                _tlRenderRafPending = false;
                if (adv.isGif && advGifAccCanvas) {
                  const targetIdx = getGifFrameIdxAtTime(adv.currentTime);
                  seekAdvGifToFrame(targetIdx);
                }
                renderAdvancedFs();
              });
            }
          }
        }
      });

      const _tlPointerUp = (e) => {
        _tlActivePointers.delete(e.pointerId);
        if (_tlActivePointers.size < 2) {
          _tlPinchActive = false;
        }
        if (_tlPinchActive) return; // 双指模式中，不处理单指逻辑
        if (e.pointerId !== _tlPointerId) return;
        const elapsed = Date.now() - _tlDownTime;
        if (!_tlMoved && elapsed < TAP_TIME) {
          // 轻点：红线直接跳到点击位置
          advTimelineSeek(e.clientX, false);
        } else if (_tlMoved) {
          // 拖动结束：强制做一次完整渲染
          _tlLastRenderTime = 0;
          if (adv.isGif && advGifAccCanvas) {
            const targetIdx = getGifFrameIdxAtTime(adv.currentTime);
            seekAdvGifToFrame(targetIdx);
          }
          renderAdvancedFs();
        }
        // 释放指针锁定
        try { dom.advFsTimelineCanvas.releasePointerCapture(e.pointerId); } catch(_) {}
        _tlPointerId = null;
        _tlMoved = false;
        _tlDragActive = false;
        _lastPlayheadX = -999;
      };

      dom.advFsTimelineCanvas.addEventListener('pointerup', _tlPointerUp);
      dom.advFsTimelineCanvas.addEventListener('pointercancel', _tlPointerUp);
    }

    // 画布交互（根据模式不同行为不同）
    if (dom.advFsCanvas) {
      // 双指缩放状态
      let pinchStartDist = 0;
      let pinchStartScale = 1;
      let pinchActive = false;

      dom.advFsCanvas.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const rect = dom.advFsCanvas.getBoundingClientRect();
        const scaleX = adv.canvasWidth / rect.width;
        const scaleY = adv.canvasHeight / rect.height;
        const cx = (e.clientX - rect.left) * scaleX;
        const cy = (e.clientY - rect.top) * scaleY;

        // 辅助函数：检测点击是否落在某个图层上（从上到下检测）
        function hitTestLayer(x, y) {
          for (let i = adv.layers.length - 1; i >= 0; i--) {
            const l = adv.layers[i];
            if (!l.visible) continue;
            const st = getAdvLayerState(l, adv.currentTime);
            const img = l.image;
            const imgW = (img.naturalWidth || img.width) * st.scale;
            const imgH = (img.naturalHeight || img.height) * st.scale;
            const left = st.x - imgW / 2;
            const top = st.y - imgH / 2;
            if (x >= left && x <= left + imgW && y >= top && y <= top + imgH) {
              return l;
            }
          }
          return null;
        }

        // 辅助函数：开始拖动图层
        function startDragLayer(layer) {
          const st = getAdvLayerState(layer, adv.currentTime);
          const offsetX = cx - st.x;
          const offsetY = cy - st.y;
          saveUndoState();
          const onMove = (ev) => {
            if (pinchActive) return;
            ev.preventDefault();
            const nx = (ev.clientX - rect.left) * scaleX - offsetX;
            const ny = (ev.clientY - rect.top) * scaleY - offsetY;
            if (adv.autoKeyframe) {
              addAdvKeyframe(layer.id, 'pos', adv.currentTime, { t: adv.currentTime, x: nx, y: ny });
            }
            syncAdvancedSliders(); renderAdvancedFs(); renderAdvancedTimeline();
          };
          const onUp = () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
          };
          document.addEventListener('pointermove', onMove);
          document.addEventListener('pointerup', onUp);
        }

        if (adv.mode === 'track') {
          // 相对位置模式
          if (adv.trackRelativeMode) {
            // 先检测是否点到了图层 — 如果点到了图层，拖动图层而非设置追踪点
            const hitLayer = hitTestLayer(cx, cy);
            if (hitLayer) {
              // 点到了图层：选中并拖动
              adv.selectedLayerId = hitLayer.id;
              syncAdvancedSliders(); renderAdvancedFs(); renderAdvLayerStrip(); renderAdvancedTimeline();
              startDragLayer(hitLayer);
              return;
            }
            // 点到空白区域：设置追踪锚点
            setTrackAnchor(cx, cy);
            adv.trackPointSet = true;
            const hintTextEl = document.getElementById('advTrackHintText');
            if (hintTextEl) hintTextEl.textContent = t('meme.adv.hint.pointSet');
            return;
          }
          // 普通追踪模式：检测是否点到了图层
          const hitLayer = hitTestLayer(cx, cy);
          if (hitLayer) {
            // 点到了图层：选中并拖动
            adv.selectedLayerId = hitLayer.id;
            syncAdvancedSliders(); renderAdvancedFs(); renderAdvLayerStrip(); renderAdvancedTimeline();
            startDragLayer(hitLayer);
            return;
          }
          return;
        }

        // 关键帧/录制模式：先检测点击是否落在某个图层上
        const hitLayer = hitTestLayer(cx, cy);
        if (hitLayer) {
          // 点到了图层：选中并拖动
          adv.selectedLayerId = hitLayer.id;
          syncAdvancedSliders(); renderAdvancedFs(); renderAdvLayerStrip(); renderAdvancedTimeline();
          startDragLayer(hitLayer);
          return;
        }

        // 没点到任何图层，如果有选中图层则拖动它
        const selLayer = adv.layers.find(l => l.id === adv.selectedLayerId);
        if (selLayer) {
          startDragLayer(selLayer);
        }
      });

      // 双指缩放手势
      dom.advFsCanvas.addEventListener('touchstart', (e) => {
        if (e.touches.length === 2) {
          e.preventDefault();
          const layer = adv.layers.find(l => l.id === adv.selectedLayerId);
          if (!layer) return;

          const t0 = e.touches[0], t1 = e.touches[1];
          pinchStartDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
          const st = getAdvLayerState(layer, adv.currentTime);
          pinchStartScale = st.scale;
          pinchActive = true;
          saveUndoState();
        }
      }, { passive: false });

      dom.advFsCanvas.addEventListener('touchmove', (e) => {
        if (e.touches.length === 2 && pinchActive) {
          e.preventDefault();
          const layer = adv.layers.find(l => l.id === adv.selectedLayerId);
          if (!layer) return;

          const t0 = e.touches[0], t1 = e.touches[1];
          const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
          const ratio = dist / (pinchStartDist || 1);
          const newScale = Math.max(0.1, Math.min(5, pinchStartScale * ratio));

          if (adv.autoKeyframe) {
            addAdvKeyframe(layer.id, 'scale', adv.currentTime, { t: adv.currentTime, s: newScale });
          }
          // 同时更新初始关键帧（如果无自动关键帧）
          const kf = layer.keyframes.scale;
          if (!adv.autoKeyframe && kf.length > 0) {
            kf[0].s = newScale;
          }

          syncAdvancedSliders(); renderAdvancedFs(); renderAdvancedTimeline();
        }
      }, { passive: false });

      dom.advFsCanvas.addEventListener('touchend', (e) => {
        if (e.touches.length < 2) {
          pinchActive = false;
        }
      });
    }

    bindAdvSliders();
  }

  function drawSelectionBox(l) {
    const box = getLayerBox(l);
    const w = box.w, h = box.h;
    ctx.save();
    // 虚线橙色选中框
    ctx.strokeStyle = '#FF6B3D';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(l.x - w / 2 - 4, l.y - h / 2 - 4, w + 8, h + 8);
    ctx.setLineDash([]);
    ctx.restore();
  }

  function getLayerBox(l) {
    if (l.type === 'text') return { w: l.size * 3, h: l.size * 2 };
    if (l.type === 'draw') return { w: l.width || l.size, h: l.height || l.size };
    return { w: l.size, h: l.size };
  }

  // ========== 文字管理 ==========
  function makeText(text, x, y, opts = {}) {
    return Object.assign({
      type: 'text', id: state.nextId++,
      text, x, y,
      font: 'heavy', color: '#FFFFFF', stroke: STROKE_DEFAULT, size: TEXT_DEFAULT_SIZE,
      rotation: 0, shadow: false, flipped: false,
    }, opts);
  }

  function getSelected() {
    return state.layers.find(l => l.id === state.selectedId);
  }

  function handleLayerAction(act, idx) {
    const l = state.layers[idx];
    if (!l) return;
    if (act === 'up' && idx < state.layers.length - 1) {
      [state.layers[idx], state.layers[idx + 1]] = [state.layers[idx + 1], state.layers[idx]];
    } else if (act === 'down' && idx > 0) {
      [state.layers[idx], state.layers[idx - 1]] = [state.layers[idx - 1], state.layers[idx]];
    } else if (act === 'flip') {
      l.flipped = !l.flipped;
    } else if (act === 'dup') {
      let copy;
      if (l.type === 'draw' && l.image) {
        const c = document.createElement('canvas');
        c.width = l.image.width; c.height = l.image.height;
        c.getContext('2d').drawImage(l.image, 0, 0);
        copy = Object.assign({}, l, { id: state.nextId++, image: c });
      } else {
        copy = JSON.parse(JSON.stringify(l));
        copy.id = state.nextId++;
      }
      copy.x += 20; copy.y += 20;
      state.layers.push(copy);
      state.selectedId = copy.id;
    } else if (act === 'del') {
      state.layers.splice(idx, 1);
      if (state.selectedId === l.id) state.selectedId = null;
    }
    render();
    pushHistory();
  }

  // ========== 裁剪 ==========
  function applyCrop() {
    if (!state.sourceImage) return;
    const w = state.canvasWidth, h = state.canvasHeight;
    let newW = w, newH = h;
    if (state.cropRatio === 'square') {
      const s = Math.min(w, h); newW = newH = s;
    } else if (state.cropRatio === 'wide') {
      if (w / h > 4 / 3) { newW = Math.round(h * 4 / 3); newH = h; }
      else { newW = w; newH = Math.round(w * 3 / 4); }
    } else if (state.cropRatio === 'portrait') {
      if (w / h > 3 / 4) { newW = Math.round(h * 3 / 4); newH = h; }
      else { newW = w; newH = Math.round(w * 4 / 3); }
    }

    const tmp = document.createElement('canvas');
    tmp.width = newW; tmp.height = newH;
    const tctx = tmp.getContext('2d');
    const ox = (w - newW) / 2, oy = (h - newH) / 2;
    tctx.drawImage(dom.canvas, ox, oy, newW, newH, 0, 0, newW, newH);

    const img = new Image();
    img.onload = () => {
      state.sourceImage = img;
      state.canvasWidth = newW; state.canvasHeight = newH;
      dom.canvas.width = newW; dom.canvas.height = newH;
      const sx = newW / w, sy = newH / h;
      state.layers.forEach(l => { l.x = (l.x - ox) * sx; l.y = (l.y - oy) * sy; });
      state.drawPaths.forEach(p => p.points.forEach(pt => { pt.x = (pt.x - ox) * sx; pt.y = (pt.y - oy) * sy; }));
      state.blurSourceData = null; state.blurSourceKey = '';
      render();
      pushHistory();
      showToast(t('meme.crop.done', { width: newW, height: newH }), 'info');
    };
    img.src = tmp.toDataURL();
  }

  function resetCrop() {
    if (!state.sourcePath) return;
    loadSource(state.sourcePath);
  }

  // ========== 平台预设 ==========
  function applyPlatformPreset(platform) {
    const preset = PLATFORM_PRESETS[platform];
    if (!preset) return;

    // 自动设置画布尺寸
    const w = preset.width, h = preset.height;
    state.canvasWidth = w; state.canvasHeight = h;
    dom.canvas.width = w; dom.canvas.height = h;

    // 重新渲染底图到新尺寸
    render();
    pushHistory();
    showToast(t('meme.preset.applied', { label: preset.label, width: w, height: h, size: (preset.maxSizeKB / 1024).toFixed(preset.maxSizeKB % 1024 === 0 ? 0 : 1) }), 'info');
  }

  // ========== 一键加白边 ==========
  function addWhiteBorder() {
    if (!state.sourceImage) return;
    const w = state.canvasWidth, h = state.canvasHeight;
    const borderPx = Math.max(8, Math.round(Math.min(w, h) * 0.08));
    const newW = w + borderPx * 2, newH = h + borderPx * 2;

    // 先把当前画布内容快照
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext('2d');
    // 渲染当前完整画面（不含选中框）
    const oldSel = state.selectedId;
    state.selectedId = snapshot.layers && snapshot.layers.length
      ? snapshot.layers[snapshot.layers.length - 1].id
      : null;
    render();
    tctx.drawImage(dom.canvas, 0, 0);
    state.selectedId = oldSel;

    // 创建新画布，白底+居中贴原图
    const out = document.createElement('canvas');
    out.width = newW; out.height = newH;
    const octx = out.getContext('2d');
    octx.fillStyle = '#FFFFFF';
    octx.fillRect(0, 0, newW, newH);
    octx.drawImage(tmp, borderPx, borderPx);

    // 替换底图
    const img = new Image();
    img.onload = () => {
      state.sourceImage = img;
      state.canvasWidth = newW; state.canvasHeight = newH;
      dom.canvas.width = newW; dom.canvas.height = newH;
      // 调整图层和涂鸦坐标
      state.layers.forEach(l => { l.x += borderPx; l.y += borderPx; });
      state.drawPaths.forEach(p => p.points.forEach(pt => { pt.x += borderPx; pt.y += borderPx; }));
      state.border = { style: 'none', width: 0 };
      state.blurSourceData = null; state.blurSourceKey = '';
      render();
      pushHistory();
      showToast(t('meme.border.white', { px: borderPx }), 'info');
    };
    img.src = out.toDataURL();
  }

  // ========== 一键圆角 ==========
  function addRoundCorner() {
    if (!state.sourceImage) return;
    const w = state.canvasWidth, h = state.canvasHeight;
    const radius = Math.round(Math.min(w, h) * 0.12);

    // 先把当前画布快照
    const oldSel = state.selectedId;
    state.selectedId = null;
    render();
    const currentDataUrl = dom.canvas.toDataURL('image/png');
    state.selectedId = oldSel;

    const img = new Image();
    img.onload = () => {
      // 创建圆角裁剪
      const out = document.createElement('canvas');
      out.width = w; out.height = h;
      const octx = out.getContext('2d');

      // 绘制圆角路径
      octx.beginPath();
      octx.moveTo(radius, 0);
      octx.lineTo(w - radius, 0);
      octx.arcTo(w, 0, w, radius, radius);
      octx.lineTo(w, h - radius);
      octx.arcTo(w, h, w - radius, h, radius);
      octx.lineTo(radius, h);
      octx.arcTo(0, h, 0, h - radius, radius);
      octx.lineTo(0, radius);
      octx.arcTo(0, 0, radius, 0, radius);
      octx.closePath();
      octx.clip();

      // 画底图
      octx.drawImage(img, 0, 0);

      // 替换底图为带透明度的圆角图
      const result = new Image();
      result.onload = () => {
        state.sourceImage = result;
        state.blurSourceData = null; state.blurSourceKey = '';
        render();
        pushHistory();
        showToast(t('meme.round.added', { px: radius }), 'info');
      };
      result.src = out.toDataURL('image/png');
    };
    img.src = currentDataUrl;
  }

  // 加载图片辅助函数（复用 resolveImgSrc 统一路径解析）
  function loadImageAsync(path) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = resolveImgSrc(path);
    });
  }

  // ========== 触摸交互 ==========
  let touch = {
    mode: 'none', id: null, type: null, sx: 0, sy: 0, ox: 0, oy: 0,
    dist: 0, size: 0, startAngle: 0, origRotation: 0, drawing: false,
  };

  function getCanvasPosXY(clientX, clientY) {
    const rect = dom.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * state.canvasWidth / rect.width,
      y: (clientY - rect.top) * state.canvasHeight / rect.height,
    };
  }

  function getCanvasPos(e) {
    const t = e.touches[0] || e.changedTouches[0];
    return getCanvasPosXY(t.clientX, t.clientY);
  }

  function hitTest(x, y) {
    for (let i = state.layers.length - 1; i >= 0; i--) {
      const l = state.layers[i];
      let hw, hh;
      if (l.type === 'text') { hw = l.size * 2; hh = l.size; }
      else if (l.type === 'draw') { hw = (l.width || l.size) / 2; hh = (l.height || l.size) / 2; }
      else { hw = l.size / 2; hh = l.size / 2; }
      if (Math.abs(x - l.x) < hw && Math.abs(y - l.y) < hh) return l;
    }
    return null;
  }

  function onTouchStart(e) {
    e.preventDefault();

    if (state.drawMode) {
      // 画笔模式
      const pos = getCanvasPos(e);
      touch.drawing = true;
      touch.id = null;
      touch.startX = pos.x; touch.startY = pos.y;

      if (state.drawToolMode === 'mosaic') {
        // 马赛克
        state.currentPath = {
          type: 'mosaic', size: state.mosaicSize,
          points: [pos],
        };
      } else if (state.drawToolMode === 'eraser') {
        // 橡皮擦
        state.currentPath = {
          type: 'eraser',
          width: state.brushWidth * 3,
          points: [pos],
        };
      } else if (state.drawToolMode === 'blur') {
        // 模糊笔刷
        state.currentPath = {
          type: 'blur',
          width: state.brushWidth * 3,
          points: [pos],
        };
        // 立即对触摸点做模糊
        applyBlurAtPoint(pos.x, pos.y, state.brushWidth * 2);
      } else if (state.drawShape === 'free') {
        // 自由画笔
        state.currentPath = {
          type: 'pen', shape: 'free',
          color: state.drawColor, width: state.brushWidth,
          points: [pos],
        };
      } else {
        // 形状画笔
        state.currentPath = {
          type: 'pen', shape: state.drawShape,
          color: state.drawColor, width: state.brushWidth,
          points: [pos, pos],
        };
      }
      state.drawPaths.push(state.currentPath);
      if (state.drawToolMode !== 'blur') render();
      return;
    }

    if (e.touches.length === 2) {
      const t1 = e.touches[0], t2 = e.touches[1];
      const p1 = getCanvasPosXY(t1.clientX, t1.clientY);
      const p2 = getCanvasPosXY(t2.clientX, t2.clientY);
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const hit = hitTest(mid.x, mid.y) || hitTest(p1.x, p1.y) || hitTest(p2.x, p2.y);
      if (hit) {
        touch.mode = 'scale';
        touch.id = hit.id;
        touch.type = hit.type;
        touch.dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
        touch.size = hit.size || 32;
        touch.origRotation = hit.rotation || 0;
        touch.startAngle = Math.atan2(t2.clientY - t1.clientY, t2.clientX - t1.clientX);
        state.selectedId = hit.id;
        render();
      }
      return;
    }

    if (e.touches.length === 1) {
      const pos = getCanvasPos(e);
      const hit = hitTest(pos.x, pos.y);
      if (hit) {
        touch.mode = 'drag'; touch.id = hit.id; touch.type = hit.type;
        touch.sx = pos.x; touch.sy = pos.y; touch.ox = hit.x; touch.oy = hit.y;
        state.selectedId = hit.id;
        render();
      } else {
        state.selectedId = null;
        render();
      }
    } else if (e.touches.length === 2 && touch.mode === 'drag') {
      const t1 = e.touches[0], t2 = e.touches[1];
      touch.mode = 'scale';
      touch.dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const l = getSelected();
      touch.size = l ? (l.size || 32) : 32;
      touch.origRotation = l ? (l.rotation || 0) : 0;
      touch.startAngle = Math.atan2(t2.clientY - t1.clientY, t2.clientX - t1.clientX);
    }
  }

  function onTouchMove(e) {
    e.preventDefault();

    if (state.drawMode && touch.drawing && state.currentPath) {
      const pos = getCanvasPos(e);
      if (state.drawToolMode === 'mosaic') {
        state.currentPath.points.push(pos);
      } else if (state.drawToolMode === 'eraser') {
        state.currentPath.points.push(pos);
      } else if (state.drawToolMode === 'blur') {
        // 模糊：在触摸移动时对底图对应区域做 box blur
        state.currentPath.points.push(pos);
        applyBlurAtPoint(pos.x, pos.y, state.brushWidth * 2);
        return; // 模糊直接操作像素，不需要传统 render
      } else if (state.drawShape === 'free') {
        state.currentPath.points.push(pos);
      } else {
        state.currentPath.points[1] = pos;
      }
      render();
      return;
    }
    if (touch.mode === 'drag' && e.touches.length === 1) {
      const pos = getCanvasPos(e);
      const l = state.layers.find(x => x.id === touch.id);
      if (l) { l.x = touch.ox + (pos.x - touch.sx); l.y = touch.oy + (pos.y - touch.sy); render(); }
    } else if (touch.mode === 'scale' && e.touches.length === 2) {
      const t1 = e.touches[0], t2 = e.touches[1];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const scale = dist / touch.dist;
      const newSize = Math.max(8, Math.min(200, Math.round(touch.size * scale)));
      const angle = Math.atan2(t2.clientY - t1.clientY, t2.clientX - t1.clientX);
      const l = getSelected();
      if (l) {
        l.size = newSize;
        l.rotation = touch.origRotation + (angle - touch.startAngle);
        render();
      }
    }
  }

  function onTouchEnd(e) {
    if (state.drawMode && touch.drawing) {
      const donePath = state.currentPath;
      touch.drawing = false;
      state.currentPath = null;
      // 画笔笔迹转成独立图层，可选中、拖动、缩放、旋转
      if (donePath && donePath.type === 'pen') {
        state.drawPaths = state.drawPaths.filter(p => p !== donePath);
        const layer = penPathToLayer(donePath);
        if (layer) {
          state.layers.push(layer);
          state.selectedId = layer.id;
        }
      }
      pushHistory();
      render();
      return;
    }
    if (e.touches.length === 0) {
      if (touch.mode === 'drag' || touch.mode === 'scale') pushHistory();
      touch.mode = 'none'; touch.id = null;
    } else if (e.touches.length === 1 && touch.mode === 'scale') {
      touch.mode = 'drag';
      const pos = getCanvasPos(e);
      touch.sx = pos.x; touch.sy = pos.y;
      const l = getSelected();
      if (l) { touch.ox = l.x; touch.oy = l.y; }
    }
  }

  // ========== 历史记录 ==========
  function pushHistory(includeSource) {
    state.history = state.history.slice(0, state.historyIndex + 1);
    // 画笔图层的 Canvas 不能直接 JSON 序列化，转成 dataURL 保存
    const layersForHistory = state.layers.map(l => {
      if (l.type === 'draw' && l.image) {
        const copy = Object.assign({}, l, { imageDataURL: l.image.toDataURL('image/png') });
        delete copy.image;
        return copy;
      }
      return l;
    });
    const snapshot = {
      layers: layersForHistory,
      drawPaths: state.drawPaths,
      filter: state.filter,
      border: state.border,
      canvasWidth: state.canvasWidth,
      canvasHeight: state.canvasHeight,
    };
    if (includeSource) {
      // 只保存源图片，不保存渲染后的画面（避免撤销时双重渲染）
      const srcTmp = document.createElement('canvas');
      srcTmp.width = state.canvasWidth;
      srcTmp.height = state.canvasHeight;
      srcTmp.getContext('2d').drawImage(state.sourceImage, 0, 0);
      snapshot.sourceDataURL = srcTmp.toDataURL('image/png');
    }
    state.history.push(JSON.stringify(snapshot));
    if (state.history.length > state.maxHistory) state.history.shift();
    state.historyIndex = state.history.length - 1;
    updateUndoRedoButtons();
  }

  function undo() {
    if (state.historyIndex <= 0) return;
    state.historyIndex--;
    restoreHistory();
  }

  function redo() {
    if (state.historyIndex >= state.history.length - 1) return;
    state.historyIndex++;
    restoreHistory();
  }

  function restoreHistory() {
    const snapshot = JSON.parse(state.history[state.historyIndex]);
    state.layers = (snapshot.layers || []).map(l => {
      if (l && l.type === 'draw' && l.imageDataURL) {
        const layer = Object.assign({}, l);
        delete layer.imageDataURL;
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = img.width; c.height = img.height;
          c.getContext('2d').drawImage(img, 0, 0);
          layer.image = c;
          render();
        };
        img.src = l.imageDataURL;
        return layer;
      }
      return l;
    });
    state.drawPaths = snapshot.drawPaths;
    state.filter = snapshot.filter;
    state.border = snapshot.border;
    state.selectedId = snapshot.layers && snapshot.layers.length
      ? snapshot.layers[snapshot.layers.length - 1].id
      : null;

    // 恢复画布尺寸
    if (snapshot.canvasWidth && snapshot.canvasHeight) {
      const resized = dom.canvas.width !== snapshot.canvasWidth || dom.canvas.height !== snapshot.canvasHeight;
      state.canvasWidth = snapshot.canvasWidth;
      state.canvasHeight = snapshot.canvasHeight;
      if (resized) {
        dom.canvas.width = snapshot.canvasWidth;
        dom.canvas.height = snapshot.canvasHeight;
      }
    }

    state.blurSourceData = null; state.blurSourceKey = '';
    state.mosaicCache = null; state.mosaicCacheKey = '';

    // 恢复源图片（裁剪撤销时需要）
    if (snapshot.sourceDataURL) {
      const img = new Image();
      img.onload = () => {
        state.sourceImage = img;
        render();
        updateUndoRedoButtons();
      };
      img.src = snapshot.sourceDataURL;
      return;
    }

    render();
    updateUndoRedoButtons();
  }

  function updateUndoRedoButtons() {
    dom.btnUndo.disabled = state.historyIndex <= 0;
    dom.btnRedo.disabled = state.historyIndex >= state.history.length - 1;
  }

  // ========== 画笔 UI 切换 ==========
  function updateDrawUI() {
    // 面板版已移除，此处保留为空函数以兼容
  }

  // 画笔全屏 UI 切换
  function updateDrawFsUI() {
    const isMosaic = state.drawToolMode === 'mosaic';
    // 形状：仅画笔模式显示
    if (dom.drawFsShapeGroup) dom.drawFsShapeGroup.style.display = (state.drawToolMode === 'pen') ? 'flex' : 'none';
    // 颜色：仅画笔模式显示
    if (dom.drawFsColorGroup) dom.drawFsColorGroup.style.display = (state.drawToolMode === 'pen') ? 'flex' : 'none';
    // 粗细：非马赛克模式显示
    if (dom.drawFsBrushGroup) dom.drawFsBrushGroup.style.display = isMosaic ? 'none' : 'flex';
    // 马赛克块大小：仅马赛克模式
    if (dom.drawFsMosaicGroup) dom.drawFsMosaicGroup.style.display = isMosaic ? 'flex' : 'none';
  }

  // ========== 自定义色盘 ==========
  // 向指定容器添加自定义颜色 chip
  function addCustomColorChipToContainer(container, group, color) {
    if (!container) return;
    if (container.querySelector(`.color-chip[data-color="${color}"]`)) return;
    const addBtn = container.querySelector('.color-chip-add');
    const chip = document.createElement('button');
    chip.className = 'color-chip' + (group === 'drawFs' ? ' draw-fs-color' : '');
    chip.dataset.color = color;
    chip.style.background = color;
    chip.onclick = () => {
      container.querySelectorAll('.color-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      if (group === 'textFs') {
        const layer = getSelected();
        if (layer && layer.type === 'text') { layer.color = color; renderTextFs(); pushHistory(); }
      } else if (group === 'drawFs') {
        state.drawColor = color;
      }
    };
    container.insertBefore(chip, addBtn);
  }

  // ============================================================
  // 模块：导出分享
  // ============================================================
  // ========== 分享 ==========
  async function shareMeme() {
    if (!state.sourceImage) return;
    const oldSel = state.selectedId;
    state.selectedId = null;
    render();

    try {
      const dataUrl = dom.canvas.toDataURL('image/png');
      const base64 = dataUrl.split(',')[1];
      const tmpName = 'meme_share_' + Date.now() + '.png';
      let tmpPath = '';
      if (window.api.getMemeSharePath) {
        tmpPath = await window.api.getMemeSharePath(tmpName);
      }
      if (tmpPath && window.api.saveBase64) {
        await window.api.saveBase64(tmpPath, base64);
        if (window.api.shareImage) {
          const r = await window.api.shareImage(tmpPath);
          if (!r || !r.success) showToast(t('meme.share.fail'), 'error');
        } else {
          const a = document.createElement('a');
          a.href = dataUrl; a.download = tmpName; a.click();
          showToast(t('meme.download.share'), 'info');
        }
      } else {
        const a = document.createElement('a');
        a.href = dataUrl; a.download = tmpName; a.click();
        showToast(t('meme.download.share'), 'info');
      }
    } catch (e) {
      showToast(t('meme.share.fail'), 'error');
    }
    state.selectedId = oldSel;
    render();
  }

  // ========== 导出 ==========
  let _exporting = false;

  async function exportMeme() {
    if (_exporting) return;
    if (!state.sourceImage) return;
    const oldSel = state.selectedId;
    state.selectedId = null;

    // GIF 动画导出
    if (state.isGif && state.gifFrames && state.gifFrames.length > 1 && window.api.encodeGifFromFrames) {
      await exportGifMeme();
      state.selectedId = oldSel;
      render();
      return;
    }

    // 静态图导出
    render();
    try {
      const dataUrl = dom.canvas.toDataURL('image/png');
      const base64 = dataUrl.split(',')[1];
      const defaultName = 'meme_' + Date.now() + '.png';
      const outputPath = await window.api.saveGifDialog(defaultName);
      if (!outputPath) { state.selectedId = oldSel; render(); return; }

      if (window.api.saveBase64) {
        const saved = await window.api.saveBase64(outputPath, base64);
        if (saved) {
          showToast(t('meme.export.success'), 'ok');
        } else {
          showToast(t('meme.export.writeFail'), 'error');
        }
      } else {
        const a = document.createElement('a');
        a.href = dataUrl; a.download = defaultName; a.click();
        showToast(t('meme.download.done'), 'info');
      }
    } catch (e) {
      showToast(t('meme.export.fail', { error: e.message || e }), 'error');
    }
    state.selectedId = oldSel;
    render();
  }

  // GIF动画导出：先选路径 → 逐帧渲染 → 保存PNG → gifski编码
  async function exportGifMeme() {
    _exporting = true;
    const totalFrames = state.gifFrames.length;
    const gw = state.sourceImage.naturalWidth || state.sourceImage.width || state.canvasWidth;
    const gh = state.sourceImage.naturalHeight || state.sourceImage.height || state.canvasHeight;

    // 限制导出分辨率和帧数，防止 gifski 原生编码时 OOM 崩溃
    const MAX_EXPORT_SIZE = 320;
    let exportW = state.canvasWidth, exportH = state.canvasHeight;
    if (exportW > MAX_EXPORT_SIZE || exportH > MAX_EXPORT_SIZE) {
      const scale = Math.min(MAX_EXPORT_SIZE / exportW, MAX_EXPORT_SIZE / exportH);
      exportW = Math.round(exportW * scale);
      exportH = Math.round(exportH * scale);
    }
    // 帧数过多时抽帧，上限 30 帧（防止 gifski native OOM）
    const MAX_EXPORT_FRAMES = 30;
    const frameStep = totalFrames > MAX_EXPORT_FRAMES ? Math.ceil(totalFrames / MAX_EXPORT_FRAMES) : 1;
    const exportFrameCount = Math.ceil(totalFrames / frameStep);

    // 1. 先让用户选择保存路径
    const defaultName = 'meme_' + Date.now() + '.gif';
    let savePath = null;
    try {
      savePath = await window.api.saveGifDialog(defaultName);
    } catch (e) {
      savePath = null;
    }
    if (!savePath) {
      _exporting = false;
      return; // 用户取消
    }

    // 保存原始状态
    const origSourceImage = state.sourceImage;
    const origGifCurrentTime = state.gifCurrentTime;
    const origGifPlaying = state.gifPlaying;
    const origSelectedId = state.selectedId;

    // 停止GIF播放
    stopGifPlayback();

    showModal(t('meme.export.gifTitle'), '<div style="text-align:center;padding:16px 0"><div style="font-size:14px;color:#aaa" id="exportProgressText">' + t('meme.export.renderingFrame', { index: 0, total: totalFrames }) + '</div><div style="margin-top:8px;height:4px;background:#333;border-radius:2px;overflow:hidden"><div id="exportProgressBar" style="height:100%;background:var(--accent);width:0%;transition:width 0.3s"></div></div></div>', []);

    // 创建累积canvas渲染GIF帧
    const accCanvas = document.createElement('canvas');
    accCanvas.width = gw; accCanvas.height = gh;
    const accCtx = accCanvas.getContext('2d');
    accCtx.fillStyle = _gifBgColor;
    accCtx.fillRect(0, 0, gw, gh);

    // 缩放canvas：将主画布缩放到导出尺寸，减少每帧数据量
    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = exportW;
    exportCanvas.height = exportH;
    const exportCtx = exportCanvas.getContext('2d');

    // 计算帧时间
    let cumTime = 0;
    const frameTimes = state.gifFrames.map(f => {
      const t = cumTime;
      cumTime += (f.delay || 100) / 1000;
      return t;
    });

    // 逐帧渲染并保存为临时 PNG（gifski 原生库仅支持 PNG 输入）
    // 每帧都从头渲染（独立完整画面），避免累积绘制的 disposal 状态污染
    const tempPaths = [];
    try {
      // 合成画布：底帧 + 滤镜 + 所有叠加图层
      const composeCanvas = document.createElement('canvas');
      composeCanvas.width = gw; composeCanvas.height = gh;
      const composeCtx = composeCanvas.getContext('2d');

      for (let i = 0, fi = 0; i < totalFrames; i += frameStep, fi++) {
        // 每帧重置 accCtx，从头累积渲染到当前帧
        accCtx.fillStyle = _gifBgColor;
        accCtx.fillRect(0, 0, gw, gh);
        _gifDisposal3Saved = null;
        for (let j = 0; j <= i; j++) {
          const prevJ = j > 0 ? state.gifFrames[j - 1] : null;
          drawGifFrameToCanvas(accCtx, state.gifFrames[j], prevJ, gw, gh);
        }

        // 合成完整画面：底帧 + 滤镜 + 边框 + 涂鸦 + 文字/高级图层
        composeCtx.clearRect(0, 0, gw, gh);
        const f2 = state.filter;
        let filterStr = FILTER_PRESETS[f2.preset] || '';
        if (f2.brightness !== FILTER_DEFAULT) filterStr += ` brightness(${f2.brightness}%)`;
        if (f2.contrast !== FILTER_DEFAULT) filterStr += ` contrast(${f2.contrast}%)`;
        if (f2.saturate !== FILTER_DEFAULT) filterStr += ` saturate(${f2.saturate}%)`;
        composeCtx.filter = filterStr || 'none';
        composeCtx.drawImage(accCanvas, 0, 0, gw, gh);
        composeCtx.filter = 'none';
        renderOverlaysToCtx(composeCtx, gw, gh, frameTimes[i]);

        // 从合成画布缩放到导出尺寸
        exportCtx.fillStyle = _gifBgColor;
        exportCtx.fillRect(0, 0, exportW, exportH);
        exportCtx.drawImage(composeCanvas, 0, 0, exportW, exportH);
        const dataUrl = exportCanvas.toDataURL('image/png');
        const base64 = dataUrl.split(',')[1];

        const tmpName = 'meme_frame_' + fi + '_' + Date.now() + '.png';
        const tmpPath = (await window.api.getMemeSharePath(tmpName)).replace('.gif', '.png');
        if (window.api.saveBase64) {
          await window.api.saveBase64(tmpPath, base64);
          tempPaths.push(tmpPath);
        }

        const progressEl = document.getElementById('exportProgressText');
        const progressBar = document.getElementById('exportProgressBar');
        if (progressEl) progressEl.textContent = t('meme.export.renderingFrame', { index: fi + 1, total: exportFrameCount });
        if (progressBar) progressBar.style.width = ((fi + 1) / exportFrameCount * 70) + '%';

        await new Promise(r => setTimeout(r, 0));
      }

      // 恢复底图
      state.sourceImage = origSourceImage;
      state.gifCurrentTime = origGifCurrentTime;
      state.selectedId = origSelectedId;

      if (tempPaths.length === 0) {
        showToast(t('meme.export.renderFail'), 'error');
        dom.modalOverlay.classList.remove('show');
        _exporting = false;
        return;
      }

      // 渲染完成，释放 canvas 引用并等待 GC 清理内存
      accCanvas.width = 0; accCanvas.height = 0;
      exportCanvas.width = 0; exportCanvas.height = 0;
      composeCanvas.width = 0; composeCanvas.height = 0;
      await new Promise(r => setTimeout(r, 500));

      // 计算GIF帧率
      const avgDelay = state.gifFrames.reduce((s, f) => s + (f.delay || 100), 0) / totalFrames;
      const fps = Math.min(30, Math.round(1000 / avgDelay));

      // 注册一次性gifski事件监听
      let handled = false;
      const gifskiPlugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Gifski;

      const doneHandler = (data) => {
        if (handled) return;
        handled = true;
        if (gifskiPlugin) {
          try { gifskiPlugin.removeListener('gifski:done', doneHandler); } catch(e) {}
          try { gifskiPlugin.removeListener('gifski:error', errHandler); } catch(e) {}
        }
        dom.modalOverlay.classList.remove('show');
        // 恢复GIF播放
        state.sourceImage = origSourceImage;
        state.gifCurrentTime = origGifCurrentTime;
        if (origGifPlaying) startGifPlayback();
        // 导出成功提示
        showToast(t('meme.export.success'), 'ok');
        _exporting = false;
      };
      const errHandler = (e) => {
        if (handled) return;
        handled = true;
        if (gifskiPlugin) {
          try { gifskiPlugin.removeListener('gifski:done', doneHandler); } catch(e2) {}
          try { gifskiPlugin.removeListener('gifski:error', errHandler); } catch(e2) {}
        }
        dom.modalOverlay.classList.remove('show');
        showToast(t('meme.export.gifEncodeFail', { error: e.message || t('error.unknown') }), 'error');
        _exporting = false;
      };

      if (gifskiPlugin) {
        gifskiPlugin.addListener('gifski:done', doneHandler);
        gifskiPlugin.addListener('gifski:error', errHandler);
      }

      // 调用gifski编码，传入导出尺寸（与缩放canvas一致）
      await window.api.encodeGifFromFrames({
        framePaths: tempPaths,
        width: exportW,
        height: exportH,
        fps: fps,
        quality: 100,
        loop: 0,
        fast: false,
        defaultName: defaultName,
        outputPath: savePath
      });

      const progressEl2 = document.getElementById('exportProgressText');
      const progressBar2 = document.getElementById('exportProgressBar');
      if (progressEl2) progressEl2.textContent = t('meme.export.encodingGif');
      if (progressBar2) progressBar2.style.width = '80%';

    } catch (e) {
      showToast(t('meme.export.fail', { error: e.message || e }), 'error');
      dom.modalOverlay.classList.remove('show');
      state.sourceImage = origSourceImage;
      state.gifCurrentTime = origGifCurrentTime;
      state.selectedId = origSelectedId;
      _exporting = false;
    }
  }

  // ============================================================
  // 模块：工具函数
  // ============================================================
  // ========== 工具 ==========
  function showModal(title, body, actions) {
    dom.modalTitle.textContent = title;
    dom.modalBody.innerHTML = body;
    dom.modalActions.innerHTML = '';
    if (actions) {
      actions.forEach(a => {
        const btn = document.createElement('button');
        btn.className = 'btn ' + (a.type === 'primary' ? 'btn-accent' : 'btn-ghost');
        btn.textContent = a.label;
        btn.onclick = () => { dom.modalOverlay.classList.remove('show'); if (a.onClick) a.onClick(); };
        dom.modalActions.appendChild(btn);
      });
    }
    dom.modalOverlay.classList.add('show');
  }

  function showToast(msg, type) {
    const t = document.createElement('div');
    t.className = 'toast ' + (type || 'info');
    t.textContent = msg;
    dom.toastWrap.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 200); }, 1000);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  // ============================================================
  // 模块：文字编辑
  // ============================================================
  // ========== 文字全屏编辑 ==========
  function openTextFs() {
    if (!state.sourceImage) { showToast(t('meme.needSource'), 'warn'); return; }
    // 如果没有选中的文字层，找第一个或新建
    let layer = getSelected();
    if (!layer || layer.type !== 'text') {
      const firstText = state.layers.find(l => l.type === 'text');
      if (firstText) {
        state.selectedId = firstText.id;
        layer = firstText;
      } else {
        // 新建一个文字层
        const textLayer = makeText(t('meme.text.default'), state.canvasWidth / 2, state.canvasHeight / 2);
        state.layers.push(textLayer);
        state.selectedId = textLayer.id;
        layer = textLayer;
        pushHistory();
      }
    }
    // 关闭底部面板
    dom.memePanel.classList.remove('open');
    dom.memePanelOverlay.classList.remove('show');
    // 填充控件
    fillTextFsControls(layer);
    renderTextFsList();
    // 显示全屏
    dom.textFullscreen.classList.remove('hidden');
    dom.textFullscreen.style.display = 'flex';
    // 用requestAnimationFrame测量画布区域实际大小，动态设置canvas分辨率和CSS尺寸
    requestAnimationFrame(() => {
      const area = dom.textFsCanvas.parentElement;
      const w = area.clientWidth - 16;
      const h = area.clientHeight - 16;
      if (w > 0 && h > 0) {
        dom.textFsCanvas.width = w;
        dom.textFsCanvas.height = h;
        dom.textFsCanvas.style.width = w + 'px';
        dom.textFsCanvas.style.height = h + 'px';
      }
      renderTextFs();
      setTimeout(() => dom.textFsInput.focus(), 100);
    });
  }

  function closeTextFs() {
    dom.textFullscreen.classList.add('hidden');
    dom.textFullscreen.style.display = 'none';
    // 更新文字列表和图层列表
    render();
    pushHistory();
  }

  function fillTextFsControls(t) {
    if (!t || t.type !== 'text') return;
    dom.textFsInput.value = t.text;
    dom.textFsFontChips.querySelectorAll('.font-chip').forEach(c => c.classList.toggle('active', c.dataset.font === t.font));
    dom.textFsColorChips.querySelectorAll('.color-chip').forEach(c => c.classList.toggle('active', c.dataset.color === t.color));
    dom.textFsSizeRange.value = t.size; dom.textFsSizeVal.textContent = t.size;
    dom.textFsStrokeRange.value = t.stroke; dom.textFsStrokeVal.textContent = t.stroke;
    dom.textFsRotateRange.value = Math.round((t.rotation || 0) * 180 / Math.PI);
    dom.textFsRotateVal.textContent = dom.textFsRotateRange.value + '°';
    dom.textFsShadowToggle.checked = !!t.shadow;
  }

  function renderTextFsList() {
    dom.textFsList.innerHTML = '';
    state.layers.filter(l => l.type === 'text').forEach(t => {
      const item = document.createElement('div');
      item.className = 'fs-text-list-item' + (t.id === state.selectedId ? ' active' : '');
      const preview = t.text.replace(/\n/g, ' ').slice(0, 10);
      const nameSpan = document.createElement('span');
      nameSpan.className = 'fs-text-list-name';
      nameSpan.textContent = preview || t('meme.text.empty');
      nameSpan.onclick = () => {
        state.selectedId = t.id;
        fillTextFsControls(t);
        renderTextFsList();
        renderTextFs();
      };
      const delBtn = document.createElement('button');
      delBtn.className = 'fs-text-list-del';
      delBtn.textContent = '×';
      delBtn.onclick = (e) => {
        e.stopPropagation();
        state.layers = state.layers.filter(l => l.id !== t.id);
        if (state.selectedId === t.id) {
          const next = state.layers.find(l => l.type === 'text');
          state.selectedId = next ? next.id : null;
          if (next) fillTextFsControls(next);
        }
        renderTextFsList();
        renderTextFs();
        pushHistory();
      };
      item.appendChild(nameSpan);
      item.appendChild(delBtn);
      dom.textFsList.appendChild(item);
    });
  }

  function renderTextFs() {
    if (!state.sourceImage) return;
    const w = dom.textFsCanvas.width;
    const h = dom.textFsCanvas.height;
    if (w <= 0 || h <= 0) return;
    const c = textFsCtx;
    c.clearRect(0, 0, w, h);

    // 纯白背景
    c.fillStyle = '#FFFFFF';
    c.fillRect(0, 0, w, h);

    // 渲染选中的文字层，居中显示
    const layer = state.layers.find(l => l.id === state.selectedId);
    if (layer && layer.type === 'text') {
      // 用较大的缩放让文字填满工作区（以宽度为主，1.3倍放大）
      const scaleX = w / state.canvasWidth;
      const scaleY = h / state.canvasHeight;
      const scale = Math.max(scaleX, scaleY) * 1.3;

      c.save();
      c.translate(w / 2, h / 2);
      c.scale(scale, scale);
      c.translate(-state.canvasWidth / 2, -state.canvasHeight / 2);
      // 文字始终居中
      const tempLayer = Object.assign({}, layer, { x: state.canvasWidth / 2, y: state.canvasHeight / 2 });
      drawLayerToCtx(tempLayer, c);
      c.restore();
    }
  }

  // 在指定 ctx 上画图层
  function drawLayerToCtx(l, c) {
    c.save();
    c.translate(l.x, l.y);
    c.rotate(l.rotation || 0);
    if (l.flipped) c.scale(-1, 1);

    if (l.type === 'text') {
      const fontFamily = FONT_MAP[l.font] || FONT_MAP.heavy;
      let weight, fontStyle;
      if (l.font === 'impact') { weight = 'bold'; fontStyle = ''; }
      else if (l.font === 'kai') { weight = 'normal'; fontStyle = 'italic '; }
      else { weight = '900'; fontStyle = ''; }
      c.font = fontStyle + weight + ' ' + l.size + 'px ' + fontFamily;
      if (l.font === 'kai') { c.transform(1, 0, -0.14, 1, 0, 0); }
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.lineJoin = 'round';

      if (l.shadow) {
        c.shadowColor = 'rgba(0,0,0,0.6)';
        c.shadowBlur = 4;
        c.shadowOffsetX = 2;
        c.shadowOffsetY = 2;
      }

      const lines = l.text.split('\n');
      const lineHeight = l.size * 1.2;
      const totalH = lines.length * lineHeight;
      const startY = -totalH / 2 + lineHeight / 2;

      lines.forEach((line, i) => {
        const y = startY + i * lineHeight;
        if (l.stroke > 0) {
          c.shadowColor = 'transparent';
          c.strokeStyle = l.color === '#000000' ? '#FFFFFF' : '#000000';
          c.lineWidth = l.stroke * 2;
          c.strokeText(line, 0, y);
          if (l.shadow) {
            c.shadowColor = 'rgba(0,0,0,0.6)';
            c.shadowBlur = 4;
            c.shadowOffsetX = 2;
            c.shadowOffsetY = 2;
          }
        }
        c.fillStyle = l.color;
        c.fillText(line, 0, y);
      });
    } else if (l.type === 'draw' && l.image) {
      c.drawImage(l.image, -l.width / 2, -l.height / 2, l.width, l.height);
    }
    c.restore();
  }

  // ========== 画笔全屏编辑 ==========
  function openDrawFs() {
    if (!state.sourceImage) { showToast(t('meme.needSource'), 'warn'); return; }
    // 关闭底部面板
    dom.memePanel.classList.remove('open');
    dom.memePanelOverlay.classList.remove('show');
    // 设置画布尺寸
    dom.drawFsCanvas.width = state.canvasWidth;
    dom.drawFsCanvas.height = state.canvasHeight;
    // 同步画笔控件
    dom.drawFsBrushRange.value = state.brushWidth;
    dom.drawFsBrushVal.textContent = state.brushWidth;
    dom.drawFsMosaicRange.value = state.mosaicSize;
    dom.drawFsMosaicVal.textContent = state.mosaicSize;
    // 同步模式/形状选中状态
    dom.drawFsModeChips.querySelectorAll('.draw-mode-chip').forEach(c => c.classList.toggle('active', c.dataset.mode === state.drawToolMode));
    dom.drawFsShapeChips.querySelectorAll('.draw-shape-chip').forEach(c => c.classList.toggle('active', c.dataset.shape === state.drawShape));
    dom.drawFsColorChips.querySelectorAll('.color-chip').forEach(c => c.classList.toggle('active', c.dataset.color === state.drawColor));
    updateDrawFsUI();
    renderDrawFs();
    // 显示全屏
    dom.drawFullscreen.classList.remove('hidden');
    dom.drawFullscreen.style.display = 'flex';
    state.drawMode = true;
  }

  function closeDrawFs() {
    // 把本次画笔的笔迹转成独立图层，退出后仍可选中、旋转、缩放、拖拽
    const penPaths = state.drawPaths.filter(p => p.type === 'pen');
    if (penPaths.length) {
      state.drawPaths = state.drawPaths.filter(p => p.type !== 'pen');
      const layers = penPaths.map(penPathToLayer).filter(Boolean);
      if (layers.length) {
        state.layers.push(...layers);
        state.selectedId = layers[layers.length - 1].id;
      }
    }
    dom.drawFullscreen.classList.add('hidden');
    dom.drawFullscreen.style.display = 'none';
    state.drawMode = false;
    dom.canvas.classList.remove('drawing');
    render();
    pushHistory();
  }

  // 画笔全屏渲染：底图 + 涂鸦（不画文字图层）
  function renderDrawFs() {
    if (!state.sourceImage) return;
    const w = state.canvasWidth, h = state.canvasHeight;
    const c = drawFsCtx;
    c.clearRect(0, 0, w, h);

    // 滤镜 + 底图
    const f = state.filter;
    let filterStr = FILTER_PRESETS[f.preset] || '';
    if (f.brightness !== FILTER_DEFAULT) filterStr += ` brightness(${f.brightness}%)`;
    if (f.contrast !== FILTER_DEFAULT) filterStr += ` contrast(${f.contrast}%)`;
    if (f.saturate !== FILTER_DEFAULT) filterStr += ` saturate(${f.saturate}%)`;
    c.filter = filterStr || 'none';
    c.drawImage(state.sourceImage, 0, 0, w, h);
    c.filter = 'none';

    // 边框
    if (state.border.style !== 'none') {
      const colors = { white: '#FFFFFF', black: '#000000', red: '#FF4747' };
      c.strokeStyle = colors[state.border.style] || '#FFFFFF';
      c.lineWidth = state.border.width * 2;
      c.strokeRect(0, 0, w, h);
    }

    // 涂鸦
    ensureDrawCanvas(w, h);
    drawCtx.clearRect(0, 0, w, h);
    state.drawPaths.forEach(p => {
      if (p.type === 'mosaic') {
        drawPath(p, c); // 马赛克画到目标 ctx
      } else {
        drawPath(p, drawCtx); // 画笔/橡皮画涂鸦层
      }
    });
    c.drawImage(drawCanvas, 0, 0);
    // 不画文字图层
  }

  // ========== 画笔全屏触摸处理 ==========
  let drawFsTouch = { drawing: false, startX: 0, startY: 0 };

  function getDrawFsCanvasPos(e) {
    const t = e.touches[0] || e.changedTouches[0];
    const rect = dom.drawFsCanvas.getBoundingClientRect();
    return {
      x: (t.clientX - rect.left) * state.canvasWidth / rect.width,
      y: (t.clientY - rect.top) * state.canvasHeight / rect.height,
    };
  }

  function onDrawFsTouchStart(e) {
    e.preventDefault();
    const pos = getDrawFsCanvasPos(e);
    drawFsTouch.drawing = true;
    drawFsTouch.startX = pos.x;
    drawFsTouch.startY = pos.y;

    if (state.drawToolMode === 'mosaic') {
      state.currentPath = {
        type: 'mosaic', size: state.mosaicSize,
        points: [pos],
      };
    } else if (state.drawToolMode === 'eraser') {
      state.currentPath = {
        type: 'eraser',
        width: state.brushWidth * 3,
        points: [pos],
      };
    } else if (state.drawToolMode === 'blur') {
      state.currentPath = {
        type: 'blur',
        width: state.brushWidth * 3,
        points: [pos],
      };
      // 在 drawFsCanvas 上做模糊
      applyBlurAtPointOnCtx(pos.x, pos.y, state.brushWidth * 2, drawFsCtx);
    } else if (state.drawShape === 'free') {
      state.currentPath = {
        type: 'pen', shape: 'free',
        color: state.drawColor, width: state.brushWidth,
        points: [pos],
      };
    } else {
      // 形状画笔
      state.currentPath = {
        type: 'pen', shape: state.drawShape,
        color: state.drawColor, width: state.brushWidth,
        points: [pos, pos],
      };
    }
    state.drawPaths.push(state.currentPath);
    if (state.drawToolMode !== 'blur') renderDrawFs();
  }

  function onDrawFsTouchMove(e) {
    e.preventDefault();
    if (!drawFsTouch.drawing || !state.currentPath) return;
    const pos = getDrawFsCanvasPos(e);

    if (state.drawToolMode === 'mosaic') {
      state.currentPath.points.push(pos);
    } else if (state.drawToolMode === 'eraser') {
      state.currentPath.points.push(pos);
    } else if (state.drawToolMode === 'blur') {
      state.currentPath.points.push(pos);
      applyBlurAtPointOnCtx(pos.x, pos.y, state.brushWidth * 2, drawFsCtx);
      return; // 模糊直接操作像素
    } else if (state.drawShape === 'free') {
      state.currentPath.points.push(pos);
    } else {
      state.currentPath.points[1] = pos;
    }
    renderDrawFs();
  }

  function onDrawFsTouchEnd(e) {
    if (drawFsTouch.drawing) {
      drawFsTouch.drawing = false;
      state.currentPath = null;
      if (state.drawToolMode !== 'blur') renderDrawFs();
    }
  }

  // 在指定 ctx 上做模糊
  function applyBlurAtPointOnCtx(cx, cy, radius, targetCtx) {
    const w = state.canvasWidth, h = state.canvasHeight;
    const currentData = targetCtx.getImageData(0, 0, w, h);
    const cd = currentData.data;
    const r = Math.max(2, radius);

    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const px = Math.round(cx + dx);
        const py = Math.round(cy + dy);
        if (px < 0 || px >= w || py < 0 || py >= h) continue;

        let sumR = 0, sumG = 0, sumB = 0, count = 0;
        const blurR = 2;
        for (let by = -blurR; by <= blurR; by++) {
          for (let bx = -blurR; bx <= blurR; bx++) {
            const bpx = px + bx, bpy = py + by;
            if (bpx < 0 || bpx >= w || bpy < 0 || bpy >= h) continue;
            const idx = (bpy * w + bpx) * 4;
            sumR += cd[idx]; sumG += cd[idx + 1]; sumB += cd[idx + 2];
            count++;
          }
        }
        if (count > 0) {
          const idx = (py * w + px) * 4;
          cd[idx] = Math.round(sumR / count);
          cd[idx + 1] = Math.round(sumG / count);
          cd[idx + 2] = Math.round(sumB / count);
        }
      }
    }
    targetCtx.putImageData(currentData, 0, 0);
  }

  // ============================================================
  // 模块：裁剪系统
  // ============================================================
  // ========== 裁剪全屏编辑 ==========
  function openCropFs() {
    if (!state.sourceImage) { showToast(t('meme.needSource'), 'warn'); return; }
    // 关闭底部面板
    dom.memePanel.classList.remove('open');
    dom.memePanelOverlay.classList.remove('show');
    // 初始化裁剪区域为整个画布
    cropFs.x = 0; cropFs.y = 0;
    cropFs.w = state.canvasWidth; cropFs.h = state.canvasHeight;
    cropFs.ratio = 'free';
    // 同步比例chip选中状态
    dom.cropFsChips.querySelectorAll('.crop-chip').forEach(c => c.classList.toggle('active', c.dataset.crop === 'free'));
    // 设置画布尺寸
    dom.cropFsCanvas.width = state.canvasWidth;
    dom.cropFsCanvas.height = state.canvasHeight;
    renderCropFs();
    // 显示全屏
    dom.cropFullscreen.classList.remove('hidden');
    dom.cropFullscreen.style.display = 'flex';
  }

  function closeCropFs() {
    dom.cropFullscreen.classList.add('hidden');
    dom.cropFullscreen.style.display = 'none';
    render();
  }

  function resetCropFs() {
    cropFs.x = 0; cropFs.y = 0;
    cropFs.w = state.canvasWidth; cropFs.h = state.canvasHeight;
    renderCropFs();
  }

  function applyCropRatio() {
    const w = state.canvasWidth, h = state.canvasHeight;
    const ratio = cropFs.ratio;
    if (ratio === 'free') return;
    let targetW, targetH;
    if (ratio === 'square') {
      const s = Math.min(cropFs.w, cropFs.h);
      targetW = targetH = s;
    } else if (ratio === 'wide') {
      targetH = cropFs.h;
      targetW = Math.round(targetH * 4 / 3);
      if (targetW > w) { targetW = w; targetH = Math.round(targetW * 3 / 4); }
    } else if (ratio === 'portrait') {
      targetW = cropFs.w;
      targetH = Math.round(targetW * 4 / 3);
      if (targetH > h) { targetH = h; targetW = Math.round(targetH * 3 / 4); }
    }
    // 居中调整
    cropFs.w = targetW; cropFs.h = targetH;
    cropFs.x = Math.max(0, Math.min(w - targetW, cropFs.x + (cropFs.w - targetW) / 2));
    cropFs.y = Math.max(0, Math.min(h - targetH, cropFs.y + (cropFs.h - targetH) / 2));
    // 确保不超出边界
    cropFs.x = Math.max(0, Math.min(w - cropFs.w, cropFs.x));
    cropFs.y = Math.max(0, Math.min(h - cropFs.h, cropFs.y));
  }

  function renderCropFs() {
    if (!state.sourceImage) return;
    const w = state.canvasWidth, h = state.canvasHeight;
    const c = cropFsCtx;
    c.clearRect(0, 0, w, h);

    // 先渲染当前画面（不含选中框）
    const oldSel = state.selectedId;
    state.selectedId = null;
    // 渲染底图+滤镜
    const f = state.filter;
    let filterStr = FILTER_PRESETS[f.preset] || '';
    if (f.brightness !== FILTER_DEFAULT) filterStr += ` brightness(${f.brightness}%)`;
    if (f.contrast !== FILTER_DEFAULT) filterStr += ` contrast(${f.contrast}%)`;
    if (f.saturate !== FILTER_DEFAULT) filterStr += ` saturate(${f.saturate}%)`;
    c.filter = filterStr || 'none';
    c.drawImage(state.sourceImage, 0, 0, w, h);
    c.filter = 'none';

    // 边框
    if (state.border.style !== 'none') {
      const colors = { white: '#FFFFFF', black: '#000000', red: '#FF4747' };
      c.strokeStyle = colors[state.border.style] || '#FFFFFF';
      c.lineWidth = state.border.width * 2;
      c.strokeRect(0, 0, w, h);
    }

    // 涂鸦
    ensureDrawCanvas(w, h);
    // 先把涂鸦画到离屏canvas
    drawCtx.clearRect(0, 0, w, h);
    state.drawPaths.forEach(p => {
      if (p.type === 'mosaic') {
        drawPath(p, c);
      } else {
        drawPath(p, drawCtx);
      }
    });
    c.drawImage(drawCanvas, 0, 0);

    // 图层
    state.layers.forEach(l => drawLayerToCtx(l, c));
    state.selectedId = oldSel;

    // 绘制裁剪遮罩（暗化非选区）
    c.save();
    c.beginPath();
    c.rect(0, 0, w, h);
    c.rect(cropFs.x, cropFs.y, cropFs.w, cropFs.h);
    c.clip('evenodd');
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(0, 0, w, h);
    c.restore();

    // 裁剪框边框
    c.strokeStyle = '#FFFFFF';
    c.lineWidth = 2;
    c.setLineDash([]);
    c.strokeRect(cropFs.x, cropFs.y, cropFs.w, cropFs.h);

    // 网格线（三分法）
    c.strokeStyle = 'rgba(255,255,255,0.3)';
    c.lineWidth = 1;
    const cx = cropFs.x, cy = cropFs.y, cw = cropFs.w, ch = cropFs.h;
    // 竖线
    c.beginPath();
    c.moveTo(cx + cw / 3, cy); c.lineTo(cx + cw / 3, cy + ch);
    c.moveTo(cx + cw * 2 / 3, cy); c.lineTo(cx + cw * 2 / 3, cy + ch);
    // 横线
    c.moveTo(cx, cy + ch / 3); c.lineTo(cx + cw, cy + ch / 3);
    c.moveTo(cx, cy + ch * 2 / 3); c.lineTo(cx + cw, cy + ch * 2 / 3);
    c.stroke();

    // 绘制8个拖拽手柄
    const handleSize = 14;
    const handles = getCropHandles(handleSize);
    c.fillStyle = '#FFFFFF';
    handles.forEach(hl => {
      c.fillRect(hl.x - hl.size / 2, hl.y - hl.size / 2, hl.size, hl.size);
    });
  }

  function getCropHandles(size) {
    const cx = cropFs.x, cy = cropFs.y, cw = cropFs.w, ch = cropFs.h;
    return [
      { mode: 'nw', x: cx, y: cy, size },
      { mode: 'n',  x: cx + cw / 2, y: cy, size },
      { mode: 'ne', x: cx + cw, y: cy, size },
      { mode: 'e',  x: cx + cw, y: cy + ch / 2, size },
      { mode: 'se', x: cx + cw, y: cy + ch, size },
      { mode: 's',  x: cx + cw / 2, y: cy + ch, size },
      { mode: 'sw', x: cx, y: cy + ch, size },
      { mode: 'w',  x: cx, y: cy + ch / 2, size },
    ];
  }

  function applyCropFs() {
    if (!state.sourceImage) return;
    const w = state.canvasWidth, h = state.canvasHeight;
    const cx = Math.round(cropFs.x), cy = Math.round(cropFs.y);
    const cw = Math.round(cropFs.w), ch = Math.round(cropFs.h);
    if (cw <= 0 || ch <= 0) { showToast(t('meme.crop.invalid'), 'warn'); return; }
    if (cx === 0 && cy === 0 && cw === w && ch === h) {
      closeCropFs();
      return;
    }

    // 裁剪前保存完整画面（支持撤销）
    pushHistory(true);

    // 只裁剪源图片，不裁剪渲染后的画面
    const tmp = document.createElement('canvas');
    tmp.width = cw; tmp.height = ch;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(state.sourceImage, cx, cy, cw, ch, 0, 0, cw, ch);

    const img = new Image();
    img.onload = () => {
      state.sourceImage = img;
      state.canvasWidth = cw; state.canvasHeight = ch;
      dom.canvas.width = cw; dom.canvas.height = ch;
      // 调整图层和涂鸦坐标（平移到新坐标系）
      state.layers.forEach(l => { l.x -= cx; l.y -= cy; });
      state.drawPaths.forEach(p => p.points.forEach(pt => { pt.x -= cx; pt.y -= cy; }));
      state.blurSourceData = null; state.blurSourceKey = '';
      state.mosaicCache = null; state.mosaicCacheKey = '';
      render();
      closeCropFs();
      showToast(t('meme.crop.done', { width: cw, height: ch }), 'info');
    };
    img.src = tmp.toDataURL();
  }

  // 裁剪画布触摸处理
  function getCropFsCanvasPos(e) {
    const t = e.touches[0] || e.changedTouches[0];
    const rect = dom.cropFsCanvas.getBoundingClientRect();
    return {
      x: (t.clientX - rect.left) * state.canvasWidth / rect.width,
      y: (t.clientY - rect.top) * state.canvasHeight / rect.height,
    };
  }

  function onCropFsTouchStart(e) {
    e.preventDefault();
    const pos = getCropFsCanvasPos(e);
    const handleSize = 20; // 稍大的触摸区域

    // 检查是否触摸了手柄
    const handles = getCropHandles(handleSize);
    for (const hl of handles) {
      if (Math.abs(pos.x - hl.x) < hl.size && Math.abs(pos.y - hl.y) < hl.size) {
        cropFs.dragging = true;
        cropFs.dragMode = hl.mode;
        cropFs.startX = pos.x; cropFs.startY = pos.y;
        cropFs.origX = cropFs.x; cropFs.origY = cropFs.y;
        cropFs.origW = cropFs.w; cropFs.origH = cropFs.h;
        return;
      }
    }

    // 直接触摸边框也能调整对应边（n/s/e/w）
    const edgeHit = 14;
    const onLeft = Math.abs(pos.x - cropFs.x) < edgeHit && pos.y >= cropFs.y && pos.y <= cropFs.y + cropFs.h;
    const onRight = Math.abs(pos.x - (cropFs.x + cropFs.w)) < edgeHit && pos.y >= cropFs.y && pos.y <= cropFs.y + cropFs.h;
    const onTop = Math.abs(pos.y - cropFs.y) < edgeHit && pos.x >= cropFs.x && pos.x <= cropFs.x + cropFs.w;
    const onBottom = Math.abs(pos.y - (cropFs.y + cropFs.h)) < edgeHit && pos.x >= cropFs.x && pos.x <= cropFs.x + cropFs.w;
    const edgeMode = onLeft ? 'w' : onRight ? 'e' : onTop ? 'n' : onBottom ? 's' : null;
    if (edgeMode) {
      cropFs.dragging = true;
      cropFs.dragMode = edgeMode;
      cropFs.startX = pos.x; cropFs.startY = pos.y;
      cropFs.origX = cropFs.x; cropFs.origY = cropFs.y;
      cropFs.origW = cropFs.w; cropFs.origH = cropFs.h;
      return;
    }

    // 检查是否在裁剪框内（移动）
    if (pos.x >= cropFs.x && pos.x <= cropFs.x + cropFs.w &&
        pos.y >= cropFs.y && pos.y <= cropFs.y + cropFs.h) {
      cropFs.dragging = true;
      cropFs.dragMode = 'move';
      cropFs.startX = pos.x; cropFs.startY = pos.y;
      cropFs.origX = cropFs.x; cropFs.origY = cropFs.y;
      cropFs.origW = cropFs.w; cropFs.origH = cropFs.h;
    }
  }

  function onCropFsTouchMove(e) {
    e.preventDefault();
    if (!cropFs.dragging) return;
    const pos = getCropFsCanvasPos(e);
    const dx = pos.x - cropFs.startX;
    const dy = pos.y - cropFs.startY;
    const w = state.canvasWidth, h = state.canvasHeight;
    const minSize = 20;

    if (cropFs.dragMode === 'move') {
      cropFs.x = Math.max(0, Math.min(w - cropFs.origW, cropFs.origX + dx));
      cropFs.y = Math.max(0, Math.min(h - cropFs.origH, cropFs.origY + dy));
    } else {
      // 调整裁剪框
      let newX = cropFs.origX, newY = cropFs.origY;
      let newW = cropFs.origW, newH = cropFs.origH;
      const mode = cropFs.dragMode;

      if (mode.includes('w')) { newX = cropFs.origX + dx; newW = cropFs.origW - dx; }
      if (mode.includes('e')) { newW = cropFs.origW + dx; }
      if (mode.includes('n')) { newY = cropFs.origY + dy; newH = cropFs.origH - dy; }
      if (mode.includes('s')) { newH = cropFs.origH + dy; }

      // 应用比例约束
      if (cropFs.ratio !== 'free') {
        if (mode === 'n' || mode === 's') {
          // 上下拖动，宽度跟随
          if (cropFs.ratio === 'square') newW = newH;
          else if (cropFs.ratio === 'wide') newW = Math.round(newH * 4 / 3);
          else if (cropFs.ratio === 'portrait') newW = Math.round(newH * 3 / 4);
          newX = cropFs.origX + (cropFs.origW - newW) / 2;
        } else if (mode === 'w' || mode === 'e') {
          // 左右拖动，高度跟随
          if (cropFs.ratio === 'square') newH = newW;
          else if (cropFs.ratio === 'wide') newH = Math.round(newW * 3 / 4);
          else if (cropFs.ratio === 'portrait') newH = Math.round(newW * 4 / 3);
          newY = cropFs.origY + (cropFs.origH - newH) / 2;
        } else {
          // 角拖动，以宽度为准
          if (cropFs.ratio === 'square') newH = newW;
          else if (cropFs.ratio === 'wide') newH = Math.round(newW * 3 / 4);
          else if (cropFs.ratio === 'portrait') newH = Math.round(newW * 4 / 3);
        }
      }

      // 最小尺寸约束
      if (newW < minSize) { newW = minSize; if (mode.includes('w')) newX = cropFs.origX + cropFs.origW - minSize; }
      if (newH < minSize) { newH = minSize; if (mode.includes('n')) newY = cropFs.origY + cropFs.origH - minSize; }

      // 边界约束
      if (newX < 0) { newW += newX; newX = 0; }
      if (newY < 0) { newH += newY; newY = 0; }
      if (newX + newW > w) newW = w - newX;
      if (newY + newH > h) newH = h - newY;

      cropFs.x = newX; cropFs.y = newY;
      cropFs.w = Math.max(minSize, newW); cropFs.h = Math.max(minSize, newH);
    }

    renderCropFs();
  }

  function onCropFsTouchEnd(e) {
    cropFs.dragging = false;
    cropFs.dragMode = null;
  }

  // ========== 启动 ==========
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ============================================================
  // AI 指令 -> 表情包工坊业务分发层
  // ============================================================
  const MemeApi = {};

  function isTextFullscreenOpen() {
    return dom.textFullscreen && dom.textFullscreen.style.display !== 'none';
  }

  function isDrawFullscreenOpen() {
    return dom.drawFullscreen && dom.drawFullscreen.style.display !== 'none';
  }

  function isCropFullscreenOpen() {
    return dom.cropFullscreen && dom.cropFullscreen.style.display !== 'none';
  }

  function isAdvancedFullscreenOpen() {
    return dom.advancedFullscreen && dom.advancedFullscreen.style.display !== 'none';
  }

  function ensureTextLayer() {
    if (!state.sourceImage) return null;
    let layer = getSelected();
    if (!layer || layer.type !== 'text') {
      const first = state.layers.find(l => l.type === 'text');
      if (first) {
        layer = first;
      } else {
        layer = makeText(t('meme.text.default'), state.canvasWidth / 2, state.canvasHeight / 2);
        state.layers.push(layer);
      }
      state.selectedId = layer.id;
    }
    return layer;
  }

  function refreshTextUi() {
    const layer = getSelected();
    if (isTextFullscreenOpen()) {
      if (layer) fillTextFsControls(layer);
      renderTextFsList();
      renderTextFs();
    }
    render();
  }

  function syncFilterUi() {
    const f = state.filter;
    document.querySelectorAll('.filter-preset').forEach(el => {
      el.classList.toggle('active', el.dataset.preset === f.preset);
    });
    if (dom.brightnessRange) { dom.brightnessRange.value = f.brightness; dom.brightnessVal.textContent = f.brightness; }
    if (dom.contrastRange) { dom.contrastRange.value = f.contrast; dom.contrastVal.textContent = f.contrast; }
    if (dom.saturateRange) { dom.saturateRange.value = f.saturate; dom.saturateVal.textContent = f.saturate; }
  }

  function openToolPanel(tool) {
    document.querySelectorAll('.meme-sidebar-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.tool === tool);
    });
    document.querySelectorAll('.panel-section').forEach(p => {
      p.classList.toggle('active', p.dataset.panel === tool);
    });
    const names = {
      filter: t('meme.tool.filter'),
      platform: t('meme.tool.platform'),
    };
    dom.memePanelTitle.textContent = names[tool] || tool;
    dom.memePanel.classList.add('open');
    dom.memePanelOverlay.classList.add('show');
  }

  function getAdvSelectedLayer() {
    return adv.layers.find(l => l.id === adv.selectedLayerId) || null;
  }

  function setAdvTransform(type, value) {
    const layer = getAdvSelectedLayer();
    if (!layer) return;
    saveUndoState();
    const st = getAdvLayerState(layer, adv.currentTime);
    if (type === 'pos') {
      addAdvKeyframe(layer.id, 'pos', adv.currentTime, { t: adv.currentTime, x: value.x, y: value.y });
    } else if (type === 'scale') {
      addAdvKeyframe(layer.id, 'scale', adv.currentTime, { t: adv.currentTime, s: value / 100 });
    } else if (type === 'rot') {
      addAdvKeyframe(layer.id, 'rot', adv.currentTime, { t: adv.currentTime, r: value });
    }
    syncAdvancedSliders();
    renderAdvancedFs();
    renderAdvancedTimeline();
  }

  function addKeyframeOfType(type, timeSeconds) {
    const layer = getAdvSelectedLayer();
    if (!layer) return;
    saveUndoState();
    const time = typeof timeSeconds === 'number' ? timeSeconds : adv.currentTime;
    const st = getAdvLayerState(layer, time);
    if (type === 'pos') {
      addAdvKeyframe(layer.id, 'pos', time, { t: time, x: st.x, y: st.y });
    } else if (type === 'scale') {
      addAdvKeyframe(layer.id, 'scale', time, { t: time, s: st.scale });
    } else if (type === 'rot') {
      addAdvKeyframe(layer.id, 'rot', time, { t: time, r: st.rotation });
    }
    if (typeof timeSeconds === 'number') {
      adv.currentTime = Math.max(0, Math.min(adv.videoDuration || timeSeconds, timeSeconds));
      updateAdvancedTimecode();
    }
    syncAdvancedSliders();
    renderAdvancedFs();
    renderAdvancedTimeline();
  }

  function aiAddDrawPath(path) {
    if (!state.sourceImage) return;
    const layer = penPathToLayer(path);
    if (!layer) return;
    state.layers.push(layer);
    state.selectedId = layer.id;
    render();
    pushHistory();
  }

  function refreshAiLayer() {
    const layer = getSelected();
    if (layer && layer.type === 'text') refreshTextUi();
    else render();
  }

  MemeApi.open_page = (params) => {
    if (params.page !== 'meme') return;
  };
  MemeApi.import_source = () => importSource();
  MemeApi.go_back = () => { location.href = 'index.html'; };

  MemeApi.open_text_editor = () => openTextFs();
  MemeApi.close_text_editor = () => { if (isTextFullscreenOpen()) closeTextFs(); };
  MemeApi.add_text = (params) => {
    const layer = ensureTextLayer();
    if (!layer) return;
    layer.text = params.text || layer.text;
    refreshTextUi();
    pushHistory();
  };
  MemeApi.set_text_font = (params) => {
    const layer = ensureTextLayer();
    if (!layer) return;
    layer.font = params.font;
    refreshTextUi();
    pushHistory();
  };
  MemeApi.set_text_color = (params) => {
    const layer = ensureTextLayer();
    if (!layer) return;
    layer.color = params.color.toUpperCase();
    refreshTextUi();
    pushHistory();
  };
  MemeApi.set_text_size = (params) => {
    const layer = ensureTextLayer();
    if (!layer) return;
    layer.size = params.size;
    refreshTextUi();
    pushHistory();
  };
  MemeApi.set_text_stroke = (params) => {
    const layer = ensureTextLayer();
    if (!layer) return;
    layer.stroke = params.stroke;
    refreshTextUi();
    pushHistory();
  };
  MemeApi.set_text_rotation = (params) => {
    const layer = ensureTextLayer();
    if (!layer) return;
    layer.rotation = params.rotation_degrees * Math.PI / 180;
    refreshTextUi();
    pushHistory();
  };
  MemeApi.set_text_shadow = (params) => {
    const layer = ensureTextLayer();
    if (!layer) return;
    layer.shadow = !!params.enabled;
    refreshTextUi();
    pushHistory();
  };

  MemeApi.open_draw_editor = () => openDrawFs();
  MemeApi.close_draw_editor = () => { if (isDrawFullscreenOpen()) closeDrawFs(); };
  MemeApi.set_draw_mode = (params) => {
    state.drawToolMode = params.mode;
    if (isDrawFullscreenOpen()) updateDrawFsUI();
  };
  MemeApi.set_draw_shape = (params) => {
    state.drawShape = params.shape;
    if (isDrawFullscreenOpen()) updateDrawFsUI();
  };
  MemeApi.set_draw_color = (params) => {
    state.drawColor = params.color.toUpperCase();
  };
  MemeApi.set_draw_brush_width = (params) => {
    state.brushWidth = params.width;
    if (dom.drawFsBrushRange) { dom.drawFsBrushRange.value = params.width; dom.drawFsBrushVal.textContent = params.width; }
  };
  MemeApi.set_mosaic_size = (params) => {
    state.mosaicSize = params.size;
    if (dom.drawFsMosaicRange) { dom.drawFsMosaicRange.value = params.size; dom.drawFsMosaicVal.textContent = params.size; }
  };
  MemeApi.clear_draw = () => {
    state.drawPaths = [];
    if (isDrawFullscreenOpen()) renderDrawFs();
    render();
    pushHistory();
  };

  MemeApi.draw_line = (params) => {
    aiAddDrawPath({
      type: 'pen', shape: 'line',
      color: (params.color || state.drawColor).toUpperCase(),
      width: params.stroke_width || state.brushWidth,
      points: [{ x: params.x1, y: params.y1 }, { x: params.x2, y: params.y2 }],
    });
  };
  MemeApi.draw_arrow = (params) => {
    aiAddDrawPath({
      type: 'pen', shape: 'arrow',
      color: (params.color || state.drawColor).toUpperCase(),
      width: params.stroke_width || state.brushWidth,
      points: [{ x: params.x1, y: params.y1 }, { x: params.x2, y: params.y2 }],
    });
  };
  MemeApi.draw_rect = (params) => {
    const w = params.width, h = params.height;
    aiAddDrawPath({
      type: 'pen', shape: 'rect',
      color: (params.color || state.drawColor).toUpperCase(),
      width: params.stroke_width || state.brushWidth,
      points: [{ x: params.x - w / 2, y: params.y - h / 2 }, { x: params.x + w / 2, y: params.y + h / 2 }],
    });
  };
  MemeApi.draw_ellipse = (params) => {
    const w = params.width, h = params.height;
    aiAddDrawPath({
      type: 'pen', shape: 'ellipse',
      color: (params.color || state.drawColor).toUpperCase(),
      width: params.stroke_width || state.brushWidth,
      points: [{ x: params.x - w / 2, y: params.y - h / 2 }, { x: params.x + w / 2, y: params.y + h / 2 }],
    });
  };
  MemeApi.draw_freehand = (params) => {
    const points = String(params.points || '')
      .split(';')
      .map(pair => {
        const [x, y] = pair.split(',').map(Number);
        return { x, y };
      })
      .filter(pt => Number.isFinite(pt.x) && Number.isFinite(pt.y));
    if (points.length < 2) return;
    aiAddDrawPath({
      type: 'pen', shape: 'free',
      color: (params.color || state.drawColor).toUpperCase(),
      width: params.stroke_width || state.brushWidth,
      points,
    });
  };
  MemeApi.erase_area = (params) => {
    if (!state.sourceImage) return;
    state.drawPaths.push({
      type: 'eraser',
      width: params.width || state.brushWidth * 3,
      points: [{ x: params.x1, y: params.y1 }, { x: params.x2, y: params.y2 }],
    });
    if (isDrawFullscreenOpen()) renderDrawFs();
    render();
    pushHistory();
  };
  MemeApi.blur_area = (params) => {
    if (!state.sourceImage) return;
    if (!isDrawFullscreenOpen()) openDrawFs();
    const w = state.canvasWidth, h = state.canvasHeight;
    const x1 = Math.max(0, Math.min(w, Math.min(params.x1, params.x2)));
    const x2 = Math.max(0, Math.min(w, Math.max(params.x1, params.x2)));
    const y1 = Math.max(0, Math.min(h, Math.min(params.y1, params.y2)));
    const y2 = Math.max(0, Math.min(h, Math.max(params.y1, params.y2)));
    const r = params.radius || 8;
    for (let y = y1; y <= y2; y += r) {
      for (let x = x1; x <= x2; x += r) {
        applyBlurAtPointOnCtx(x, y, r, drawFsCtx);
      }
    }
    renderDrawFs();
  };
  MemeApi.mosaic_area = (params) => {
    if (!state.sourceImage) return;
    const w = state.canvasWidth, h = state.canvasHeight;
    const x1 = Math.max(0, Math.min(w, Math.min(params.x1, params.x2)));
    const x2 = Math.max(0, Math.min(w, Math.max(params.x1, params.x2)));
    const y1 = Math.max(0, Math.min(h, Math.min(params.y1, params.y2)));
    const y2 = Math.max(0, Math.min(h, Math.max(params.y1, params.y2)));
    const size = params.size || state.mosaicSize;
    const points = [];
    for (let y = y1; y <= y2; y += size) {
      for (let x = x1; x <= x2; x += size) {
        points.push({ x, y });
      }
    }
    state.drawPaths.push({ type: 'mosaic', size, points });
    if (isDrawFullscreenOpen()) renderDrawFs();
    render();
    pushHistory();
  };

  MemeApi.set_tool = (params) => {
    const tool = params.tool;
    if (tool === 'text') { openTextFs(); return; }
    if (tool === 'draw') { openDrawFs(); return; }
    if (tool === 'crop') { openCropFs(); return; }
    openToolPanel(tool);
  };
  MemeApi.apply_filter = (params) => {
    const vals = FILTER_PRESET_VALUES[params.preset] || { preset: params.preset, brightness: 100, contrast: 100, saturate: 100 };
    state.filter = {
      preset: vals.preset || params.preset,
      brightness: typeof params.brightness === 'number' ? params.brightness : vals.brightness,
      contrast: typeof params.contrast === 'number' ? params.contrast : vals.contrast,
      saturate: typeof params.saturation === 'number' ? params.saturation : vals.saturate,
    };
    syncFilterUi();
    render();
    pushHistory();
  };
  MemeApi.set_brightness = (params) => {
    state.filter.brightness = params.value;
    syncFilterUi();
    render();
    pushHistory();
  };
  MemeApi.set_contrast = (params) => {
    state.filter.contrast = params.value;
    syncFilterUi();
    render();
    pushHistory();
  };
  MemeApi.set_saturation = (params) => {
    state.filter.saturate = params.value;
    syncFilterUi();
    render();
    pushHistory();
  };

  MemeApi.open_crop_editor = () => openCropFs();
  MemeApi.close_crop_editor = () => { if (isCropFullscreenOpen()) closeCropFs(); };
  MemeApi.set_crop_ratio = (params) => {
    if (isCropFullscreenOpen()) {
      cropFs.ratio = params.ratio;
      dom.cropFsChips.querySelectorAll('.crop-chip').forEach(c => {
        c.classList.toggle('active', c.dataset.crop === params.ratio);
      });
      applyCropRatio();
      renderCropFs();
    } else {
      state.cropRatio = params.ratio;
      document.querySelectorAll('.crop-chip').forEach(c => {
        c.classList.toggle('active', c.dataset.crop === params.ratio);
      });
    }
  };
  MemeApi.set_crop_rect = (params) => {
    if (!state.sourceImage) return;
    if (!isCropFullscreenOpen()) openCropFs();
    const w = state.canvasWidth, h = state.canvasHeight;
    cropFs.x = Math.max(0, Math.min(w - 1, params.x));
    cropFs.y = Math.max(0, Math.min(h - 1, params.y));
    cropFs.w = Math.max(1, Math.min(w - cropFs.x, params.width));
    cropFs.h = Math.max(1, Math.min(h - cropFs.y, params.height));
    cropFs.ratio = 'free';
    dom.cropFsChips.querySelectorAll('.crop-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.crop === 'free');
    });
    renderCropFs();
  };
  MemeApi.apply_crop = () => {
    if (isCropFullscreenOpen()) applyCropFs();
    else applyCrop();
  };
  MemeApi.reset_crop = () => {
    if (isCropFullscreenOpen()) resetCropFs();
    else resetCrop();
  };
  MemeApi.apply_platform_preset = (params) => applyPlatformPreset(params.platform);
  MemeApi.add_white_border = () => addWhiteBorder();
  MemeApi.add_round_corner = () => addRoundCorner();
  MemeApi.close_tool_panel = () => closePanel();

  MemeApi.select_layer = (params) => {
    const layer = state.layers[params.index];
    if (!layer) return;
    state.selectedId = layer.id;
    render();
  };
  MemeApi.move_layer = (params) => {
    const layer = getSelected();
    if (!layer) return;
    layer.x = params.x;
    layer.y = params.y;
    refreshAiLayer();
    pushHistory();
  };
  MemeApi.move_layer_by = (params) => {
    const layer = getSelected();
    if (!layer) return;
    layer.x += params.dx;
    layer.y += params.dy;
    refreshAiLayer();
    pushHistory();
  };
  MemeApi.scale_layer = (params) => {
    const layer = getSelected();
    if (!layer) return;
    const ratio = params.scale_percent / 100;
    if (layer.type === 'text') {
      layer.size = Math.max(12, Math.min(200, Math.round(layer.size * ratio)));
    } else if (layer.type === 'draw') {
      layer.width = Math.max(4, Math.round(layer.width * ratio));
      layer.height = Math.max(4, Math.round(layer.height * ratio));
    }
    refreshAiLayer();
    pushHistory();
  };
  MemeApi.rotate_layer = (params) => {
    const layer = getSelected();
    if (!layer) return;
    layer.rotation = params.rotation_degrees * Math.PI / 180;
    refreshAiLayer();
    pushHistory();
  };
  MemeApi.move_layer_up = () => {
    const idx = state.layers.findIndex(l => l.id === state.selectedId);
    if (idx >= 0) handleLayerAction('up', idx);
  };
  MemeApi.move_layer_down = () => {
    const idx = state.layers.findIndex(l => l.id === state.selectedId);
    if (idx >= 0) handleLayerAction('down', idx);
  };
  MemeApi.duplicate_layer = () => {
    const idx = state.layers.findIndex(l => l.id === state.selectedId);
    if (idx >= 0) handleLayerAction('dup', idx);
  };
  MemeApi.flip_layer = () => {
    const idx = state.layers.findIndex(l => l.id === state.selectedId);
    if (idx >= 0) handleLayerAction('flip', idx);
  };
  MemeApi.delete_selected_layer = () => {
    if (state.selectedId !== null) {
      state.layers = state.layers.filter(l => l.id !== state.selectedId);
      state.selectedId = null;
      render();
      pushHistory();
    }
  };
  MemeApi.undo = () => undo();
  MemeApi.redo = () => redo();
  MemeApi.share_meme = () => shareMeme();
  MemeApi.export_meme = () => exportMeme();

  window.MemeApi = MemeApi;
})();
