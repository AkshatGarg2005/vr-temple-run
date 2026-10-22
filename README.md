# Relic Run

A Temple Run–style endless runner for the browser, with phone VR and tilt controls. Built with three.js and no image or model files: every texture, model, and sound is generated in code.

## Run it

```bash
node server.js
```

- **On this computer:** open http://localhost:8080
- **On your phone** (same Wi-Fi): open the `https://<your-ip>:8443` address the server prints, and accept the certificate warning once. Phones only give the gyroscope to pages served over HTTPS, so the `http://` address won't work for tilt or VR on a phone.

The first run creates a self-signed certificate in `.cert/`. To play without the warning, host the folder on any HTTPS static host (GitHub Pages, Netlify, Vercel).

## Controls

| | Keyboard | Phone | Phone VR (headset, first person) |
|---|---|---|---|
| Look around | | | Move your head freely |
| Change lane | ← → (between junctions) | Tilt the phone | Facing forward, tilt your head left or right; hold it level for the centre lane |
| Turn at a junction | ← → | Swipe left / right | Automatic. At a fork you take the side you're looking towards |
| Jump | ↑ or Space | Swipe up | Jump for real (a screen tap also works) |
| Slide | ↓ | Swipe down | Crouch for real |
| Pause | P / Esc | Pause button | Pause button (top centre) |

In Phone VR, the phone's accelerometer detects real jumps and crouches:

- **Calibration:** every time you enter Phone VR you're asked to stand still, jump once, then crouch once. The detector tunes itself to your movements and your phone. Tap the screen to skip a step, and defaults are used for it.
- **Feedback:** during the run, `▲ JUMP` or `▼ SLIDE` flashes in the score bar each time a real jump or crouch is detected.
- **What counts as a jump:** a push-off followed by a moment of free fall. Nodding, looking around, small bobs and marching in place don't trigger it. Jogging hard in place can.
- **What counts as a crouch:** your head moving down quickly by a real distance.
- **Tuning:** if moves are missed or fire too easily, change **Body sensing** on the title screen (Low / Normal / High). Open the page with `?debug` (e.g. `https://<your-ip>:8443/?debug`) to see the live sensor readings and the current thresholds.
- **"Motion sensor not responding":** the browser isn't sending motion data. Use the `https://` address and allow motion access when asked. On iPhone this is Safari's prompt; if you denied it earlier, clear the site's data in Settings → Safari and try again.

**Recenter view** (Phone VR): if "straight ahead" drifts, recenter in any of these ways:

- **Hands-free:** face the way you want to go and look down at your feet for about 2 seconds. A ring in the middle of the view fills up, then the view recenters.
- **Headset button:** press and hold it (a long press on the screen).
- **On-screen button:** tap the ⟲ button next to the pause button.
- **Pause menu:** choose **Recenter view**.

On a WebXR headset, click the thumbstick.

After a run ends in Phone VR, jump to start again.

**Hints** (title screen, on by default): before each root, gap, fallen log or fire trap, an arrow cue says **Jump** or **Slide** ("Crouch" in Phone VR). It appears dimmed as a "get ready" warning, then turns green with a short sound at the moment to act. In Phone VR the cue appears on a panel over the path, and earlier than on a normal screen, because a real jump or crouch takes longer to detect than a key press.

`C` switches between the chase camera and first person when playing on a normal screen. On a WebXR headset with tracking (e.g. Quest), **Enter VR** appears on the title screen and your real head height drives jumps and crouches. The thumbstick changes lanes, the trigger jumps and the grip slides.

## Rules

Turn at every junction or you hit the temple wall. Jump over roots and gaps, slide under fallen logs and fire traps, and steer around stone blocks. Clipping a root or the edge of a block makes you stumble and brings the guardians close behind you. Stumble again within 7 seconds and they catch you. Coins add to your score, the multiplier goes up every 750 m, and the red magnet pulls in nearby coins.

## Graphics

The game always runs at its highest quality: sun shafts, lens flare, bloom, film-style colour grading, soft shadows, flickering firelight, high-resolution stone with ambient occlusion and roughness maps, swaying vines and ferns, waterfalls, bird flocks, and a sky with a moon and stars. To keep the frame rate smooth, the rendering resolution adjusts itself automatically, and on very slow devices the sun shafts switch off. In a WebXR headset, post-processing is skipped because the browser draws straight to the headset.

## Files

- `app.js`: startup, menus, VR session handling, main loop
- `js/game.js`: rules, runner physics, cameras, head and controller gestures
- `js/world.js`: endless track generator, obstacles, coins, scenery
- `js/builders.js`, `js/textures.js`: procedural models and textures
- `js/atmosphere.js`: sky, fog, mountains, cloud sea, jungle canopy
- `js/render.js`: bloom, colour grading, split-screen stereo
- `js/characters.js`: the explorer and the guardians
- `js/motion.js`: real jump / crouch detection from the accelerometer
- `js/input.js`, `js/audio.js`, `js/particles.js`, `js/hud3d.js`
- `server.js`: local HTTP/HTTPS server
