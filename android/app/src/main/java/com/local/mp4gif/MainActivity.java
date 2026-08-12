package com.local.mp4gif;

import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import java.security.MessageDigest;

public class MainActivity extends BridgeActivity {

    // Release 正式签名 SHA-256（防反编译重打包：签名不一致视为非官方版本）
    private static final String EXPECTED_RELEASE_CERT_SHA256 =
            "41dbe989b03f7e476a64bf2121c8da9f1b583c3972828d65fcaec6472fdca8be";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Debug 包跳过校验，方便开发测试；Release 包强制校验正式签名
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) == 0) {
            if (!verifyReleaseSignature()) {
                super.onCreate(savedInstanceState);
                showUnauthorizedDialog();
                return;
            }
        }
        registerPlugin(AppBridgePlugin.class);
        registerPlugin(GifskiPlugin.class);
        super.onCreate(savedInstanceState);
    }

    private boolean verifyReleaseSignature() {
        try {
            Signature[] signatures;
            if (android.os.Build.VERSION.SDK_INT >= 28) {
                android.content.pm.SigningInfo info = getPackageManager()
                        .getPackageInfo(getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES)
                        .signingInfo;
                signatures = info != null
                        ? (info.hasMultipleSigners() ? info.getApkContentsSigners() : info.getSigningCertificateHistory())
                        : null;
            } else {
                signatures = getPackageManager()
                        .getPackageInfo(getPackageName(), PackageManager.GET_SIGNATURES)
                        .signatures;
            }
            if (signatures == null) return false;
            for (Signature signature : signatures) {
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                byte[] digest = md.digest(signature.toByteArray());
                StringBuilder sb = new StringBuilder();
                for (byte b : digest) {
                    sb.append(String.format("%02x", b));
                }
                if (EXPECTED_RELEASE_CERT_SHA256.equalsIgnoreCase(sb.toString())) {
                    return true;
                }
            }
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    private void showUnauthorizedDialog() {
        try {
            new android.app.AlertDialog.Builder(this)
                    .setTitle("未授权版本")
                    .setMessage("当前安装包签名与官方版本不一致，可能已被篡改或重新打包。\n请从官方渠道安装。")
                    .setCancelable(false)
                    .setPositiveButton("退出", (dialog, which) -> finish())
                    .show();
        } catch (Exception ignored) {
            finish();
        }
    }
}
