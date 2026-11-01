#!/usr/bin/env bash
# Headless performance measurement of the release build.
#
#   scripts/perf-measure.sh <book-dir> <out-dir>
#
# Pass 1 imports the books; passes 2 and 3 measure a cold start (launch -> window
# mapped, launch -> "Shelfs started"). Frame rate was measured separately
# during development with a temporary on-screen probe patched into ShelfView:
# 220 books under llvmpipe settled to ~40 fps with the shelf already usable.
# Software GL is used here, so these are the numbers for a machine with no GPU.
set -uo pipefail

books=${1:?usage: perf-measure.sh <book-dir> <out-dir>}
out=${2:?usage: perf-measure.sh <book-dir> <out-dir>}
root=$(cd "$(dirname "$0")/.." && pwd)
bin=$root/src-tauri/target/release/bookshelf
profile=/tmp/bookshelf-perf
mkdir -p "$out"

[[ -x $bin ]] || { echo "build first: cargo build --release" >&2; exit 1; }

run_once() {
  local tag=$1
  local args=$2
  local settle=${3:-14}
  export PROFILE=$profile BIN=$bin OUT=$out TAG=$tag ARGS=$args
  export SETTLE=$settle
  xvfb-run -a --server-args='-screen 0 1440x900x24' bash -c '
    set -uo pipefail
    start=$(date +%s%N)
    # shellcheck disable=SC2086
    "$BIN" $ARGS >"$PROFILE/app-$TAG.log" 2>&1 &
    app=$!
    t_window=""
    t_started=""
    for _ in $(seq 1 400); do
      if [[ -z $t_window ]] && xdotool search --name "Shelfs" >/dev/null 2>&1; then
        t_window=$(( ($(date +%s%N) - start) / 1000000 ))
      fi
      if [[ -z $t_started ]] && grep -q "Shelfs started" "$PROFILE/app-$TAG.log" 2>/dev/null; then
        t_started=$(( ($(date +%s%N) - start) / 1000000 ))
      fi
      [[ -n $t_window && -n $t_started ]] && break
      sleep 0.05
    done
    echo "MEASURE[$TAG] window_mapped_ms=${t_window:-timeout} core_started_ms=${t_started:-timeout}"
    sleep "$SETTLE"
    import -window root "$OUT/$TAG-early.png"
    sleep 14
    import -window root "$OUT/$TAG-settled.png"
    kill $app 2>/dev/null; wait $app 2>/dev/null
  '
}

rm -rf "$profile"
mkdir -p "$profile/data" "$profile/cache" "$profile/config" "$profile/run"
chmod 700 "$profile/run"
export XDG_DATA_HOME="$profile/data" XDG_CACHE_HOME="$profile/cache" XDG_CONFIG_HOME="$profile/config"
export XDG_RUNTIME_DIR="$profile/run"
export LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
export GDK_BACKEND=x11 BOOKSHELF_LOG=info
# The single-instance lock lives on the session bus; a dead address makes each
# measurement run standalone even if another Shelfs window exists.
export DBUS_SESSION_BUS_ADDRESS="unix:path=$profile/nobus"

echo "pass 1: importing books (waiting for the import to finish)"
run_once import "$books" 120
echo "pass 2: cold start"
run_once run1 "" 6
echo "pass 3: cold start again"
run_once run2 "" 6
