package com.local.mp4gif

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import uniffi.expo_gifski.*
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * GifskiPlugin
 * -----------------------------------------------------------------------------
 * Capacitor 插件，使用 gifski 原生库（Rust）进行高质量 GIF 编码。
 * 使用 gifski 原生库实现单步高质量编码。
 *
 * 事件（通过 notifyListeners 推送）：
 *   - gifski:progress → { percent: double, frameProgress: double }
 *   - gifski:done     → { outputPath: string }   （公共 Movies 路径或 SAF URI）
 *   - gifski:error    → { kind: string, message: string }
 *
 * 事件模型：startConversion 立即返回 jobId，
 * 编码完成后通过事件通知前端，避免前端 await 阻塞。
 */
@CapacitorPlugin(name = "Gifski")
class GifskiPlugin : Plugin() {

    private val mainHandler = Handler(Looper.getMainLooper())

    /**
     * 单个编码任务的可变状态。
     * 使用 volatile 保护单字段可见性；复合操作由 ConcurrentHashMap 保证键级别安全。
     * 支持并发与取消。
     */
    private class JobState(val jobId: String) {
        val cancelled = AtomicBoolean(false)
        @Volatile var saveUri: Uri? = null        // 用户通过 SAF 选择的保存 URI（可能为 null）
        @Volatile var cacheOutputPath: String? = null  // 实际写入的缓存文件路径
        @Volatile var displayName: String = "output.gif"
    }

    /** 全局任务表：jobId → JobState，支持并发与取消 */
    private val jobs = ConcurrentHashMap<String, JobState>()

    // =========================================================================
    // 1) gifskiCheck —— gifski 可用性检测
    // =========================================================================

    @PluginMethod
    fun gifskiCheck(call: PluginCall) {
        val ret = JSObject()
        try {
            val version = getGifskiVersion()
            ret.put("available", true)
            ret.put("version", version ?: "")
        } catch (t: Throwable) {
            ret.put("available", false)
            ret.put("version", "")
        }
        call.resolve(ret)
    }

    // =========================================================================
    // 1.5) probeVideo —— 视频元数据探测
    // =========================================================================

