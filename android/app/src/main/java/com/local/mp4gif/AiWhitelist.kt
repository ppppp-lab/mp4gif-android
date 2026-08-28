package com.local.mp4gif

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * Kotlin safety layer for AI function calls.
 *
 * The model output is parsed, every method and parameter is checked against
 * the whitelist, and any invalid call rejects the whole instruction.
 */
object AiWhitelist {

    data class AiCall(
        val method: String,
        val params: JSONObject,
    )

    private enum class Type { INT, FLOAT, BOOL, STRING }

    private data class ParamRule(
        val type: Type,
        val required: Boolean = false,
        val min: Double? = null,
        val max: Double? = null,
        val allowedValues: Set<Any>? = null,
        val pattern: Regex? = null,
    )

    private fun intRule(lo: Int, hi: Int, required: Boolean = true) =
        ParamRule(Type.INT, required, lo.toDouble(), hi.toDouble())

    private fun boolRule(required: Boolean = true) =
        ParamRule(Type.BOOL, required)

    private fun stringEnum(vararg values: String, required: Boolean = true) =
        ParamRule(Type.STRING, required, allowedValues = values.toSet())

    private fun stringPattern(pattern: Regex, required: Boolean = true) =
        ParamRule(Type.STRING, required, pattern = pattern)

    private val whitelist: Map<String, Map<String, ParamRule>> = mapOf(
        "open_page" to mapOf("page" to stringEnum("meme")),
        "import_source" to emptyMap(),
        "open_text_editor" to emptyMap(),
        "add_text" to mapOf("text" to stringPattern(Regex("^.{1,100}$"))),
        "set_text_font" to mapOf("font" to stringEnum("heavy", "impact", "song", "kai", "mono")),
        "set_text_color" to mapOf("color" to stringPattern(Regex("^#[0-9A-Fa-f]{6}$"))),
        "set_text_size" to mapOf("size" to intRule(12, 80)),
        "set_text_stroke" to mapOf("stroke" to intRule(0, 8)),
        "set_text_rotation" to mapOf("rotation_degrees" to intRule(-180, 180)),
        "set_text_shadow" to mapOf("enabled" to boolRule()),
        "open_draw_editor" to emptyMap(),
        "set_draw_mode" to mapOf("mode" to stringEnum("pen", "eraser", "blur", "mosaic")),
        "set_draw_shape" to mapOf("shape" to stringEnum("free", "line", "arrow", "rect", "ellipse")),
        "set_draw_color" to mapOf("color" to stringPattern(Regex("^#[0-9A-Fa-f]{6}$"))),
        "set_draw_brush_width" to mapOf("width" to intRule(1, 20)),
        "set_mosaic_size" to mapOf("size" to intRule(4, 30)),
        "clear_draw" to emptyMap(),
        "draw_line" to mapOf(
            "x1" to intRule(0, 8192),
            "y1" to intRule(0, 8192),
            "x2" to intRule(0, 8192),
            "y2" to intRule(0, 8192),
            "color" to stringPattern(Regex("^#[0-9A-Fa-f]{6}$"), required = false),
            "stroke_width" to intRule(1, 40, required = false),
        ),
        "draw_arrow" to mapOf(
            "x1" to intRule(0, 8192),
            "y1" to intRule(0, 8192),
            "x2" to intRule(0, 8192),
            "y2" to intRule(0, 8192),
            "color" to stringPattern(Regex("^#[0-9A-Fa-f]{6}$"), required = false),
            "stroke_width" to intRule(1, 40, required = false),
        ),
        "draw_rect" to mapOf(
            "x" to intRule(0, 8192),
            "y" to intRule(0, 8192),
            "width" to intRule(1, 8192),
            "height" to intRule(1, 8192),
            "color" to stringPattern(Regex("^#[0-9A-Fa-f]{6}$"), required = false),
            "stroke_width" to intRule(1, 40, required = false),
        ),
        "draw_ellipse" to mapOf(
            "x" to intRule(0, 8192),
            "y" to intRule(0, 8192),
            "width" to intRule(1, 8192),
            "height" to intRule(1, 8192),
            "color" to stringPattern(Regex("^#[0-9A-Fa-f]{6}$"), required = false),
            "stroke_width" to intRule(1, 40, required = false),
        ),
        "erase_area" to mapOf(
            "x1" to intRule(0, 8192),
            "y1" to intRule(0, 8192),
            "x2" to intRule(0, 8192),
            "y2" to intRule(0, 8192),
            "width" to intRule(1, 100, required = false),
        ),
        "blur_area" to mapOf(
            "x1" to intRule(0, 8192),
            "y1" to intRule(0, 8192),
            "x2" to intRule(0, 8192),
            "y2" to intRule(0, 8192),
            "radius" to intRule(2, 50, required = false),
        ),
        "mosaic_area" to mapOf(
            "x1" to intRule(0, 8192),
            "y1" to intRule(0, 8192),
            "x2" to intRule(0, 8192),
            "y2" to intRule(0, 8192),
            "size" to intRule(4, 30, required = false),
        ),
        "select_layer" to mapOf("index" to intRule(0, 999)),
        "move_layer" to mapOf(
            "x" to intRule(0, 8192),
            "y" to intRule(0, 8192),
        ),
        "move_layer_by" to mapOf(
            "dx" to intRule(-4096, 4096),
            "dy" to intRule(-4096, 4096),
        ),
        "scale_layer" to mapOf("scale_percent" to intRule(10, 500)),
        "rotate_layer" to mapOf("rotation_degrees" to intRule(-180, 180)),
        "move_layer_up" to emptyMap(),
        "move_layer_down" to emptyMap(),
        "duplicate_layer" to emptyMap(),
        "flip_layer" to emptyMap(),
        "set_tool" to mapOf("tool" to stringEnum("text", "filter", "draw", "crop", "platform")),
        "apply_filter" to mapOf(
            "preset" to stringEnum("none", "gray", "sepia", "cold", "warm", "invert"),
            "brightness" to intRule(0, 200, required = false),
            "contrast" to intRule(0, 200, required = false),
            "saturation" to intRule(0, 200, required = false),
        ),
        "set_brightness" to mapOf("value" to intRule(0, 200)),
        "set_contrast" to mapOf("value" to intRule(0, 200)),
        "set_saturation" to mapOf("value" to intRule(0, 200)),
        "open_crop_editor" to emptyMap(),
        "set_crop_ratio" to mapOf("ratio" to stringEnum("free", "square", "wide", "portrait")),
        "set_crop_rect" to mapOf(
            "x" to intRule(0, 8192),
            "y" to intRule(0, 8192),
            "width" to intRule(1, 8192),
            "height" to intRule(1, 8192),
        ),
        "apply_crop" to emptyMap(),
        "reset_crop" to emptyMap(),
        "apply_platform_preset" to mapOf("platform" to stringEnum("wechat", "qq", "xiaohongshu", "douyin")),
        "add_white_border" to emptyMap(),
        "add_round_corner" to emptyMap(),
        "delete_selected_layer" to emptyMap(),
        "undo" to emptyMap(),
        "redo" to emptyMap(),
        "share_meme" to emptyMap(),
        "export_meme" to emptyMap(),
    )

