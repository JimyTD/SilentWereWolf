#!/usr/bin/env bash
# Recreate the active release after an external environment-file change.
set -Eeuo pipefail

readonly PROJECT="silentwerewolf"
readonly RELEASE_ROOT="/root/silentwerewolf-releases"
readonly LOCK_FILE="/root/silentwerewolf-deploy.lock"

die() {
  echo "recreate: $*" >&2
  exit 1
}

[[ "${SILENTWEREWOLF_DEPLOY_ACK:-}" == "active-games-will-end" ]] || \
  die "set SILENTWEREWOLF_DEPLOY_ACK=active-games-will-end after confirming no game may be interrupted"

current_link="$RELEASE_ROOT/current"
[[ -L "$current_link" ]] || die "current release pointer is missing"
current_release="$(readlink -f "$current_link")"
[[ -f "$current_release/docker-compose.yml" ]] || die "current release is not usable: $current_release"

exec 9>"$LOCK_FILE"
flock -n 9 || die "another deployment is already running"

docker compose -p "$PROJECT" -f "$current_release/docker-compose.yml" \
  --project-directory "$current_release" config --quiet
docker compose -p "$PROJECT" -f "$current_release/docker-compose.yml" \
  --project-directory "$current_release" up -d --force-recreate --no-build --wait --wait-timeout 180
curl -fsS --max-time 10 http://127.0.0.1:8081/healthz | grep -q '"status":"ok"'

echo "recreate: active release is healthy: $current_release"
