package com.local.mp4gif;

import android.app.ActivityManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.MediaStore;
import android.provider.OpenableColumns;

import androidx.activity.result.ActivityResult;
import androidx.annotation.Nullable;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * AppBridgePlugin
 * -----------------------------------------------------------------------------
 * Capacitor 6 插件，向 Web 层提供通用 Android 能力：
 * 文件选择、保存、打开、分享、相机、剪贴板、屏幕常亮、设备内存等。
 *
 * 视频探测与 GIF 转换由 GifskiPlugin 负责。
 */
@CapacitorPlugin(name = "AppBridge")
public class AppBridgePlugin extends Plugin {

    // =========================================================================
    // 1) openVideoDialog —— 视频文件选择
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
     * Gifski 需要真实文件路径，不能直接处理 SAF URI。
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
    // 2) saveGifDialog —— 输出路径选择（SAF ACTION_CREATE_DOCUMENT）
    // =========================================================================

    @PluginMethod
    public void saveGifDialog(PluginCall call) {
        String defaultName = call.getString("defaultName");
        if (defaultName == null || defaultName.isEmpty()) {
            defaultName = "output.gif";
        }

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        String lower = defaultName.toLowerCase();
        if (lower.endsWith(".png")) {
            intent.setType("image/png");
        } else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
            intent.setType("image/jpeg");
        } else if (lower.endsWith(".webp")) {
            intent.setType("image/webp");
        } else {
            if (!lower.endsWith(".gif")) {
                defaultName = defaultName + ".gif";
            }
            intent.setType("image/gif");
        }
        intent.putExtra(Intent.EXTRA_TITLE, defaultName);

        try {
            startActivityForResult(call, intent, "saveGifResult");
        } catch (ActivityNotFoundException e) {
            // 极少数设备不支持 SAF，回退到缓存路径
            int dot = defaultName.lastIndexOf('.');
            String safeName = dot > 0 ? defaultName.substring(0, dot) : defaultName;
            String ext = dot > 0 ? defaultName.substring(dot + 1) : "gif";
            File cacheFile = new File(getCacheDir(), "gif_output_" + safeName + "." + ext);
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
    // 3) openInFolder —— 打开输出文件或所在目录
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
     * - 相对路径（Pictures/MP4转GIF/xxx.gif）：查 MediaStore 获取 content URI
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
        String fileName = path;
        int lastSlash = path.lastIndexOf('/');
        if (lastSlash >= 0) fileName = path.substring(lastSlash + 1);

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
                targetDir = "Movies";
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
    // 4) keepScreenOn / releaseScreenOn —— 导出期间保持屏幕常亮
    // =========================================================================

    @PluginMethod
    public void keepScreenOn(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            getActivity().getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    @PluginMethod
    public void releaseScreenOn(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            getActivity().getWindow().clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
        call.resolve();
    }

    @PluginMethod
    public void exitApp(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            getActivity().finishAffinity();
        });
        call.resolve();
    }

    // =========================================================================
    // 5) openImageDialog —— 图片文件选择（PNG/JPG/WEBP/GIF）
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
    // 6) saveBase64 —— 将 Base64 编码的图片数据保存到文件
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

