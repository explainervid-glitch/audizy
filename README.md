# Audizy

A CEP panel for Adobe After Effects that makes audio cutting fast and visual. Precompose an audio layer, then edit it on a waveform timeline inside the panel — cut, trim, and move clips without twirling layers open in the AE timeline.

## Features

- **Precompose workflow** — select an audio layer and precompose it in one click. The precomp is stamped with a layer marker (`Audizy Precomp`) so the panel recognizes and reloads it later, with no manual selection.
- **Waveform timeline** — the panel decodes the audio (Web Audio API) and draws a min/max waveform envelope per clip. No need to expand `Audio > Waveform` in AE.
- **Non-linear editing** — all edits map to real trimmed layers *inside the precomp*, so the main comp stays clean:
  - **Cut** (Razor tool / `Ctrl+K`) — split a clip at the cursor or playhead.
  - **Trim** — hover a clip edge and drag to trim in/out (source-anchored, clamped to the source length).
  - **Move** — drag a clip freely to any time.
  - **Delete** — remove the selected clip.
- **Playhead sync** — the panel playhead follows the precomp's current time and writes it back to AE.
- **Undo aware** — the panel polls the precomp and refreshes when AE undo/redo changes the clips.
- **Log panel** — captures errors and messages, with copy to clipboard.

## Tools

| Tool | Shortcut |
| --- | --- |
| Selection | `V` |
| Razor | `C` |
| Hand (pan) | `H` — or hold the middle mouse button |
| Cut at playhead | `Ctrl+K` |
| Delete clip | `Delete` / `Backspace` |
| Fit to window | `F` |
| Zoom | `+` / `-`, or `Ctrl` + mouse wheel |

## Install (development)

1. Enable unsigned CEP extensions. After Effects 2026 uses CSXS 12 (set 11 as well to be safe):

   ```
   reg add "HKCU\Software\Adobe\CSXS.12" /v PlayerDebugMode /t REG_SZ /d 1 /f
   reg add "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f
   ```

2. Symlink (or copy) this folder into the CEP extensions directory. The link name must match the `ExtensionBundleId` in `CSXS/manifest.xml` (`com.audizy.panel`):

   ```
   mklink /D "%APPDATA%\Adobe\CEP\extensions\com.audizy.panel" "<path>\com.audizy.panel"
   ```

   (Run in an elevated `cmd`, or with Windows Developer Mode on.)

3. Restart After Effects and open `Window > Extensions > Audizy`.

## Usage

1. Add an audio layer to a composition and select it.
2. Click the **Precompose** icon in the sidebar. The audio is precomposed and its waveform appears on the panel timeline.
3. Cut, trim, and move clips on the timeline. Every edit updates the layers inside the precomp.
4. Reopen the panel later on the same comp — the stamped precomp loads automatically.

## Project structure

```
com.audizy.panel/
├── CSXS/manifest.xml   Extension manifest (AEFT host, Node enabled)
├── index.html          Panel markup
├── css/styles.css      Theme
├── js/
│   ├── CSInterface.js  Adobe CEP bridge
│   ├── icons.js        Inline SVG tool icons
│   ├── waveform.js     File read + Web Audio decode + waveform drawing
│   └── main.js         Timeline UI, tools, edit logic
└── jsx/audizy.jsx      ExtendScript backend (precompose, cut/trim/move, state)
```

## How it works

- The panel talks to After Effects through `CSInterface.evalScript`, calling ExtendScript functions in `jsx/audizy.jsx`.
- Audio is read via CEP's `cep.fs.readFile` (Base64), falling back to Node `fs`, then decoded with the Web Audio API for the waveform.
- The edit list drives `azApply`, which rebuilds the precomp's audio layers as trimmed footage layers at their comp positions. The layers themselves are the source of truth, so edits survive reload and undo.

## Requirements

- After Effects with CEP (2024 or later; developed against 2026).
- Windows or macOS.

## License

Proprietary. All rights reserved.
