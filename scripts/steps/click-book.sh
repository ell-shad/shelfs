# Diagnostic: does a synthetic mouse press/release select a book?
xdotool mousemove 390 690; sleep 0.5
xdotool mousedown 1; sleep 0.15; xdotool mouseup 1
sleep 0.4; shot 10-afterclick
xdotool mousemove 1300 200; sleep 2.0; shot 11-afterclick-settled
xdotool key Return; sleep 1.0; shot 12-enter
