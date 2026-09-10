# WinControl

A Winamp-skinned **remote control** for whatever is playing on your Mac.
It plays no audio itself, and it never touches Spotify's protocol — zero ToS
exposure.

Works with: the Spotify app, Bandcamp / YouTube / SoundCloud tabs in Safari or
Chrome, Apple Music — anything that shows up in macOS "Now Playing".

macOS only (Apple Silicon or Intel). The EQ needs macOS 14.2+.

## Setup

1. Install [Node.js](https://nodejs.org) (LTS is fine).

2. Recommended — install the media backend (this is what reaches browser tabs):

   ```
   brew tap ungive/media-control
   brew install media-control
   ```

   Without it, WinControl falls back to AppleScript and can only control the
   Spotify desktop app.

3. Install and run:

   ```
   npm install
   npm start
   ```

It starts on the bundled Winamp5 Classified skin with a Bandcamp Daily playlist.
Both are just defaults — see below.

## Skins

It ships with one skin, **Winamp5 Classified** — the one it opens on. The rest
of `renderer/skins/` is gitignored: skins are other people's artwork, and
everyone wants their own set.

Grab any classic `.wsz` from [skins.webamp.org](https://skins.webamp.org/) and
either:

- **drag it onto the player** for a one-off swap, or
- **drop it in `renderer/skins/`** to get it in the Skin menu (restart) and in
  the random-skin pool (`⌘R`, or the shuffle button — no restart needed).

*Skin ▸ Use This Skin as Default* remembers the one you want to open with.

## Feeds

The playlist window shows an RSS feed, not next tracks. Edit `feeds.json` in the
project root (also gitignored — it's a personal list):

```json
[{ "name": "Bandcamp Daily", "url": "https://daily.bandcamp.com/feed" }]
```

The Feeds menu picks between entries and notices edits without a restart.
*Add Feed…* (`⌘⇧A`) and the playlist's `+` button append to the same file.
Double-click a headline to open it; **MISC ▸ File Info** opens the feed's site.

Packaged, `feeds.json` and `settings.json` live in
`~/Library/Application Support/WinControl/` instead.

## What the controls do

| Control | Does |
|---|---|
| Play / pause / stop / prev / next | the real player |
| Track marquee, clock, position bar | the real player (position bar seeks) |
| Volume slider | macOS **system** output volume |
| Balance slider | stereo balance of the default output device |
| EQ sliders | a real **system-wide 10-band EQ** |
| Shuffle button | loads a random skin |
| Playlist `+` / SEL | add a feed / pick a feed |

Real playback shuffle and repeat are in the **Playback** menu, not on the
buttons.

Keys: `⌘P` play-pause · `⌘.` stop · `⌘←`/`⌘→` prev/next · `⌘R` random skin ·
`⌘O` load a skin file · `⌘G` EQ · `⌘E` playlist · `⌘T` time mode ·
`⌘=`/`⌘-`/`⌘0` zoom · `⌘⇧R` refresh feed · `⌘⇧A` add feed.

## First run on macOS

- The **first click** on play may raise an Automation prompt ("Electron wants
  to control Spotify"). Allow it — that's the AppleScript fallback. Manage it
  later under System Settings → Privacy & Security → Automation.
- Moving an EQ slider starts a system audio tap and may raise a microphone /
  audio-capture prompt. Return the EQ to flat and the tap is torn down.
- The window is frameless and transparent; drag it by the skin's title bar,
  exactly like Winamp.

## How it works

- `renderer/` — [Webamp](https://github.com/captbaritone/webamp) renders the
  skin. Its playlist holds one silent WAV and playback is never started; the
  skin's display is driven by dispatching into Webamp's store, and clicks are
  intercepted and forwarded over IPC.
- `main.js` — runs `media-control` (MediaRemote via
  [mediaremote-adapter](https://github.com/ungive/mediaremote-adapter)), falling
  back to `osascript -e 'tell application "Spotify" to playpause'`. Also owns
  the menu bar, the feed fetch, and the two audio helpers.
- `helper/balance.c`, `helper/eqtap.m` — small CoreAudio binaries for stereo
  balance and the 10-band EQ (`AudioHardwareCreateProcessTap`: no driver, no
  admin prompt, and the default output device is never changed). Both are
  compiled on first use, so the Command Line Tools are needed in dev.

`CLAUDE.md` is the real engineering log — the invariants, the measured traps,
and the things already ruled out. Read it before changing anything.

## Building

```
npm run dist
```

Produces `dist/WinControl-<version>-<arch>.dmg` for the host architecture. Only
the one default skin goes in; your own skins, feeds and preferences stay out —
a clean default install.

The build is **unsigned and not notarized**, so on another Mac Gatekeeper will
refuse it: right-click → Open, or
`xattr -dr com.apple.quarantine /Applications/WinControl.app`.
`media-control` stays a `brew` prerequisite; it is not bundled.

## License

MIT — see [LICENSE](LICENSE). Winamp skins are the property of their authors and
none are distributed here.
