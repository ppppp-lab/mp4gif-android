# -*- coding: utf-8 -*-
"""Generate a 960-line Chinese instruction -> JSON function call SFT dataset."""

import json
import random
import re


TARGET = 960
MIN_METHOD_COUNT = 6


def int_spec(lo, hi, required=True):
    return {"type": "int", "range": (lo, hi), "required": required}


def str_spec(enum=None, required=True, pattern=None):
    return {"type": "string", "enum": enum, "pattern": pattern, "required": required}


def bool_spec(required=True):
    return {"type": "bool", "required": required}


SPECS = {
    "open_page": {"page": str_spec(["meme"])},
    "import_source": {},
    "go_back": {},
    "open_text_editor": {},
    "close_text_editor": {},
    "add_text": {"text": str_spec(pattern=r"^.{1,100}$")},
    "set_text_font": {"font": str_spec(["heavy", "impact", "song", "kai", "mono"])},
    "set_text_color": {"color": str_spec(pattern=r"^#[0-9A-Fa-f]{6}$")},
    "set_text_size": {"size": int_spec(12, 80)},
    "set_text_stroke": {"stroke": int_spec(0, 8)},
    "set_text_rotation": {"rotation_degrees": int_spec(-180, 180)},
    "set_text_shadow": {"enabled": bool_spec()},
    "open_draw_editor": {},
    "close_draw_editor": {},
    "set_draw_mode": {"mode": str_spec(["pen", "eraser", "blur", "mosaic"])},
    "set_draw_shape": {"shape": str_spec(["free", "line", "arrow", "rect", "ellipse"])},
    "set_draw_color": {"color": str_spec(pattern=r"^#[0-9A-Fa-f]{6}$")},
    "set_draw_brush_width": {"width": int_spec(1, 20)},
    "set_mosaic_size": {"size": int_spec(4, 30)},
    "clear_draw": {},
    "draw_line": {
        "x1": int_spec(0, 8192),
        "y1": int_spec(0, 8192),
        "x2": int_spec(0, 8192),
        "y2": int_spec(0, 8192),
        "color": str_spec(pattern=r"^#[0-9A-Fa-f]{6}$", required=False),
        "stroke_width": int_spec(1, 40, required=False),
    },
    "draw_arrow": {
        "x1": int_spec(0, 8192),
        "y1": int_spec(0, 8192),
        "x2": int_spec(0, 8192),
        "y2": int_spec(0, 8192),
        "color": str_spec(pattern=r"^#[0-9A-Fa-f]{6}$", required=False),
        "stroke_width": int_spec(1, 40, required=False),
    },
    "draw_rect": {
        "x": int_spec(0, 8192),
        "y": int_spec(0, 8192),
        "width": int_spec(1, 8192),
        "height": int_spec(1, 8192),
        "color": str_spec(pattern=r"^#[0-9A-Fa-f]{6}$", required=False),
        "stroke_width": int_spec(1, 40, required=False),
    },
    "draw_ellipse": {
        "x": int_spec(0, 8192),
        "y": int_spec(0, 8192),
        "width": int_spec(1, 8192),
        "height": int_spec(1, 8192),
        "color": str_spec(pattern=r"^#[0-9A-Fa-f]{6}$", required=False),
        "stroke_width": int_spec(1, 40, required=False),
    },
    "draw_freehand": {
        "points": str_spec(pattern=r"^[0-9]+,[0-9]+(;[0-9]+,[0-9]+)*$"),
        "color": str_spec(pattern=r"^#[0-9A-Fa-f]{6}$", required=False),
        "stroke_width": int_spec(1, 40, required=False),
    },
    "erase_area": {
        "x1": int_spec(0, 8192),
        "y1": int_spec(0, 8192),
        "x2": int_spec(0, 8192),
        "y2": int_spec(0, 8192),
        "width": int_spec(1, 100, required=False),
    },
    "blur_area": {
        "x1": int_spec(0, 8192),
        "y1": int_spec(0, 8192),
        "x2": int_spec(0, 8192),
        "y2": int_spec(0, 8192),
        "radius": int_spec(2, 50, required=False),
    },
    "mosaic_area": {
        "x1": int_spec(0, 8192),
        "y1": int_spec(0, 8192),
        "x2": int_spec(0, 8192),
        "y2": int_spec(0, 8192),
        "size": int_spec(4, 30, required=False),
    },
    "select_layer": {"index": int_spec(0, 999)},
    "move_layer": {"x": int_spec(0, 8192), "y": int_spec(0, 8192)},
    "move_layer_by": {"dx": int_spec(-4096, 4096), "dy": int_spec(-4096, 4096)},
    "scale_layer": {"scale_percent": int_spec(10, 500)},
    "rotate_layer": {"rotation_degrees": int_spec(-180, 180)},
    "move_layer_up": {},
    "move_layer_down": {},
    "duplicate_layer": {},
    "flip_layer": {},
    "set_tool": {"tool": str_spec(["text", "filter", "draw", "crop", "platform"])},
    "apply_filter": {
        "preset": str_spec(["none", "gray", "sepia", "cold", "warm", "invert"]),
        "brightness": int_spec(0, 200, required=False),
        "contrast": int_spec(0, 200, required=False),
        "saturation": int_spec(0, 200, required=False),
    },
    "set_brightness": {"value": int_spec(0, 200)},
    "set_contrast": {"value": int_spec(0, 200)},
    "set_saturation": {"value": int_spec(0, 200)},
    "open_crop_editor": {},
    "close_crop_editor": {},
    "set_crop_ratio": {"ratio": str_spec(["free", "square", "wide", "portrait"])},
    "set_crop_rect": {
        "x": int_spec(0, 8192),
        "y": int_spec(0, 8192),
        "width": int_spec(1, 8192),
        "height": int_spec(1, 8192),
    },
    "apply_crop": {},
    "reset_crop": {},
    "apply_platform_preset": {"platform": str_spec(["wechat", "qq", "xiaohongshu", "douyin"])},
    "add_white_border": {},
    "add_round_corner": {},
    "close_tool_panel": {},
    "delete_selected_layer": {},
    "undo": {},
    "redo": {},
    "share_meme": {},
    "export_meme": {},
}


