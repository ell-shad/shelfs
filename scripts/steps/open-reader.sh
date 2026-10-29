# Open a book from the shelf, then the reader, then page + contents.
xdotool mousemove 390 690; sleep 0.7
xdotool mousedown 1; sleep 0.1; xdotool mouseup 1
sleep 2.5; shot 30-detail
xdotool mousemove 1087 626 click 1
sleep 6; shot 31-reader-epub
xdotool key Right; sleep 2; shot 32-reader-page2
xdotool key t; sleep 1.5; shot 33-reader-toc
xdotool key Escape; sleep 1; shot 34-reader-after-escape
