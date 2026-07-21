#!/bin/sh

# Resolve a caller-supplied leaf beneath an existing, symlink-free physical parent without
# creating or changing anything. The result is safe to use for one non-recursive leaf operation.
resolve_safe_leaf_path() {
  unsafe_path=$1
  path_label=$2

  case "$unsafe_path" in
    ''|/|*/|*//*)
      echo "Refusing ambiguous $path_label path: $unsafe_path" >&2
      return 64
      ;;
  esac
  case "/$unsafe_path/" in
    */./*|*/../*)
      echo "Refusing $path_label path with a dot segment: $unsafe_path" >&2
      return 64
      ;;
  esac

  unsafe_parent=$(dirname -- "$unsafe_path")
  safe_name=$(basename -- "$unsafe_path")
  case "$safe_name" in
    ''|.|..)
      echo "Refusing unsafe $path_label leaf: $unsafe_path" >&2
      return 64
      ;;
  esac
  if [ ! -d "$unsafe_parent" ]; then
    echo "$path_label parent must already exist: $unsafe_parent" >&2
    return 73
  fi

  physical_parent=$(CDPATH= cd -P -- "$unsafe_parent" 2>/dev/null && pwd -P) || {
    echo "Could not resolve $path_label parent: $unsafe_parent" >&2
    return 73
  }
  physical_working_directory=$(pwd -P)
  case "$unsafe_parent" in
    .) lexical_parent=$physical_working_directory ;;
    /*) lexical_parent=$unsafe_parent ;;
    *) lexical_parent=$physical_working_directory/$unsafe_parent ;;
  esac
  if [ "$lexical_parent" != "$physical_parent" ]; then
    echo "$path_label parent must not contain symbolic links: $unsafe_parent" >&2
    return 73
  fi

  if [ "$physical_parent" = / ]; then
    printf '/%s\n' "$safe_name"
  else
    printf '%s/%s\n' "$physical_parent" "$safe_name"
  fi
}
