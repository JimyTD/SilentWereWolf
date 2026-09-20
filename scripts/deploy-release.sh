#!/usr/bin/env bash
# Deploy an immutable, commit-addressed SilentWerewolf release on the production host.
set -Eeuo pipefail

readonly PROJECT="silentwerewolf"
readonly RELEASE_ROOT="/root/silentwerewolf-releases"
readonly LOCK_FILE="/root/silentwerewolf-deploy.lock"
readonly MIN_FREE_KIB=$((4 * 1024 * 1024))

die() {
  echo "deploy: $*" >&2
  exit 1
}

usage() {
  echo "usage: SILENTWEREWOLF_DEPLOY_ACK=active-games-will-end $0 <full-commit-sha>" >&2
  exit 2
}

commit="${1:-}"
[[ "$commit" =~ ^[0-9a-f]{40,64}$ ]] || usage
[[ "${SILENTWEREWOLF_DEPLOY_ACK:-}" == "active-games-will-end" ]] || \
  die "set SILENTWEREWOLF_DEPLOY_ACK=active-games-will-end after confirming no game may be interrupted"

source_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
[[ -f "$source_dir/docker-compose.yml" ]] || die "source directory does not contain docker-compose.yml"

mkdir -p "$RELEASE_ROOT"
exec 9>"$LOCK_FILE"
flock -n 9 || die "another deployment is already running"

current_link="$RELEASE_ROOT/current"
previous_link="$RELEASE_ROOT/previous"
activation_attempted=false
previous_release=""

if [[ -L "$current_link" ]]; then
  previous_release="$(readlink -f "$current_link")"
else
  running_dir="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' silentwerewolf-app 2>/dev/null || true)"
  if [[ -n "$running_dir" && -f "$running_dir/docker-compose.yml" ]]; then
    ln -s "$running_dir" "$current_link"
    previous_release="$(readlink -f "$current_link")"
    echo "deploy: initialized current pointer from running container: $previous_release"
  fi
fi

rollback() {
  local status="$1"
  trap - ERR
  if [[ "$activation_attempted" == true && -n "$previous_release" && -f "$previous_release/docker-compose.yml" ]]; then
    echo "deploy: activation failed; restoring $previous_release" >&2
    docker compose -p "$PROJECT" -f "$previous_release/docker-compose.yml" \
      --project-directory "$previous_release" up -d --build --wait --wait-timeout 180 || \
      echo "deploy: rollback command failed; inspect containers immediately" >&2
    curl -fsS --max-time 10 http://127.0.0.1:8081/ >/dev/null || \
      echo "deploy: rollback health probe failed; inspect containers immediately" >&2
  fi
  exit "$status"
}
trap 'rollback $?' ERR

available_kib="$(df -Pk /root | awk 'NR == 2 { print $4 }')"
[[ "$available_kib" =~ ^[0-9]+$ ]] || die "could not determine available disk space"
(( available_kib >= MIN_FREE_KIB )) || die "less than 4 GiB free; inspect disk and Docker cache before deploying"

echo "deploy: source commit $commit"
echo "deploy: free disk $((available_kib / 1024 / 1024)) GiB"
docker compose ls
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'

release_dir="$RELEASE_ROOT/$commit"
[[ ! -e "$release_dir" ]] || die "release directory already exists: $release_dir"
mkdir -p "$release_dir"
tar --exclude=.git --exclude=node_modules -C "$source_dir" -cf - . | tar -C "$release_dir" -xf -
printf '%s\n' "$commit" > "$release_dir/.release-commit"

docker compose -p "$PROJECT" -f "$release_dir/docker-compose.yml" \
  --project-directory "$release_dir" config --quiet

activation_attempted=true
docker compose -p "$PROJECT" -f "$release_dir/docker-compose.yml" \
  --project-directory "$release_dir" up -d --build --wait --wait-timeout 180

curl -fsS --max-time 10 http://127.0.0.1:8081/healthz | grep -q '"status":"ok"'
[[ "$(docker inspect --format '{{.State.Health.Status}}' silentwerewolf-app)" == "healthy" ]]

cat > "$release_dir/.release-manifest" <<EOF
commit=$commit
deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
previous_release=$previous_release
app_image=$(docker inspect --format '{{.Image}}' silentwerewolf-app)
nginx_image=$(docker inspect --format '{{.Image}}' silentwerewolf-nginx)
EOF

if [[ -n "$previous_release" ]]; then
  ln -sfn "$previous_release" "$previous_link.next"
  mv -Tf "$previous_link.next" "$previous_link"
fi
ln -sfn "$release_dir" "$current_link.next"
mv -Tf "$current_link.next" "$current_link"

echo "deploy: healthy release is current: $release_dir"
docker compose -p "$PROJECT" -f "$release_dir/docker-compose.yml" \
  --project-directory "$release_dir" ps