def validate_type(value, spec):
    t = spec["type"]
    if t == "int":
        return isinstance(value, int) and not isinstance(value, bool)
    if t == "float":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if t == "bool":
        return isinstance(value, bool)
    if t == "string":
        return isinstance(value, str)
    return False


def validate_call(call):
    if not isinstance(call, dict):
        return False
    method = call.get("method")
    params = call.get("params")
    if not isinstance(method, str) or method not in SPECS:
        return False
    if not isinstance(params, dict):
        return False
    spec = SPECS[method]
    if set(params.keys()) - set(spec.keys()):
        return False
    for key, param_spec in spec.items():
        if key not in params:
            if param_spec.get("required"):
                return False
            continue
        value = params[key]
        if not validate_type(value, param_spec):
            return False
        if "range" in param_spec:
            lo, hi = param_spec["range"]
            if value < lo or value > hi:
                return False
        if param_spec.get("enum") is not None and value not in param_spec["enum"]:
            return False
        if param_spec.get("pattern") is not None and not re.fullmatch(param_spec["pattern"], value):
            return False
    return True


def call(method, params=None):
    c = {"method": method, "params": params or {}}
    assert validate_call(c), f"invalid call: {c}"
    return c


def output_json(calls):
    for c in calls:
        assert validate_call(c)
    return json.dumps(calls, ensure_ascii=False, separators=(",", ":"))


def line(instruction, calls):
    return {"instruction": instruction.strip(), "output": output_json(calls)}


