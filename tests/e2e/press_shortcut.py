# Envoie Alt+Shift+L au niveau X11 (XTEST), comme un vrai clavier.
import time
from Xlib import X, XK, display
from Xlib.ext import xtest

d = display.Display()
xtest.fake_input(d, X.MotionNotify, x=600, y=300)
d.sync()
time.sleep(0.2)

def key(sym, press):
    code = d.keysym_to_keycode(XK.string_to_keysym(sym))
    xtest.fake_input(d, X.KeyPress if press else X.KeyRelease, code)
    d.sync()
    time.sleep(0.05)

for s in ("Alt_L", "Shift_L", "l"):
    key(s, True)
for s in ("l", "Shift_L", "Alt_L"):
    key(s, False)
print("shortcut sent")
