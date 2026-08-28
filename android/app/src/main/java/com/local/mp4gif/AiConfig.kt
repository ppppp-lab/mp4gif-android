package com.local.mp4gif

/**
 * AI model configuration.
 *
 * Fill these constants after the GGUF model is uploaded to ModelScope.
 * The APK never bundles the model; it is downloaded into the app private dir.
 */
object AiConfig {
    const val MODEL_FILE_NAME = "mp4gif-ai.gguf"
    const val MODEL_VERSION = "0.1.0"

    const val MODEL_URL = "https://modelscope.cn/models/ppyycc/mp4gif-ai/resolve/master/mp4gif-ai.gguf"
    const val MODEL_SHA256 = "23FE15B6207B71EEF275885D33D2B76A8CC64D55EC2222F50008F7C1694118E4"

    const val CONTEXT_SIZE = 2048
    const val BATCH_SIZE = 128
    const val MAX_TOKENS = 256
    const val THREADS = 4
}
