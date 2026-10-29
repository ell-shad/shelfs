#!/usr/bin/env bash
# Headless interaction run: launches the app on Xvfb with a scratch library,
# executes a fixed click/key sequence with xdotool and screenshots every step.
# Used to verify the shelf, the detail card and the reader visually.
#
#   scripts/gui-drive.sh <out-dir> [book files or folders ...]
#
# Expects the Vite dev server for debug binaries (started here if needed).
set -uo pipefail

out=${1:?usage: gui-drive.sh <out-dir> [files...]}
shift || true

root=$(cd "$(dirname "$0")/.." && pwd)
profile=/tmp/bookshelf-drive
mkdir -p "$out"
rm -rf "$profile"
mkdir -p "$profile/data" "$profile/cache" "$profile/config" "$profile/run"
chmod 700 "$profile/run"

bin=$root/src-tauri/target/release/bookshelf
[[ -x $bin ]] || bin=$root/src-tauri/target/debug/bookshelf

vite_pid=""
if [[ $bin == */target/debug/* ]] && ! curl -sf -o /dev/null http://127.0.0.1:1420/; then
  ( cd "$root" && npm run dev:web ) >/tmp/bookshelf-vite.log 2>&1 &
  vite_pid=$!
  for _ in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:1420/ && break; sleep 0.5; done
fi

export PROFILE=$profile BIN=$bin OUT=$out
export XDG_DATA_HOME="$profile/data" XDG_CACHE_HOME="$profile/cache" XDG_CONFIG_HOME="$profile/config"
export XDG_RUNTIME_DIR="$profile/run"
export LIBGL_ALWAYS_SOFTWARE=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1
export GDK_BACKEND=x11 BOOKSHELF_LOG=${BOOKSHELF_LOG:-debug}

steps=${BS_STEPS:-}
[[ -n $steps ]] && export STEPS_FILE=$steps

xvfb-run -a --server-args='-screen 0 1440x900x24' bash -c '
  set -uo pipefail
  "$BIN" "$@" >"$PROFILE/app.log" 2>&1 &
  app=$!
  for _ in $(seq 1 90); do xdotool search --name "My Bookshelf" >/dev/null 2>&1 && break; sleep 0.5; done
  shot() { import -window root "$OUT/$1.png"; echo "shot $1"; }
  sleep 14
  if [[ -n ${STEPS_FILE:-} ]]; then
    # shellcheck disable=SC1090
    source "$STEPS_FILE"
  else
    shot 01-shelf
    # Hover the first book, then click it to pull it out.
    xdotool mousemove 390 690; sleep 0.6; shot 02-hover
    xdotool mousemove 390 690 mousedown 1; sleep 0.12; xdotool mouseup 1
    sleep 1.2; xdotool mousemove 1300 700; sleep 2.5; shot 03-detail
    xdotool key Escape; sleep 1.5
    # Open the accessible list view through the toolbar toggle.
    xdotool mousemove 1070 43 click 1; sleep 2.5; shot 04-list
  fi
  kill $app 2>/dev/null; wait $app 2>/dev/null
' _ "$@"

if [[ -n $vite_pid ]]; then kill "$vite_pid" 2>/dev/null || true; fi
echo "screenshots in $out; app log: $profile/app.log"
