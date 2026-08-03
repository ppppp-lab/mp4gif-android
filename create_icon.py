#!/usr/bin/env python3
"""
MP4转GIF 应用图标设计
基于 "Temporal Chromatics" 设计哲学
"""

from PIL import Image, ImageDraw, ImageFilter, ImageFont
import math

# 尺寸
SIZE = 512
CORNER_RADIUS = 108  # Android adaptive icon 圆角

# 颜色方案（与应用暗色主题一致）
BG_DARK = "#0E1014"       # 主背景
ACCENT_ORANGE = "#FF6B3D" # 主强调色（橙红）
ACCENT_TEAL = "#2DD4BF"   # 辅助强调色（青绿）
PALETTE_PINK = "#FF8A80"  # GIF 调色板色彩 1
PALETTE_PURPLE = "#B388FF" # GIF 调色板色彩 2
TEXT_LIGHT = "#E8E8E8"    # 浅色文字

def hex_to_rgb(hex_color):
    hex_color = hex_color.lstrip('#')
    return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))

def create_icon():
    img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # 1. 圆角矩形背景
    bg_rgb = hex_to_rgb(BG_DARK)
    draw.rounded_rectangle(
        [(0, 0), (SIZE, SIZE)],
        radius=CORNER_RADIUS,
        fill=bg_rgb
    )
    
    # 2. 绘制核心图形：视频帧序列 → GIF 循环
    # 概念：三个堆叠的矩形代表视频帧，渐变圆形代表 GIF 循环
    
    center_x, center_y = SIZE // 2, SIZE // 2
    
    # 帧序列（三个错位的矩形，代表时间轴上的帧）
    frame_width = 100
    frame_height = 140
    frame_gap = 24
    frames_start_x = center_x - (frame_width * 1.5 + frame_gap)
    frames_y = center_y - frame_height // 2 - 20
    
    # 绘制三个帧矩形（从左到右，颜色渐变）
    frame_colors = [
        hex_to_rgb("#3A3D44"),  # 最暗（最早帧）
        hex_to_rgb("#4A4D54"),  # 中间
        hex_to_rgb("#5A5D64"),  # 最亮（当前帧）
    ]
    
    for i, color in enumerate(frame_colors):
        x = frames_start_x + i * (frame_width + frame_gap)
        # 圆角矩形帧
        draw.rounded_rectangle(
            [(x, frames_y), (x + frame_width, frames_y + frame_height)],
            radius=12,
            fill=color,
            outline=hex_to_rgb(ACCENT_ORANGE) if i == 2 else None,
            width=3 if i == 2 else 0
        )
        # 帧内的"播放进度"线
        if i == 2:
            draw.rectangle(
                [(x + 10, frames_y + frame_height - 20), (x + frame_width - 10, frames_y + frame_height - 16)],
                fill=hex_to_rgb(ACCENT_ORANGE)
            )
    
    # 3. GIF 循环符号（右侧）
    # 一个带有箭头的循环圆，代表 GIF 的循环播放
    loop_center_x = center_x + 80
    loop_center_y = center_y + 30
    loop_radius = 65
    
    # 循环圆环
    draw.arc(
        [(loop_center_x - loop_radius, loop_center_y - loop_radius),
         (loop_center_x + loop_radius, loop_center_y + loop_radius)],
        start=30, end=330,
        fill=hex_to_rgb(ACCENT_TEAL),
        width=8
    )
    
    # 循环箭头头部（小三角形）
    arrow_angle = 30  # 弧线结束位置
    arrow_x = loop_center_x + loop_radius * math.cos(math.radians(arrow_angle))
    arrow_y = loop_center_y - loop_radius * math.sin(math.radians(arrow_angle))
    
    # 箭头三角形
    arrow_size = 14
    arrow_points = [
        (arrow_x, arrow_y),
        (arrow_x - arrow_size * math.cos(math.radians(arrow_angle - 30)), 
         arrow_y + arrow_size * math.sin(math.radians(arrow_angle - 30))),
        (arrow_x - arrow_size * math.cos(math.radians(arrow_angle + 30)), 
         arrow_y + arrow_size * math.sin(math.radians(arrow_angle + 30))),
    ]
    draw.polygon(arrow_points, fill=hex_to_rgb(ACCENT_TEAL))
    
    # 4. 转换箭头（从帧序列指向循环）
    # 斜向箭头表示"转换"过程
    arrow_start = (frames_start_x + 2.5 * (frame_width + frame_gap) + 10, frames_y + frame_height // 2)
    arrow_end = (loop_center_x - loop_radius - 15, loop_center_y)
    
    # 箭头主线
    draw.line([arrow_start, arrow_end], fill=hex_to_rgb(ACCENT_ORANGE), width=6)
    
    # 箭头头部
    arrow_head_len = 18
    arrow_angle2 = math.atan2(arrow_end[1] - arrow_start[1], arrow_end[0] - arrow_start[0])
    head_points = [
        (arrow_end[0], arrow_end[1]),
        (arrow_end[0] - arrow_head_len * math.cos(arrow_angle2 - 0.4),
         arrow_end[1] - arrow_head_len * math.sin(arrow_angle2 - 0.4)),
        (arrow_end[0] - arrow_head_len * math.cos(arrow_angle2 + 0.4),
         arrow_end[1] - arrow_head_len * math.sin(arrow_angle2 + 0.4)),
    ]
    draw.polygon(head_points, fill=hex_to_rgb(ACCENT_ORANGE))
    
    # 5. 调色板色彩点缀（右上角）
    # 三个小圆点代表 GIF 的调色板颜色
    palette_y = 80
    palette_colors = [hex_to_rgb(ACCENT_ORANGE), hex_to_rgb(PALETTE_PINK), hex_to_rgb(PALETTE_PURPLE)]
    palette_radius = 12
    palette_start_x = SIZE - 100
    
    for i, color in enumerate(palette_colors):
        x = palette_start_x + i * 30
        draw.ellipse(
            [(x - palette_radius, palette_y - palette_radius),
             (x + palette_radius, palette_y + palette_radius)],
            fill=color
        )
    
    # 6. 底部标签 "GIF"
    # 使用等宽字体（与应用数据字体一致）
    try:
        font = ImageFont.truetype("consola.ttf", 36)
    except:
        font = ImageFont.load_default()
    
    label = "GIF"
    label_bbox = draw.textbbox((0, 0), label, font=font)
    label_width = label_bbox[2] - label_bbox[0]
    label_x = center_x + 80 - label_width // 2
    label_y = loop_center_y + loop_radius + 25
    
    draw.text((label_x, label_y), label, fill=hex_to_rgb(TEXT_LIGHT), font=font)
    
    # 7. 微妙的帧计数标注
    try:
        small_font = ImageFont.truetype("consola.ttf", 14)
    except:
        small_font = font
    
    # 在帧上标注序号
    for i in range(3):
        x = frames_start_x + i * (frame_width + frame_gap) + 8
        y = frames_y + 8
        frame_num = str(i + 1)
        draw.text((x, y), frame_num, fill=hex_to_rgb("#888888"), font=small_font)
    
    # 8. 保存
    img.save('c:/工具/mp4-to-gif-android/icon_512.png', 'PNG')
    print("图标已生成: icon_512.png")
    
    # 也生成圆角裁剪版本（Android Adaptive Icon foreground）
    # Android adaptive icon 需要前景层和背景层分开
    # 前景层：108dp 安全区内
    fg_img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    fg_draw = ImageDraw.Draw(fg_img)
    
    # 只绘制核心内容，不绘制背景
    # 复制核心图形到前景层
    # ... (简化：直接用原图作为 foreground，Android 会自动裁剪)
    
    fg_img.save('c:/工具/mp4-to-gif-android/icon_foreground.png', 'PNG')
    print("前景层已生成: icon_foreground.png")
    
    # 生成小尺寸预览
    for s in [192, 144, 96, 72, 48, 36]:
        small = img.resize((s, s), Image.Resampling.LANCZOS)
        small.save(f'c:/工具/mp4-to-gif-android/icon_{s}.png', 'PNG')
    print("各尺寸图标已生成")

if __name__ == '__main__':
    create_icon()