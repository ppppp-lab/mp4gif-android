package com.local.mp4gif

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Downloads the GGUF model into the app private directory.
 * Supports resume via Range requests, .part temp files and SHA-256 verification.
 */
class ModelDownloader(private val context: Context) {

    private val cancelled = AtomicBoolean(false)

    fun cancel() {
        cancelled.set(true)
    }

    fun modelFile(): File {
        return File(File(context.filesDir, "models"), AiConfig.MODEL_FILE_NAME)
    }

    fun isReady(): Boolean {
        if (AiConfig.MODEL_URL.isBlank() || AiConfig.MODEL_SHA256.isBlank()) return false
        val file = modelFile()
        if (!file.exists() || file.length() == 0L) return false
        return sha256(file).equals(AiConfig.MODEL_SHA256, ignoreCase = true)
    }

    fun download(onProgress: (downloadedBytes: Long, totalBytes: Long) -> Unit): File {
        cancelled.set(false)
        if (AiConfig.MODEL_URL.isBlank()) {
            error("模型地址未配置")
        }
        if (AiConfig.MODEL_SHA256.isBlank()) {
            error("模型校验值未配置")
        }

        val dir = File(context.filesDir, "models").apply { mkdirs() }
        val target = File(dir, AiConfig.MODEL_FILE_NAME)
        if (target.exists() && sha256(target).equals(AiConfig.MODEL_SHA256, ignoreCase = true)) {
            return target
        }

        val part = File(dir, AiConfig.MODEL_FILE_NAME + ".part")
        var downloaded = if (part.exists()) part.length() else 0L
        val connection = URL(AiConfig.MODEL_URL).openConnection() as HttpURLConnection
        connection.connectTimeout = 15_000
        connection.readTimeout = 30_000
        connection.setRequestProperty("Range", "bytes=$downloaded-")

        try {
            connection.connect()
            val code = connection.responseCode
            if (code != HttpURLConnection.HTTP_OK && code != HttpURLConnection.HTTP_PARTIAL) {
                error("模型下载失败，HTTP $code")
            }

            if (code == HttpURLConnection.HTTP_OK) {
                downloaded = 0L
                part.delete()
            }

            val total = downloaded + connection.contentLengthLong.coerceAtLeast(0L)
            val input = connection.inputStream
            val output = FileOutputStream(part, true)
            try {
                val buffer = ByteArray(128 * 1024)
                var read: Int
                while (input.read(buffer).also { read = it } != -1) {
                    if (cancelled.get()) {
                        error("下载已取消")
                    }
                    output.write(buffer, 0, read)
                    downloaded += read
                    val finalTotal = if (total > 0) total else downloaded
                    onProgress(downloaded, finalTotal)
                }
            } finally {
                input.close()
                output.close()
            }

            val actualSha = sha256(part)
            if (!actualSha.equals(AiConfig.MODEL_SHA256, ignoreCase = true)) {
                part.delete()
                error("模型文件校验失败")
            }
            target.delete()
            if (!part.renameTo(target)) {
                part.copyTo(target, overwrite = true)
                part.delete()
            }
            return target
        } finally {
            connection.disconnect()
        }
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
