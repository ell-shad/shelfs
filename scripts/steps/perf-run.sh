# Cold start timing and frame time, with an already-imported library.
start=$(date +%s%N)
for _ in $(seq 1 400); do xdotool search --name "My Bookshelf" >/dev/null 2>&1 && break; sleep 0.05; done
window_ms=$(( ($(date +%s%N) - start) / 1000000 ))
echo "MEASURE window_mapped_ms=$window_ms"
sleep 8; shot 01-settled
sleep 10; shot 02-frame-time
sleep 6; shot 03-frame-time-again