    @PluginMethod
    fun probeVideo(call: PluginCall) {
        val path = call.getString("path")
        if (path.isNullOrEmpty()) {
            call.reject("未提供文件路径")
            return
        }

        Thread {
            var retriever: MediaMetadataRetriever? = null
            try {
                retriever = MediaMetadataRetriever()
                val r = retriever
                when {
                    path.startsWith("/") -> r.setDataSource(path)
                    path.startsWith("content://") -> r.setDataSource(context, Uri.parse(path))
                    else -> r.setDataSource(path)
                }

                val durationMs = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toDoubleOrNull() ?: 0.0
                val rawWidth = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
                val rawHeight = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
                val rotation = readVideoRotation(r, path)
                val isSideways = rotation == 90 || rotation == 270
                val width = if (isSideways) rawHeight else rawWidth
                val height = if (isSideways) rawWidth else rawHeight

                var fps = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE)?.toDoubleOrNull() ?: 0.0
                if (fps <= 0) {
                    val frameCount = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT)?.toLongOrNull() ?: 0L
                    if (frameCount > 0 && durationMs > 0) {
                        fps = frameCount / (durationMs / 1000.0)
                    }
                }

                val sizeBytes = if (path.startsWith("/")) File(path).length() else 0L

                val ret = JSObject()
                ret.put("width", width)
                ret.put("height", height)
                ret.put("rotation", rotation)
                ret.put("duration", durationMs / 1000.0)
                ret.put("fps", fps)
                ret.put("sizeBytes", sizeBytes)
                mainHandler.post { call.resolve(ret) }
            } catch (e: Exception) {
                val message = e.message ?: "未知错误"
                mainHandler.post { call.reject("探测失败: $message") }
            } finally {
                try { retriever?.release() } catch (_: Exception) {}
            }
        }.start()
    }

    // =========================================================================
    // 2) encodeGif —— GIF 编码（核心）
    // =========================================================================

    @PluginMethod
    fun encodeGif(call: PluginCall) {
        val inputPath = call.getString("inputPath")
        val outputPath = call.getString("outputPath")
        if (inputPath.isNullOrEmpty()) {
            call.reject("缺少 inputPath 参数")
            return
        }
        if (outputPath.isNullOrEmpty()) {
            call.reject("缺少 outputPath 参数")
            return
        }

        // 解析参数
        val startSec = call.getDouble("startSec", 0.0) ?: 0.0
        val durationSec = call.getDouble("durationSec", 0.0) ?: 0.0
        val width = call.getInt("width", 480) ?: 480
        val height = call.getInt("height", -1) ?: -1
        val fps = call.getInt("fps", 15) ?: 15
        val quality = call.getInt("quality", 90) ?: 90
        val loop = call.getInt("loop", 0) ?: 0
        val fast = call.getBoolean("fast", false) ?: false

        // 生成 jobId
        val jobId = System.currentTimeMillis().toString() + "-" + (Math.random() * 0xFFFFFF).toLong().toString(16)
        val job = JobState(jobId)
        val defaultName = call.getString("defaultName", "output.gif") ?: "output.gif"
        job.displayName = defaultName
        if (!job.displayName!!.toLowerCase().endsWith(".gif")) {
            job.displayName = job.displayName + ".gif"
        }

        // 判断 outputPath 是 SAF URI (content://) 还是文件路径
        // gifski Rust 端只能写入真实文件路径，SAF URI 需要先写缓存再复制
        val cacheOutputPath: String
        if (outputPath.startsWith("content://")) {
            job.saveUri = Uri.parse(outputPath)
            val safeName = job.displayName!!.replace("[^a-zA-Z0-9_.-]".toRegex(), "_")
            cacheOutputPath = File(context.cacheDir, "gifski_output_$safeName").absolutePath
        } else if (outputPath.startsWith("/")) {
            cacheOutputPath = outputPath
        } else {
            val safeName = job.displayName!!.replace("[^a-zA-Z0-9_.-]".toRegex(), "_")
            cacheOutputPath = File(context.cacheDir, "gifski_output_$safeName").absolutePath
        }
        job.cacheOutputPath = cacheOutputPath

        jobs[jobId] = job

        // 立即返回 jobId，编码在后台异步进行
        val ret = JSObject()
        ret.put("jobId", jobId)
        call.resolve(ret)

        // 启动异步编码
        Thread {
            encodeGifAsync(
                job, inputPath, cacheOutputPath,
                startSec, durationSec, width, height,
                fps, quality, loop, fast
            )
        }.start()
    }

    private fun encodeGifAsync(
        job: JobState, inputPath: String, cacheOutputPath: String,
        startSec: Double, durationSec: Double, width: Int, height: Int,
        fps: Int, quality: Int, loop: Int, fast: Boolean
    ) {
        val cacheDir = context.cacheDir
        val tempPngPaths = mutableListOf<String>()
        val retriever = MediaMetadataRetriever()

        try {
            // 设置数据源
            when {
                inputPath.startsWith("/") -> retriever.setDataSource(inputPath)
                inputPath.startsWith("content://") -> retriever.setDataSource(context, Uri.parse(inputPath))
                else -> retriever.setDataSource(inputPath)
            }

            // 获取视频时长
            val durationStr = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
            var videoDurationMs: Long = 0
            if (durationStr != null) {
                try { videoDurationMs = durationStr.toLong() } catch (_: NumberFormatException) {}
            }
            val videoDurationSec = videoDurationMs / 1000.0

            // 计算实际时长
            val actualDuration = when {
                durationSec <= 0.0 || durationSec > videoDurationSec - startSec -> videoDurationSec - startSec
                else -> durationSec
            }

            if (actualDuration <= 0) {
                emitError(job, "invalid", "无效时间范围: startSec=$startSec 超过视频时长")
                return
            }

            // 获取视频分辨率与旋转元数据（手机竖屏视频通常存储为横屏 + rotation 元数据）
            val rawWidth = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 480
            val rawHeight = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 360
            val rotation = readVideoRotation(retriever, inputPath)
            val isPortrait = rotation == 90 || rotation == 270
            // 部分设备取帧时已经自动转正，再用元数据转一次会变成横屏；取一帧实际尺寸判断
            val probeFrame = retriever.getFrameAtTime((startSec * 1_000_000).toLong(), MediaMetadataRetriever.OPTION_CLOSEST)
            val probeW = probeFrame?.width ?: rawWidth
            val probeH = probeFrame?.height ?: rawHeight
            val frameAlreadyCorrected = isPortrait && probeH > probeW
            probeFrame?.recycle()
            val needsRotate = rotation == 180 || (isPortrait && !frameAlreadyCorrected)
            val videoWidth = if (isPortrait) rawHeight else rawWidth
            val videoHeight = if (isPortrait) rawWidth else rawHeight
            Log.i("GifskiPlugin", "旋转: rotation=$rotation, 源=${rawWidth}x${rawHeight}, 帧=${probeW}x${probeH}, 已转正=$frameAlreadyCorrected, 需要旋转=$needsRotate, 目标方向=${videoWidth}x${videoHeight}")

            // 计算目标分辨率（aspect-fit：保持宽高比，不裁剪）
            val (targetWidth, targetHeight) = if (height <= 0) {
                val w = if (width <= 0) 480 else width
                val scale = w.toDouble() / videoWidth
                Pair(w, Math.round(videoHeight * scale).toInt())
            } else {
                Pair(if (width > 0) width else videoWidth, height)
            }

            Log.i("GifskiPlugin", "视频: duration=${videoDurationSec}s, 提取 $startSec ~ ${startSec + actualDuration}, ${fps}fps")
            Log.i("GifskiPlugin", "目标分辨率: ${targetWidth}x${targetHeight}")

            // 计算帧数
            val frameInterval = 1.0 / fps
            val frameCount = Math.ceil(actualDuration / frameInterval).toInt()

            Log.i("GifskiPlugin", "提取 $frameCount 帧")

            // 提取帧（使用 OPTION_CLOSEST 精确取帧，避免 OPTION_CLOSEST_SYNC 只返回关键帧导致帧率极低）
            var extractedCount = 0
            for (i in 0 until frameCount) {
                if (job.cancelled.get()) break

                val timestamp = startSec + i * frameInterval
                val timeUs = (timestamp * 1_000_000).toLong()

                // 必须使用 OPTION_CLOSEST 以精确获取指定时间戳的帧：
                // OPTION_CLOSEST_SYNC 只返回关键帧（I-frame），而视频关键帧通常间隔 2~5 秒，
                // 导致连续请求都返回同一关键帧，实际帧率降至 0.5~2fps（GIF 看起来像幻灯片）。
                // OPTION_CLOSEST 虽然每帧提取稍慢（需从最近关键帧解码到目标时间点），
                // 但能保证按用户设定的 fps 精确取帧，输出帧率正确。
                val bitmap = retriever.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST)
                if (bitmap == null) {
                    Log.w("GifskiPlugin", "帧 $i (t=${timestamp}s) 提取失败")
                    continue
                }

                // 只有需要时才旋转（避免设备已自动转正后二次旋转），然后缩放（aspect-fit，保持完整画面不裁剪）
                val orientedBitmap = if (needsRotate) rotateBitmap(bitmap, rotation) else bitmap
                val scaledBitmap = resizeBitmapAspectFit(orientedBitmap, targetWidth, targetHeight)
                if (orientedBitmap !== bitmap) bitmap.recycle()
                if (scaledBitmap !== orientedBitmap) orientedBitmap.recycle()

                // 保存为临时 PNG
                val tmpFile = File(cacheDir, "gifski_frame_${UUID.randomUUID()}.png")
                try {
                    FileOutputStream(tmpFile).use { out ->
                        scaledBitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                    }
                    tempPngPaths.add(tmpFile.absolutePath)
                    extractedCount++
                } catch (e: Exception) {
                    Log.w("GifskiPlugin", "帧 $i 保存失败: ${e.message}")
                } finally {
                    scaledBitmap.recycle()
                }

                // 发送进度（前面 70% 是帧提取）
                val frameProgress = (i + 1).toDouble() / frameCount
                emitProgress(frameProgress, frameProgress * 0.7)
            }

            if (job.cancelled.get()) {
                cleanupTempFiles(tempPngPaths)
                emitError(job, "cancelled", "用户取消")
                return
            }

            if (tempPngPaths.isEmpty()) {
                emitError(job, "no-frames", "未能提取任何帧")
                return
            }

            Log.i("GifskiPlugin", "已提取 $extractedCount/$frameCount 帧，开始编码...")

            // 构建 gifski 选项
            val options = GifskiOptions(
                width = targetWidth.toUInt(),
                height = targetHeight.toUInt(),
                quality = quality.toUByte(),
                repeat = loop,
                fast = fast,
                fps = fps.toFloat()
            )

            // 创建进度回调
            val progressCallback = object : GifskiProgressCallback {
                override fun onProgress(progress: GifskiProgress) {
                    if (job.cancelled.get()) return
                    val framesProcessed = progress.framesProcessed.toLong()
                    val totalFrames = progress.totalFrames.toLong()
                    val frameProgress = if (totalFrames > 0) framesProcessed.toDouble() / totalFrames else 0.0
                    // 后面 30% 是编码
                    emitProgress(frameProgress, 0.7 + frameProgress * 0.3)
                }
            }

            // 调用 gifski 原生库
            try {
                encodeGif(tempPngPaths, cacheOutputPath, options, progressCallback)
            } catch (e: GifskiException) {
                emitError(job, "encoder", "GIF 编码失败: ${e.message}")
                return
            }

            if (job.cancelled.get()) {
                cleanupTempFiles(tempPngPaths)
                emitError(job, "cancelled", "用户取消")
                return
            }

            // 清理临时 PNG 文件
            cleanupTempFiles(tempPngPaths)

            // 完成：将缓存文件复制到用户选择的位置（SAF URI 或公共 Movies）
            finalizeJob(job, cacheOutputPath)

        } catch (e: Exception) {
            // 异常时清理临时文件，避免磁盘泄漏
            cleanupTempFiles(tempPngPaths)
            emitError(job, "generic", "编码失败: ${e.message}")
        } finally {
            try {
                retriever.release()
            } catch (_: Exception) {}
        }
    }

    // =========================================================================
    // 收尾：复制缓存 GIF 到用户 SAF 路径或公共 Movies 目录
    // =========================================================================

    private fun finalizeJob(job: JobState, cacheOutputPath: String) {
        try {
            val cacheFile = File(cacheOutputPath)
            if (!cacheFile.exists()) {
                emitError(job, "disk", "输出文件不存在，转换可能未完成")
                return
            }

            val displayName = job.displayName ?: cacheFile.name

            if (job.saveUri != null) {
                // 用户通过 SAF 选了保存路径：复制到 SAF URI
                try {
                    copyCacheToUri(cacheFile, job.saveUri!!)
                    cacheFile.delete()
                    emitDone(job, job.saveUri.toString())
                } catch (e: IOException) {
                    emitError(job, "disk", "保存到 SAF 失败: ${e.message}")
                }
            } else {
                // 没有 SAF URI：复制到公共 Movies/MP4转GIF/ 目录
                try {
                    val publicPath = copyToPublicMovies(cacheFile, displayName)
                    cacheFile.delete()
                    emitDone(job, publicPath)
                } catch (e: IOException) {
                    emitError(job, "disk", "保存到公共目录失败: ${e.message}")
                }
            }
        } catch (e: Exception) {
            emitError(job, "generic", "收尾失败: ${e.message}")
        }
    }

    private fun copyCacheToUri(cacheFile: File, uri: Uri) {
        FileInputStream(cacheFile).use { ins ->
            context.contentResolver.openOutputStream(uri)?.use { os ->
                val buf = ByteArray(8192)
                var n: Int
                while (ins.read(buf).also { n = it } > 0) {
                    os.write(buf, 0, n)
                }
            } ?: throw IOException("无法打开 SAF 输出流: $uri")
        }
    }

    /**
     * 将缓存文件复制到公共 Movies/MP4转GIF/ 目录。
     * - API 29+：使用 MediaStore 插入条目
     * - API 24-28：直接写入外部存储公共目录
     */
    private fun copyToPublicMovies(cacheFile: File, displayName: String): String {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val cr = context.contentResolver
            val values = android.content.ContentValues()
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
            values.put(MediaStore.MediaColumns.MIME_TYPE, "image/gif")
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/MP4转GIF")
            values.put(MediaStore.MediaColumns.IS_PENDING, 1)

            val uri = cr.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                ?: throw IOException("无法创建 MediaStore 条目")

            try {
                FileInputStream(cacheFile).use { ins ->
                    cr.openOutputStream(uri)?.use { os ->
                        val buf = ByteArray(8192)
                        var n: Int
                        while (ins.read(buf).also { n = it } > 0) {
                            os.write(buf, 0, n)
                        }
                    } ?: throw IOException("无法打开 MediaStore 输出流")
                }
            } catch (e: IOException) {
                try { cr.delete(uri, null, null) } catch (_: Exception) {}
                throw e
            }

            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            try { cr.update(uri, values, null, null) } catch (_: Exception) {}

            // 同时复制到应用外部文件目录，返回绝对路径供 WebView 加载
            var appPicsDir = File(context.getExternalFilesDir(Environment.DIRECTORY_PICTURES), "MP4转GIF")
            if (!appPicsDir.exists() && !appPicsDir.mkdirs()) {
                appPicsDir = context.getExternalFilesDir(Environment.DIRECTORY_PICTURES)!!
            }
            val appCopy = File(appPicsDir, displayName)
            FileInputStream(cacheFile).use { ins ->
                FileOutputStream(appCopy).use { os ->
                    val buf = ByteArray(8192)
                    var n: Int
                    while (ins.read(buf).also { n = it } > 0) {
                        os.write(buf, 0, n)
                    }
                }
            }
            return appCopy.absolutePath
        } else {
            val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES), "MP4转GIF")
            if (!dir.exists() && !dir.mkdirs()) {
                throw IOException("无法创建目录: " + dir.absolutePath)
            }
            val target = File(dir, displayName)
            FileInputStream(cacheFile).use { ins ->
                FileOutputStream(target).use { os ->
                    val buf = ByteArray(8192)
                    var n: Int
                    while (ins.read(buf).also { n = it } > 0) {
                        os.write(buf, 0, n)
                    }
                }
            }
            return target.absolutePath
        }
    }

    // =========================================================================
    // 辅助方法
    // =========================================================================

    /**
     * aspect-fit 缩放：保持宽高比，完整保留画面内容（不裁剪）。
     * 等比缩放，保持宽高比不裁剪。
     * 如果目标尺寸与源尺寸比例不同，会在宽或高方向留白（黑边）。
     */
    private fun resizeBitmapAspectFit(bitmap: Bitmap, targetWidth: Int, targetHeight: Int): Bitmap {
        if (bitmap.width == targetWidth && bitmap.height == targetHeight) {
            return bitmap
        }

        val widthRatio = targetWidth.toFloat() / bitmap.width
        val heightRatio = targetHeight.toFloat() / bitmap.height
        // aspect-fit: 取较小比例，保证完整画面都在目标区域内
        val scale = minOf(widthRatio, heightRatio)

        val scaledWidth = (bitmap.width * scale).toInt()
        val scaledHeight = (bitmap.height * scale).toInt()

        // 创建目标尺寸的画布，先用透明色填充
        val result = Bitmap.createBitmap(targetWidth, targetHeight, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(result)
        canvas.drawColor(Color.TRANSPARENT)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)

        // 居中绘制缩放后的 bitmap
        val offsetX = (targetWidth - scaledWidth) / 2f
        val offsetY = (targetHeight - scaledHeight) / 2f

        val matrix = Matrix()
        matrix.postScale(scale, scale)
        matrix.postTranslate(offsetX, offsetY)

        canvas.drawBitmap(bitmap, matrix, paint)
        return result
    }

    private fun normalizeRotation(raw: Int): Int {
        val r = raw % 360
        return if (r < 0) r + 360 else r
    }

    /** 通过 MediaExtractor 读取视频格式中的旋转元数据（API 23+，兼容性更好） */
    private fun readRotationFromExtractor(path: String): Int {
        return try {
            val extractor = MediaExtractor()
            try {
                when {
                    path.startsWith("/") -> extractor.setDataSource(path)
                    path.startsWith("content://") -> extractor.setDataSource(context, Uri.parse(path), null)
                    else -> extractor.setDataSource(path)
                }
                for (i in 0 until extractor.trackCount) {
                    val format = extractor.getTrackFormat(i)
                    val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
                    if (mime.startsWith("video/") && format.containsKey(MediaFormat.KEY_ROTATION)) {
                        return normalizeRotation(format.getInteger(MediaFormat.KEY_ROTATION))
                    }
                }
                0
            } finally {
                extractor.release()
            }
        } catch (_: Throwable) {
            0
        }
    }

    /** 综合读取视频旋转：优先 MediaExtractor，回退 MediaMetadataRetriever */
    private fun readVideoRotation(retriever: MediaMetadataRetriever, path: String): Int {
        val metaRotation = normalizeRotation(
            retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
        )
        val extractorRotation = readRotationFromExtractor(path)
        return if (extractorRotation != 0) extractorRotation else metaRotation
    }

    /** 把 MediaMetadataRetriever 取到的原始帧按视频旋转元数据转正 */
    private fun rotateBitmap(bitmap: Bitmap, degrees: Int): Bitmap {
        if (degrees == 0) return bitmap
        val matrix = Matrix()
        matrix.postRotate(degrees.toFloat())
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    }

    private fun emitProgress(frameProgress: Double, totalProgress: Double) {
        val data = JSObject()
        val pct = kotlin.math.min(100.0, (totalProgress * 100.0).toLong().toDouble())
        data.put("percent", pct)
        data.put("frameProgress", (frameProgress * 100.0).toLong())
        notifyListeners("gifski:progress", data)
    }

    private fun emitDone(job: JobState, outputPath: String) {
        val data = JSObject()
        data.put("outputPath", outputPath)
        notifyListeners("gifski:done", data)
        jobs.remove(job.jobId)
    }

    private fun emitError(job: JobState, kind: String, message: String) {
        val data = JSObject()
        data.put("kind", kind)
        data.put("message", message)
        notifyListeners("gifski:error", data)
        jobs.remove(job.jobId)
    }

    private fun cleanupTempFiles(paths: List<String>) {
        for (path in paths) {
            try { File(path).delete() } catch (_: Exception) {}
        }
    }

    // =========================================================================
    // 3) encodeGifFromFrames —— 从帧PNG路径列表编码GIF（表情包工坊用）
    // =========================================================================

    @PluginMethod
    fun encodeGifFromFrames(call: PluginCall) {
        val framePaths = call.getArray("framePaths")
        val width = call.getInt("width", 480) ?: 480
        val height = call.getInt("height", 480) ?: 480
        val fps = call.getInt("fps", 15) ?: 15
        val quality = call.getInt("quality", 90) ?: 90
        val loop = call.getInt("loop", 0) ?: 0
        val fast = call.getBoolean("fast", false) ?: false
        val outputPath = call.getString("outputPath")

        if (framePaths == null || framePaths.length() == 0) {
            call.reject("缺少 framePaths 参数")
            return
        }

        // 转换为 List<String>
        val paths = mutableListOf<String>()
        for (i in 0 until framePaths.length()) {
            val p = framePaths.getString(i)
            if (p != null) paths.add(p)
        }
        if (paths.isEmpty()) {
            call.reject("framePaths 为空")
            return
        }

        val jobId = System.currentTimeMillis().toString() + "-" + (Math.random() * 0xFFFFFF).toLong().toString(16)
        val job = JobState(jobId)
        val defaultName = call.getString("defaultName", "meme.gif") ?: "meme.gif"
        job.displayName = defaultName
        if (!job.displayName!!.toLowerCase().endsWith(".gif")) {
            job.displayName = job.displayName + ".gif"
        }

        // 用户通过 saveGifDialog 选择了保存路径（SAF content:// URI）
        if (outputPath != null && outputPath.startsWith("content://")) {
            job.saveUri = Uri.parse(outputPath)
        }

        val safeName = job.displayName!!.replace("[^a-zA-Z0-9_.-]".toRegex(), "_")
        val cacheOutputPath = File(context.cacheDir, "gifski_meme_$safeName").absolutePath
        job.cacheOutputPath = cacheOutputPath

        jobs[jobId] = job

        val ret = JSObject()
        ret.put("jobId", jobId)
        call.resolve(ret)

        Thread {
            encodeGifFromFramesAsync(job, paths, cacheOutputPath, width, height, fps, quality, loop, fast)
        }.start()
    }

    private fun encodeGifFromFramesAsync(
        job: JobState, framePaths: List<String>, cacheOutputPath: String,
        width: Int, height: Int, fps: Int, quality: Int, loop: Int, fast: Boolean
    ) {
        try {
            // 内存信息日志，便于排查 OOM
            val runtime = Runtime.getRuntime()
            val usedMB = (runtime.totalMemory() - runtime.freeMemory()) / 1048576L
            val maxMB = runtime.maxMemory() / 1048576L
            Log.i("GifskiPlugin", "帧模式编码: ${framePaths.size}帧, ${width}x${height}, ${fps}fps")
            Log.i("GifskiPlugin", "JVM内存: 已用=${usedMB}MB, 上限=${maxMB}MB")

            // 确保缓存输出文件的父目录存在
            val cacheFile = File(cacheOutputPath)
            val parentDir = cacheFile.parentFile
            if (parentDir != null && !parentDir.exists()) {
                parentDir.mkdirs()
            }

            // 验证所有帧文件存在，并统计总大小
            var totalFrameBytes = 0L
            for ((idx, path) in framePaths.withIndex()) {
                val f = File(path)
                if (!f.exists() || f.length() == 0L) {
                    emitError(job, "no-frames", "帧文件不存在或为空: 帧$idx ($path)")
                    cleanupTempFiles(framePaths)
                    return
                }
                totalFrameBytes += f.length()
                Log.d("GifskiPlugin", "帧 $idx: ${f.length()/1024}KB, $path")
            }
            Log.i("GifskiPlugin", "帧文件总大小: ${totalFrameBytes / 1048576L}MB (${framePaths.size}帧)")

            // 调用 gifski 前强制 GC，释放 WebView 占用的内存
            Log.i("GifskiPlugin", "调用 System.gc() 释放内存...")
            System.gc()
            Thread.sleep(200)

            val runtime2 = Runtime.getRuntime()
            val usedMB2 = (runtime2.totalMemory() - runtime2.freeMemory()) / 1048576L
            val freeMB = maxMB - usedMB2
            Log.i("GifskiPlugin", "GC后内存: 已用=${usedMB2}MB, 可用=${freeMB}MB, 上限=${maxMB}MB")

            // 预估 gifski 需要的内存：每帧 width*height*4 字节（RGBA），加上编码缓冲
            val estimatedGifskiMem = (width.toLong() * height * 4 * framePaths.size) / 1048576L
            Log.i("GifskiPlugin", "预估gifski内存需求: ${estimatedGifskiMem}MB")
            if (freeMB < estimatedGifskiMem) {
                Log.w("GifskiPlugin", "可用内存(${freeMB}MB) < 预估需求(${estimatedGifskiMem}MB)，可能OOM")
            }

            // 构建 gifski 选项
            val options = GifskiOptions(
                width = width.toUInt(),
                height = height.toUInt(),
                quality = quality.toUByte(),
                repeat = loop,
                fast = fast,
                fps = fps.toFloat()
            )

            val progressCallback = object : GifskiProgressCallback {
                override fun onProgress(progress: GifskiProgress) {
                    if (job.cancelled.get()) return
                    val framesProcessed = progress.framesProcessed.toLong()
                    val totalFrames = progress.totalFrames.toLong()
                    val frameProgress = if (totalFrames > 0) framesProcessed.toDouble() / totalFrames else 0.0
                    emitProgress(frameProgress, frameProgress)
                }
            }

            Log.i("GifskiPlugin", "开始调用 gifski encodeGif...")
            try {
                encodeGif(framePaths, cacheOutputPath, options, progressCallback)
                Log.i("GifskiPlugin", "gifski encodeGif 返回成功")
            } catch (e: GifskiException) {
                Log.e("GifskiPlugin", "GIF编码异常: ${e.message}")
                cleanupTempFiles(framePaths)
                emitError(job, "encoder", "GIF 编码失败: ${e.message}")
                return
            } catch (e: OutOfMemoryError) {
                Log.e("GifskiPlugin", "GIF编码OOM: ${e.message}")
                cleanupTempFiles(framePaths)
                emitError(job, "oom", "内存不足，请尝试减少帧数或降低分辨率")
                return
            } catch (e: Throwable) {
                Log.e("GifskiPlugin", "GIF编码未知异常: ${e.javaClass.name}: ${e.message}")
                cleanupTempFiles(framePaths)
                emitError(job, "generic", "编码异常: ${e.message}")
                return
            }

            // 编码完成，立即清理临时帧文件释放磁盘空间
            cleanupTempFiles(framePaths)

            if (job.cancelled.get()) {
                emitError(job, "cancelled", "用户取消")
                return
            }

            // 验证输出文件
            val outFile = File(cacheOutputPath)
            if (!outFile.exists() || outFile.length() == 0L) {
                emitError(job, "disk", "编码完成但输出文件不存在或为空: $cacheOutputPath")
                return
            }
            Log.i("GifskiPlugin", "编码完成，输出文件: ${outFile.length()} bytes")

            finalizeJob(job, cacheOutputPath)
        } catch (e: Exception) {
            cleanupTempFiles(framePaths)
            emitError(job, "generic", "编码失败: ${e.message}")
        }
    }

    // =========================================================================
    // 3.5) benchmark —— 设备性能基准
    // =========================================================================

    @PluginMethod
    fun benchmark(call: PluginCall) {
        Thread {
            try {
                // 生成 12 帧 480x270 渐变 PNG，用 gifski 编码 1 秒 12fps GIF 测耗时
                val cacheDir = context.cacheDir
                val framePaths = mutableListOf<String>()
                val frames = 12
                val width = 480
                val height = 270
                for (i in 0 until frames) {
                    val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                    val canvas = Canvas(bmp)
                    canvas.drawColor(Color.rgb(20 + i * 8, 40 + i * 12, 90 + i * 8))
                    val file = File(cacheDir, "bench_${System.currentTimeMillis()}_$i.png")
                    FileOutputStream(file).use { out -> bmp.compress(Bitmap.CompressFormat.PNG, 100, out) }
                    bmp.recycle()
                    framePaths.add(file.absolutePath)
                }

                val start = System.currentTimeMillis()
                val outFile = File(cacheDir, "bench_out_${System.currentTimeMillis()}.gif")
                val options = GifskiOptions(
                    width = width.toUInt(),
                    height = height.toUInt(),
                    quality = 85.toUByte(),
                    repeat = 0,
                    fast = false,
                    fps = 12f
                )
                encodeGif(framePaths, outFile.absolutePath, options, object : GifskiProgressCallback {
                    override fun onProgress(progress: GifskiProgress) {}
                })
                val elapsedSec = (System.currentTimeMillis() - start) / 1000.0
                cleanupTempFiles(framePaths)
                outFile.delete()

                val ret = JSObject()
                ret.put("seconds", elapsedSec)
                mainHandler.post { call.resolve(ret) }
            } catch (e: Exception) {
                val ret = JSObject()
                ret.put("seconds", -1)
                mainHandler.post { call.resolve(ret) }
            }
        }.start()
    }

    // =========================================================================
    // 3.6) probeEstSize —— 采样编码预估体积与耗时
    // =========================================================================

    @PluginMethod
    fun probeEstSize(call: PluginCall) {
        val inputPath = call.getString("inputPath")
        if (inputPath.isNullOrEmpty()) {
            call.reject("缺少 inputPath 参数")
            return
        }
        val startSec = call.getDouble("startSec", 0.0) ?: 0.0
        val width = call.getInt("width", 480) ?: 480
        val height = call.getInt("height", -1) ?: -1
        val fps = call.getInt("fps", 12) ?: 12
        val qualityValue = call.getInt("qualityValue", 85) ?: 85
        val sampleSec = call.getDouble("sampleSec", 1.0) ?: 1.0

        Thread {
            var retriever: MediaMetadataRetriever? = null
            val tempPngPaths = mutableListOf<String>()
            val resolved = java.util.concurrent.atomic.AtomicBoolean(false)
            fun settle(ret: JSObject) {
                if (resolved.compareAndSet(false, true)) {
                    mainHandler.post { call.resolve(ret) }
                }
            }
            // 兜底：最迟 20 秒返回，避免前端导出流程被卡死
            Thread {
                Thread.sleep(20000)
                if (resolved.compareAndSet(false, true)) {
                    val ret = JSObject()
                    ret.put("bytes", -1)
                    ret.put("elapsedMs", -1)
                    ret.put("sampleSec", sampleSec)
                    mainHandler.post { call.resolve(ret) }
                }
            }.start()
            try {
                retriever = MediaMetadataRetriever()
                val r = retriever
                when {
                    inputPath.startsWith("/") -> r.setDataSource(inputPath)
                    inputPath.startsWith("content://") -> r.setDataSource(context, Uri.parse(inputPath))
                    else -> r.setDataSource(inputPath)
                }

                val rawWidth = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 480
                val rawHeight = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 360
                val rotation = readVideoRotation(r, inputPath)
                val isSideways = rotation == 90 || rotation == 270
                val videoWidth = if (isSideways) rawHeight else rawWidth
                val videoHeight = if (isSideways) rawWidth else rawHeight

                val (targetWidth, targetHeight) = if (height <= 0) {
                    val w = if (width <= 0) 480 else width
                    val scale = w.toDouble() / videoWidth
                    Pair(w, Math.round(videoHeight * scale).toInt())
                } else {
                    Pair(if (width > 0) width else videoWidth, height)
                }

                val frameInterval = 1.0 / fps
                val frameCount = Math.ceil(sampleSec / frameInterval).toInt().coerceAtMost(60)
                val cacheDir = context.cacheDir
                val startTime = System.currentTimeMillis()

                for (i in 0 until frameCount) {
                    val timestamp = startSec + i * frameInterval
                    val timeUs = (timestamp * 1_000_000).toLong()
                    val bitmap = r.getFrameAtTime(timeUs, MediaMetadataRetriever.OPTION_CLOSEST) ?: continue
                    val oriented = rotateBitmap(bitmap, rotation)
                    val scaled = resizeBitmapAspectFit(oriented, targetWidth, targetHeight)
                    if (oriented !== bitmap) bitmap.recycle()
                    if (scaled !== oriented) oriented.recycle()
                    val tmp = File(cacheDir, "probe_frame_${System.currentTimeMillis()}_$i.png")
                    FileOutputStream(tmp).use { out -> scaled.compress(Bitmap.CompressFormat.PNG, 100, out) }
                    scaled.recycle()
                    tempPngPaths.add(tmp.absolutePath)
                }

                if (tempPngPaths.isEmpty()) {
                    cleanupTempFiles(tempPngPaths)
                    val ret = JSObject()
                    ret.put("bytes", -1)
                    ret.put("elapsedMs", -1)
                    ret.put("sampleSec", sampleSec)
                    settle(ret)
                    return@Thread
                }

                val outFile = File(cacheDir, "probe_out_${System.currentTimeMillis()}.gif")
                val options = GifskiOptions(
                    width = targetWidth.toUInt(),
                    height = targetHeight.toUInt(),
                    quality = qualityValue.coerceIn(1, 100).toUByte(),
                    repeat = 0,
                    fast = false,
                    fps = fps.toFloat()
                )
                encodeGif(tempPngPaths, outFile.absolutePath, options, object : GifskiProgressCallback {
                    override fun onProgress(progress: GifskiProgress) {}
                })
                val elapsedMs = System.currentTimeMillis() - startTime
                val bytes = outFile.length()
                cleanupTempFiles(tempPngPaths)
                outFile.delete()

                val ret = JSObject()
                ret.put("bytes", bytes)
                ret.put("elapsedMs", elapsedMs)
                ret.put("sampleSec", sampleSec)
                settle(ret)
            } catch (e: Throwable) {
                cleanupTempFiles(tempPngPaths)
                val ret = JSObject()
                ret.put("bytes", -1)
                ret.put("elapsedMs", -1)
                ret.put("sampleSec", sampleSec)
                settle(ret)
            } finally {
                try { retriever?.release() } catch (_: Exception) {}
            }
        }.start()
    }

    // =========================================================================
    // 4) cancelEncode —— 取消指定任务
    // =========================================================================

    @PluginMethod
    fun cancelEncode(call: PluginCall) {
        val jobId = call.getString("jobId")
        val ret = JSObject()

        if (jobId.isNullOrEmpty()) {
            // 兼容旧调用：取消所有任务
            jobs.values.forEach { it.cancelled.set(true) }
            ret.put("cancelled", true)
            call.resolve(ret)
            return
        }

        val job = jobs[jobId]
        if (job == null) {
            ret.put("cancelled", false)
            call.resolve(ret)
            return
        }

        job.cancelled.set(true)
        ret.put("cancelled", true)
        call.resolve(ret)
    }
}
