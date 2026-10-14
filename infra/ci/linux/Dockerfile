# syntax=docker/dockerfile:1.7
# Build from the repository root. Registration remains in the separate trusted
# Compose service; the job listener never receives the GitHub App private key.
FROM myoung34/github-runner@sha256:1b947d2475cc6f4c3edf0e91dd879b091857e41a311be917016243479bb34101

USER root
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# A fixed Ubuntu archive snapshot makes native package selection reproducible.
# Advance this deliberately with the reviewed image digest, never at job startup.
ARG UBUNTU_SNAPSHOT=20261014T000000Z
RUN set -eux; \
    . /etc/os-release; test "$VERSION_CODENAME" = noble; \
    rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; \
    printf 'deb [check-valid-until=no signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://snapshot.ubuntu.com/ubuntu/%s noble main universe restricted multiverse\n' "$UBUNTU_SNAPSHOT" > /etc/apt/sources.list; \
    printf 'deb [check-valid-until=no signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://snapshot.ubuntu.com/ubuntu/%s noble-updates main universe restricted multiverse\n' "$UBUNTU_SNAPSHOT" >> /etc/apt/sources.list; \
    printf 'deb [check-valid-until=no signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://snapshot.ubuntu.com/ubuntu/%s noble-security main universe restricted multiverse\n' "$UBUNTU_SNAPSHOT" >> /etc/apt/sources.list; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
      binutils build-essential ca-certificates curl dbus dbus-x11 fakeroot \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji gh git imagemagick \
      jq libasound2-dev libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 \
      libatspi2.0-0t64 libcairo2 libcups2t64 libdbus-1-dev libdrm2 libegl1 \
      libfuse2t64 libgbm1 libgl1 libglib2.0-dev libgtk-3-0t64 libnspr4 libnss3 \
      libnotify4 libpango-1.0-0 libpulse-dev libsecret-1-dev libssl-dev \
      libwayland-dev libx11-6 libx11-xcb1 libxcb1 libxcb-cursor0 libxcb-icccm4 \
      libxcb-image0 libxcb-keysyms1 libxcb-render-util0 libxcb-xinerama0 \
      libxcb-xkb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
      libxkbcommon-dev libxkbcommon-x11-0 libxrandr2 libxshmfence1 \
      libvulkan1 openjdk-17-jdk-headless pkg-config portaudio19-dev python3 rsync \
      unzip xauth xdg-utils xvfb xz-utils zip zstd; \
    test "$(id -u runner)" = 1001; test "$(id -g runner)" = 121; \
    usermod --groups runner runner; \
    SUDO_FORCE_REMOVE=yes apt-get purge --yes --auto-remove sudo; \
    test -x /actions-runner/externals/node24/bin/node; \
    ln -sf /actions-runner/externals/node24/bin/node /usr/local/bin/node; \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    ANDROID_HOME=/_work/.t3-ci/android-sdk \
    ANDROID_SDK_ROOT=/_work/.t3-ci/android-sdk \
    ANDROID_USER_HOME=/_work/.t3-ci/android-user \
    ANDROID_AVD_HOME=/_work/.t3-ci/android-avd \
    GRADLE_USER_HOME=/_work/.t3-ci/gradle \
    CARGO_HOME=/_work/.t3-ci/cargo \
    RUSTUP_HOME=/_work/.t3-ci/rustup \
    XDG_CACHE_HOME=/_work/.t3-ci/cache \
    XDG_DATA_HOME=/_work/.t3-ci/data \
    PNPM_HOME=/_work/.t3-ci/pnpm \
    NPM_CONFIG_CACHE=/_work/.t3-ci/npm \
    XDG_RUNTIME_DIR=/_work/.t3-ci/runtime \
    TMPDIR=/_work/_temp \
    HOME=/home/runner \
    PATH=/_work/.t3-ci/android-sdk/cmdline-tools/latest/bin:/_work/.t3-ci/android-sdk/platform-tools:/_work/.t3-ci/android-sdk/emulator:/usr/lib/jvm/java-17-openjdk-amd64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

COPY infra/ci/linux/android-sdk.lock.json infra/ci/linux/install-sdk.py /usr/local/lib/t3-ci/
RUN set -euo pipefail; \
    python3 /usr/local/lib/t3-ci/install-sdk.py; \
    set +o pipefail; \
    yes | /opt/t3-ci/android-sdk/cmdline-tools/latest/bin/sdkmanager --sdk_root=/opt/t3-ci/android-sdk --licenses >/dev/null; \
    set -o pipefail; \
    /opt/t3-ci/android-sdk/cmdline-tools/latest/bin/sdkmanager --sdk_root=/opt/t3-ci/android-sdk --list_installed; \
    chmod -R a-w /opt/t3-ci/android-sdk; \
    rm -rf /root/.android /home/runner/.android /_work/.t3-ci /tmp/*

COPY --chmod=0755 infra/ci/linux/preflight.sh /usr/local/bin/t3-ci-preflight
COPY --chmod=0755 infra/ci/linux/start-runner.sh /usr/local/bin/t3-ci-start-runner

USER 1001:121
RUN /usr/local/bin/t3-ci-preflight --image

# SDK tools can create preferences even during version probes. Do not let
# Docker's initial named-volume population carry probe state into a new job.
USER root
RUN rm -rf /_work/.t3-ci /_work/_temp /home/runner/.android /home/runner/.cache
USER 1001:121

# The owner-controlled Compose definition invokes this after registration and
# supplies read-only rootfs, cap_drop, no-new-privileges and per-job volumes.
ENTRYPOINT ["/usr/local/bin/t3-ci-start-runner"]
