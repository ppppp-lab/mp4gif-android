package com.local.mp4gif.ai

import android.content.Context
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * AI 指令分发与安全校验框架。
 *
 * 数据流：
 * 1. llama.cpp 输出 JSON 字符串（GBNF 已保证语法合法）。
 * 2. 反序列化为函数调用数组。
 * 3. 白名单 + 参数名 + 类型 + 业务范围校验。
 * 4. 全部通过后逐条分发给 App 业务层。
 * 5. 任一环节失败，整体拒绝并返回"无法识别该指令"。
 */

data class AiCall(
    val method: String,
    val params: JSONObject
)

sealed class DispatchResult {
    object Success : DispatchResult()
    data class Rejected(val message: String = "无法识别该指令") : DispatchResult()
}

object AiDispatcher {
    private const val UNRECOGNIZED = "无法识别该指令"

    fun dispatch(rawJson: String): DispatchResult {
        return try {
            val calls = parseCalls(rawJson)
            calls.forEach { call ->
                if (!SafetyValidator.validate(call.method, call.params)) {
                    return DispatchResult.Rejected(UNRECOGNIZED)
                }
            }
            BusinessDispatcher.invoke(calls)
            DispatchResult.Success
        } catch (e: JSONException) {
            DispatchResult.Rejected(UNRECOGNIZED)
        }
    }

    private fun parseCalls(rawJson: String): List<AiCall> {
        val root = JSONArray(rawJson)
        val calls = mutableListOf<AiCall>()
        for (i in 0 until root.length()) {
            val obj = root.optJSONObject(i)
                ?: throw JSONException("call item must be an object")
            val method = obj.optString("method")
            val params = obj.optJSONObject("params")
                ?: throw JSONException("params must be an object")
            calls += AiCall(method, params)
        }
        return calls
    }
}

object BusinessDispatcher {
    /**
     * 业务分发层。
     *
     * 这里只保留分发框架；具体业务函数在接入现有 WebView/原生插件时逐个绑定：
     * open_page -> 跳转表情包工坊
     * import_source / export_meme / undo / redo 等 -> meme.js 对应动作
     */
    fun invoke(calls: List<AiCall>) {
        calls.forEach { call ->
            when (call.method) {
                // TODO("接入具体业务函数")
                else -> Unit
            }
        }
    }
}

object SafetyValidator {
    private enum class Type { INT, FLOAT, BOOL, STRING }

    private data class ParamRule(
        val type: Type,
        val required: Boolean = false,
        val min: Double? = null,
        val max: Double? = null,
        val allowedValues: Set<Any>? = null,
        val pattern: Regex? = null
    )

    private fun intRule(lo: Int, hi: Int, required: Boolean = true) =
        ParamRule(Type.INT, required, lo.toDouble(), hi.toDouble())

    private fun floatRule(lo: Double, hi: Double, required: Boolean = true) =
        ParamRule(Type.FLOAT, required, lo, hi)

    private fun boolRule(required: Boolean = true) =
        ParamRule(Type.BOOL, required)

    private fun intEnum(vararg values: Int) =
        ParamRule(Type.INT, allowedValues = values.toSet())

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
            "saturation" to intRule(0, 200, required = false)
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
            "y" to intRule(0, 480)
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
        "export_meme" to emptyMap()
    )

    fun validate(method: String, params: JSONObject): Boolean {
        val rules = whitelist[method] ?: return false
        if (!params.keys().asSequence().all { it in rules }) return false
        for ((key, rule) in rules) {
            if (!params.has(key)) {
                if (rule.required) return false
                continue
            }
            val value = params.get(key)
            if (!typeMatches(value, rule.type)) return false
            if (!rangeMatches(value, rule)) return false
            if (rule.allowedValues != null && value !in rule.allowedValues) return false
            if (rule.pattern != null && value is String && !rule.pattern.matches(value)) return false
        }
        return true
    }

    private fun typeMatches(value: Any?, type: Type): Boolean {
        return when (type) {
            Type.INT -> value is Int || (value is Double && value == Math.floor(value) && !value.isInfinite())
            Type.FLOAT -> value is Int || value is Double || value is Float
            Type.BOOL -> value is Boolean
            Type.STRING -> value is String
        }
    }

    private fun rangeMatches(value: Any?, rule: ParamRule): Boolean {
        val number = when (value) {
            is Int -> value.toDouble()
            is Double -> value
            is Float -> value.toDouble()
            else -> return true
        }
        if (rule.min != null && number < rule.min) return false
        if (rule.max != null && number > rule.max) return false
        return true
    }

}

/**
 * 魔搭模型下载器：断点续传 + SHA256 校验。
 * 下载完成后保存在 App 私有目录，不申请存储权限。
 */
class ModelDownloader(
    private val context: Context,
    private val modelUrl: String,
    private val expectedSha256: String,
    private val fileName: String = "mp4gif-ai.gguf"
) {
    suspend fun ensureModel(onProgress: (downloadedBytes: Long, totalBytes: Long) -> Unit): File {
        val dir = File(context.filesDir, "models").apply { mkdirs() }
        val target = File(dir, fileName)
        if (target.exists() && sha256(target).equals(expectedSha256, ignoreCase = true)) {
            return target
        }

        val part = File(dir, "$fileName.part")
        var downloaded = if (part.exists()) part.length() else 0L
        val connection = URL(modelUrl).openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 30_000
        connection.setRequestProperty("Range", "bytes=$downloaded-")
        connection.connect()

        val code = connection.responseCode
        if (code == HttpURLConnection.HTTP_PARTIAL) {
            val total = downloaded + connection.contentLengthLong.coerceAtLeast(0L)
            connection.inputStream.use { input ->
                FileOutputStream(part, true).use { output ->
                    val buffer = ByteArray(128 * 1024)
                    var read: Int
                    while (input.read(buffer).also { read = it } != -1) {
                        output.write(buffer, 0, read)
                        downloaded += read
                        onProgress(downloaded, total)
                    }
                }
            }
            if (!sha256(part).equals(expectedSha256, ignoreCase = true)) {
                part.delete()
                error("模型文件校验失败，已删除临时文件")
            }
            if (target.exists()) target.delete()
            part.renameTo(target)
        } else if (code == HttpURLConnection.HTTP_OK) {
            downloaded = 0L
            part.delete()
            val total = connection.contentLengthLong.coerceAtLeast(0L)
            connection.inputStream.use { input ->
                FileOutputStream(part, true).use { output ->
                    val buffer = ByteArray(128 * 1024)
                    var read: Int
                    while (input.read(buffer).also { read = it } != -1) {
                        output.write(buffer, 0, read)
                        downloaded += read
                        onProgress(downloaded, total)
                    }
                }
            }
            if (!sha256(part).equals(expectedSha256, ignoreCase = true)) {
                part.delete()
                error("模型文件校验失败，已删除临时文件")
            }
            if (target.exists()) target.delete()
            part.renameTo(target)
        } else {
            connection.disconnect()
            error("模型下载失败，HTTP $code")
        }
        return target
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            var read: Int
            while (input.read(buffer).also { read = it } != -1) {
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}

/**
 * 旧方案/测试用：从 APK assets 读取内置 GGUF。
 * 正式版使用 ModelDownloader 从魔搭下载，不在 assets 内放大模型。
 */
fun copyModelFromAssetsIfNeeded(context: Context) {
    val target = File(context.filesDir, "models/mp4gif-ai.gguf")
    if (target.exists()) return
    target.parentFile?.mkdirs()
    context.assets.open("models/mp4gif-ai.gguf").use { input ->
        target.outputStream().use { output ->
            input.copyTo(output)
        }
    }
}
