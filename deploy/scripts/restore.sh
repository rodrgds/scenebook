#!/bin/sh
set -eu

if [ "$#" -ne 2 ] || [ "$2" != "--confirm-destructive-restore" ]; then
  echo "Usage: $0 BACKUP_DIRECTORY --confirm-destructive-restore" >&2
  exit 64
fi

DEPLOY_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BACKUP_INPUT=$1
. "$DEPLOY_DIR/scripts/path-safety.sh"
BACKUP_DIR=$(resolve_safe_leaf_path "$BACKUP_INPUT" "restore source") || exit $?
if [ -L "$BACKUP_DIR" ] || [ ! -d "$BACKUP_DIR" ]; then
  echo "Restore source must be a real directory: $BACKUP_INPUT" >&2
  exit 66
fi
if [ -n "$(find "$BACKUP_DIR" -type l -print -quit)" ]; then
  echo "Restore source must not contain symbolic links: $BACKUP_INPUT" >&2
  exit 66
fi
cd "$DEPLOY_DIR"

for file in postgres.dump SHA256SUMS; do
  test -f "$BACKUP_DIR/$file" || { echo "Missing backup file: $file" >&2; exit 66; }
done
test -d "$BACKUP_DIR/objects" || { echo "Missing backup directory: objects" >&2; exit 66; }

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS)
else
  (cd "$BACKUP_DIR" && shasum -a 256 -c SHA256SUMS)
fi

RUNNING_SERVICES=$(docker compose ps --status running --services)
was_running() {
  printf '%s\n' "$RUNNING_SERVICES" | grep -qx "$1"
}

RESTORE_SUCCEEDED=false
resume_services() {
  if [ "$RESTORE_SUCCEEDED" != true ]; then
    echo "Restore failed; traffic-facing services remain stopped." >&2
    return
  fi
  for service in cloud gateway studio static; do
    if was_running "$service"; then
      docker compose start "$service" >/dev/null
    fi
  done
}
trap resume_services EXIT INT TERM

docker compose stop cloud gateway studio static
docker compose exec -T postgres pg_restore --username scenebook --dbname scenebook --clean --if-exists --no-owner --no-acl --single-transaction --exit-on-error <"$BACKUP_DIR/postgres.dump"
docker compose run --rm --no-deps --volume "$BACKUP_DIR:/backup:ro" --entrypoint /bin/sh minio-init -eu -c '
  mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
  mc mirror --overwrite --remove /backup/objects local/scenebook
'

RESTORE_SUCCEEDED=true
resume_services
trap - EXIT INT TERM
echo "Restore completed. Verify /readyz and a known Release before reopening traffic."
