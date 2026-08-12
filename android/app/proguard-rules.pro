# ===== R8/ProGuard 保留规则 =====

# --- Capacitor 框架（插件通过反射注册） ---
-keep class com.getcapacitor.** { *; }
-dontwarn com.getcapacitor.**

# --- 项目自身插件（Capacitor @CapacitorPlugin 注解通过反射发现） ---
-keep class com.local.mp4gif.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }

# --- JNA（Gifski 通过 JNA 调用 Rust FFI，反射加载 native 库） ---
-keep class com.sun.jna.** { *; }
-dontwarn com.sun.jna.**
-keepclassmembers class * extends com.sun.jna.** { *; }

# --- uniffi generated classes（gifski Rust 绑定，JNA Structure 反射读取字段顺序） ---
-keep class uniffi.expo_gifski.** { *; }
-dontwarn uniffi.expo_gifski.**

# --- 所有 JNA Structure 子类：保留字段名和 getFieldOrder 方法（R8 混淆会破坏反射） ---
-keepclassmembers class * extends com.sun.jna.Structure {
    <fields>;
    public java.util.List getFieldOrder();
}
-keepclassmembers class * extends com.sun.jna.Structure {
    public <init>(...);
}

# --- Expo Gifski 插件 ---
-keep class expo.modules.gifski.** { *; }
-dontwarn expo.modules.gifski.**

# --- 所有 native 方法 ---
-keepclasseswithmembernames class * { native <methods>; }

# --- WebView JavaScript 接口 ---
-keepclassmembers class * { @android.webkit.JavascriptInterface <methods>; }

# --- Cordova 插件（Capacitor 兼容层） ---
-keep class org.apache.cordova.** { *; }
-dontwarn org.apache.cordova.**

# --- 保留注解（R8 默认会剥离，但 Capacitor 依赖运行时注解） ---
-keepattributes RuntimeVisibleAnnotations,RuntimeInvisibleAnnotations,AnnotationDefault

# --- AndroidX 保留（大部分已被 R8 规则覆盖，保险起见） ---
-dontwarn androidx.**
