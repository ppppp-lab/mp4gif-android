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

## License

MIT