                if (path.startsWith("content://")) {
                    Uri uri = Uri.parse(path);
                    try (OutputStream os = getContext().getContentResolver().openOutputStream(uri)) {
                        if (os == null) {
                            throw new IOException("无法打开输出流");
                        }
                        os.write(bytes);
                    }
                } else {
                    File outFile = new File(path);
                    File parentDir = outFile.getParentFile();
                    if (parentDir != null && !parentDir.exists()) {
                        parentDir.mkdirs();
                    }

                    try (FileOutputStream fos = new FileOutputStream(outFile)) {
                        fos.write(bytes);
                    }
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
    // 6.5) readFileBase64 —— 读取本地文件并返回 Base64（GIF 解析兜底）
    // =========================================================================

    @PluginMethod
    public void readFileBase64(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("缺少 path 参数");
            return;
        }

        new Thread(() -> {
            try {
                byte[] bytes;
                if (path.startsWith("content://")) {
                    try (InputStream is = getContext().getContentResolver().openInputStream(Uri.parse(path));
                         ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
                        if (is == null) throw new IOException("无法打开输入流");
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                        bytes = bos.toByteArray();
                    }
                } else {
                    try (InputStream is = new FileInputStream(new File(path));
                         ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
                        byte[] buf = new byte[8192];
                        int n;
                        while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                        bytes = bos.toByteArray();
                    }
                }

                JSObject ret = new JSObject();
                ret.put("base64", android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP));
                call.resolve(ret);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? "读取文件失败" : e.getMessage());
            }
        }).start();
    }

    // =========================================================================
    // 7) getMemeSharePath —— 获取表情包分享临时路径
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

        File shareDir = new File(getCacheDir(), "meme_share");
        if (!shareDir.exists()) shareDir.mkdirs();
        File shareFile = new File(shareDir, name);

        JSObject ret = new JSObject();
        ret.put("path", shareFile.getAbsolutePath());
        call.resolve(ret);
    }

    // =========================================================================
    // 8) shareImage —— 通过 Intent 分享图片到其他应用
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

            Uri shareUri = FileProvider.getUriForFile(
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
    // 9) openCamera —— 调用系统相机拍照
    // =========================================================================

    @PluginMethod
    public void openCamera(PluginCall call) {
        try {
            Intent intent = new Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE);
            if (intent.resolveActivity(getContext().getPackageManager()) != null) {
                // 创建临时文件存储拍照结果
                File photoFile = new File(getCacheDir(), "camera_photo_" + System.currentTimeMillis() + ".jpg");
                Uri photoUri = FileProvider.getUriForFile(
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
            Arrays.sort(photoFiles, (a, b) -> Long.compare(b.lastModified(), a.lastModified()));
            JSArray paths = new JSArray();
            paths.put(photoFiles[0].getAbsolutePath());
            call.resolve(makePathsResult(paths));
        } else {
            call.resolve(makePathsResult(null));
        }
    }

    // =========================================================================
    // 9.5) openVideoCamera —— 调用系统相机录制视频
    // =========================================================================

    @PluginMethod
    public void openVideoCamera(PluginCall call) {
        int durationLimit = call.getInt("durationLimit", 60);
        try {
            Intent intent = new Intent(android.provider.MediaStore.ACTION_VIDEO_CAPTURE);
            if (intent.resolveActivity(getContext().getPackageManager()) != null) {
                intent.putExtra(android.provider.MediaStore.EXTRA_DURATION_LIMIT, durationLimit);
                intent.putExtra(android.provider.MediaStore.EXTRA_VIDEO_QUALITY, 1);
                call.setKeepAlive(true);
                startActivityForResult(call, intent, "onVideoCameraResult");
            } else {
                call.resolve(makePathsResult(null));
            }
        } catch (Exception e) {
            call.resolve(makePathsResult(null));
        }
    }

    @ActivityCallback
    private void onVideoCameraResult(PluginCall call, @Nullable ActivityResult result) {
        if (call == null) return;
        if (result == null || result.getResultCode() != android.app.Activity.RESULT_OK || result.getData() == null) {
            call.resolve(makePathsResult(null));
            return;
        }
        Uri uri = result.getData().getData();
        if (uri == null) {
            call.resolve(makePathsResult(null));
            return;
        }
        try {
            String path = copyUriToCache(uri);
            if (path != null) {
                JSArray paths = new JSArray();
                paths.put(path);
                call.resolve(makePathsResult(paths));
            } else {
                call.resolve(makePathsResult(null));
            }
        } catch (IOException e) {
            call.resolve(makePathsResult(null));
        }
    }

    // =========================================================================
    // 10) getClipboardImage —— 读取剪贴板中的图片
    // =========================================================================

    @PluginMethod
    public void getClipboardImage(PluginCall call) {
        try {
            ClipboardManager clipboard = (ClipboardManager)
                    getContext().getSystemService(android.content.Context.CLIPBOARD_SERVICE);
            if (clipboard == null || !clipboard.hasPrimaryClip()) {
                JSObject ret = new JSObject();
                ret.put("path", null);
                call.resolve(ret);
                return;
            }

            ClipData clip = clipboard.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) {
                JSObject ret = new JSObject();
                ret.put("path", null);
                call.resolve(ret);
                return;
            }

            ClipData.Item item = clip.getItemAt(0);
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
    // 11) getDeviceMemory —— 设备内存信息
    // =========================================================================

    @PluginMethod
    public void getDeviceMemory(PluginCall call) {
        try {
            ActivityManager am = (ActivityManager)
                    getContext().getSystemService(android.content.Context.ACTIVITY_SERVICE);
            long totalMB = 2048;  // 保守默认值
            long availMB = 512;

            if (am != null) {
                ActivityManager.MemoryInfo memInfo = new ActivityManager.MemoryInfo();
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