PATTERNS = {
    "open_page": [
        "打开{page}页",
        "去{page}页面",
        "我要进{page}",
        "帮我打开{page}",
        "能不能到{page}页",
        "到{page}页面去",
        "现在去{page}",
        "把界面切到{page}",
    ],
    "import_source": ["导入素材", "选一张图片进来", "导入GIF", "从相册选素材", "帮我导入一个表情素材"],
    "go_back": ["返回首页", "回到首页", "返回上一页"],
    "open_text_editor": ["打开文字编辑", "我要加文字", "打开文字面板"],
    "close_text_editor": ["关闭文字编辑", "完成文字", "退出文字编辑"],
    "add_text": ["加文字“{text}”", "写上“{text}”", "添加文字{text}", "打个字“{text}”", "加一句{text}"],
    "set_text_font": ["字体改成{font}", "用{font}字体", "文字换成{font}", "字体选{font}"],
    "set_text_color": ["文字颜色改成{color}", "用{color}颜色", "字变{color}", "颜色设为{color}"],
    "set_text_size": ["字号调到{size}", "文字大小{size}", "字调成{size}号", "字号{size}"],
    "set_text_stroke": ["描边改成{stroke}", "描边宽度{stroke}", "文字描边设成{stroke}"],
    "set_text_rotation": ["文字旋转{rotation_degrees}度", "转{rotation_degrees}度", "角度改成{rotation_degrees}", "旋转到{rotation_degrees}度"],
    "set_text_shadow": ["打开阴影", "关闭阴影", "给文字加阴影", "不要阴影"],
    "open_draw_editor": ["打开画笔", "我要画画", "打开涂鸦页"],
    "close_draw_editor": ["关闭画笔", "完成画笔", "退出画笔"],
    "set_draw_mode": ["用{mode}模式", "画笔模式改成{mode}", "切换成{mode}", "选{mode}"],
    "set_draw_shape": ["画{shape}形状", "形状选{shape}", "改成{shape}形", "用{shape}工具"],
    "set_draw_color": ["画笔颜色改成{color}", "用{color}颜色画", "颜色设成{color}", "画笔变{color}"],
    "set_draw_brush_width": ["画笔粗细{width}", "笔刷宽度改成{width}", "线条设成{width}px", "笔刷{width}"],
    "set_mosaic_size": ["马赛克块大小{size}", "马赛克设成{size}px", "马赛克块改{size}"],
    "clear_draw": ["清除涂鸦", "把画的都删了", "清空画笔", "擦掉全部涂鸦"],
    "draw_line": ["在画布中间画一条横线", "从{x1},{y1}到{x2},{y2}画一条线", "画一条{x1},{y1}到{x2},{y2}的直线", "帮我画条线"],
    "draw_arrow": ["从{x1},{y1}到{x2},{y2}画箭头", "画一个箭头", "加一个指向右边的箭头"],
    "draw_rect": ["在{x},{y}画一个{width}×{height}的矩形", "画个矩形", "加一个方框"],
    "draw_ellipse": ["在{x},{y}画一个椭圆", "画个圆圈", "加一个{width}×{height}的椭圆"],
    "draw_freehand": ["随手画一条曲线", "画个手绘轨迹", "按照这几个点画一条线"],
    "erase_area": ["擦掉{x1},{y1}到{x2},{y2}这块", "把这块擦掉", "擦除中间区域"],
    "blur_area": ["把{x1},{y1}到{x2},{y2}模糊一下", "模糊这个区域", "把中间打码模糊"],
    "mosaic_area": ["把{x1},{y1}到{x2},{y2}打马赛克", "给这块加马赛克", "马赛克处理这个区域"],
    "select_layer": ["选择第{index}个图层", "选中图层{index}", "点一下第{index}个图层"],
    "move_layer": ["把图层移动到{x},{y}", "移到画布中间", "把选中的图层放到{x},{y}"],
    "move_layer_by": ["向右移{dx}", "向下移{dy}", "图层移动{dx},{dy}", "往右挪{dx}往左挪{dy}"],
    "scale_layer": ["把图层放大到{scale_percent}%", "缩放改成{scale_percent}%", "图层放大一点到{scale_percent}%"],
    "rotate_layer": ["把图层旋转{rotation_degrees}度", "旋转到{rotation_degrees}度", "图层转{rotation_degrees}度"],
    "move_layer_up": ["图层上移一层", "把图层往上移", "置前一层"],
    "move_layer_down": ["图层下移一层", "把图层往下移", "置后一层"],
    "duplicate_layer": ["复制当前图层", "把这个图层复制一份", "复制图层"],
    "flip_layer": ["翻转图层", "水平翻转", "镜像一下"],
    "set_tool": ["打开{tool}工具", "切到{tool}", "用{tool}功能", "进入{tool}面板", "选择{tool}"],
    "apply_filter": ["用{preset}滤镜", "加{preset}效果", "滤镜改成{preset}", "套上{preset}"],
    "set_brightness": ["亮度调到{value}", "亮度{value}", "调亮一点到{value}", "亮度改成{value}%"],
    "set_contrast": ["对比度调到{value}", "对比度{value}", "对比度改成{value}%"],
    "set_saturation": ["饱和度调到{value}", "饱和度{value}", "饱和度改成{value}%"],
    "open_crop_editor": ["打开裁剪", "我要裁剪", "进入裁剪页面"],
    "close_crop_editor": ["关闭裁剪", "退出裁剪", "不裁了"],
    "set_crop_ratio": ["裁剪比例改成{ratio}", "用{ratio}比例", "裁成{ratio}", "比例选{ratio}"],
    "set_crop_rect": ["裁剪区域设为{x},{y}，宽{width}高{height}", "把裁剪框放在{x},{y}", "裁剪中间一块"],
    "apply_crop": ["应用裁剪", "裁剪吧", "确定裁剪", "按这个裁"],
    "reset_crop": ["重置裁剪", "恢复选区", "取消裁剪调整"],
    "apply_platform_preset": ["用{platform}预设", "套{platform}尺寸", "设置成{platform}规格", "按{platform}平台导出"],
    "add_white_border": ["加白边", "添加白色边框", "四周加一圈白边"],
    "add_round_corner": ["加圆角", "把边角变圆", "添加圆角效果"],
    "close_tool_panel": ["收起工具面板", "关闭面板", "收起面板"],
    "delete_selected_layer": ["删除选中图层", "把这个图层删了", "删掉当前图层"],
    "undo": ["撤销", "上一步", "退回一步", "撤销刚才的操作"],
    "redo": ["重做", "下一步", "前进一步", "恢复刚才撤销的"],
    "share_meme": ["分享表情包", "把这个发出去", "分享出去"],
    "export_meme": ["导出表情包", "保存表情包", "导出GIF表情包", "生成表情包"],
}


