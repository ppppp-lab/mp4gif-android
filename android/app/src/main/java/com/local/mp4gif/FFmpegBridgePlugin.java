package com.local.mp4gif;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;

import androidx.activity.result.ActivityResult;
import androidx.annotation.Nullable;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.arthenica.ffmpegkit.FFmpegKit;
import com.arthenica.ffmpegkit.FFmpegKitConfig;
import com.arthenica.ffmpegkit.FFmpegSession;
import com.arthenica.ffmpegkit.FFprobeKit;
import com.arthenica.ffmpegkit.Log;
import com.arthenica.ffmpegkit.MediaInformation;
import com.arthenica.ffmpegkit.MediaInformationSession;
import com.arthenica.ffmpegkit.ReturnCode;
import com.arthenica.ffmpegkit.Statistics;
import com.arthenica.ffmpegkit.StreamInformation;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * FFmpegBridgePlugin
 * -----------------------------------------------------------------------------
 * Capacitor 6 插件，将 Web 层与 ffmpeg-kit + Android 文件系统桥接起来。
 * 对标桌面 Electron 版 preload.js 中暴露的 window.api 接口。
 *
 * 暴露方法（与桌面 window.api 一一对应）：
 *   - ffmpegCheck()        → {available: bool, version: string}
 *   - probeVideo(path)     → {width, height, duration, fps, sizeBytes}
 *   - openVideoDialog(multi) → {paths: string[] | null}
 *   - saveGifDialog(name)  → {path: string}
 *   - startConversion(params) → {jobId: string}
 *   - cancelConversion(jobId) → {cancelled: bool}
 *   - openInFolder(path)   → {success: bool}
 *
 * 事件（通过 notifyListeners 推送）：
 *   - conv:log       → {stream: "stdout"|"stderr", line: string}
 *   - conv:progress  → {percent: double, timeSec: double}
 *   - conv:done      → {outputPath: string}   （公共 Movies 路径）
 *   - conv:error     → {kind: string, message: string, raw: string}
 */
@CapacitorPlugin(name = "FFmpegBridge")
public class FFmpegBridgePlugin extends Plugin {

    /** 进度事件最小间隔（毫秒），与桌面版 PROGRESS_THROTTLE_MS 一致 */
    private static final long PROGRESS_THROTTLE_MS = 500L;

    // =========================================================================
    // 任务状态
    // =========================================================================

    /**
     * 单个转换任务的可变状态。
     * 使用 volatile 保护单字段的可见性；复合操作由 ConcurrentHashMap 保证键级别安全。
     */
    private static final class JobState {
        final String jobId;
        volatile FFmpegSession session;     // 当前正在执行的 FFmpegSession（用于取消）
        volatile boolean cancelled;         // 用户是否已取消
        volatile String palettePath;        // 调色板临时文件路径
        volatile double durationSec;        // 本任务目标时长（endSec - startSec）
        volatile int totalSteps;            // 总步数：1（单步）或 2（调色板）
        volatile int currentStep;           // 当前步序号（0 基）
        volatile long lastProgressAt;       // 上次进度事件时间戳
        volatile Uri saveUri;               // 用户通过 SAF 选择的保存 URI（可能为 null）
        volatile String inputPath;          // 输入文件路径（用于完成后清理缓存）

        JobState(String jobId) {
            this.jobId = jobId;
        }
    }

    /** 全局任务表：jobId → JobState */
    private final Map<String, JobState> jobs = new ConcurrentHashMap<>();

    // =========================================================================
    // 生命周期
    // =========================================================================

    @Override
    public void load() {
        // 确保日志/统计重定向已开启（默认即为开启，此处为兜底）
        try {
            FFmpegKitConfig.enableRedirection();
        } catch (Throwable ignored) {
            // 忽略：部分版本/环境下可能已初始化
        }
    }

    // =========================================================================
    // 1) ffmpegCheck —— FFmpeg 可用性检测
    // =========================================================================

