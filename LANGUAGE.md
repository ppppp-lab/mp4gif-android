# 语言文件说明

## 网页 UI 文案唯一文件

所有显示在网页界面上的中文文案都集中在：

`www-backup/i18n.js`

以后要改成英文版，只需要修改这个文件里的 value，例如：

```js
'home.capture.title': 'Record Video',
```

不要修改 key，例如 `home.capture.title` 这类名字。

## 怎么加新文案

1. 在 `www-backup/i18n.js` 里加一个新 key；
2. HTML 静态文字加 `data-i18n="key"`，占位符用 `data-i18n-placeholder`，title 用 `data-i18n-title`；
3. JS 动态文案用 `t('key', { 变量: 值 })`。

## 哪些不要翻译

- MP4、GIF、MB、KB、fps、px、s 等单位
- 文件格式名，如 MOV、AVI、MKV、WEBM、PNG、JPG
- 应用内部 key、包名、文件名

## Android 原生文案

桌面应用名和原生弹窗不在 `i18n.js` 内：

- 桌面应用名：`android/app/src/main/res/values/strings.xml`
- 原生弹窗文案：同文件中的 `unauthorized_*`

未来做英文版时，需要额外创建：

`android/app/src/main/res/values-en/strings.xml`

