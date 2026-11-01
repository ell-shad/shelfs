# Measure: cold start to first window, then frame time after the shelf settles.
start=$(date +%s%N)
for _ in $(seq 1 200); do xdotool search --name "Shelfs" >/dev/null 2>&1 && break; sleep 0.05; done
window_ms=$(( ($(date +%s%N) - start) / 1000000 ))
echo "MEASURE window_mapped_ms=$window_ms"
sleep 3; shot 90-startup3s
sleep 10; shot 91-settled
sleep 8; shot 92-frame-time
