#!/usr/bin/env bash
# Launch the real app on a headless X server (Xvfb) with software GL and take a
# screenshot. Used for verification and for the README images.
#
#   scripts/gui-smoke.sh <out.png> [book files or folders ...]
#
# Environment:
#   BS_PROFILE   directory for XDG data/cache/config (default: /tmp/bookshelf-gui)
#   BS_KEEP=1    keep the profile between runs (default: fresh library each run)
#   BS_WAIT      seconds to wait for the window before screenshotting (default 6)
set -euo pipefail

out=${1:?usage: gui-smoke.sh <out.png> [files...]}
shift || true

root=$(cd "$(dirname "$0")/.." && pwd)
profile=${BS_PROFILE:-/tmp/bookshelf-gui}
wait_s=${BS_WAIT:-6}
bin=${BS_BIN:-$root/src-tauri/target/release/bookshelf}
[[ -x $bin ]] || bin="$root/src-tauri/target/debug/bookshelf"

if [[ ! -x $bin ]]; then
  echo "build first: (cd src-tauri && cargo build) or (cargo build --release)" >&2
  exit 1
fi

# Debug binaries load the Vite dev URL, so they need the dev server running.
# Release binaries embed ui/dist and need nothing.
dev_pid=""
if [[ $bin == */target/debug/* ]]; then
  if ! curl -sf -o /dev/null http://127.0.0.1:1420/; then
    ( cd "$root" && npm run dev:web ) >"${TMPDIR:-/tmp}/bookshelf-vite.log" 2>&1 &
    dev_pid=$!
    for _ in $(seq 1 60); do
      curl -sf -o /dev/null http://127.0.0.1:1420/ && break
      sleep 0.5
    done
  fi
fi
cleanup() {
  if [[ -n $dev_pid ]]; then kill "$dev_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

if [[ ${BS_KEEP:-0} != 1 ]]; then
  rm -rf "$profile"
fi
mkdir -p "$profile/data" "$profile/cache" "$profile/config"

log="$profile/app.log"
export XDG_DATA_HOME="$profile/data"
export XDG_CACHE_HOME="$profile/cache"
export XDG_CONFIG_HOME="$profile/config"
export XDG_RUNTIME_DIR="$profile/run"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
export LIBGL_ALWAYS_SOFTWARE=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export GDK_BACKEND=x11
export BOOKSHELF_LOG=${BOOKSHELF_LOG:-info}

xvfb-run -a --server-args='-screen 0 1440x900x24' \
  bash -c '
    set -euo pipefail
    "'"$bin"'" '"$(printf '%q ' "$@")"' >"'"$log"'" 2>&1 &
    app=$!
    for _ in $(seq 1 60); do
      if xdotool search --name "My Bookshelf" >/dev/null 2>&1; then break; fi
      sleep 0.5
    done
    sleep '"$wait_s"'
    import -window root "'"$out"'"
    kill $app 2>/dev/null || true
    wait $app 2>/dev/null || true
  '

echo "screenshot: $out"
echo "log:        $log"
