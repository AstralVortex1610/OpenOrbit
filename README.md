# Kitten Watcher

A white chibi boy kitten who lives on your Windows desktop.

- **Doomscroll bouncer**: stay on Instagram, Reels, Shorts, TikTok, X, Reddit, Facebook or Snapchat for 15 s and he peeks up, stares, teases you, dashes over and closes it (Ctrl+W for a browser tab, the X button for an app), then salutes and leaves.
- **Break buddy**: every 45 min of active use he pops in with a stunt; 12 stunts, never repeats the last five.
- **Watches with you**: on videos, calls, pictures or reading he taps it and settles in, sitting at the bottom or hanging upside down from the top (small, in the corner, on calls). He rides along when you move the window.
- **Hears you (offline)**: "hey kitty", "I need a break", "go away kitty", "good boy", "bad kitty", "kitty dance", "do a flip". He jumps at loud noises. He never talks back.
- **Physics**: grab and fling him; drag a window into him to knock him away. Double-click to shoo. He rides and shoves windows during stunts.
- **Rare notes**: about 1 in 100 catches he opens Notepad and types you a note.
- **Orbit link**: reads your name and memory topics from Orbit (read-only) and writes `kitten-companion.md` into Orbit's memory so Orbit knows your scroll and break habits.
- **Stubborn**: no window, no tray icon, no taskbar entry, starts with Windows, and a watchdog relaunches him if killed. Quit for the session: Ctrl+Alt+Shift+K, then the passphrase (default `kitty let me go`).

- **Moves like a real cat**: a 2D skeletal rig (image head with blinks, ear flicks and glowing eyes; procedurally drawn body, four 2-bone IK legs with planted paws, a 7-segment spring tail). Walk, trot and gallop gaits with proper leg phases, body bob and spine flex; sit, loaf, stretch, crouch-and-wiggle before big jumps, landing absorb with no bounce.
- **Real physics and navigation**: gravity, no rubber bouncing, he lands on his feet. He walks on the taskbar and on the top edges of your visible windows, rides a window you move, falls when it closes or minimizes, and plans routes: walk, jump onto ledges, drop down, climb window sides or the screen edge.
- **Sound effects** (quiet, never speech): paw pats, jump, land thump, meows, purr when petted (hover over him) or watching with you, hiss when startled. `sound_volume` (0-1) and `sound_muted` in config; say "quiet kitty" / "kitty sounds on". Sources and licences: `assets/sfx/CREDITS.txt`.

Settings: `%APPDATA%\KittenWatcher\config.json`.
