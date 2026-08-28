# AI 函数调用接口规范

## 1. 目标

本地小模型接收用户中文口语指令，输出标准 JSON 函数调用字符串。App 侧通过 GBNF 保证 JSON 语法合法，再通过 Kotlin 白名单和参数校验层拦截非法调用。

## 2. 调用格式

模型输出统一使用函数数组，即使只有一个动作也输出数组：

```json
[
  {"method":"open_page","params":{"page":"meme"}},
  {"method":"open_text_editor","params":{}},
  {"method":"add_text","params":{"text":"哈哈"}},
  {"method":"export_meme","params":{}}
]
```

命名规则：
- `method` 使用小写下划线命名。
- `params` 必须是 JSON 对象。
- 数字参数区分 `int`、`float`、`bool`，不使用字符串代替数字。
- 可选参数允许缺失；显式传 `null` 不合法。

## 3. 安全等级

本 App 不包含删除用户数据、清空存储、覆盖源文件等高危操作。全部 `method` 的安全等级均为：

```text
普通操作
```

## 4. method 白名单

AI 只开放表情包工坊控制，不开放高级编辑器、MP4 转 GIF、首页、相机和隐私政策页面。

### 4.1 入口与素材

| method | 参数 | 说明 |
|---|---|---|
| `open_page` | `page: string` | 页面枚举，仅 `meme` |
| `import_source` | 无 | 在表情包工坊导入 GIF 或图片素材 |

### 4.2 文字

| method | 参数 | 说明 |
|---|---|---|
| `open_text_editor` | 无 | 打开文字编辑全屏页 |
| `add_text` | `text: string` | 文字内容，长度 `1..100` |
| `set_text_font` | `font: string` | 枚举：`heavy`、`impact`、`song`、`kai`、`mono` |
| `set_text_color` | `color: string` | 十六进制颜色，格式 `#RRGGBB` |
| `set_text_size` | `size: int` | `12..80` |
| `set_text_stroke` | `stroke: int` | `0..8` |
| `set_text_rotation` | `rotation_degrees: int` | `-180..180` |
| `set_text_shadow` | `enabled: bool` | 是否开启阴影 |

### 4.3 画笔与图形

| method | 参数 | 说明 |
|---|---|---|
| `open_draw_editor` | 无 | 打开画笔编辑全屏页 |
| `set_draw_mode` | `mode: string` | 枚举：`pen`、`eraser`、`blur`、`mosaic` |
| `set_draw_shape` | `shape: string` | 枚举：`free`、`line`、`arrow`、`rect`、`ellipse` |
| `set_draw_color` | `color: string` | 十六进制颜色 |
| `set_draw_brush_width` | `width: int` | `1..20` |
| `set_mosaic_size` | `size: int` | `4..30` |
| `clear_draw` | 无 | 清除当前涂鸦 |
| `draw_line` | `x1,y1,x2,y2: int`，`color?`，`stroke_width?` | 画一条线 |
| `draw_arrow` | `x1,y1,x2,y2: int`，`color?`，`stroke_width?` | 画一个箭头 |
| `draw_rect` | `x,y,width,height: int`，`color?`，`stroke_width?` | 以中心 `x,y` 画矩形 |
| `draw_ellipse` | `x,y,width,height: int`，`color?`，`stroke_width?` | 以中心 `x,y` 画椭圆 |
| `draw_freehand` | `points: string`，`color?`，`stroke_width?` | 按坐标串画手绘轨迹，格式 `x,y;x,y;...` |
| `erase_area` | `x1,y1,x2,y2: int`，`width?` | 擦除矩形区域内的涂鸦 |
| `blur_area` | `x1,y1,x2,y2: int`，`radius?` | 模糊矩形区域 |
| `mosaic_area` | `x1,y1,x2,y2: int`，`size?` | 给矩形区域打马赛克 |

### 4.4 图层

| method | 参数 | 说明 |
|---|---|---|
| `select_layer` | `index: int` | 按索引选择图层，`0..999` |
| `move_layer` | `x,y: int` | 把选中图层移动到 `x,y` |
| `move_layer_by` | `dx,dy: int` | 把选中图层相对移动 `dx,dy` |
| `scale_layer` | `scale_percent: int` | 缩放选中图层，`10..500` |
| `rotate_layer` | `rotation_degrees: int` | 旋转选中图层，`-180..180` |
| `move_layer_up` | 无 | 图层上移一层 |
| `move_layer_down` | 无 | 图层下移一层 |
| `duplicate_layer` | 无 | 复制选中图层 |
| `flip_layer` | 无 | 水平翻转选中图层 |
| `delete_selected_layer` | 无 | 删除选中图层 |

### 4.5 滤镜、裁剪、平台

| method | 参数 | 说明 |
|---|---|---|
| `set_tool` | `tool: string` | 枚举：`text`、`filter`、`draw`、`crop`、`platform` |
| `apply_filter` | `preset: string`，`brightness?`，`contrast?`，`saturation?` | `preset` 枚举：`none/gray/sepia/cold/warm/invert`，数值 `0..200` |
| `set_brightness` | `value: int` | `0..200` |
| `set_contrast` | `value: int` | `0..200` |
| `set_saturation` | `value: int` | `0..200` |
| `open_crop_editor` | 无 | 打开裁剪编辑全屏页 |
| `set_crop_ratio` | `ratio: string` | 枚举：`free`、`square`、`wide`、`portrait` |
| `set_crop_rect` | `x,y,width,height: int` | 设置自定义裁剪选区 |
| `apply_crop` | 无 | 应用当前裁剪 |
| `reset_crop` | 无 | 重置裁剪选区 |
| `apply_platform_preset` | `platform: string` | 枚举：`wechat`、`qq`、`xiaohongshu`、`douyin` |
| `add_white_border` | 无 | 添加白边 |
| `add_round_corner` | 无 | 添加圆角 |

### 4.6 通用操作

| method | 参数 | 说明 |
|---|---|---|
| `undo` | 无 | 撤销 |
| `redo` | 无 | 重做 |
| `share_meme` | 无 | 分享当前表情包 |
| `export_meme` | 无 | 导出当前表情包 |

## 5. 校验规则

Kotlin 校验层按以下顺序执行，任一环节失败立即拒绝整个数组并返回 UI 提示 `无法识别该指令`：

1. JSON 反序列化失败。
2. 顶层必须是数组，数组内每个元素必须是对象。
3. `method` 必须存在于白名单。
4. `params` 必须是 JSON 对象。
5. 参数名必须是该方法允许的参数，不存在多余参数。
6. 必填参数不能缺失。
7. 参数类型必须匹配。
8. 参数必须满足枚举、数值范围、字符串长度或正则格式。

## 6. 示例

用户说“做个表情包，在画面中间画一条横线，然后导出”：

```json
[
  {"method":"open_page","params":{"page":"meme"}},
  {"method":"import_source","params":{}},
  {"method":"draw_line","params":{"x1":0,"y1":240,"x2":480,"y2":240,"color":"#FF0000","stroke_width":4}},
  {"method":"export_meme","params":{}}
]
```