VALUES = {
    "open_page": [
        {"page": "meme"},
    ],
    "add_text": [
        {"text": "哈哈"},
        {"text": "太棒了"},
        {"text": "无语"},
        {"text": "666"},
        {"text": "笑死"},
        {"text": "这个真的绝了"},
    ],
    "set_text_font": [{"font": "heavy"}, {"font": "impact"}, {"font": "song"}, {"font": "kai"}, {"font": "mono"}],
    "set_text_color": [
        {"color": "#FFFFFF"},
        {"color": "#000000"},
        {"color": "#FF4747"},
        {"color": "#FFD93D"},
        {"color": "#3DDC84"},
        {"color": "#00C2FF"},
    ],
    "set_text_size": [{"size": 12}, {"size": 20}, {"size": 32}, {"size": 50}, {"size": 80}],
    "set_text_stroke": [{"stroke": 0}, {"stroke": 2}, {"stroke": 3}, {"stroke": 5}, {"stroke": 8}],
    "set_text_rotation": [{"rotation_degrees": -180}, {"rotation_degrees": -45}, {"rotation_degrees": 0}, {"rotation_degrees": 30}, {"rotation_degrees": 180}],
    "set_text_shadow": [{"enabled": True}, {"enabled": False}],
    "set_draw_mode": [{"mode": "pen"}, {"mode": "eraser"}, {"mode": "blur"}, {"mode": "mosaic"}],
    "set_draw_shape": [{"shape": "free"}, {"shape": "line"}, {"shape": "arrow"}, {"shape": "rect"}, {"shape": "ellipse"}],
    "set_draw_color": [
        {"color": "#FF4747"},
        {"color": "#FFD93D"},
        {"color": "#3DDC84"},
        {"color": "#00C2FF"},
        {"color": "#FFFFFF"},
        {"color": "#000000"},
    ],
    "set_draw_brush_width": [{"width": 1}, {"width": 4}, {"width": 8}, {"width": 12}, {"width": 20}],
    "set_mosaic_size": [{"size": 4}, {"size": 10}, {"size": 16}, {"size": 24}, {"size": 30}],
    "draw_line": [
        {"x1": 0, "y1": 240, "x2": 480, "y2": 240},
        {"x1": 80, "y1": 120, "x2": 400, "y2": 360, "color": "#FF4747", "stroke_width": 4},
        {"x1": 120, "y1": 360, "x2": 360, "y2": 120},
    ],
    "draw_arrow": [
        {"x1": 80, "y1": 240, "x2": 400, "y2": 240},
        {"x1": 120, "y1": 120, "x2": 360, "y2": 360, "color": "#FFD93D"},
    ],
    "draw_rect": [
        {"x": 240, "y": 240, "width": 200, "height": 120},
        {"x": 160, "y": 120, "width": 320, "height": 240, "color": "#3DDC84", "stroke_width": 6},
    ],
    "draw_ellipse": [
        {"x": 240, "y": 240, "width": 240, "height": 160},
        {"x": 240, "y": 240, "width": 300, "height": 200, "color": "#00C2FF"},
    ],
    "draw_freehand": [
        {"points": "80,240;160,200;240,260;320,200;400,240"},
        {"points": "80,80;160,160;240,120;320,200;400,160", "color": "#FFD93D", "stroke_width": 6},
    ],
    "erase_area": [
        {"x1": 160, "y1": 160, "x2": 320, "y2": 320},
        {"x1": 80, "y1": 80, "x2": 400, "y2": 400, "width": 24},
    ],
    "blur_area": [
        {"x1": 160, "y1": 160, "x2": 320, "y2": 320},
        {"x1": 80, "y1": 80, "x2": 400, "y2": 400, "radius": 12},
    ],
    "mosaic_area": [
        {"x1": 160, "y1": 160, "x2": 320, "y2": 320},
        {"x1": 80, "y1": 80, "x2": 400, "y2": 400, "size": 12},
    ],
    "select_layer": [{"index": 0}, {"index": 1}, {"index": 2}],
    "move_layer": [{"x": 120, "y": 80}, {"x": 240, "y": 240}, {"x": 360, "y": 400}],
    "move_layer_by": [{"dx": 20, "dy": 0}, {"dx": 0, "dy": -30}, {"dx": -40, "dy": 50}],
    "scale_layer": [{"scale_percent": 50}, {"scale_percent": 100}, {"scale_percent": 150}, {"scale_percent": 200}],
    "rotate_layer": [{"rotation_degrees": -90}, {"rotation_degrees": -45}, {"rotation_degrees": 0}, {"rotation_degrees": 30}, {"rotation_degrees": 90}],
    "set_tool": [
        {"tool": "text"},
        {"tool": "filter"},
        {"tool": "draw"},
        {"tool": "crop"},
        {"tool": "platform"},
    ],
    "apply_filter": [
        {"preset": "none"},
        {"preset": "gray"},
        {"preset": "sepia"},
        {"preset": "cold"},
        {"preset": "warm"},
        {"preset": "invert"},
        {"preset": "cold", "brightness": 110, "contrast": 120, "saturation": 90},
        {"preset": "warm", "brightness": 100, "contrast": 80, "saturation": 140},
    ],
    "set_brightness": [{"value": 0}, {"value": 50}, {"value": 100}, {"value": 150}, {"value": 200}],
    "set_contrast": [{"value": 0}, {"value": 50}, {"value": 100}, {"value": 150}, {"value": 200}],
    "set_saturation": [{"value": 0}, {"value": 50}, {"value": 100}, {"value": 150}, {"value": 200}],
    "set_crop_ratio": [{"ratio": "free"}, {"ratio": "square"}, {"ratio": "wide"}, {"ratio": "portrait"}],
    "set_crop_rect": [
        {"x": 60, "y": 60, "width": 360, "height": 360},
        {"x": 120, "y": 80, "width": 240, "height": 320},
    ],
    "apply_platform_preset": [{"platform": "wechat"}, {"platform": "qq"}, {"platform": "xiaohongshu"}, {"platform": "douyin"}],
}


