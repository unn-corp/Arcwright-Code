#!/usr/bin/env bash
# Infrastructure-owned bootstrap. Never register here or read an App key.
set -euo pipefail
[[ "$(id -u):$(id -g)" == 1001:121 ]] || { echo "Expected runner UID/GID 1001:121." >&2; exit 1; }

state=/_work/.t3-ci
[[ ! -e "$state" ]] || { echo "T3 CI state exists; require a fresh disposable workspace." >&2; exit 1; }
mkdir -p "$state" "$TMPDIR" "$ANDROID_USER_HOME" "$ANDROID_AVD_HOME" \
  "$GRADLE_USER_HOME" "$CARGO_HOME" "$RUSTUP_HOME" "$XDG_CACHE_HOME" \
  "$XDG_DATA_HOME" "$PNPM_HOME" "$NPM_CONFIG_CACHE"
mkdir -m 0700 "$XDG_RUNTIME_DIR"
cp -a --no-preserve=ownership /opt/t3-ci/android-sdk "$ANDROID_HOME"
# The seed stays immutable in the image; sdkmanager, emulator-runner, and Gradle
# may modify only this job's private copy, destroyed with runner-work.
chmod -R u+w "$ANDROID_HOME"

for directory in .android .cache .cargo .gradle .local .npm .rustup .vite-plus; do
  case "$directory" in
    .android) target="$ANDROID_USER_HOME" ;;
    .cache) target="$XDG_CACHE_HOME" ;;
    .cargo) target="$CARGO_HOME" ;;
    .gradle) target="$GRADLE_USER_HOME" ;;
    .local) target="$XDG_DATA_HOME" ;;
    .npm) target="$NPM_CONFIG_CACHE" ;;
    .rustup) target="$RUSTUP_HOME" ;;
    .vite-plus) target="$state/home/vite-plus" ;;
  esac
  mkdir -p "$target"
  [[ ! -e "$HOME/$directory" ]] || { echo "Unexpected existing home state: $directory" >&2; exit 1; }
  ln -s "$target" "$HOME/$directory"
done

t3-ci-preflight --runtime
exec /actions-runner/run.sh
