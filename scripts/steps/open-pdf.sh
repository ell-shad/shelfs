# Open a PDF from the accessible list view and page through it.
xdotool mousemove 1070 43 click 1; sleep 2
shot 40-list
# "Read" on the fifth card (first PDF row, second column).
xdotool mousemove 777 311 click 1; sleep 8
shot 41-reader-pdf
xdotool key Right; sleep 2; shot 42-reader-pdf-page2
xdotool key t; sleep 2; shot 43-reader-pdf-toc
xdotool key Escape; sleep 1; shot 44-reader-pdf-closed-panel
