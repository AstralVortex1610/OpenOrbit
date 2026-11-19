#!/bin/bash
# Builds and signs OrbitRemote-<version>.apk straight from the Android SDK tools (aapt2, javac, d8,
# zipalign, apksigner) without Gradle. Android Studio / Gradle users can open remote/android instead.
#   remote/tools/build-apk.sh [out.apk]
# Env: ANDROID_HOME (SDK with platforms/android-35+ and build-tools 35), AAPT2 (override aapt2, e.g. a qemu wrapper on ARM),
#      ORBIT_KS / ORBIT_KS_PASS / ORBIT_KEY_ALIAS (release keystore; without them a local debug key is made in remote/keystore/).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"; ROOT="$(cd "$HERE/.." && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
BT="$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)"
PLAT="$(ls -d "$SDK"/platforms/android-* | sort -V | tail -1)/android.jar"
AAPT2="${AAPT2:-$BT/aapt2}"
VER=0.1.0
OUT="${1:-$ROOT/dist-remote/OrbitRemote-$VER.apk}"
APP="$HERE/android/app/src/main"
W="$HERE/android/app/build/manual"; rm -rf "$W"; mkdir -p "$W/classes" "$W/gen" "$W/dex"
node "$HERE/build.js" "$APP/assets/www"
"$AAPT2" compile --dir "$APP/res" -o "$W/res.zip"
"$AAPT2" link -I "$PLAT" --manifest "$APP/AndroidManifest.xml" -A "$APP/assets" --java "$W/gen" \
  --min-sdk-version 29 --target-sdk-version 35 --version-code 1 --version-name "$VER" -o "$W/base.apk" "$W/res.zip"
javac -nowarn -Xlint:-options -source 11 -target 11 -encoding UTF-8 -classpath "$PLAT" -d "$W/classes" $(find "$APP/java" "$W/gen" -name '*.java')
java -cp "$BT/lib/d8.jar" com.android.tools.r8.D8 --release --min-api 29 --lib "$PLAT" --output "$W/dex" $(find "$W/classes" -name '*.class')
cp "$W/base.apk" "$W/unsigned.apk"; (cd "$W/dex" && zip -q -X "$W/unsigned.apk" classes.dex)
zipalign -p -f 4 "$W/unsigned.apk" "$W/aligned.apk"
if [ -n "${ORBIT_KS:-}" ]; then KS="$ORBIT_KS"; PASS="$ORBIT_KS_PASS"; ALIAS="${ORBIT_KEY_ALIAS:-orbit-remote}"
else KS="$HERE/keystore/orbit-remote-debug.jks"; PASS="android"; ALIAS="orbit-remote-debug"
  if [ ! -f "$KS" ]; then mkdir -p "$(dirname "$KS")"; keytool -genkeypair -keystore "$KS" -storepass "$PASS" -keypass "$PASS" -alias "$ALIAS" -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Orbit Remote Debug" >/dev/null 2>&1; fi
fi
mkdir -p "$(dirname "$OUT")"
apksigner sign --v4-signing-enabled false --ks "$KS" --ks-pass "pass:$PASS" --ks-key-alias "$ALIAS" --out "$OUT" "$W/aligned.apk"
apksigner verify --print-certs "$OUT" | head -3
echo "APK: $OUT ($(du -h "$OUT" | cut -f1))"