def decorate(text, rng):
    mode = rng.random()
    if mode < 0.18:
        return "帮我" + text
    if mode < 0.32:
        return "请帮我" + text
    if mode < 0.46:
        return "我想" + text
    if mode < 0.58:
        return "能不能" + text
    if mode < 0.68:
        return text + "吧"
    if mode < 0.76:
        return text + "一下"
    if mode < 0.84:
        return "麻烦你" + text
    return text


def make_single(method, params, rng, decorate_chance=0.0):
    keys = set(params)
    patterns = [
        p for p in PATTERNS[method]
        if not re.search(r"\{(.*?)\}", p) or set(re.findall(r"\{(.*?)\}", p)) <= keys
    ]
    pattern = rng.choice(patterns)
    text = pattern.format(**params)
    if rng.random() < decorate_chance:
        text = decorate(text, rng)
    return line(text, [call(method, dict(params))])


def generate_singles(rng):
    samples = []
    seen = set()
    for method in SPECS:
        values = VALUES.get(method, [{}])
        for params in values:
            for _ in range(3):
                sample = make_single(method, params, rng, decorate_chance=0.55)
                key = sample["instruction"]
                if key not in seen:
                    seen.add(key)
                    samples.append(sample)
    return samples


def workflow_samples(rng, count):
    samples = []
    seen = set()
    colors = ["#FFFFFF", "#000000", "#FF4747", "#FFD93D", "#3DDC84", "#00C2FF"]
    texts = ["哈哈", "太棒了", "无语", "666", "笑死", "这个真的绝了"]
    fonts = ["heavy", "impact", "song", "kai", "mono"]
    presets = ["none", "gray", "sepia", "cold", "warm", "invert"]
    platforms = ["wechat", "qq", "xiaohongshu", "douyin"]

    meme_heads = [
        "做个表情包",
        "帮我加工一下这个GIF",
        "做一张搞笑表情包",
        "给这个表情包加字",
    ]

    while len(samples) < count:
        kind = rng.random()
        if kind < 0.42:
            text = rng.choice(texts)
            color = rng.choice(colors)
            size = rng.choice([16, 24, 32, 48, 64])
            rotation = rng.choice([-30, 0, 15, 45, 90])
            font = rng.choice(fonts)
            instruction = rng.choice(meme_heads) + f"，加文字“{text}”，字体{font}，颜色{color}，字号{size}，旋转{rotation}度，然后导出"
            calls = [
                call("open_page", {"page": "meme"}),
                call("import_source"),
                call("set_tool", {"tool": "text"}),
                call("open_text_editor"),
                call("add_text", {"text": text}),
                call("set_text_font", {"font": font}),
                call("set_text_color", {"color": color}),
                call("set_text_size", {"size": size}),
                call("set_text_rotation", {"rotation_degrees": rotation}),
                call("export_meme"),
            ]
        elif kind < 0.72:
            preset = rng.choice(presets)
            brightness = rng.choice([80, 100, 120, 150])
            contrast = rng.choice([80, 100, 120])
            saturation = rng.choice([70, 100, 130, 160])
            ratio = rng.choice(["free", "square", "wide", "portrait"])
            instruction = f"做个表情包，加{preset}滤镜，亮度{brightness}，对比度{contrast}，饱和度{saturation}，裁成{ratio}比例，导出"
            calls = [
                call("open_page", {"page": "meme"}),
                call("import_source"),
                call("set_tool", {"tool": "filter"}),
                call("apply_filter", {"preset": preset, "brightness": brightness, "contrast": contrast, "saturation": saturation}),
                call("set_tool", {"tool": "crop"}),
                call("open_crop_editor"),
                call("set_crop_ratio", {"ratio": ratio}),
                call("apply_crop"),
                call("export_meme"),
            ]
        else:
            platform = rng.choice(platforms)
            instruction = f"用{platform}预设做个表情包，在中间画一条横线，再画一个矩形，选中第一个图层移到中间，导出"
            calls = [
                call("open_page", {"page": "meme"}),
                call("import_source"),
                call("set_tool", {"tool": "platform"}),
                call("apply_platform_preset", {"platform": platform}),
                call("draw_line", {"x1": 80, "y1": 240, "x2": 400, "y2": 240, "color": "#FF4747", "stroke_width": 4}),
                call("draw_rect", {"x": 240, "y": 240, "width": 200, "height": 120, "color": "#3DDC84"}),
                call("select_layer", {"index": 0}),
                call("move_layer", {"x": 240, "y": 240}),
                call("export_meme"),
            ]
        key = instruction.strip()
        if key in seen:
            continue
        seen.add(key)
        samples.append(line(instruction, calls))
    return samples


