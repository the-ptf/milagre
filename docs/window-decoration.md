# Window decoration

The default desktop window uses macOS traffic lights in its content, or an external native frame on Linux and Windows.
The sidebar reserves horizontal space only when window controls occupy the content. A Linux window manager hiding an
external frame does not move its controls into the content, so it does not need that reservation either.

The top bar is 44px tall. Beside the window controls it holds the sidebar toggle and the sidebar's Canvas, Search,
Routines and Filters; in Settings it holds Back and the Settings title instead. On macOS the traffic lights sit at
x 16, y 16, and the toggle starts one 16px margin after them.

To supply integrated Electron controls on Linux or Windows, launch Milagre with `--window-decoration=overlay`.
For a local checkout, use `node scripts/launch-electron.cjs --window-decoration=overlay` after building the renderer.
This hides the native title bar and enables Electron's Window Controls Overlay. The renderer uses its title-bar geometry
to keep sidebar, Changes, panels, attention and diff actions clear of controls on either edge. Geometry changes, including
fullscreen and resizing, update the layout. The native application menu remains available.

The preload exposes the local window's decoration separately from the Project's bridge. A Project on another computer
cannot change the window's layout. Mobile navigation continues to use the native toolbar and safe-area insets.
