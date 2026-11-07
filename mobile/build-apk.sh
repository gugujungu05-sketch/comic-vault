#!/usr/bin/env bash
# 漫画库 Android 手机客户端构建脚本
#
# 不使用 Gradle / Android Studio，直接调用 Android SDK build-tools 手工构建：
#   aapt2 (资源编译/链接) -> javac -> d8 -> zip -> zipalign -> apksigner
# 产物为已签名的可安装 APK，源码只是一个 WebView 壳，不存在第三方依赖。
#
# 用法：
#   ANDROID_HOME=/opt/android-sdk bash mobile/build-apk.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/opt/android-sdk}}"
BT="$SDK/build-tools/35.0.0"
PLATFORM="$SDK/platforms/android-35/android.jar"
OUT="$HERE/build"
WORKSPACE="${CV_OUTPUT_DIR:-/workspace}"
APK_NAME="漫画库-Android.apk"
KS="$HERE/comicvault.keystore"
KS_PASS="comicvault"
KS_ALIAS="comicvault"

echo "==> 检查工具链 (SDK: $SDK)"
for t in aapt2 d8 zipalign apksigner; do
    [ -x "$BT/$t" ] || { echo "缺少工具：$BT/$t"; exit 1; }
done
[ -f "$PLATFORM" ] || { echo "缺少平台：$PLATFORM"; exit 1; }
command -v javac >/dev/null || { echo "缺少 javac"; exit 1; }
command -v keytool >/dev/null || { echo "缺少 keytool"; exit 1; }
command -v zip >/dev/null || { echo "缺少 zip"; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/compiled" "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "==> [1/7] 编译资源 (aapt2 compile)"
"$BT/aapt2" compile --dir "$HERE/res" -o "$OUT/compiled/"

echo "==> [2a/7] 打包独立客户端界面到 assets"
mkdir -p "$OUT/assets/app"
cp -f "$HERE/../desktop/app/"*.html "$HERE/../desktop/app/"*.css "$HERE/../desktop/app/"*.js "$OUT/assets/app/"
cp -f "$HERE/assets/android-bridge.js" "$OUT/assets/app/"
python3 - "$OUT/assets/app" <<'PYBRIDGE'
import io, os, sys
d = sys.argv[1]
for name, script in [('index.html', 'app.js'), ('reader.html', 'reader.js')]:
    p = os.path.join(d, name)
    s = io.open(p, encoding='utf-8').read()
    tag = '<script src="%s"></script>' % script
    if 'android-bridge.js' not in s:
        s = s.replace(tag, '<script src="android-bridge.js"></script>\n  ' + tag)
    io.open(p, 'w', encoding='utf-8').write(s)
print('本地界面已适配 Android 桥：%s' % ', '.join(sorted(os.listdir(d))))
PYBRIDGE

echo "==> [2/7] 链接资源并生成 R.java (aapt2 link)"
mapfile -t FLATS < <(find "$OUT/compiled" -name '*.flat' | sort)
"$BT/aapt2" link \
    -o "$OUT/base.apk" \
    -I "$PLATFORM" \
    --manifest "$HERE/src/AndroidManifest.xml" \
    --java "$OUT/gen" \
    -A "$OUT/assets" \
    --min-sdk-version 23 \
    --target-sdk-version 35 \
    "${FLATS[@]}"

echo "==> [3/7] 编译 Java 源码 (javac)"
find "$HERE/src/java" "$OUT/gen" -name '*.java' | sort > "$OUT/sources.txt"
javac --release 11 -nowarn -encoding UTF-8 \
    -cp "$PLATFORM" \
    -d "$OUT/classes" \
    @"$OUT/sources.txt"

echo "==> [4/7] 转换为 DEX (d8)"
mapfile -t CLASSES < <(find "$OUT/classes" -name '*.class' | sort)
"$BT/d8" --lib "$PLATFORM" --min-api 23 --output "$OUT/dex" "${CLASSES[@]}"

echo "==> [5/7] 打包 classes.dex 并对齐 (zip + zipalign)"
(cd "$OUT/dex" && zip -q "$OUT/base.apk" classes.dex)
"$BT/zipalign" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"
"$BT/zipalign" -c -p 4 "$OUT/aligned.apk"

echo "==> [6/7] 生成/复用签名密钥并签名 (apksigner)"
if [ ! -f "$KS" ]; then
    keytool -genkeypair \
        -keystore "$KS" \
        -alias "$KS_ALIAS" \
        -keyalg RSA -keysize 2048 -validity 10950 \
        -storetype PKCS12 \
        -storepass "$KS_PASS" -keypass "$KS_PASS" \
        -dname "CN=ComicVault, OU=Mobile, O=ComicVault, L=Shenzhen, ST=Guangdong, C=CN" \
        >/dev/null 2>&1
    echo "    已生成自签名密钥：$KS"
fi
"$BT/apksigner" sign \
    --ks "$KS" \
    --ks-key-alias "$KS_ALIAS" \
    --ks-pass "pass:$KS_PASS" \
    --key-pass "pass:$KS_PASS" \
    --min-sdk-version 23 \
    --v1-signing-enabled true \
    --v2-signing-enabled true \
    --out "$OUT/$APK_NAME" \
    "$OUT/aligned.apk"

echo "==> [7/7] 验证并交付"
"$BT/apksigner" verify --verbose --min-sdk-version 23 "$OUT/$APK_NAME"
cp -f "$OUT/$APK_NAME" "$WORKSPACE/$APK_NAME"

echo
echo "=== 构建完成 ==="
echo "APK: $WORKSPACE/$APK_NAME"
ls -lh "$WORKSPACE/$APK_NAME"
"$BT/aapt2" dump badging "$OUT/$APK_NAME" > "$OUT/badging.txt"
head -12 "$OUT/badging.txt"
