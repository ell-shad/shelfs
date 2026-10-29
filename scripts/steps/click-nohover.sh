# Diagnostic: press immediately after warping the pointer, so no hover pull has
# been applied yet.
xdotool mousemove 1200 200; sleep 0.4
xdotool mousemove 390 690 mousedown 1; sleep 0.05; xdotool mouseup 1
sleep 2.5; shot 20-nohover-click
