#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/scenebook-backup-test.XXXXXX")
case "$TEST_ROOT" in
  "${TMPDIR:-/tmp}"/scenebook-backup-test.*) ;;
  *) echo "Unsafe test directory: $TEST_ROOT" >&2; exit 1 ;;
esac
TEST_ROOT=$(CDPATH= cd -P -- "$TEST_ROOT" && pwd -P)
cleanup() {
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT INT TERM

mode_of() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

BACKUP_DIR="$TEST_ROOT/result"
ROOT_MODE=$(mode_of "$TEST_ROOT")
PATH="$SCRIPT_DIR/test-fixtures:$PATH" \
  SCENEBOOK_BACKUP_TEST_ROOT="$TEST_ROOT" \
  "$SCRIPT_DIR/backup.sh" "$BACKUP_DIR" >/dev/null

test "$(mode_of "$TEST_ROOT")" = "$ROOT_MODE"
test "$(mode_of "$BACKUP_DIR")" = 700
test -z "$(find "$BACKUP_DIR" -type d ! -perm 0700 -print -quit)"
test -z "$(find "$BACKUP_DIR" -type f ! -perm 0600 -print -quit)"
test -s "$BACKUP_DIR/postgres.dump"
test -s "$BACKUP_DIR/objects/nested/object.bin"
test -s "$BACKUP_DIR/SHA256SUMS"

ln -s "$BACKUP_DIR" "$TEST_ROOT/link"
if PATH="$SCRIPT_DIR/test-fixtures:$PATH" \
  SCENEBOOK_BACKUP_TEST_ROOT="$TEST_ROOT" \
  "$SCRIPT_DIR/backup.sh" "$TEST_ROOT/link" >/dev/null 2>&1; then
  echo "Backup accepted a symbolic-link destination." >&2
  exit 1
fi

GUARD="$TEST_ROOT/guard"
mkdir "$GUARD"
chmod 751 "$GUARD"
for unsafe in "$GUARD/new/.." "$GUARD/new/." "$GUARD/trailing/"; do
  if PATH="$SCRIPT_DIR/test-fixtures:$PATH" \
    SCENEBOOK_BACKUP_TEST_ROOT="$TEST_ROOT" \
    "$SCRIPT_DIR/backup.sh" "$unsafe" >/dev/null 2>&1; then
    echo "Backup accepted ambiguous destination: $unsafe" >&2
    exit 1
  fi
  test "$(mode_of "$GUARD")" = 751
  test ! -e "$GUARD/new"
  test ! -e "$GUARD/trailing"
  if PATH="$SCRIPT_DIR/test-fixtures:$PATH" \
    SCENEBOOK_BACKUP_TEST_ROOT="$TEST_ROOT" \
    "$SCRIPT_DIR/restore.sh" "$unsafe" --confirm-destructive-restore >/dev/null 2>&1; then
    echo "Restore accepted ambiguous source: $unsafe" >&2
    exit 1
  fi
  test "$(mode_of "$GUARD")" = 751
done

REAL_PARENT="$TEST_ROOT/real-parent"
LINKED_PARENT="$TEST_ROOT/linked-parent"
mkdir "$REAL_PARENT"
chmod 751 "$REAL_PARENT"
ln -s "$REAL_PARENT" "$LINKED_PARENT"
if PATH="$SCRIPT_DIR/test-fixtures:$PATH" \
  SCENEBOOK_BACKUP_TEST_ROOT="$TEST_ROOT" \
  "$SCRIPT_DIR/backup.sh" "$LINKED_PARENT/result" >/dev/null 2>&1; then
  echo "Backup accepted a symbolic-link parent." >&2
  exit 1
fi
test "$(mode_of "$REAL_PARENT")" = 751
test ! -e "$REAL_PARENT/result"
if PATH="$SCRIPT_DIR/test-fixtures:$PATH" \
  SCENEBOOK_BACKUP_TEST_ROOT="$TEST_ROOT" \
  "$SCRIPT_DIR/restore.sh" "$LINKED_PARENT/result" --confirm-destructive-restore \
    >/dev/null 2>&1; then
  echo "Restore accepted a symbolic-link parent." >&2
  exit 1
fi
test "$(mode_of "$REAL_PARENT")" = 751

UNSAFE_RESTORE="$TEST_ROOT/unsafe-restore"
mkdir -m 700 "$UNSAFE_RESTORE"
ln -s "$BACKUP_DIR/postgres.dump" "$UNSAFE_RESTORE/postgres.dump"
if PATH="$SCRIPT_DIR/test-fixtures:$PATH" \
  SCENEBOOK_BACKUP_TEST_ROOT="$TEST_ROOT" \
  "$SCRIPT_DIR/restore.sh" "$UNSAFE_RESTORE" --confirm-destructive-restore \
    >/dev/null 2>&1; then
  echo "Restore accepted a source tree containing a symbolic link." >&2
  exit 1
fi

echo "Backup permission and destination tests passed."
