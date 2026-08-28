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

    private fun floatRule(lo: Double, hi: Double, required: Boolean = true) =
        ParamRule(Type.FLOAT, required, lo, hi)

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
        "set_tool" to mapOf("tool" to stringEnum("text", "filter", "draw", "crop", "platform", "advanced")),
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
        "apply_crop" to emptyMap(),
        "reset_crop" to emptyMap(),
        "apply_platform_preset" to mapOf("platform" to stringEnum("wechat", "qq", "xiaohongshu", "douyin")),
        "add_white_border" to emptyMap(),
        "add_round_corner" to emptyMap(),
        "open_advanced_editor" to emptyMap(),
        "add_advanced_image" to emptyMap(),
        "set_advanced_position" to mapOf(
            "x" to intRule(0, 480),
            "y" to intRule(0, 480),
        ),
        "set_advanced_scale" to mapOf("scale_percent" to intRule(10, 500)),
        "set_advanced_rotation" to mapOf("rotation_degrees" to intRule(-180, 180)),
        "set_tracking_precision" to mapOf("precision" to intRule(1, 10)),
        "set_tracking_relative" to mapOf("relative" to boolRule()),
        "start_tracking" to emptyMap(),
        "add_position_keyframe" to mapOf("time_seconds" to floatRule(0.0, 86400.0, required = false)),
        "add_scale_keyframe" to mapOf("time_seconds" to floatRule(0.0, 86400.0, required = false)),
        "add_rotation_keyframe" to mapOf("time_seconds" to floatRule(0.0, 86400.0, required = false)),
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