    fun parse(rawJson: String): List<AiCall>? {
        return try {
            val root = JSONArray(rawJson)
            val calls = mutableListOf<AiCall>()
            for (i in 0 until root.length()) {
                val obj = root.optJSONObject(i) ?: return null
                val method = obj.optString("method")
                val params = obj.optJSONObject("params") ?: return null
                if (method.isEmpty() || !validate(method, params)) return null
                calls += AiCall(method, params)
            }
            calls
        } catch (e: JSONException) {
            null
        }
    }

    private fun validate(method: String, params: JSONObject): Boolean {
        val rules = whitelist[method] ?: return false

        val paramNames = mutableListOf<String>()
        params.keys().forEach { paramNames += it }
        if (paramNames.any { it !in rules }) return false

        for ((key, rule) in rules) {
            if (!params.has(key)) {
                if (rule.required) return false
                continue
            }
            val value = params.get(key)
            if (value === JSONObject.NULL) return false
            if (!typeMatches(value, rule.type)) return false
            if (!rangeMatches(value, rule)) return false
            if (rule.allowedValues != null && value !in rule.allowedValues) return false
            if (rule.pattern != null && (value as? String)?.let { rule.pattern.matches(it) } != true) return false
        }
        return true
    }

    private fun typeMatches(value: Any, type: Type): Boolean {
        return when (type) {
            Type.INT -> value is Number && value.toDouble() == Math.floor(value.toDouble()) && !value.toDouble().isInfinite()
            Type.FLOAT -> value is Number
            Type.BOOL -> value is Boolean
            Type.STRING -> value is String
        }
    }

    private fun rangeMatches(value: Any, rule: ParamRule): Boolean {
        val number = value as? Number ?: return true
        val d = number.toDouble()
        if (rule.min != null && d < rule.min) return false
        if (rule.max != null && d > rule.max) return false
        return true
    }
}
