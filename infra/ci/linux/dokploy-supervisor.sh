#!/bin/sh
# Trusted Dokploy manager. Jobs never receive this socket, helper or App key.
set -eu
: "${CI_RUNNER_PROJECT:?required}"
: "${CI_RUNNER_COMPOSE_FILE:?required}"
: "${CI_RUNNER_SUBNET:?required}"
: "${CI_RUNNER_GATEWAY:?required}"
: "${CI_RUNNER_HELPER_IMAGE:?required}"
: "${CI_RUNNER_HOST_PUBLIC_IP:?required}"
policy=/opt/runner-supervisor/network-policy.py
case "$CI_RUNNER_SUBNET:$CI_RUNNER_GATEWAY" in
  172.31.240.0/24:172.31.240.1) slot=1 ;;
  172.31.241.0/24:172.31.241.1) slot=2 ;;
  *) echo "[t3-ci-manager] unexpected reserved slot/subnet" >&2; exit 64 ;;
esac
printf '%s' "$CI_RUNNER_PROJECT" | grep -Eq "^t3-ci-linux-${slot}(-[a-z0-9]{1,12})?$" || exit 64
printf '%s' "$CI_RUNNER_HELPER_IMAGE" | grep -Eq '^([a-z0-9./_-]+@)?sha256:[0-9a-f]{64}$' || {
  echo "[t3-ci-manager] helper image must use an immutable digest" >&2; exit 64;
}
[ -f "$CI_RUNNER_COMPOSE_FILE" ] && [ -f "$policy" ] || exit 66
max_seconds="${CI_RUNNER_MAX_SECONDS:-28800}"
case "$max_seconds" in *[!0-9]*|'') exit 64 ;; esac
[ "$max_seconds" -eq 28800 ] || exit 64
network="${CI_RUNNER_PROJECT}_isolated"
stopping=0
wait_pid=""
sleep_pid=""

compose() {
  timeout 180 docker compose --project-name "$CI_RUNNER_PROJECT" --file "$CI_RUNNER_COMPOSE_FILE" --profile pair "$@"
}
cleanup_pair() {
  compose stop --timeout 30 runner >/dev/null 2>&1 || true
  compose rm --force --stop runner register prepare >/dev/null 2>&1 || true
  for volume in runner-state runner-work; do
    name="${CI_RUNNER_PROJECT}_${volume}"
    if timeout 45 docker volume inspect "$name" >/dev/null 2>&1; then
      timeout 45 docker volume rm "$name" >/dev/null || return 1
    fi
  done
  if timeout 45 docker network inspect "$network" >/dev/null 2>&1; then
    timeout 45 docker network rm "$network" >/dev/null || return 1
  fi
}
on_signal() {
  stopping=1
  [ -z "$wait_pid" ] || kill "$wait_pid" >/dev/null 2>&1 || true
  [ -z "$sleep_pid" ] || kill "$sleep_pid" >/dev/null 2>&1 || true
}
trap on_signal INT TERM
trap 'cleanup_pair || true' EXIT

backoff=15
while [ "$stopping" -eq 0 ]; do
  # Never register or start a job unless cleanup and its source-scoped firewall
  # succeed. Repeat before each fresh pair, healing Docker/host restarts.
  cleanup_pair
  compose config --quiet
  # Create an empty, Compose-owned bridge so interface and IPv6 guards exist
  # before any registration, preparation or runner service starts.
  docker network create --driver bridge --subnet "$CI_RUNNER_SUBNET" --gateway "$CI_RUNNER_GATEWAY" \
    --opt "com.docker.network.bridge.name=t3ci-ln${slot}" \
    --label "com.docker.compose.project=$CI_RUNNER_PROJECT" \
    --label com.docker.compose.network=isolated "$network" >/dev/null
  docker run --rm --interactive --read-only --user 0:0 --privileged --pid=host --network=host \
    --entrypoint /usr/bin/nsenter "$CI_RUNNER_HELPER_IMAGE" \
    -t 1 -m -n /usr/bin/python3 - apply "$CI_RUNNER_SUBNET" "$network" "$CI_RUNNER_HOST_PUBLIC_IP" < "$policy"

  echo "[t3-ci-manager] starting disposable pair ${CI_RUNNER_PROJECT}"
  runner_rc=70
  if compose up --detach runner >/dev/null; then
    runner_id="$(compose ps --quiet runner)"
    case "$runner_id" in
      ''|*[!a-f0-9]*) ;;
      *)
        compose rm --force register prepare >/dev/null 2>&1 || true
        docker wait "$runner_id" > /tmp/t3-ci-runner-exit-code &
        wait_pid=$!
        listener_started="$(date +%s)"
        job_started=0
        while [ "$stopping" -eq 0 ] && kill -0 "$wait_pid" >/dev/null 2>&1; do
          now="$(date +%s)"
          # Observe command names only, never argv containing job credentials.
          # Record the first worker once; later repository processes cannot
          # refresh the deadline by repeatedly impersonating that name.
          if [ "$job_started" -eq 0 ] && timeout 15 docker top "$runner_id" -eo comm 2>/dev/null | grep -Eq '^[[:space:]]*Runner\.Worker[[:space:]]*$'; then
            job_started="$now"
          fi
          if [ $((now - listener_started)) -ge "$max_seconds" ] || \
             { [ "$job_started" -eq 0 ] && [ $((now - listener_started)) -ge 3600 ]; } || \
             { [ "$job_started" -gt 0 ] && [ $((now - job_started)) -ge 23400 ]; }; then
            echo "[t3-ci-manager] bounded listener/job lifetime reached" >&2
            timeout 45 docker compose --project-name "$CI_RUNNER_PROJECT" --file "$CI_RUNNER_COMPOSE_FILE" --profile pair stop --timeout 30 runner >/dev/null || true
            kill "$wait_pid" >/dev/null 2>&1 || true
            break
          fi
          sleep 10 &
          sleep_pid=$!
          wait "$sleep_pid" || true
          sleep_pid=""
        done
        wait "$wait_pid" || true
        wait_pid=""
        if [ -s /tmp/t3-ci-runner-exit-code ]; then
          runner_rc="$(tr -cd '0-9' < /tmp/t3-ci-runner-exit-code)"
        fi
        rm -f /tmp/t3-ci-runner-exit-code
        case "$runner_rc" in ''|*[!0-9]*) runner_rc=70 ;; esac
        ;;
    esac
  fi
  cleanup_pair
  [ "$stopping" -eq 0 ] || break
  if [ "$runner_rc" -eq 0 ]; then backoff=15; continue; fi
  echo "[t3-ci-manager] pair exited ${runner_rc}; retrying in ${backoff}s" >&2
  sleep "$backoff" &
  sleep_pid=$!
  wait "$sleep_pid" || true
  sleep_pid=""
  backoff=$((backoff * 2))
  [ "$backoff" -le 300 ] || backoff=300
done
