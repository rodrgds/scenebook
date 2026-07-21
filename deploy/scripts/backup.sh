#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 BACKUP_DIRECTORY" >&2
  exit 64
fi

DEPLOY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BACKUP_INPUT=$1
. "$DEPLOY_DIR/scripts/path-safety.sh"
BACKUP_DIR=$(resolve_safe_leaf_path "$BACKUP_INPUT" "backup") || exit $?

if [ -e "$BACKUP_DIR" ] || [ -L "$BACKUP_DIR" ]; then
  echo "Backup directory must be a new exclusive leaf: $BACKUP_INPUT" >&2
  exit 73
fi
mkdir -m 700 -- "$BACKUP_DIR"
if [ -L "$BACKUP_DIR" ] || [ ! -d "$BACKUP_DIR" ]; then
  echo "Backup destination changed during creation: $BACKUP_INPUT" >&2
  exit 73
fi
if stat -c '%a' "$BACKUP_DIR" >/dev/null 2>&1; then
  BACKUP_MODE=$(stat -c '%a' "$BACKUP_DIR")
else
  BACKUP_MODE=$(stat -f '%Lp' "$BACKUP_DIR")
fi
if [ "$BACKUP_MODE" != 700 ]; then
  echo "Backup directory must have mode 0700; found $BACKUP_MODE: $BACKUP_DIR" >&2
  exit 73
fi
cd "$DEPLOY_DIR"

CLOUD_WAS_RUNNING=false
if docker compose ps --status running --services | grep -qx cloud; then
  CLOUD_WAS_RUNNING=true
fi

resume_cloud() {
  if [ "$CLOUD_WAS_RUNNING" = true ]; then
    docker compose start cloud >/dev/null 2>&1 || true
  fi
}
trap resume_cloud EXIT INT TERM

if [ "$CLOUD_WAS_RUNNING" = true ]; then
  docker compose stop cloud
fi
docker compose exec -T postgres pg_dump --username scenebook --dbname scenebook --format=custom --no-owner --no-acl >"$BACKUP_DIR/postgres.dump"
docker compose run --rm --no-deps --volume "$BACKUP_DIR:/backup" --entrypoint /bin/sh minio-init -eu -c '
  umask 077
  mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
  mkdir -p /backup/objects
  mc mirror --overwrite --remove local/scenebook /backup/objects
  find /backup/objects -type d -exec chmod 700 {} +
  find /backup/objects -type f -exec chmod 600 {} +
'

{
  echo "created_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  docker compose images --format json
} >"$BACKUP_DIR/manifest.txt"

(
  cd "$BACKUP_DIR"
  find . -type f ! -name SHA256SUMS -print | LC_ALL=C sort | while IFS= read -r file; do
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$file"
    else
      shasum -a 256 "$file"
    fi
  done >SHA256SUMS
)

chmod 600 "$BACKUP_DIR/postgres.dump" "$BACKUP_DIR/manifest.txt" "$BACKUP_DIR/SHA256SUMS"
if [ -n "$(find "$BACKUP_DIR" -type l -print -quit)" ]; then
  echo "Backup result unexpectedly contains a symbolic link." >&2
  exit 74
fi
if [ -n "$(find "$BACKUP_DIR" -type d ! -perm 0700 -print -quit)" ]; then
  echo "Backup result contains a directory whose mode is not 0700." >&2
  exit 74
fi
if [ -n "$(find "$BACKUP_DIR" -type f ! -perm 0600 -print -quit)" ]; then
  echo "Backup result contains a file whose mode is not 0600." >&2
  exit 74
fi

resume_cloud
trap - EXIT INT TERM
echo "Backup written to $BACKUP_DIR"
