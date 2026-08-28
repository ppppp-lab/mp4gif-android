package com.local.mp4gif

import android.os.Handler
import android.os.Looper
import com.capllama.CapacitorLlama
import com.capllama.PartialCompletionCallback
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.TimeUnit

/**
 * AiBridge exposes model status, model download and GBNF-constrained inference
 * to the meme studio web layer.
 */
@CapacitorPlugin(name = "AiBridge")
class AiBridgePlugin : Plugin() {

    private val mainHandler = Handler(Looper.getMainLooper())
    private val downloader by lazy { ModelDownloader(context) }

    @PluginMethod
    fun checkModel(call: PluginCall) {
        Thread {
            val ret = JSObject()
            ret.put("ready", downloader.isReady())
            ret.put("version", AiConfig.MODEL_VERSION)
            mainHandler.post { call.resolve(ret) }
        }.start()
    }

    @PluginMethod
    fun downloadModel(call: PluginCall) {
        call.setKeepAlive(true)
        Thread {
            try {
                downloader.download { downloadedBytes, totalBytes ->
                    val percent = if (totalBytes > 0) downloadedBytes * 100.0 / totalBytes else 0.0
                    val data = JSObject()
                    data.put("percent", percent)
                    notifyListeners("ai:downloadProgress", data)
                }
                val ret = JSObject()
                ret.put("ready", true)
                mainHandler.post { call.resolve(ret) }
            } catch (e: Throwable) {
                mainHandler.post { call.reject(e.message ?: "模型下载失败") }
            }
        }.start()
    }

    @PluginMethod
    fun cancelDownload(call: PluginCall) {
        downloader.cancel()
        val ret = JSObject()
        ret.put("cancelled", true)
        call.resolve(ret)
    }

    @PluginMethod
    fun generate(call: PluginCall) {
        val instruction = call.getString("instruction") ?: ""
        if (instruction.isBlank()) {
            call.reject("指令为空")
            return
        }

        Thread {
            var llama: CapacitorLlama? = null
            try {
                if (!downloader.isReady()) {
                    resolveUnavailable(call, "模型未就绪")
                    return@Thread
                }

                val grammar = context.assets.open("function_call.gbnf").bufferedReader().use { it.readText() }
                val engine = CapacitorLlama()
                llama = engine
                val modelFile = downloader.modelFile()

                val initParams = JSObject()
                initParams.put("id", 1)
                initParams.put("model", modelFile.absolutePath)
                initParams.put("n_ctx", AiConfig.CONTEXT_SIZE)
                initParams.put("n_batch", AiConfig.BATCH_SIZE)
                initParams.put("n_threads", AiConfig.THREADS)
                initParams.put("use_mmap", true)
                initParams.put("use_mlock", false)

                val initFuture = engine.initContext(1.0, initParams)
                val initResult = initFuture.get(120, TimeUnit.SECONDS)
                    ?: throw IllegalStateException("模型加载失败")
                if (initResult.has("error")) {
                    throw IllegalStateException(initResult.getString("error"))
                }

                val completionParams = JSObject()
                completionParams.put("id", 1)
                val inner = JSObject()
                inner.put("prompt", buildPrompt(instruction))
                inner.put("grammar", grammar)
                inner.put("n_predict", AiConfig.MAX_TOKENS)
                inner.put("temperature", 0.2)
                inner.put("top_k", 40)
                inner.put("top_p", 0.9)
                inner.put("emit_partial_completion", false)
                completionParams.put("params", inner)

                val completionFuture = engine.completion(completionParams, PartialCompletionCallback { })
                val result = completionFuture.get(180, TimeUnit.SECONDS)
                    ?: throw IllegalStateException("AI 生成失败")
                if (result.has("error")) {
                    throw IllegalStateException(result.getString("error"))
                }

                val raw = result.optString("content").takeIf { it.isNotBlank() }
                    ?: result.optString("text").takeIf { it.isNotBlank() }
                    ?: throw IllegalStateException("AI 输出为空")

                val calls = AiWhitelist.parse(raw)
                if (calls == null) {
                    resolveUnavailable(call, "无法识别该指令")
                    return@Thread
                }

                val callsArray = JSArray()
                calls.forEach { c ->
                    val item = JSObject()
                    item.put("method", c.method)
                    item.put("params", c.params)
                    callsArray.put(item)
                }
                val ret = JSObject()
                ret.put("ok", true)
                ret.put("calls", callsArray)
                mainHandler.post { call.resolve(ret) }
            } catch (e: Throwable) {
                resolveUnavailable(call, e.message ?: "AI 生成失败")
            } finally {
                if (llama != null) {
                    try {
                        llama.releaseContext(1.0, JSObject())
                    } catch (_: Exception) {
                    }
                }
            }
        }.start()
    }

    private fun resolveUnavailable(call: PluginCall, message: String) {
        val ret = JSObject()
        ret.put("ok", false)
        ret.put("message", message)
        mainHandler.post { call.resolve(ret) }
    }

    private fun buildPrompt(instruction: String): String {
        val system = "你是一个表情包工坊指令助手。只输出符合 function_call.gbnf 的 JSON 数组，不要输出任何解释。"
        return "<|im_start|>system\n$system<|im_end|>\n" +
            "<|im_start|>user\n$instruction<|im_end|>\n" +
            "<|im_start|>assistant\n"
    }
}