    @PluginMethod
    public void ffmpegCheck(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            String version = FFmpegKitConfig.getVersion();
            ret.put("available", true);
            ret.put("version", version != null ? version : "");
        } catch (Throwable t) {
            ret.put("available", false);
            ret.put("version", "");
        }
        call.resolve(ret);
    }

    // =========================================================================
    // 2) probeVideo —— 视频元数据探测
    // =========================================================================

    @PluginMethod
    public void probeVideo(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("未提供文件路径");
            return;
        }

        File f = new File(path);
        if (!f.exists()) {
            call.reject("文件不存在: " + path);
            return;
        }

        try {
            MediaInformationSession session = FFprobeKit.getMediaInformation(path);
            if (session == null) {
                call.reject("无法解析视频信息，文件可能损坏或不是支持的视频格式。");
                return;
            }
            ReturnCode rc = session.getReturnCode();
            if (rc == null || !ReturnCode.isSuccess(rc)) {
                call.reject("无法解析视频信息，文件可能损坏或不是支持的视频格式。");
                return;
            }

            MediaInformation info = session.getMediaInformation();
            if (info == null) {
                call.reject("无法解析视频信息");
                return;
            }

            JSObject ret = new JSObject();

            // 时长：MediaInformation.getDuration() 返回秒数字符串
            double duration = 0;
            String durStr = info.getDuration();
            if (durStr != null && !durStr.isEmpty()) {
                try {
                    duration = Double.parseDouble(durStr);
                } catch (NumberFormatException ignored) {
                }
            }
            ret.put("duration", duration);

            // 从视频流取宽高/帧率
            int width = 0, height = 0;
            double fps = 0;
            List<StreamInformation> streams = info.getStreams();
            if (streams != null) {
                for (StreamInformation s : streams) {
                    if (s == null) continue;
                    String type = s.getType();
                    if ("video".equalsIgnoreCase(type)) {
                        Long w = s.getWidth();
                        Long h = s.getHeight();
                        if (w != null) width = w.intValue();
                        if (h != null) height = h.intValue();
                        String fpsStr = s.getAverageFrameRate();
                        fps = parseFps(fpsStr);
                        break;
                    }
                }
            }
            ret.put("width", width);
            ret.put("height", height);
            ret.put("fps", fps);

            // 文件体积
            ret.put("sizeBytes", f.length());

            call.resolve(ret);
        } catch (Throwable t) {
            call.reject("探测失败: " + t.getMessage());
        }
    }

    /**
     * 解析 ffprobe 返回的帧率字符串，如 "30000/1001"、"30/1"、"29.97"。
     */
    private static double parseFps(String s) {
        if (s == null || s.isEmpty()) return 0;
        try {
            int slash = s.indexOf('/');
            if (slash >= 0) {
                double num = Double.parseDouble(s.substring(0, slash).trim());
                double den = Double.parseDouble(s.substring(slash + 1).trim());
                if (den == 0) return 0;
                return num / den;
            }
            return Double.parseDouble(s.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    // =========================================================================
    // 3) openVideoDialog —— 文件选择
    // =========================================================================

    @PluginMethod
    public void openVideoDialog(PluginCall call) {
        Boolean multiBoxed = call.getBoolean("multi", false);
        boolean multi = multiBoxed != null && multiBoxed;

        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("video/*");
        if (multi) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }

        call.setKeepAlive(true);
        startActivityForResult(call, intent, "onVideoPicked");
    }

    @ActivityCallback
    private void onVideoPicked(PluginCall call, @Nullable ActivityResult result) {
        if (call == null) {
            return;
        }
        if (result == null) {
            call.resolve(makePathsResult(null));
            return;
        }
        int resultCode = result.getResultCode();
        Intent data = result.getData();
        if (resultCode != android.app.Activity.RESULT_OK || data == null) {
            call.resolve(makePathsResult(null));
            return;
        }

        List<Uri> uris = new ArrayList<>();
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
        } else {
            Uri u = data.getData();
            if (u != null) uris.add(u);
        }

        if (uris.isEmpty()) {
            call.resolve(makePathsResult(null));
            return;
        }

        JSArray paths = new JSArray();
        for (Uri uri : uris) {
            try {
                String p = copyUriToCache(uri);
                if (p != null) paths.put(p);
            } catch (IOException e) {
                // 单个文件复制失败，跳过
            }
        }

        if (paths.length() == 0) {
            call.resolve(makePathsResult(null));
            return;
        }
        call.resolve(makePathsResult(paths));
    }

    private JSObject makePathsResult(JSArray paths) {
        JSObject ret = new JSObject();
        ret.put("paths", paths);
        return ret;
    }

    /**
     * 将 content:// URI 指向的内容复制到应用缓存目录，返回缓存文件绝对路径。
     * FFmpegKit 需要真实文件路径，不能直接处理 SAF URI。
     */
    private String copyUriToCache(Uri uri) throws IOException {
        String ext = guessExtension(uri);
        File out = new File(getCacheDir(), "input_" + System.currentTimeMillis() + "." + ext);
        ContentResolver cr = getContext().getContentResolver();
        try (InputStream is = cr.openInputStream(uri);
             FileOutputStream fos = new FileOutputStream(out)) {
            if (is == null) throw new IOException("无法打开输入流: " + uri);
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) > 0) {
                fos.write(buf, 0, n);
            }
        }
        return out.getAbsolutePath();
    }

    /**
     * 从 URI 推断文件扩展名：先查 DISPLAY_NAME，再退到 MIME 类型。
     */
    private String guessExtension(Uri uri) {
        String ext = "mp4";
        ContentResolver cr = getContext().getContentResolver();
        Cursor c = null;
        try {
            c = cr.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) {
                    String name = c.getString(idx);
                    if (name != null) {
                        int dot = name.lastIndexOf('.');
                        if (dot >= 0 && dot < name.length() - 1) {
                            String candidate = name.substring(dot + 1).toLowerCase();
                            if (!candidate.isEmpty() && candidate.length() <= 5) {
                                ext = candidate;
                            }
                        }
                    }
                }
            }
        } finally {
            if (c != null) c.close();
        }
        // MIME 兜底
        if (ext.isEmpty()) {
            String mime = cr.getType(uri);
            if (mime != null) {
                int slash = mime.indexOf('/');
                if (slash >= 0 && slash < mime.length() - 1) {
                    ext = mime.substring(slash + 1).toLowerCase();
                    if ("x-matroska".equals(ext)) ext = "mkv";
                    else if ("quicktime".equals(ext)) ext = "mov";
                    else if ("msvideo".equals(ext)) ext = "avi";
                    else if ("webm".equals(ext) || "mp4".equals(ext) || "mp2t".equals(ext)) {
                        // keep
                    } else if (ext.length() > 5) {
                        ext = "mp4";
                    }
                }
            }
        }
        return ext;
    }

    private File getCacheDir() {
        return getContext().getCacheDir();
    }

    // =========================================================================
    // 4) saveGifDialog —— 输出路径选择（SAF ACTION_CREATE_DOCUMENT）
    // =========================================================================

    @PluginMethod
    public void saveGifDialog(PluginCall call) {
        String defaultName = call.getString("defaultName");
        if (defaultName == null || defaultName.isEmpty()) {
            defaultName = "output.gif";
        }
        // 确保 .gif 后缀
        if (!defaultName.toLowerCase().endsWith(".gif")) {
            defaultName = defaultName + ".gif";
        }

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/gif");
        intent.putExtra(Intent.EXTRA_TITLE, defaultName);

        try {
            startActivityForResult(call, intent, "saveGifResult");
        } catch (ActivityNotFoundException e) {
            // 极少数设备不支持 SAF，回退到缓存路径
            String safeName = defaultName.replaceAll("(?i)\\.gif$", "");
            File cacheFile = new File(getCacheDir(), "gif_output_" + safeName + ".gif");
            JSObject ret = new JSObject();
            ret.put("path", cacheFile.getAbsolutePath());
            call.resolve(ret);
        }
    }

    @ActivityCallback
    private void saveGifResult(PluginCall call, @Nullable ActivityResult result) {
        if (call == null) return;
        // result 可能为 null（极少数情况下系统未返回结果），需保护
        if (result == null) {
            call.resolve(new JSObject().put("path", null));
            return;
        }
        if (result.getResultCode() == android.app.Activity.RESULT_OK && result.getData() != null) {
            Uri uri = result.getData().getData();
            if (uri != null) {
                JSObject ret = new JSObject();
                ret.put("path", uri.toString());
                call.resolve(ret);
                return;
            }
        }
        // 用户取消
        call.resolve(new JSObject().put("path", null));
    }

    // =========================================================================
    // 5) startConversion —— 启动转换（核心）
    // =========================================================================

    @PluginMethod
    public void startConversion(PluginCall call) {
        String inputPath = call.getString("inputPath");
        String outputPath = call.getString("outputPath");
        if (inputPath == null || inputPath.isEmpty()) {
            call.reject("缺少 inputPath 参数");
            return;
        }

        Double startSecBox = call.getDouble("startSec", 0.0);
        Double endSecBox = call.getDouble("endSec", 0.0);
        Integer widthBox = call.getInt("width", 320);
        Integer heightBox = call.getInt("height", 0);
        Integer fpsBox = call.getInt("fps", 15);
        Integer loopBox = call.getInt("loop", 0);
        Boolean paletteBox = call.getBoolean("palette", false);
        String quality = call.getString("quality", "balanced");

        double startSec = startSecBox != null ? startSecBox : 0.0;
        double endSec = endSecBox != null ? endSecBox : 0.0;
        int width = widthBox != null ? widthBox : 320;
        int height = heightBox != null ? heightBox : 0;
        int fps = fpsBox != null ? fpsBox : 15;
        int loop = loopBox != null ? loopBox : 0;
        boolean palette = paletteBox != null && paletteBox;
        boolean smaller = "smaller".equals(quality);

        // 生成 jobId
        String jobId = System.currentTimeMillis() + "-" + Long.toHexString((long) (Math.random() * 0xFFFFFF));
        JobState job = new JobState(jobId);
        job.durationSec = Math.max(0.001, endSec - startSec);
        job.inputPath = inputPath;  // 记录输入路径，完成后清理缓存

        // 判断 outputPath 是 SAF URI (content://) 还是文件路径
        String cacheOutputPath;
        if (outputPath != null && outputPath.startsWith("content://")) {
            // SAF URI：FFmpeg 不能写 content:// 路径，输出到缓存文件，完成后复制到 SAF URI
            job.saveUri = Uri.parse(outputPath);
            String defaultName = call.getString("defaultName", "output.gif");
            String safeName = defaultName.replaceAll("[^a-zA-Z0-9_.-]", "_");
            cacheOutputPath = new File(getCacheDir(), "gif_output_" + safeName).getAbsolutePath();
        } else if (outputPath != null && outputPath.startsWith("/")) {
            // 绝对路径：直接使用
            cacheOutputPath = outputPath;
        } else {
            // 其他情况（如纯文件名）：映射到缓存
            String defaultName = call.getString("defaultName", "output.gif");
            if (!defaultName.toLowerCase().endsWith(".gif")) {
                defaultName = defaultName + ".gif";
            }
            String safeName = defaultName.replaceAll("[^a-zA-Z0-9_.-]", "_");
            cacheOutputPath = new File(getCacheDir(), "gif_output_" + safeName).getAbsolutePath();
        }

        jobs.put(jobId, job);

        // 立即返回 jobId，转换在后台异步进行
        JSObject ret = new JSObject();
        ret.put("jobId", jobId);
        call.resolve(ret);

        // 启动异步转换（FFmpeg 输出到缓存路径）
        runConversion(job, inputPath, cacheOutputPath, startSec, endSec, width, height, fps, loop, palette, smaller);
    }

    // =========================================================================
    // 转换主流程
    // =========================================================================

    private void runConversion(JobState job, String inputPath, String outputPath,
                               double startSec, double endSec,
                               int width, int height, int fps, int loop,
                               boolean palette, boolean smaller) {
        if (palette) {
            // —— 两步调色板流程 ——
            job.totalSteps = 2;
            job.currentStep = 0;
            job.palettePath = new File(getCacheDir(), "palette_" + job.jobId + ".png").getAbsolutePath();

            emitLog(job, "stdout", "[1/2] 生成调色板…");

            String cmd1 = buildPaletteGenCommand(inputPath, job.palettePath,
                    startSec, endSec, width, height, fps, smaller);

            FFmpegSession session1 = FFmpegKit.executeAsync(cmd1,
                    s1 -> onStepComplete(job, s1, 0, () -> {
                        if (job.cancelled) {
                            cleanupJob(job);
                            return;
                        }
                        // 第2步：用调色板编码 GIF
                        emitLog(job, "stdout", "[2/2] 编码 GIF…");
                        job.currentStep = 1;
                        String cmd2 = buildPaletteUseCommand(inputPath, job.palettePath, outputPath,
                                startSec, endSec, width, height, fps, loop, smaller);
                        FFmpegSession session2 = FFmpegKit.executeAsync(cmd2,
                                s2 -> onStepComplete(job, s2, 1, () -> finalizeConversion(job, outputPath)),
                                log -> onLog(job, log),
                                stats -> onStats(job, stats)
                        );
                        job.session = session2;
                    }),
                    log -> onLog(job, log),
                    stats -> onStats(job, stats)
            );
            job.session = session1;
        } else {
            // —— 单步流程 ——
            job.totalSteps = 1;
            job.currentStep = 0;

            emitLog(job, "stdout", "开始编码 GIF…");

            String cmd = buildSimpleCommand(inputPath, outputPath,
                    startSec, endSec, width, height, fps, loop);

            FFmpegSession session = FFmpegKit.executeAsync(cmd,
                    s -> onStepComplete(job, s, 0, () -> finalizeConversion(job, outputPath)),
                    log -> onLog(job, log),
                    stats -> onStats(job, stats)
            );
            job.session = session;
        }
    }

    // =========================================================================
    // FFmpeg 命令构造（与桌面 main.js 完全一致）
    // =========================================================================

    /**
     * 单步（不开调色板）命令。
     *   -y -ss <start> -to <end> -i "<input>" -vf scale=<w>:<h>:flags=lanczos,fps=<fps>
     *      -threads 0 -loop <loop> "<out>"
     * height <= 0 时使用 scale=<w>:-1 保持宽高比。
     * -threads 0 自动匹配 CPU 核心数，充分利用多核。
     */
    private static String buildSimpleCommand(String inputPath, String outputPath,
                                             double startSec, double endSec,
                                             int width, int height, int fps, int loop) {
        String scale = height <= 0
                ? "scale=" + width + ":-1:flags=lanczos"
                : "scale=" + width + ":" + height + ":flags=lanczos";
        return "-y" +
                " -ss " + fmt(startSec) +
                " -to " + fmt(endSec) +
                " -i " + quote(inputPath) +
                " -vf " + scale + ",fps=" + fps +
                " -threads 0" +
                " -loop " + loop +
                " " + quote(outputPath);
    }

    /**
     * 调色板第1步：生成 palette PNG。
     *   -y -ss <start> -to <end> -i "<input>"
     *      -vf fps=8,scale=<w>:<h>:flags=lanczos,palettegen=stats_mode=full:reserve_transparent=0[:max_colors=128] "<palette>"
     *
     * 优化：
     *  - fps=8 降采样：调色板统计不需要每帧，8fps 采样足够准确，生成速度提升 30-50%
     *  - flags=lanczos：缩放质量优于默认 bicubic
     *  - -threads 0：自动多线程
     */
    private static String buildPaletteGenCommand(String inputPath, String palettePath,
                                                 double startSec, double endSec,
                                                 int width, int height, int fps, boolean smaller) {
        String scale = height <= 0
                ? "scale=" + width + ":-1:flags=lanczos"
                : "scale=" + width + ":" + height + ":flags=lanczos";
        String palettegen = smaller
                ? "palettegen=stats_mode=full:reserve_transparent=0:max_colors=128"
                : "palettegen=stats_mode=full:reserve_transparent=0";
        return "-y" +
                " -ss " + fmt(startSec) +
                " -to " + fmt(endSec) +
                " -i " + quote(inputPath) +
                " -vf fps=8," + scale + "," + palettegen +
                " -threads 0" +
                " " + quote(palettePath);
    }

    /**
     * 调色板第2步：用 palette 编码 GIF。
     *   -y -ss <start> -to <end> -i "<input>" -i "<palette>"
     *      -filter_complex fps=<fps>,scale=<w>:<h>:flags=lanczos[x];[x][1:v]paletteuse=dither=<algo>
     *      -threads 0 -loop <loop> "<out>"
     *
     * 优化：
     *  - flags=lanczos：缩小后边缘更锐利
     *  - dither 算法：balanced → sierra2_4a（画质均衡），smaller → floyd_steinberg（限色下更自然）
     *  - -threads 0：自动多线程
     */
    private static String buildPaletteUseCommand(String inputPath, String palettePath, String outputPath,
                                                 double startSec, double endSec,
                                                 int width, int height, int fps, int loop,
                                                 boolean smaller) {
        String scale = height <= 0
                ? width + ":-1:flags=lanczos"
                : width + ":" + height + ":flags=lanczos";
        String dither = smaller ? "floyd_steinberg" : "sierra2_4a";
        String filterComplex = "fps=" + fps + ",scale=" + scale + "[x];[x][1:v]paletteuse=dither=" + dither;
        return "-y" +
                " -ss " + fmt(startSec) +
                " -to " + fmt(endSec) +
                " -i " + quote(inputPath) +
                " -i " + quote(palettePath) +
                " -filter_complex " + quote(filterComplex) +
                " -threads 0" +
                " -loop " + loop +
                " " + quote(outputPath);
    }

    /** 将路径/参数用双引号包裹，FFmpegKit 命令解析器支持双引号分组 */
    private static String quote(String s) {
        return "\"" + s + "\"";
    }

    /** 格式化数字：整数值去掉小数点（2.0 → "2"，1.5 → "1.5"） */
    private static String fmt(double d) {
        if (d == Math.floor(d) && !Double.isInfinite(d)) {
            return String.valueOf((long) d);
        }
        return String.valueOf(d);
    }

    // =========================================================================
    // 回调处理
    // =========================================================================

    /**
     * 单步执行完成回调。
     * - 取消 → 静默清理
     * - 成功 → 强制发送本步最大进度，然后执行 onSuccess（启动下一步或收尾）
     * - 失败 → 分类错误并发送 conv:error
     */
    private void onStepComplete(JobState job, FFmpegSession session, int stepIndex, Runnable onSuccess) {
        // 用户已取消：静默
        if (job.cancelled) {
            cleanupJob(job);
            return;
        }

        ReturnCode rc = session.getReturnCode();
        if (rc == null) {
            emitError(job, "generic", "FFmpeg 执行失败（未知返回码）。", "");
            return;
        }

        // 取消返回码：静默
        if (ReturnCode.isCancel(rc)) {
            cleanupJob(job);
            return;
        }

        if (ReturnCode.isSuccess(rc)) {
            // 步骤完成，强制进度到本步上限（调色板15%，合成85%→100%）
            int maxPercent;
            if (job.totalSteps <= 1) {
                maxPercent = 100;
            } else if (stepIndex == 0) {
                maxPercent = 15;
            } else {
                maxPercent = 100;
            }
            emitProgress(job, maxPercent, job.durationSec);
            onSuccess.run();
        } else {
            // 失败：分类错误
            String failStack = session.getFailStackTrace();
            String output = session.getOutput();
            String raw;
            if (failStack != null && !failStack.isEmpty()) {
                raw = failStack;
            } else if (output != null) {
                raw = output;
            } else {
                raw = "";
            }
            JSObject classified = classifyError(raw, rc.getValue());
            emitError(job,
                    classified.getString("kind"),
                    classified.getString("message"),
                    classified.getString("raw"));
        }
    }

    /**
     * 日志回调：逐行转发到 Web 层。
     * FFmpeg 的信息输出（含进度行）走 stderr，故统一标记为 "stderr"。
     */
    private void onLog(JobState job, Log log) {
        if (job.cancelled) return;
        String msg = log.getMessage();
        if (msg == null) return;
        String trimmed = msg.trim();
        if (trimmed.isEmpty()) return;
        emitLog(job, "stderr", trimmed);
    }

    /**
     * 统计回调：解析当前处理时间，计算进度百分比。
     * - stats.getTime() 返回毫秒，除以 1000 得到秒
     * - 两步流程：调色板生成约占总耗时 15%，GIF 合成约占 85%
     *   第0步映射到 0~15%，第1步映射到 15~100%
     * - 节流：500ms 最小间隔，但 >= 99.5% 时强制发送
     */
    private void onStats(JobState job, Statistics stats) {
        if (job.cancelled) return;

        double timeSec = stats.getTime() / 1000.0;
        double denom = Math.max(0.001, job.durationSec);
        double rawPercent = (timeSec / denom) * 100;
        if (rawPercent < 0) rawPercent = 0;
        if (rawPercent > 100) rawPercent = 100;

        double percent;
        if (job.totalSteps <= 1) {
            percent = rawPercent;
        } else {
            // 两步加权：调色板约占 15%，合成约占 85%
            if (job.currentStep == 0) {
                // 第0步：0% → 15%
                percent = rawPercent * 0.15;
            } else {
                // 第1步：15% → 100%
                percent = 15.0 + rawPercent * 0.85;
            }
        }
        if (percent > 100) percent = 100;

        long now = System.currentTimeMillis();
        if (now - job.lastProgressAt >= PROGRESS_THROTTLE_MS || percent >= 99.5) {
            job.lastProgressAt = now;
            emitProgress(job, percent, timeSec);
        }
    }

    // =========================================================================
    // 转换收尾：复制缓存 GIF 到用户 SAF 选择的路径，发送 conv:done
    // =========================================================================

    private void finalizeConversion(JobState job, String cacheOutputPath) {
        if (job.cancelled) {
            cleanupJob(job);
            return;
        }

        // 清理调色板临时文件
        deleteQuietly(job.palettePath);

        try {
            File cacheFile = new File(cacheOutputPath);
            if (!cacheFile.exists()) {
                emitError(job, "disk", "输出文件不存在，转换可能未完成。", "");
                return;
            }

            // 从缓存文件名提取显示名：gif_output_<name>.gif → <name>.gif
            String displayName = cacheFile.getName();
            if (displayName.startsWith("gif_output_")) {
                displayName = displayName.substring("gif_output_".length());
            }

            // 如果用户通过 saveGifDialog 选了 SAF 路径，复制到那里
            if (job.saveUri != null) {
                copyCacheToUri(cacheFile, job.saveUri);
                cacheFile.delete();

                emitProgress(job, 100, job.durationSec);

                JSObject done = new JSObject();
                done.put("outputPath", job.saveUri.toString());
                notifyListeners("conv:done", done);
                cleanupInputCache(job);
                jobs.remove(job.jobId);
            } else {
                // 没有 SAF URI（saveGifDialog 回退到缓存路径），复制到公共 Movies 目录
                String publicPath = copyToPublicMovies(cacheFile, displayName);
                cacheFile.delete();

                emitProgress(job, 100, job.durationSec);

                JSObject done = new JSObject();
                done.put("outputPath", publicPath);
                notifyListeners("conv:done", done);
                cleanupInputCache(job);
                jobs.remove(job.jobId);
            }
        } catch (Exception e) {
            emitError(job, "disk", "保存 GIF 失败: " + e.getMessage(), String.valueOf(e));
        }
    }

    /**
     * 清理输入缓存文件。
     * openVideoDialog 会将 SAF URI 复制到缓存目录（input_xxx.mp4），
     * 转换完成后应清理，避免长期积累占用存储。
     * 仅清理应用缓存目录下的文件，不删除用户原始文件。
     */
    private void cleanupInputCache(JobState job) {
        if (job.inputPath == null || job.inputPath.isEmpty()) return;
        try {
            File inputFile = new File(job.inputPath);
            File cacheDir = getCacheDir();
            // 仅当输入文件位于应用缓存目录下时才删除（避免误删用户原始文件）
            if (inputFile.getAbsolutePath().startsWith(cacheDir.getAbsolutePath())
                    && inputFile.getName().startsWith("input_")) {
                inputFile.delete();
            }
        } catch (Exception ignored) {
        }
    }

    private void copyCacheToUri(File cacheFile, Uri uri) throws IOException {
        try (InputStream is = new FileInputStream(cacheFile);
             OutputStream os = getContext().getContentResolver().openOutputStream(uri)) {
            if (os == null) throw new IOException("无法打开输出流: " + uri);
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) > 0) {
                os.write(buf, 0, n);
            }
        }
    }

    /**
     * 将缓存文件复制到公共 Movies/MP4转GIF/ 目录。
     * - API 29+：使用 MediaStore 插入条目，写入后清除 IS_PENDING
     * - API 24-28：直接写入 Environment.DIRECTORY_MOVIES/MP4转GIF/
     * 返回公共路径字符串（API 24-28 为绝对路径，29+ 为相对路径）。
     */
    private String copyToPublicMovies(File cacheFile, String displayName) throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            // API 29+：MediaStore
            ContentResolver cr = getContext().getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, displayName);
            values.put(MediaStore.MediaColumns.MIME_TYPE, "image/gif");
            values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/MP4转GIF");
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);

            Uri uri = cr.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values);
            if (uri == null) {
                throw new IOException("无法创建 MediaStore 条目");
            }

            try (InputStream is = new FileInputStream(cacheFile);
                 OutputStream os = cr.openOutputStream(uri)) {
                if (os == null) throw new IOException("无法打开 MediaStore 输出流");
                byte[] buf = new byte[8192];
                int n;
                while ((n = is.read(buf)) > 0) {
                    os.write(buf, 0, n);
                }
            } catch (IOException e) {
                // 写入失败：删除 MediaStore 条目
                try { cr.delete(uri, null, null); } catch (Exception ignored) {}
                throw e;
            }

            // 清除 IS_PENDING，让文件对其他应用可见
            values.clear();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            try {
                cr.update(uri, values, null, null);
            } catch (Exception ignored) {
            }

            // API 29+ 无法获取真实文件路径，返回相对路径供显示
            return Environment.DIRECTORY_MOVIES + "/MP4转GIF/" + displayName;
        } else {
            // API 24-28：直接文件写入
            File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES), "MP4转GIF");
            if (!dir.exists() && !dir.mkdirs()) {
                throw new IOException("无法创建目录: " + dir.getAbsolutePath());
            }
            File target = new File(dir, displayName);
            try (InputStream is = new FileInputStream(cacheFile);
                 FileOutputStream os = new FileOutputStream(target)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = is.read(buf)) > 0) {
                    os.write(buf, 0, n);
                }
            }
            return target.getAbsolutePath();
        }
    }

    // =========================================================================
    // 6) cancelConversion —— 取消转换
    // =========================================================================

    @PluginMethod
    public void cancelConversion(PluginCall call) {
        String jobId = call.getString("jobId");
        JSObject ret = new JSObject();

        if (jobId == null) {
            ret.put("cancelled", false);
            call.resolve(ret);
            return;
        }

        JobState job = jobs.get(jobId);
        if (job == null) {
            ret.put("cancelled", false);
            call.resolve(ret);
            return;
        }

        job.cancelled = true;
        if (job.session != null) {
            try {
                FFmpegKit.cancel(job.session.getSessionId());
            } catch (Throwable ignored) {
            }
        }

        // 清理调色板临时文件
        deleteQuietly(job.palettePath);

        ret.put("cancelled", true);
        call.resolve(ret);
    }

    // =========================================================================
    // 7) openInFolder —— 打开 GIF 文件（用图片查看器）或回退打开所在目录
    // =========================================================================

    @PluginMethod
    public void openInFolder(PluginCall call) {
        String path = call.getString("path");
        JSObject ret = new JSObject();
        try {
            Uri contentUri = resolveContentUri(path);

            if (contentUri != null) {
                // 优先用视频播放器打开 GIF（能播放动画），失败则用图片查看器
                String[] mimeTypes = { "video/*", "image/gif" };
                boolean opened = false;
                for (String mime : mimeTypes) {
                    try {
                        Intent viewIntent = new Intent(Intent.ACTION_VIEW);
                        viewIntent.setDataAndType(contentUri, mime);
                        viewIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        getActivity().startActivity(Intent.createChooser(viewIntent, "查看 GIF"));
                        ret.put("success", true);
                        opened = true;
                        break;
                    } catch (ActivityNotFoundException e) {
                        // 该 MIME 类型没有可处理的应用，尝试下一个
                    }
                }
                if (opened) {
                    call.resolve(ret);
                    return;
                }
            }

            // 回退：尝试用文件管理器打开所在目录
            openDirectoryFallback(path, ret);
        } catch (Exception e) {
            ret.put("success", false);
        }
        call.resolve(ret);
    }

    /**
     * 根据路径解析出可用于 ACTION_VIEW 的 content:// URI。
     * - content:// 开头：直接返回
     * - 绝对路径（/storage/...）：用 FileProvider 包装
     * - 相对路径（Movies/MP4转GIF/xxx.gif）：查 MediaStore 获取 content URI
     */
    private Uri resolveContentUri(String path) {
        if (path == null || path.isEmpty()) return null;

        // SAF / content URI：直接使用
        if (path.startsWith("content://")) {
            return Uri.parse(path);
        }

        // 绝对文件路径：用 FileProvider
        if (path.startsWith("/")) {
            File file = new File(path);
            if (file.exists()) {
                try {
                    String authority = getContext().getPackageName() + ".fileprovider";
                    return FileProvider.getUriForFile(getContext(), authority, file);
                } catch (Exception e) {
                    // FileProvider 失败，回退查询 MediaStore
                }
            }
        }

        // 相对路径或 FileProvider 失败：查 MediaStore
        // 从路径中提取文件名
        String fileName = path;
        int lastSlash = path.lastIndexOf('/');
        if (lastSlash >= 0) fileName = path.substring(lastSlash + 1);

        // 同时查 Images 和 Video 表（Gifski 用 Images，FFmpeg 用 Video）
        Uri[] storeUris = {
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        };
        for (Uri storeUri : storeUris) {
            Cursor cursor = null;
            try {
                cursor = getContext().getContentResolver().query(
                    storeUri,
                    new String[]{ MediaStore.MediaColumns._ID },
                    MediaStore.MediaColumns.DISPLAY_NAME + " = ?",
                    new String[]{ fileName },
                    null
                );
                if (cursor != null && cursor.moveToFirst()) {
                    long id = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID));
                    return Uri.withAppendedPath(storeUri, String.valueOf(id));
                }
            } catch (Exception e) {
                // 查询失败，继续尝试下一个
            } finally {
                if (cursor != null) cursor.close();
            }
        }

        return null;
    }

    /**
     * 回退方案：用文件管理器打开 GIF 所在目录
     */
    private void openDirectoryFallback(String path, JSObject ret) {
        // 推断目录
        String targetDir = "Pictures";  // Gifski 默认保存到 Pictures
        if (path != null) {
            String lower = path.toLowerCase();
            if (lower.contains("movies")) {
                targetDir = "Movies";     // FFmpeg 保存到 Movies
            } else if (lower.contains("download")) {
                targetDir = "Download";
            } else if (lower.contains("dcim")) {
                targetDir = "DCIM";
            }
        }

        // 方案1：用 ACTION_VIEW 打开 DocumentsUI 目录
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.setType("vnd.android.document/directory");
            Uri dirUri = Uri.parse("content://com.android.externalstorage.documents/document/primary%3A" + targetDir);
            intent.setData(dirUri);
            getActivity().startActivity(intent);
            ret.put("success", true);
            return;
        } catch (ActivityNotFoundException e) {
            // DocumentsUI 不可用
        }

        // 方案2：用 Files 包名直接打开
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setPackage("com.google.android.apps.nbu.files");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(intent);
            ret.put("success", true);
            return;
        } catch (Exception e) {
            // Files 应用不可用
        }

        // 方案3：用 ACTION_GET_CONTENT 兜底
        try {
            Intent fallback = new Intent(Intent.ACTION_GET_CONTENT);
            fallback.setType("image/gif");
            fallback.addCategory(Intent.CATEGORY_OPENABLE);
            fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(Intent.createChooser(fallback, "选择 GIF 查看器"));
            ret.put("success", true);
        } catch (Exception e2) {
            ret.put("success", false);
        }
    }

    // =========================================================================
    // 8) benchmark —— 性能校准：编码 1 秒 480×270 12fps GIF 并返回耗时
    // =========================================================================

    /**
     * 在后台线程运行一次小型 GIF 编码，测量实际耗时（秒）。
     * 编码参数：1 秒 480×270 12fps 调色板两步流程（与 estimate.js 基准一致）。
     * 使用 lavfi color 源生成纯色测试视频，无需输入文件。
     * 若 lavfi 不可用（ffmpeg-kit-min 可能不包含），返回 -1 退化为公式估算。
     */
    @PluginMethod
    public void benchmark(PluginCall call) {
        new Thread(() -> {
            try {
                File cacheDir = getCacheDir();
                File testPalette = new File(cacheDir, "bench_palette.png");
                File testGif = new File(cacheDir, "bench_test.gif");
                testPalette.delete();
                testGif.delete();

                long startTime = System.currentTimeMillis();

                // 第1步：palettegen（1 秒 480×270 12fps 纯色视频）
                String cmd1 = "-y -f lavfi -i color=c=black:s=480x270:d=1:r=12" +
                        " -vf \"fps=12,palettegen=stats_mode=full:reserve_transparent=0\"" +
                        " \"" + testPalette.getAbsolutePath() + "\"";

                FFmpegSession s1 = FFmpegKit.execute(cmd1);
                if (s1 == null || !ReturnCode.isSuccess(s1.getReturnCode())) {
                    // lavfi 不可用，返回 -1 退化为公式估算
                    JSObject ret = new JSObject();
                    ret.put("seconds", -1.0);
                    call.resolve(ret);
                    return;
                }

                // 第2步：paletteuse 编码 GIF
                String cmd2 = "-y -f lavfi -i color=c=black:s=480x270:d=1:r=12" +
                        " -i \"" + testPalette.getAbsolutePath() + "\"" +
                        " -filter_complex \"fps=12[x];[x][1:v]paletteuse=dither=sierra2_4a\"" +
                        " \"" + testGif.getAbsolutePath() + "\"";

                FFmpegSession s2 = FFmpegKit.execute(cmd2);
                long elapsed = System.currentTimeMillis() - startTime;

                // 清理临时文件
                testPalette.delete();
                testGif.delete();

                JSObject ret = new JSObject();
                if (s2 != null && ReturnCode.isSuccess(s2.getReturnCode())) {
                    ret.put("seconds", elapsed / 1000.0);
                } else {
                    ret.put("seconds", -1.0);
                }
                call.resolve(ret);
            } catch (Exception e) {
                JSObject ret = new JSObject();
                ret.put("seconds", -1.0);
                call.resolve(ret);
            }
        }).start();
    }

    // =========================================================================
    // 9) probeEstSize —— 采样预估：编码 sampleSec 秒 GIF，返回实际体积 + 耗时
    // =========================================================================

    /**
     * 编码一小段视频（默认 0.5 秒）为 GIF，返回实际文件体积和耗时。
     * JS 端据此线性外推完整视频的预估体积和耗时，消除硬编码系数的误差。
     *
     * @param inputPath  源视频路径
     * @param startSec   采样起始时间
     * @param width      输出宽度
     * @param height     输出高度（-1 等比）
     * @param fps        帧率
     * @param palette    是否启用调色板
     * @param smaller    是否 smaller 质量
     * @param sampleSec  采样时长（秒），默认 0.5
     */
    @PluginMethod
    public void probeEstSize(PluginCall call) {
        String inputPath = call.getString("inputPath");
        double startSec = call.getDouble("startSec", 0.0);
        int width = call.getInt("width", 480);
        int height = call.getInt("height", -1);
        int fps = call.getInt("fps", 12);
        boolean palette = call.getBoolean("palette", true);
        boolean smaller = call.getBoolean("smaller", false);
        double sampleSec = call.getDouble("sampleSec", 0.5);

        new Thread(() -> {
            try {
                File cacheDir = getCacheDir();
                File sampleGif = new File(cacheDir, "size_probe.gif");
                File samplePal = new File(cacheDir, "size_probe_palette.png");
                sampleGif.delete();
                samplePal.delete();

                long startTime = System.currentTimeMillis();
                String scale = height <= 0
                        ? width + ":-1:flags=lanczos"
                        : width + ":" + height + ":flags=lanczos";
                int rc;

                if (palette) {
                    String palettegen = smaller
                            ? "palettegen=stats_mode=full:reserve_transparent=0:max_colors=128"
                            : "palettegen=stats_mode=full:reserve_transparent=0";
                    String dither = smaller ? "floyd_steinberg" : "sierra2_4a";

                    String cmd1 = "-y -ss " + fmt(startSec) + " -t " + fmt(sampleSec)
                            + " -i " + quote(inputPath)
                            + " -vf fps=8," + scale + "," + palettegen
                            + " -threads 0"
                            + " " + quote(samplePal.getAbsolutePath());
                    FFmpegSession s1 = FFmpegKit.execute(cmd1);
                    if (s1 == null || !ReturnCode.isSuccess(s1.getReturnCode())) {
                        samplePal.delete();
                        resolveProbe(call, -1, -1, sampleSec);
                        return;
                    }

                    String cmd2 = "-y -ss " + fmt(startSec) + " -t " + fmt(sampleSec)
                            + " -i " + quote(inputPath)
                            + " -i " + quote(samplePal.getAbsolutePath())
                            + " -filter_complex fps=" + fps + ",scale=" + scale + "[x];[x][1:v]paletteuse=dither=" + dither
                            + " -threads 0"
                            + " " + quote(sampleGif.getAbsolutePath());
                    FFmpegSession s2 = FFmpegKit.execute(cmd2);
                    rc = (s2 != null && ReturnCode.isSuccess(s2.getReturnCode())) ? 0 : -1;
                    samplePal.delete();
                } else {
                    String cmd = "-y -ss " + fmt(startSec) + " -t " + fmt(sampleSec)
                            + " -i " + quote(inputPath)
                            + " -vf " + scale + ",fps=" + fps
                            + " -threads 0"
                            + " " + quote(sampleGif.getAbsolutePath());
                    FFmpegSession s = FFmpegKit.execute(cmd);
                    rc = (s != null && ReturnCode.isSuccess(s.getReturnCode())) ? 0 : -1;
                }

                long elapsed = System.currentTimeMillis() - startTime;
                long fileSize = sampleGif.length();
                sampleGif.delete();

                if (rc == 0 && fileSize > 0) {
                    resolveProbe(call, fileSize, elapsed, sampleSec);
                } else {
                    resolveProbe(call, -1, -1, sampleSec);
                }
            } catch (Exception e) {
                resolveProbe(call, -1, -1, sampleSec);
            }
        }).start();
    }

    private void resolveProbe(PluginCall call, long bytes, long elapsedMs, double sampleSec) {
        JSObject ret = new JSObject();
        ret.put("bytes", bytes);
        ret.put("elapsedMs", elapsedMs);
        ret.put("sampleSec", sampleSec);
        call.resolve(ret);
    }

    // =========================================================================
    // 10) keepScreenOn / releaseScreenOn —— 导出期间保持屏幕常亮
    // =========================================================================

    /**
     * 保持屏幕常亮（导出期间调用）。
     * 使用 FLAG_KEEP_SCREEN_ON，不需要 WAKE_LOCK 权限。
     */
    @PluginMethod
    public void keepScreenOn(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            getActivity().getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    /**
     * 取消屏幕常亮（导出完成/中断后调用）。
     */
    @PluginMethod
    public void releaseScreenOn(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            getActivity().getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    // =========================================================================
    // 11) openImageDialog —— 图片文件选择（PNG/JPG/WEBP/GIF）
    // =========================================================================

    @PluginMethod
    public void openImageDialog(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*");
        // 同时允许选择 GIF
        String[] mimeTypes = {"image/png", "image/jpeg", "image/webp", "image/gif"};
        intent.putExtra(Intent.EXTRA_MIME_TYPES, mimeTypes);

        call.setKeepAlive(true);
        startActivityForResult(call, intent, "onImagePicked");
    }

    @ActivityCallback
    private void onImagePicked(PluginCall call, @Nullable ActivityResult result) {
        if (call == null) return;
        if (result == null) {
            call.resolve(makePathsResult(null));
            return;
        }
        int resultCode = result.getResultCode();
        Intent data = result.getData();
        if (resultCode != android.app.Activity.RESULT_OK || data == null) {
            call.resolve(makePathsResult(null));
            return;
        }

        List<Uri> uris = new ArrayList<>();
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri u = clip.getItemAt(i).getUri();
                if (u != null) uris.add(u);
            }
        } else {
            Uri u = data.getData();
            if (u != null) uris.add(u);
        }

        if (uris.isEmpty()) {
            call.resolve(makePathsResult(null));
            return;
        }

        JSArray paths = new JSArray();
        for (Uri uri : uris) {
            try {
                String p = copyUriToCache(uri);
                if (p != null) paths.put(p);
            } catch (IOException e) {
                // 单个文件复制失败，跳过
            }
        }

        if (paths.length() == 0) {
            call.resolve(makePathsResult(null));
            return;
        }
        call.resolve(makePathsResult(paths));
    }

    // =========================================================================
    // 12) saveBase64 —— 将 Base64 编码的图片数据保存到文件
    // =========================================================================

    @PluginMethod
    public void saveBase64(PluginCall call) {
        String path = call.getString("path");
        String base64 = call.getString("base64");
        if (path == null || path.isEmpty() || base64 == null || base64.isEmpty()) {
            call.reject("缺少 path 或 base64 参数");
            return;
        }

        new Thread(() -> {
            try {
                // 去除 data URL 前缀（如 data:image/png;base64,）
                String data = base64;
                if (data.contains(",")) {
                    data = data.substring(data.indexOf(",") + 1);
                }
                byte[] bytes = android.util.Base64.decode(data, android.util.Base64.DEFAULT);

                File outFile = new File(path);
                File parentDir = outFile.getParentFile();
                if (parentDir != null && !parentDir.exists()) {
                    parentDir.mkdirs();
                }

                try (FileOutputStream fos = new FileOutputStream(outFile)) {
                    fos.write(bytes);
                }

                JSObject ret = new JSObject();
                ret.put("success", true);
                call.resolve(ret);
            } catch (Exception e) {
                JSObject ret = new JSObject();
                ret.put("success", false);
                call.resolve(ret);
            }
        }).start();
    }

    // =========================================================================
    // 13) getMemeSharePath —— 获取表情包分享临时路径
    // =========================================================================

    @PluginMethod
    public void getMemeSharePath(PluginCall call) {
        String name = call.getString("name");
        if (name == null || name.isEmpty()) {
            name = "meme_" + System.currentTimeMillis() + ".png";
        }
        if (!name.toLowerCase().endsWith(".png") && !name.toLowerCase().endsWith(".jpg") && !name.toLowerCase().endsWith(".gif")) {
            name = name + ".png";
        }

        // 使用缓存目录作为分享临时路径
        File shareDir = new File(getCacheDir(), "meme_share");
        if (!shareDir.exists()) shareDir.mkdirs();
        File shareFile = new File(shareDir, name);

        JSObject ret = new JSObject();
        ret.put("path", shareFile.getAbsolutePath());
        call.resolve(ret);
    }

    // =========================================================================
    // 14) shareImage —— 通过 Intent 分享图片到其他应用
    // =========================================================================

    @PluginMethod
    public void shareImage(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("缺少 path 参数");
            return;
        }

        try {
            File file = new File(path);
            if (!file.exists()) {
                JSObject ret = new JSObject();
                ret.put("success", false);
                call.resolve(ret);
                return;
            }

            // 使用 FileProvider 获取 content:// URI
            android.content.ContentResolver cr = getContext().getContentResolver();
            // 直接使用 androidx.core.content.FileProvider
            Uri shareUri = androidx.core.content.FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    file
            );

            Intent shareIntent = new Intent(Intent.ACTION_SEND);
            shareIntent.setType("image/*");
            shareIntent.putExtra(Intent.EXTRA_STREAM, shareUri);
            shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            shareIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

            getActivity().startActivity(Intent.createChooser(shareIntent, "分享表情包").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));

            JSObject ret = new JSObject();
            ret.put("success", true);
            call.resolve(ret);
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("success", false);
            call.resolve(ret);
        }
    }

    // =========================================================================
    // 15) openCamera —— 调用系统相机拍照
    // =========================================================================

    @PluginMethod
    public void openCamera(PluginCall call) {
        try {
            Intent intent = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
            if (intent.resolveActivity(getContext().getPackageManager()) != null) {
                // 创建临时文件存储拍照结果
                File photoFile = new File(getCacheDir(), "camera_photo_" + System.currentTimeMillis() + ".jpg");
                Uri photoUri = androidx.core.content.FileProvider.getUriForFile(
                        getContext(),
                        getContext().getPackageName() + ".fileprovider",
                        photoFile
                );
                intent.putExtra(android.provider.MediaStore.EXTRA_OUTPUT, photoUri);
                intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);

                call.setKeepAlive(true);
                startActivityForResult(call, intent, "onCameraResult");
            } else {
                // 没有相机应用
                call.resolve(makePathsResult(null));
            }
        } catch (Exception e) {
            call.resolve(makePathsResult(null));
        }
    }

    @ActivityCallback
    private void onCameraResult(PluginCall call, @Nullable ActivityResult result) {
        if (call == null) return;
        if (result == null || result.getResultCode() != android.app.Activity.RESULT_OK) {
            call.resolve(makePathsResult(null));
            return;
        }
        // 查找缓存目录中最近的相机照片
        File cacheDir = getCacheDir();
        File[] photoFiles = cacheDir.listFiles((dir, name) -> name.startsWith("camera_photo_") && name.endsWith(".jpg"));
        if (photoFiles != null && photoFiles.length > 0) {
            // 取最新的文件
            java.util.Arrays.sort(photoFiles, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
            JSArray paths = new JSArray();
            paths.put(photoFiles[0].getAbsolutePath());
            call.resolve(makePathsResult(paths));
        } else {
            call.resolve(makePathsResult(null));
        }
    }

    // =========================================================================
    // 16) getClipboardImage —— 读取剪贴板中的图片
    // =========================================================================

    @PluginMethod
    public void getClipboardImage(PluginCall call) {
        try {
            android.content.ClipboardManager clipboard = (android.content.ClipboardManager)
                    getContext().getSystemService(android.content.Context.CLIPBOARD_SERVICE);
            if (clipboard == null || !clipboard.hasPrimaryClip()) {
                JSObject ret = new JSObject();
                ret.put("path", null);
                call.resolve(ret);
                return;
            }

            android.content.ClipData clip = clipboard.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) {
                JSObject ret = new JSObject();
                ret.put("path", null);
                call.resolve(ret);
                return;
            }

            android.content.ClipData.Item item = clip.getItemAt(0);
            Uri uri = item.getUri();
            if (uri != null) {
                // 复制到缓存
                String cachedPath = copyUriToCache(uri);
                JSObject ret = new JSObject();
                ret.put("path", cachedPath);
                call.resolve(ret);
                return;
            }

            // 尝试从 Intent 获取
            Intent intent = item.getIntent();
            if (intent != null) {
                Uri intentUri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (intentUri != null) {
                    String cachedPath = copyUriToCache(intentUri);
                    JSObject ret = new JSObject();
                    ret.put("path", cachedPath);
                    call.resolve(ret);
                    return;
                }
            }

            JSObject ret = new JSObject();
            ret.put("path", null);
            call.resolve(ret);
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("path", null);
            call.resolve(ret);
        }
    }

    // =========================================================================
    // 事件发射辅助方法
    // =========================================================================

    private void emitLog(JobState job, String stream, String line) {
        JSObject data = new JSObject();
        data.put("stream", stream);
        data.put("line", line);
        notifyListeners("conv:log", data);
    }

    private void emitProgress(JobState job, double percent, double timeSec) {
        JSObject data = new JSObject();
        data.put("percent", percent);
        data.put("timeSec", timeSec);
        notifyListeners("conv:progress", data);
    }

    private void emitError(JobState job, String kind, String message, String raw) {
        JSObject data = new JSObject();
        data.put("kind", kind);
        data.put("message", message);
        data.put("raw", raw);
        notifyListeners("conv:error", data);
        jobs.remove(job.jobId);
    }

    // =========================================================================
    // 错误分类（与桌面 classifyError 一致）
    // =========================================================================

    /**
     * 判定 FFmpeg 的失败输出，归类为 conv:error 的 kind。
     * - No such file / Invalid data / not contain any stream / corrupt → source-corrupt
     * - EACCES / EPERM / Permission denied / cannot write / disk full / No space left → disk
     * - 其它 → generic
     */
    private static JSObject classifyError(String raw, int code) {
        String r = raw != null ? raw : "";
        String kind;
        String message;

        if (containsAny(r, "No such file", "Invalid data", "not contain any stream", "corrupt", "could not find")) {
            kind = "source-corrupt";
            message = "源文件损坏、为空或不是支持的视频格式。";
        } else if (containsAny(r, "EACCES", "EPERM", "Permission denied", "cannot write", "disk full", "No space left")) {
            kind = "disk";
            message = "磁盘写入失败或输出路径权限不足。";
        } else {
            kind = "generic";
            message = "FFmpeg 执行失败（返回码 " + code + "）。";
        }

        JSObject ret = new JSObject();
        ret.put("kind", kind);
        ret.put("message", message);
        ret.put("raw", r);
        return ret;
    }

    /** 大小写不敏感地检查 raw 是否包含 needles 中的任意一个 */
    private static boolean containsAny(String raw, String... needles) {
        if (raw == null || raw.isEmpty()) return false;
        String lower = raw.toLowerCase();
        for (String n : needles) {
            if (n != null && lower.contains(n.toLowerCase())) {
                return true;
            }
        }
        return false;
    }

    // =========================================================================
    // 清理辅助
    // =========================================================================

    /** 删除调色板临时文件 + 输入缓存，并从任务表中移除 */
    private void cleanupJob(JobState job) {
        deleteQuietly(job.palettePath);
        cleanupInputCache(job);
        jobs.remove(job.jobId);
    }

    /** 安静删除文件，忽略不存在等错误 */
    private static void deleteQuietly(String path) {
        if (path == null || path.isEmpty()) return;
        try {
            new File(path).delete();
        } catch (Exception ignored) {
        }
    }

    // =========================================================================
    // 设备内存信息
    // =========================================================================

    /**
     * 获取设备总内存和可用内存（MB）。
     * 返回 { totalMB, availMB } 供前端做内存预估保护。
     */
    @PluginMethod
    public void getDeviceMemory(PluginCall call) {
        try {
            android.app.ActivityManager am = (android.app.ActivityManager)
                    getContext().getSystemService(android.content.Context.ACTIVITY_SERVICE);
            long totalMB = 2048;  // 保守默认值
            long availMB = 512;

            if (am != null) {
                // 总RAM
                android.app.ActivityManager.MemoryInfo memInfo = new android.app.ActivityManager.MemoryInfo();
                am.getMemoryInfo(memInfo);
                totalMB = memInfo.totalMem / (1024 * 1024);
                availMB = memInfo.availMem / (1024 * 1024);
            }

            JSObject ret = new JSObject();
            ret.put("totalMB", totalMB);
            ret.put("availMB", availMB);
            call.resolve(ret);
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("totalMB", 2048);
            ret.put("availMB", 512);
            call.resolve(ret);
        }
    }
}
