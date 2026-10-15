#!/usr/bin/env bash
# Focused readiness checks; does not build T3 Code or access registration secrets.
set -euo pipefail
mode="${1:---image}"
[[ "$mode" == --image || "$mode" == --runtime ]] || { echo "Usage: t3-ci-preflight [--image|--runtime]" >&2; exit 64; }
fail() { echo "[t3-ci-preflight] $*" >&2; exit 1; }
[[ "$(id -u):$(id -g)" == 1001:121 ]] || fail "Expected UID/GID 1001:121."
[[ " $(id -nG) " != *' docker '* && " $(id -nG) " != *' sudo '* ]] || fail "Privileged supplementary group detected."
! command -v sudo >/dev/null || fail "sudo must not exist in the job image."
[[ ! -S /var/run/docker.sock ]] || fail "Host Docker socket is forbidden."
[[ "$(uname -m)" == x86_64 ]] || fail "Expected native Linux x64 hardware."
for tool in git gh jq curl unzip zip python3 gcc g++ make pkg-config java convert node qemu-system-x86_64 qemu-img genisoimage ssh ssh-keygen; do
  command -v "$tool" >/dev/null || fail "Missing $tool."
done
pkg-config --exists libsecret-1 wayland-client xkbcommon || fail "Missing native development headers."
[[ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 24')" == true ]] || fail "Node 24 or newer is required."
java -version 2>&1 | grep -q 'version "17\.' || fail "Expected preinstalled Java 17."

python3 - <<'PY'
import ctypes
for library in ["libnotify.so.4", "libsecret-1.so.0", "libgtk-3.so.0", "libnspr4.so", "libnss3.so",
                "libgbm.so.1", "libasound.so.2", "libEGL.so.1", "libX11.so.6", "libxkbcommon.so.0"]:
    ctypes.CDLL(library)
print("[t3-ci-preflight] Native runtime libraries available.")
PY

/usr/local/bin/t3-ci-package-vm preflight

sdk="$ANDROID_HOME"
[[ "$mode" != --image ]] || sdk=/opt/t3-ci/android-sdk
export ANDROID_HOME="$sdk" ANDROID_SDK_ROOT="$sdk"
for executable in cmdline-tools/latest/bin/sdkmanager cmdline-tools/latest/bin/avdmanager \
  platform-tools/adb emulator/emulator build-tools/36.0.0/aapt2 build-tools/36.0.0/apksigner; do
  [[ -x "$sdk/$executable" ]] || fail "Missing Android SDK executable: $executable."
done
[[ -f "$sdk/platforms/android-36/android.jar" ]] || fail "Missing Android API 36."
[[ -f "$sdk/system-images/android-36/google_apis/x86_64/system.img" ]] || fail "Missing API 36 Google APIs x86_64 system image."
"$sdk/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$sdk" --version >/dev/null
"$sdk/platform-tools/adb" version >/dev/null
"$sdk/emulator/emulator" -version >/dev/null

if [[ "$mode" == --runtime ]]; then
  [[ -w "$sdk" && -w "$TMPDIR" && -w "$GRADLE_USER_HOME" && -w "$ANDROID_AVD_HOME" ]] || fail "Per-job SDK/cache/temp storage must be writable."
  grep -q '^NoNewPrivs:[[:space:]]*1$' /proc/self/status || fail "no-new-privileges is missing."
  grep -q '^CapEff:[[:space:]]*0000000000000000$' /proc/self/status || fail "Effective capabilities must be empty."
  awk '$2 == "/" && $4 ~ /(^|,)ro(,|$)/ { ok = 1 } END { exit !ok }' /proc/mounts || fail "Root filesystem must be read-only."
  [[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]] || fail "Readable/writable /dev/kvm is required."
  "$sdk/emulator/emulator" -accel-check || fail "Android emulator acceleration is unavailable."
fi
echo "[t3-ci-preflight] $mode readiness passed."
