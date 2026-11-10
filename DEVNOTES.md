# Orbit 0.4.0
Install: run Orbit-Setup-0.4.0.exe (or unzip Orbit-0.4.0-win.zip and run Orbit.exe). Unsigned, so SmartScreen: More info > Run anyway.
Setup: Settings > Brain > base URL, API key, model > Test connection > Save.

New in 0.4.0
- Live voice: a full-duplex call with Orbit (waveform button next to the mic, or "Hey Orbit"). It hears your tone, reacts, and you can interrupt it. The voice model talks; Orbit's own agent does the work in the background and the voice tells you the result.
- Engines: Gemini Live (gemini-3.8-live, free tier with an AI Studio key) or OpenAI GPT-Live (gpt-live-1, about $0.05/min, client delegation). Set up in Settings > Live voice.
- Test: node test/live-test.js (mock servers for both protocols).

New in 0.3.0
- "Hey Orbit" wake word: offline Vosk model (assets/vosk-model-small-en-us-0.15.tar.gz) in renderer/wake.js. Two-stage: a partial hit starts recording, the final result confirms (word confidence >= 0.92) or cancels. Opt-in: Settings > Hey Orbit. Test: electron --no-sandbox --ozone-platform=headless test/wake/run.js (needs espeak-ng wavs in /tmp).
- Phone (src/phone.js): ntfy (topic + "<topic>-reply" topic for answers/messages) and Telegram (own bot, 6-digit pairing code, inline answer buttons, ignores other chats). Pings when idle/locked (phoneWhen, phoneIdleMinutes). Test: node test/phone-test.js (live ntfy + mocked Telegram).
- Windows app control (src/winui.js): UI Automation via PowerShell. Tools windows_list, window_focus, ui_snapshot, ui_click, ui_type, keys_send, mouse_click. Consequential clicks ask first.
- Installer: NSIS + ZIP. npm run dist:win. On Linux/ARM: ELECTRON_BUILDER_NSIS_DIR=$PWD/build/nsis-linux (must be absolute) (wrapper uses native makensis + electron-builder's NSIS 3.0.4 data; build/patch-nsis.js avoids Wine).

Build: npm install && npm run dist:win. Tests: node test/agent-test.js; ORBIT_BROWSER_PATH=/usr/bin/chromium node test/browser-test.js; screenshots: electron test/shot.js.
Data: %APPDATA%\Orbit (settings.json with encrypted keys, thread.json, tasks.json, memory/, browser-profile/).

## v0.4.1: fast voice tasks
- Instant actions (src/quick.js): open apps/sites, Google/YouTube search, play/pause/next/previous, volume, mute, lock run directly in milliseconds with no model loop. Gemini Live calls the quick_action tool; GPT-Live and plain "open X" orbit_task requests are matched by quick.parse().
- Voice tasks use Settings → "Model for voice tasks" (falls back to the fast model, then the main model), a trimmed 16-message context, a speed-first prompt, and jump ahead of queued scheduled tasks.
- Read-only tool calls in one step (web_search, fetch_url, read_file, list_dir, memory reads, screenshot…) run in parallel.
- Test: node test/speed-test.js; node test/live-test.js covers quick actions.

## v0.5.0: talk while it works, parallel tasks, Google, images, publishing
- Lanes (src/agent.js): main conversation; a side lane that answers instantly (fast model, read-only tools, task_status / tell_main / start_task / stop_task) when you message Orbit while it's busy; up to `maxWorkers` (default 3) background tasks, each with a private thread and its own tab in the shared browser (Browser(store, parent)). Desktop mouse/keyboard tools take turns via a lock. Results post back to the chat; side notes and corrections reach the main task at its next step without breaking tool-call pairing.
- Tools: start_task, task_status, wait_tasks, stop_task, tell_main; gmail_search/read/send (send needs approval, draft_only option), calendar_events/create/delete; generate_image (OpenAI-style /images/generations, saves to Pictures\Orbit); publish_site (Netlify file-digest deploy, src/publish.js).
- Voice tasks from Live now run as background tasks, so several can run at once.
- Google sign-in (src/google.js): Desktop-app OAuth client (client ID + secret in Settings → Accounts), PKCE + loopback, encrypted refresh token. Scopes: gmail.modify, calendar.events.
- UI: running-task chips above the composer (with stop), separate turns for background and quick answers, Settings → Accounts card, "Background tasks at once".
- Tests: node test/parallel-test.js, node test/google-oauth-test.js, ORBIT_BROWSER_PATH=/usr/bin/chromium node test/tabs-test.js; screenshots: electron test/shot-v5.js.
- Still can't: run while the laptop is off (it lives on your PC).

## v0.6.0: Orbit Voice, built in
- New default live engine `orbit`: on-device ears and voice, your own chat model as the brain. No voice key.
  - renderer/voice/worker-src.js (bundled by build/bundle-voice.js into renderer/voice/worker.js): two Web Workers from one bundle. "ears" = Silero VAD (onnx-community/silero-vad) + Moonshine base (or Whisper base for Hindi/Hinglish); "voice" = Kokoro-82M (onnx-community/Kokoro-82M-v1.0-ONNX), WebGPU when available, else multithreaded WASM. Also computes simple prosody (loudness, pitch, pace vs. your baseline) and pre-renders backchannel clips (mm-hmm, yeah, right, hmm).
  - src/voice-cache.js: 127.0.0.1 server that downloads models (Hugging Face) and the ORT wasm (jsDelivr) once into userData/models, then serves offline. ~250 MB first run.
  - src/live.js `orbit` engine: turn() / interrupt({heard|merge}) / talking(); streams the brain's reply sentence-by-sentence to TTS (first clause cut at a comma for speed), quick_action + orbit_task (background) tools, spoken task results, "humanize" prompt, prosody cues.
  - renderer/live.js: barge-in (stops audio instantly, sends what you actually heard), keep-talking merge, backchannels on pauses, a soft "hmm" if the brain is slow.
- Chat read-aloud uses Orbit Voice: "Speak replies out loud" and a Listen button on every reply.
- Settings → Live voice: Orbit Voice option, voice picker (Kokoro voices), hearing model, "Hear this voice".
- Tests: node test/orbit-voice-test.js (engine), electron test/voice-e2e.js (real models: Kokoro speaks, VAD + Moonshine hear it back; set ORBIT_MODELS to a cache dir).

## Building from the repo
The wake-word model (assets/vosk-model-small-en-us-0.15.tar.gz, about 40 MB) isn't in git. Download https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip, unzip it, and run `tar czf assets/vosk-model-small-en-us-0.15.tar.gz vosk-model-small-en-us-0.15`. The Release workflow does this for you. Push a `v*` tag and it builds the Windows zip and attaches it to a GitHub release.