def main():
    rng = random.Random(20260828)
    samples = generate_singles(rng)
    workflows = workflow_samples(rng, max(0, TARGET - len(samples) - 60))
    seen = set()
    all_samples = []
    for sample in samples + workflows:
        key = sample["instruction"]
        if key not in seen:
            seen.add(key)
            all_samples.append(sample)

    counts = {m: 0 for m in SPECS}
    for s in all_samples:
        for c in json.loads(s["output"]):
            counts[c["method"]] += 1
    for method in SPECS:
        while counts[method] < MIN_METHOD_COUNT:
            params = rng.choice(VALUES.get(method, [{}]))
            sample = make_single(method, dict(params), rng, decorate_chance=0.85)
            key = sample["instruction"]
            if key in seen:
                continue
            seen.add(key)
            all_samples.append(sample)
            counts[method] += 1

    if len(all_samples) < TARGET:
        extra = TARGET - len(all_samples)
        pool = [
            make_single(method, dict(params), rng, decorate_chance=0.9)
            for method in SPECS
            for params in VALUES.get(method, [{}])
        ]
        for sample in pool:
            if len(all_samples) >= TARGET:
                break
            key = sample["instruction"]
            if key not in seen:
                seen.add(key)
                all_samples.append(sample)

    if len(all_samples) > TARGET:
        for _ in range(len(all_samples) - TARGET):
            removed = False
            for idx in range(len(all_samples) - 1, -1, -1):
                methods = [c["method"] for c in json.loads(all_samples[idx]["output"])]
                if all(counts[m] > MIN_METHOD_COUNT for m in methods):
                    for m in methods:
                        counts[m] -= 1
                    all_samples.pop(idx)
                    removed = True
                    break
            if not removed:
                break

    for sample in all_samples:
        output = json.loads(sample["output"])
        assert isinstance(output, list) and output
        for c in output:
            assert validate_call(c), sample

    methods = {c["method"] for s in all_samples for c in json.loads(s["output"])}
    missing = set(SPECS) - methods
    if missing:
        raise SystemExit(f"missing methods: {missing}")

    with open("ai_training_data.jsonl", "w", encoding="utf-8") as f:
        for sample in all_samples:
            f.write(json.dumps(sample, ensure_ascii=False, separators=(",", ":")) + "\n")

    counts = {m: 0 for m in SPECS}
    for s in all_samples:
        for c in json.loads(s["output"]):
            counts[c["method"]] += 1
    print("total:", len(all_samples))
    print("min method count:", min(counts.values()), max(counts.values()))


if __name__ == "__main__":
    main()
