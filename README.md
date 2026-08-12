# MP4 to GIF Android

Android tool for converting MP4 videos to GIF, built with Capacitor, gifuct-js, and expo-gifski (Gifski engine).

## Structure

- `www/` - web app source (Capacitor web assets)
- `android/` - generated Android project
- `www-backup/` - backup of the web app
- `PROJECT_REPORT.md`, `BUGS.md` - project notes

## Build

```powershell
npm install
npx cap sync android
cd android
.\gradlew assembleRelease
```

Release signing is configured in `android/gradle.properties`. The keystore file and real passwords are kept out of version control; a fresh clone needs to supply `release-keystore.jks` and valid signing credentials locally.

## Web 资源加固

- `www-backup/` 保存可读源码，`www/` 是混淆压缩后的产物。
- 修改前端逻辑后先改 `www-backup/` 里的源码，再运行 `npm run build:www`，最后 `npx cap sync android`。
- Release 包启动时会校验正式签名，签名不一致（被解包重打包）会直接拦截退出。

## License

MIT
