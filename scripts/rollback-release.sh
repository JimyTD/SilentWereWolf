#!/usr/bin/env bash
# Restore the release referenced by /root/silentwerewolf-releases/previous.
set -Eeuo pipefail

readonly PROJECT="silentwerewolf"
readonly RELEASE_ROOT="/root/silentwerewolf-releases"
readonly LOCK_FILE="/root/silentwerewolf-deploy.lock"

die() {
  echo "rollback: $*" >&2
  exit 1
}

[[ "${SILENTWEREWOLF_DEPLOY_ACK:-}" == "active-games-will-end" ]] || \
  die "set SILENTWEREWOLF_DEPLOY_ACK=active-games-will-end after confirming no game may be interrupted"

current_link="$RELEASE_ROOT/current"
previous_link="$RELEASE_ROOT/previous"
[[ -L "$current_link" && -L "$previous_link" ]] || die "current and previous release pointers are required"

current_release="$(readlink -f "$current_link")"
previous_release="$(readlink -f "$previous_link")"
[[ -f "$previous_release/docker-compose.yml" ]] || die "previous release is not usable: $previous_release"

activation_attempted=false
restore_current() {
  local status="$1"
  trap - ERR
  if [[ "$activation_attempted" == true ]]; then
    echo "rollback: restoration failed; recreating current release $current_release" >&2
    docker compose -p "$PROJECT" -f "$current_release/docker-compose.yml" \
      --project-directory "$current_release" up -d --build --wait --wait-timeout 180 || \
      echo "rollback: automatic recovery failed; inspect containers immediately" >&2
  fi
  exit "$status"
}
trap 'restore_current $?' ERR

exec 9>"$LOCK_FILE"
flock -n 9 || die "another deployment is already running"

echo "rollback: restoring $previous_release"
docker compose -p "$PROJECT" -f "$previous_release/docker-compose.yml" \
  --project-directory "$previous_release" config --quiet
activation_attempted=true
docker compose -p "$PROJECT" -f "$previous_release/docker-compose.yml" \
  --project-directory "$previous_release" up -d --build --wait --wait-timeout 180
if [[ -f "$previous_release/scripts/deploy-release.sh" ]]; then
  curl -fsS --max-time 10 http://127.0.0.1:8081/healthz | grep -q '"status":"ok"'
else
  curl -fsS --max-time 10 http://127.0.0.1:8081/ >/dev/null
fi

ln -sfn "$current_release" "$previous_link.next"
mv -Tf "$previous_link.next" "$previous_link"
ln -sfn "$previous_release" "$current_link.next"
mv -Tf "$current_link.next" "$current_link"

echo "rollback: healthy release is current: $previous_release"
