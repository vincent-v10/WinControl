// main.js - Electron main process.
// Creates a transparent, frameless window that hosts the Webamp skin UI,
// and bridges button clicks to macOS media commands.
//
// Backend priority:
//   1. media-control (brew install: `brew tap ungive/media-control && brew install media-control`)
//      -> controls whatever is in macOS "Now Playing": Spotify, Safari/Chrome tabs (Bandcamp!), Music, etc.
//   2. AppleScript to the Spotify app (works out of the box, Spotify only).

const { app, BrowserWindow, Menu, dialog, ipcMain, nativeImage, shell } = require("electron");
const { execFile, spawn } = require("child_process");
const { pathToFileURL } = require("url");
const fs = require("fs");
const path = require("path");

// Before ready, or the app menu keeps saying "Electron".
app.setName("WinControl");

// Homebrew paths aren't in Electron's PATH when launched from Finder, so probe directly.
const MEDIA_CONTROL_CANDIDATES = [
  "/opt/homebrew/bin/media-control", // Apple Silicon
  "/usr/local/bin/media-control",    // Intel
];
const mediaControlBin = MEDIA_CONTROL_CANDIDATES.find((p) => {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
});

function runMediaControl(args) {
  return new Promise((resolve, reject) => {
    execFile(mediaControlBin, args, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

// 5s: nothing here may hang the UI. Every osascript call in this app is a
// volume get/set or a Spotify verb -- the one that used to wait on a human
// (the feed URL dialog) is now an in-page field, see askFeedUrl in app.js.
function runOsascript(script) {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: 5000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

// ------------------------------------------------------------------- balance
// The one control that needs compiled code. CoreAudio's balance properties are
// unreachable from osascript -- the framework ships no BridgeSupport metadata
// for AudioObject*, so even `osascript -l JavaScript` can't call it -- and
// media-control has no balance command (MediaRemote doesn't model one).
// helper/balance.c documents the two device routes it tries and the one
// ('vmbl') that answers 'who?' on every device here.
//
// Built on first use with the clang that ships with the Command Line Tools,
// and cached next to its source: no build step for whoever clones this, and no
// architecture-specific binary committed.
// Packaged builds don't do this: `npm run dist` compiles both helpers first
// (scripts.helpers) and ships the binaries, because a bundle is read-only the
// moment it's signed or app-translocated. See helperBin's isPackaged branch.
const BALANCE = [path.join(__dirname, "helper", "balance.c"), path.join(__dirname, "helper", "balance"),
                 ["-framework", "CoreFoundation", "-framework", "CoreAudio"]];

// Shared by balance.c and eqtap.m: stat the binary against its source, shell
// out to clang when it's missing or stale, and cache the promise per binary.
const helperBuilds = new Map();

function helperBin(src, bin, flags) {
  // Shipped prebuilt by `npm run dist`; nothing to stat, nothing to build.
  if (app.isPackaged) return Promise.resolve(bin);

  if (!helperBuilds.has(bin)) {
    let fresh = false;
    try {
      fresh = fs.statSync(bin).mtimeMs >= fs.statSync(src).mtimeMs;
    } catch { /* not built yet */ }

    const build = fresh ? Promise.resolve(bin) : new Promise((resolve, reject) => {
      // Absolute path, for the same reason media-control is probed absolutely:
      // launched from Finder, Electron's PATH is not a login shell's.
      execFile("/usr/bin/clang",
        ["-fobjc-arc", "-O2", "-o", bin, src, ...flags],
        { timeout: 30000 },
        (err, _out, stderr) => err
          ? reject(new Error(`clang failed (Command Line Tools installed?): ${(stderr || err.message).trim()}`))
          : resolve(bin));
    });
    // Don't cache a failure forever: `xcode-select --install` plus one more
    // nudge of the slider should be enough to get it working.
    build.catch(() => helperBuilds.delete(bin));
    helperBuilds.set(bin, build);
  }
  return helperBuilds.get(bin);
}

// -1 (full left) .. 1 (full right). Remembered so a volume change can put it
// back -- see the volume branch of handleAction.
let lastBalance = 0;

async function runBalance(args) {
  const bin = await helperBin(...BALANCE);
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 5000 }, (err, stdout, stderr) =>
      (err ? reject(new Error((stderr || "").trim() || String(err))) : resolve(stdout)));
  });
}

// ------------------------------------------------------------------------ eq
// The last inert control on the skin. Webamp's own EQ filters the silent dummy
// track and nothing else, media-control has no EQ command, and macOS exposes no
// system EQ -- so this one carries real DSP: helper/eqtap.m asks CoreAudio for a
// copy of every process's audio, mutes the originals while it holds that copy
// (CATapMutedWhenTapped) and re-emits it filtered to the same output device.
//
// Unlike balance, the helper is a *persistent* process: it owns the tap for as
// long as the EQ is on, and killing it is what unmutes. So a flat EQ must not
// leave it running -- see the all-zero guard in handleAction. That is also the
// safety property worth keeping: no helper, no code in the audio path at all.
const EQTAP = [path.join(__dirname, "helper", "eqtap.m"), path.join(__dirname, "helper", "eqtap"),
               ["-framework", "Foundation", "-framework", "CoreAudio"]];

let eqProc = null;      // running helper, or null whenever the EQ is off
let eqWanted = false;   // ... which of the two it is, for the respawn below
let eqLine = null;      // last curve sent, replayed after a device-change exit
let eqSpawnedAt = 0;

function stopEq() {
  eqWanted = false;
  if (!eqProc) return;
  eqProc.stdin.end();   // EOF -> the helper destroys its tap and exits, which
  eqProc = null;        // is what puts audio back on the normal path.
}

async function sendEq(line) {
  eqWanted = true;
  eqLine = line;
  if (!eqProc) {
    const bin = await helperBin(...EQTAP);
    eqSpawnedAt = Date.now();
    const child = spawn(bin, [], { stdio: ["pipe", "ignore", "pipe"] });
    child.stderr.on("data", (d) => console.warn("eqtap:", String(d).trim()));
    child.on("error", (e) => { console.warn("eqtap spawn failed:", e.message); eqProc = null; });
    child.on("exit", (code) => {
      eqProc = null;
      // The helper exits 0 when the default output device changes: its aggregate
      // is built around one device, so it can't follow. Respawn against the new
      // one. Non-zero means it couldn't tap at all -- don't loop on that, and
      // don't loop if it just died on us either.
      if (eqWanted && code === 0 && eqLine && Date.now() - eqSpawnedAt > 1000) {
        sendEq(eqLine).catch(() => {});
      }
    });
    eqProc = child;
  }
  eqProc.stdin.write(line + "\n");
}

// verb: "playpause" | "play" | "pause" | "next track" | "previous track"
const runAppleScriptSpotify = (verb) =>
  runOsascript(`tell application "Spotify" to ${verb}`);

// action -> [media-control argv, AppleScript verb for the Spotify-only fallback]
const ACTIONS = {
  "play-pause": [["toggle-play-pause"], "playpause"],
  "play":       [["play"], "play"],
  "pause":      [["pause"], "pause"],
  "stop":       [["stop"], "pause"],  // Spotify's dictionary has no stop, only pause
  "next":       [["next-track"], "next track"],
  "previous":   [["previous-track"], "previous track"],
  // Routed to the real player, not to Webamp's inert indicators.
  "shuffle":    [["toggle-shuffle"], "set shuffling to not shuffling"],
  "repeat":     [["toggle-repeat"], "set repeating to not repeating"],
};

// Map controller actions -> backend commands. `arg` is only used by seek/volume.
async function handleAction(action, arg) {
  // Volume is the one action that never touches media-control: MediaRemote has
  // no volume concept and `media-control` exposes no such command (checked).
  // The macOS system output volume is the universal equivalent -- it moves
  // Spotify, browser tabs and Music alike, which is the same reach as the rest
  // of the remote. "get" seeds the slider so the first drag doesn't jump.
  if (action === "volume") {
    try {
      if (arg === "get") {
        // -1 on output devices with no software volume (some USB DACs,
        // aggregate devices). Passed through; the renderer skips seeding then.
        const out = await runOsascript("output volume of (get volume settings)");
        return { ok: true, volume: Number(out.trim()) };
      }
      const v = Math.max(0, Math.min(100, Math.round(Number(arg) || 0)));
      await runOsascript(`set volume output volume ${v}`);
      // Measured: that writes both channels to the same level, which centres
      // the balance on every device panned through per-channel volume (i.e.
      // everything without a StereoPan property). Put it back. Skipped at
      // centre, so the usual case costs nothing.
      if (lastBalance) await runBalance([String(lastBalance)]).catch(() => {});
      return { ok: true, backend: "applescript-system" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // Balance is the other action media-control can't do; it goes to CoreAudio
  // through the helper above. "get" seeds the slider, same as volume.
  if (action === "balance") {
    try {
      if (arg === "get") {
        lastBalance = Number((await runBalance([])).trim()) || 0;
        return { ok: true, balance: lastBalance };
      }
      const p = Math.max(-1, Math.min(1, Number(arg) || 0));
      await runBalance([String(p)]);
      lastBalance = p;
      return { ok: true, backend: "coreaudio" };
    } catch (e) {
      // Devices with neither property (measured: DELL S2725DS) land here every
      // time; the renderer warns once per drag and the slider still moves.
      return { ok: false, error: String(e) };
    }
  }

  // arg: { on, gains: [10 dB values], preamp }. A flat curve stops the helper
  // rather than running it: an all-pass tap would still mute and re-emit, i.e.
  // pay the latency for nothing. So "EQ off" and "EQ flat" are the same state,
  // which is also why there's no seeding "get" -- the EQ is ours, not the OS's.
  if (action === "eq") {
    try {
      const dB = (v) => Math.max(-12, Math.min(12, Number(v) || 0));
      const gains = Array.from({ length: 10 }, (_, i) => dB(arg && arg.gains ? arg.gains[i] : 0));
      const preamp = dB(arg && arg.preamp);
      if (!arg || !arg.on || (preamp === 0 && gains.every((g) => g === 0))) {
        stopEq();
        return { ok: true, eq: "off" };
      }
      await sendEq([...gains, preamp].map((g) => g.toFixed(2)).join(" "));
      return { ok: true, backend: "coreaudio-tap" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // seek carries a position, so it can't live in the static table above.
  const pos = Math.max(0, Number(arg) || 0);
  const [mc, verb] = action === "seek"
    ? [["seek", String(pos)], `set player position to ${pos}`]
    : (ACTIONS[action] || []);

  if (!mc) return { ok: false, error: `unknown action: ${action}` };

  if (mediaControlBin) {
    try {
      await runMediaControl(mc);
      return { ok: true, backend: "media-control" };
    } catch (e) {
      // fall through to AppleScript
    }
  }
  try {
    await runAppleScriptSpotify(verb);
    return { ok: true, backend: "applescript-spotify" };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Fetch now-playing metadata + position so the skin can show real time.
async function getNowPlaying() {
  if (!mediaControlBin) return null;
  try {
    // --no-artwork matters: without it every poll ships a few hundred KB of
    // base64 cover art through execFile and JSON.parse, for nothing.
    // ponytail: polling is fine at 3s; switch to `media-control stream` if the
    // process-per-poll ever shows up in Activity Monitor.
    const out = await runMediaControl(["get", "--no-artwork"]);
    const data = JSON.parse(out);
    // media-control prints a flat JSON object; be defensive about shape.
    const src = data.payload || data;
    if (!src.title) return null;
    return {
      title: src.title,
      artist: src.artist || null,
      duration: Number(src.duration) || 0,
      // elapsedTime was accurate at `timestamp`, not now. Shipping both lets the
      // renderer tick every second off a single 3s poll instead of polling faster.
      elapsed: Number(src.elapsedTime) || 0,
      elapsedAt: Date.parse(src.timestamp) || Date.now(),
      rate: src.playbackRate == null ? 1 : Number(src.playbackRate),
      playing: Boolean(src.playing),
    };
  } catch {
    return null;
  }
}

ipcMain.handle("media", (_evt, action, arg) => handleAction(action, arg));
ipcMain.handle("now-playing", () => getNowPlaying());
ipcMain.handle("backend-info", () => ({
  mediaControl: Boolean(mediaControlBin),
  path: mediaControlBin || null,
}));

// ------------------------------------------------------------------ rss feed
// The playlist window shows headlines instead of "next tracks" -- there is no
// next track, the playlist is one silent dummy file. The feeds themselves live
// in feeds.json next to this file: drop an entry in there and it appears in the
// Feeds menu without a restart (watchFile below rebuilds the menu on save).
// Feeds > Add Feed... and the playlist "+" button both prompt for one and
// append it to that same file. Cmd+Shift+R refreshes the current one.
// Packaged, it moves to Application Support: addFeed writes to this file, and
// a bundle is read-only under app translocation and invalidates its own
// signature if written to. readFeeds' ENOENT path covers the first run, so
// there is nothing to seed -- the packaged app starts on DEFAULT_FEED.
const FEEDS_FILE = app.isPackaged
  ? path.join(app.getPath("userData"), "feeds.json")
  : path.join(__dirname, "feeds.json");
const DEFAULT_FEED = { name: "Bandcamp Daily", url: "https://daily.bandcamp.com/feed" };

// Deliberately tolerant: this file is hand-edited, so a syntax error or one
// junk entry must not take the menu (or the app) with it -- bad entries are
// dropped and an empty list falls back to the default. httpUrl is the same
// scheme check article links get; a feed URL is outside input too.
function readFeeds() {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(FEEDS_FILE, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") console.warn(`${FEEDS_FILE}:`, String(e));
  }
  const feeds = (Array.isArray(list) ? list : [])
    .map((f) => {
      try {
        return { name: String(f.name || new URL(f.url).hostname), url: httpUrl(f.url) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return feeds.length ? feeds : [DEFAULT_FEED];
}

// Appends unless the URL is already listed. Name defaults to the host -- rename
// it by editing feeds.json, which is also how you delete one.
function addFeed(url) {
  const feeds = readFeeds();
  if (feeds.some((f) => f.url === url)) return;
  feeds.push({ name: new URL(url).hostname.replace(/^www\./, ""), url });
  fs.mkdirSync(path.dirname(FEEDS_FILE), { recursive: true });   // userData may not exist yet
  fs.writeFileSync(FEEDS_FILE, JSON.stringify(feeds, null, 2) + "\n");
}

// Poll-based on purpose: a save from an editor (and writeFileSync above)
// replaces the file, which kills an fs.watch handle but not a stat poll.
fs.watchFile(FEEDS_FILE, { interval: 2000 }, () => rebuildMenu());

let feedUrl = readFeeds()[0].url;

// Fetched here rather than in the renderer: that's a file:// page, so an https
// fetch from it is a null-origin CORS request and most feeds reject it.
// Parsing happens renderer-side, where DOMParser is free.
async function getFeed() {
  try {
    const res = await fetch(feedUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${feedUrl}` };
    return { ok: true, xml: await res.text() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

ipcMain.handle("feed", getFeed);

// Both URLs that enter this app come from outside -- article links from the
// feed, the feed URL from the dialog below -- and openExternal will launch
// anything with a handler registered (file:, mailto:, custom app schemes).
// Throws on anything that isn't plain http(s); callers report the message.
function httpUrl(url) {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`refused scheme: ${u.protocol}`);
  }
  return u.href;
}

function openLink(url) {
  try {
    shell.openExternal(httpUrl(url));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

ipcMain.handle("open-link", (_evt, url) => openLink(url));

// Repurposed File Info, the second entry of the playlist MISC menu -- on a list
// of headlines it means nothing, and Webamp's is an alert() saying exactly that,
// so it opens the current feed's site instead.
// Built from feedUrl *here*, so the renderer has no say in what gets opened --
// and it still goes through the same httpUrl scheme check every article link
// gets, because feeds.json is hand-edited. feedUrl is always a validated
// http(s) href: every write point runs it through httpUrl first.
ipcMain.handle("feed-home", () => openLink(new URL(feedUrl).origin));

// The one way the current feed changes, from either entry point: the Feeds menu
// (an existing entry, so addFeed is a no-op) and the ADD FEED field (a new one,
// so it gets remembered). rebuildMenu is what moves the radio dot.
function useFeed(url) {
  feedUrl = url;
  addFeed(url);
  rebuildMenu();
}

// Typed into the renderer's own field (#feed-prompt), which is why the URL is
// still validated here: it came from outside, and the renderer is not the
// place to decide what may be written to feeds.json. The message is shown in
// the field, so a bad URL is a normal return, not a throw.
ipcMain.handle("add-feed", (_evt, url) => {
  try {
    useFeed(httpUrl(url));
    return { ok: true, url: feedUrl };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// Scale: page zoom + matching window resize. Cmd+= / Cmd+- / Cmd+0.
// BASE is the skin's own size in CSS px, not a constant: the renderer measures
// the bounding box of Webamp's open windows and reports it (fitWindow in
// app.js), so the OS window tracks the skin through a playlist resize, a shade
// toggle or Cmd+G/Cmd+E. Seeded with the startup layout in app.js
// (main 116 + equalizer 116 + playlist 116+4*29) so the first frame is right.
let BASE = { width: 275, height: 464 };
let zoom = 1.5; // classic skin is tiny at 1x; one Cmd+- step below the old 2

function applyZoom(win, z) {
  zoom = Math.max(1, Math.min(3, z));
  win.webContents.setZoomFactor(zoom);
  win.setContentSize(Math.round(BASE.width * zoom), Math.round(BASE.height * zoom));
}

// The renderer owns the size; main only scales it. Fire-and-forget (send, not
// invoke) -- it runs on every playlist resize step and nothing needs an answer.
ipcMain.on("fit", (evt, width, height) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win || !width || !height) return;
  BASE = { width, height };
  applyZoom(win, zoom);
});

// The Dock icon is painted from the current skin by the renderer -- see
// paintDockIcon in app.js, which is where the canvas is. Send, not invoke, for
// the same reason as fit: nothing needs an answer. Only the running app's icon
// changes; build/icon.icns is what Finder and the dmg show, and a running app
// cannot rewrite that.
ipcMain.on("dock-icon", (_evt, dataUrl) => {
  const img = nativeImage.createFromDataURL(String(dataUrl));
  if (!img.isEmpty()) app.dock.setIcon(img);   // junk data URL -> empty, not a throw
});

// -------------------------------------------------------------------- about
// The standard macOS About panel draws NSApp's icon -- i.e. whatever the Dock
// currently holds, which here follows the skin -- and Electron cannot override
// that (setAboutPanelOptions' iconPath is Linux/Windows only). So About is a
// message box with the image passed in, which is the only way to show the
// *default* art while the Dock is hued.
// nativeImage.resize() smooths, and it cannot read build/icon.icns at all, so
// the 32x32 source is nearest-upscaled by hand exactly like paintDockIcon does
// in the renderer: integer scale, hard pixels.
const ABOUT_SCALE = 8; // 32 -> 256

function aboutIcon() {
  const src = nativeImage.createFromPath(path.join(__dirname, "renderer", "icon-32.png"));
  const { width, height } = src.getSize();
  if (!width) return undefined; // missing file -> a dialog without art beats no dialog
  const from = src.toBitmap();
  const w = width * ABOUT_SCALE, h = height * ABOUT_SCALE;
  const to = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = ((y / ABOUT_SCALE) | 0) * width;
    for (let x = 0; x < w; x++) {
      const i = (row + ((x / ABOUT_SCALE) | 0)) * 4;
      from.copy(to, (y * w + x) * 4, i, i + 4);
    }
  }
  return nativeImage.createFromBuffer(to, { width: w, height: h });
}

function showAbout(win) {
  dialog.showMessageBox(win, {
    type: "none",
    icon: aboutIcon(),
    title: `About ${app.name}`,
    // package.json, not app.getVersion(): that reads the *Electron* version
    // whenever the app path isn't the project root, which is how every harness
    // in scratchpad/ is launched.
    message: `${app.name} ${require("./package.json").version}`,
    detail: "A Winamp-skinned remote control for whatever macOS is playing.\nPlays no audio itself.",
    buttons: ["OK"],
  });
}

// ----------------------------------------------------------------- settings
// Two things the menus persist: which skin to open with, and whether the Dock
// icon follows it. Same directory as feeds.json -- next to the source in dev,
// Application Support when packaged -- and the same tolerance: it's a small
// JSON file that can be hand-edited, so junk falls back to the defaults instead
// of taking the app down with it.
const SETTINGS_FILE = path.join(path.dirname(FEEDS_FILE), "settings.json");

// Skins live in renderer/skins/. Just drop a .wsz in there -- the folder is read
// at startup for the Skin menu and again on every shuffle, so no code change is
// needed. The startup skin is set by initialSkin in app.js.
// The folder is gitignored and excluded from the build, so a fresh clone and a
// packaged app both have none: FALLBACK_SKIN is only used when it is actually
// on disk, otherwise the first launch is Webamp's own base skin.
const SKINS_DIR = path.join(__dirname, "renderer", "skins");
const FALLBACK_SKIN = "Winamp5_Classified_v5.5.wsz";

let settings = (() => {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return s && typeof s === "object" && !Array.isArray(s) ? s : {};
  } catch (e) {
    if (e.code !== "ENOENT") console.warn(`${SETTINGS_FILE}:`, String(e));
    return {};
  }
})();

// `skin` may legitimately be null -- that's Webamp's own base skin -- so
// presence, not truthiness, is what separates "unset" from "set to base".
const defaultSkin = () =>
  "skin" in settings ? settings.skin
    : fs.existsSync(path.join(SKINS_DIR, FALLBACK_SKIN)) ? `skins/${FALLBACK_SKIN}` : null;
const iconMode = () => (settings.icon === "default" ? "default" : "skin");

function saveSettings(patch) {
  settings = { ...settings, ...patch };
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });   // userData may not exist yet
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
  rebuildMenu();   // the radio dot and the enabled state both live in the template
}

function listSkins() {
  try {
    return fs.readdirSync(SKINS_DIR)
      .filter((f) => /\.(wsz|zip)$/i.test(f))
      .sort()
      // URL is relative to renderer/index.html; encode it, skin names are full
      // of spaces and brackets.
      .map((f) => ({ url: `skins/${encodeURIComponent(f)}`, name: f.replace(/\.(wsz|zip)$/i, "") }));
  } catch {
    return []; // folder missing entirely
  }
}

// Tracked so shuffle can avoid picking the skin that's already showing, and so
// "Use This Skin as Default" knows whether it has anything to do. Seeded with
// what the renderer is told to open with, which is the same value.
let currentSkin = defaultSkin();

function sendSkin(webContents, url) {
  currentSkin = url;
  webContents.send("menu", "skin", url);
  rebuildMenu();   // "Use This Skin as Default" greys out once it already is
}

// The renderer paints both icons (nativeImage cannot read .icns -- measured:
// createFromPath returns an empty image), so this is just: remember, and ask
// for a repaint. The renderer's dedupe key includes the mode, so it repaints
// even though the skin hasn't changed.
function setIconMode(win, mode) {
  saveSettings({ icon: mode });
  win.webContents.send("menu", "icon", mode);
}

// Repurposed skin shuffle button. Rereads the folder so newly added skins are
// picked up without a restart (the Skin menu still only lists what was there
// at launch).
function randomSkin(webContents) {
  const skins = listSkins();
  if (!skins.length) return { ok: false, error: `no .wsz files in ${SKINS_DIR}` };
  const pool = skins.filter((s) => s.url !== currentSkin);
  // Fall back to the full list when the current skin is the only one there.
  const from = pool.length ? pool : skins;
  const pick = from[Math.floor(Math.random() * from.length)];
  sendSkin(webContents, pick.url);
  return { ok: true, name: pick.name, of: skins.length };
}

ipcMain.handle("random-skin", (evt) => randomSkin(evt.sender));

async function pickSkin(win) {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Load Winamp Skin",
    filters: [{ name: "Winamp Skin", extensions: ["wsz", "zip"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths[0]) return;
  // pathToFileURL, not string concat: skin names are full of spaces and brackets.
  sendSkin(win.webContents, pathToFileURL(filePaths[0]).href);
}

// Webamp's own right-click menu is a DOM node inside a small frameless window
// with overflow:hidden, so it gets clipped (73px off the right edge near the
// window border) with no way to scroll to the hidden items. Same options, as a
// real macOS menu instead. The renderer suppresses the DOM one.
let mainWin = null;

// The Feeds submenu is data-driven (feeds.json) and carries a radio dot for the
// current feed, so the menu is rebuilt rather than mutated -- that's the only
// way to move a checkmark in a template-built Menu.
function rebuildMenu() {
  if (mainWin) Menu.setApplicationMenu(buildMenu(mainWin));
}

// Just the feeds: shared by the Feeds menu and the popup the playlist's SEL
// button opens, so there is one list and one place the radio dot is decided.
// The Refresh / Add Feed commands are the menu bar's, and are added there --
// the popup is a picker and holds nothing but the choices.
function feedItemsTemplate(win) {
  return readFeeds().map((f) => ({
    label: f.name,
    type: "radio",
    checked: f.url === feedUrl,
    click: () => {
      useFeed(f.url);
      win.webContents.send("menu", "feed");
    },
  }));
}

// Repurposed playlist SEL button (select all/none/invert is meaningless on a
// list of headlines). A *native* popup, not a DOM one: Webamp's own menus clip
// inside this small overflow:hidden window, an OS menu is its own window and
// doesn't. x/y default to the cursor, which is where the button is.
let feedPopup = null;

ipcMain.handle("feed-menu", (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false, error: "no window" };
  // Replace rather than stack: one harness run recorded two popups from a
  // single click (not reproduced since), and two stacked OS menus is a worse
  // outcome than a menu that just reopens.
  feedPopup?.closePopup(win);
  feedPopup = Menu.buildFromTemplate(feedItemsTemplate(win));
  feedPopup.popup({ window: win });
  return { ok: true };
});

function buildMenu(win) {
  const send = (cmd, arg) => () => win.webContents.send("menu", cmd, arg);
  const act = (action) => () => handleAction(action);
  const skin = (url) => () => sendSkin(win.webContents, url);

  return Menu.buildFromTemplate([
    // Spelled out rather than { role: "appMenu" }, for one item: the standard
    // About panel would show the Dock icon, which follows the skin.
    {
      label: app.name,
      submenu: [
        { label: `About ${app.name}`, click: () => showAbout(win) },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    // Not decoration: macOS routes Cmd+X/C/V/A through these roles, so without
    // an Edit menu they are unbound and a URL cannot be pasted into the field.
    { role: "editMenu" },
    {
      label: "Playback",
      submenu: [
        { label: "Play / Pause", accelerator: "CmdOrCtrl+P", click: act("play-pause") },
        { label: "Stop", accelerator: "CmdOrCtrl+.", click: act("stop") },
        { type: "separator" },
        { label: "Previous", accelerator: "CmdOrCtrl+Left", click: act("previous") },
        { label: "Next", accelerator: "CmdOrCtrl+Right", click: act("next") },
        { type: "separator" },
        { label: "Toggle Shuffle", click: act("shuffle") },
        { label: "Toggle Repeat", click: act("repeat") },
      ],
    },
    {
      label: "Skin",
      submenu: [
        {
          label: "Use This Skin as Default",
          // Greyed out when it already is -- which is also how the menu shows
          // you what the default currently is, without a second radio list.
          enabled: currentSkin !== defaultSkin(),
          click: () => saveSettings({ skin: currentSkin }),
        },
        {
          label: "App Icon",
          submenu: [
            { label: "Reflect Skin", type: "radio", checked: iconMode() === "skin",
              click: () => setIconMode(win, "skin") },
            { label: "Default Icon", type: "radio", checked: iconMode() === "default",
              click: () => setIconMode(win, "default") },
          ],
        },
        { type: "separator" },
        { label: "Load Skin…", accelerator: "CmdOrCtrl+O", click: () => pickSkin(win) },
        { label: "Random Skin", accelerator: "CmdOrCtrl+R", click: () => randomSkin(win.webContents) },
        { type: "separator" },
        ...listSkins().map((s) => ({ label: s.name, click: skin(s.url) })),
        { label: "Base Skin", click: skin(null) },
      ],
    },
    {
      label: "Feeds",
      submenu: [
        { label: "Refresh", accelerator: "CmdOrCtrl+Shift+R", click: send("feed") },
        // Opens the field in the renderer, which reloads the list itself once
        // main has accepted the URL -- so no send("feed") here.
        { label: "Add Feed…", accelerator: "CmdOrCtrl+Shift+A", click: send("add-feed") },
        { type: "separator" },
        ...feedItemsTemplate(win),
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => applyZoom(win, zoom + 0.5) },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => applyZoom(win, zoom - 0.5) },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => applyZoom(win, 1) },
        { type: "separator" },
        { label: "Equalizer", accelerator: "CmdOrCtrl+G", click: send("window", "equalizer") },
        { label: "Playlist", accelerator: "CmdOrCtrl+E", click: send("window", "playlist") },
        { type: "separator" },
        { label: "Toggle Time Remaining", accelerator: "CmdOrCtrl+T", click: send("timemode") },
      ],
    },
  ]);
}

function createWindow() {
  const win = new BrowserWindow({
    width: Math.round(BASE.width * zoom),
    height: Math.round(BASE.height * zoom),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    // Without this the window cannot reach the top of the screen: AppKit's
    // constrainFrameRect: clamps it to the work area, so it stops at the bottom
    // of the menu bar (measured: y=33 on this display, whether dragged or set
    // with setPosition, at every window level). The flag makes Electron skip
    // that constraint. Named for resizing, but it's the same hook.
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      zoomFactor: zoom,
      // Passed as argv rather than fetched over IPC because the renderer needs
      // them *synchronously*: `new Webamp({ initialSkin })` is built at script
      // scope, so an async invoke would mean either restructuring that or
      // opening on the fallback skin and flashing to the real one.
      additionalArguments: [
        `--wincontrol-settings=${JSON.stringify({ skin: defaultSkin(), icon: iconMode() })}`,
      ],
    },
  });
  // Deliberately NOT alwaysOnTop: it behaves like any other app window and
  // goes behind whatever you click next. It can still be dragged up under the
  // menu bar (enableLargerThanScreen), where the top of the skin will hide
  // behind it -- that's the price of not outranking the menu bar. Bringing
  // alwaysOnTop back means setAlwaysOnTop(true, "status"), one level above
  // "main-menu"; the plain flag only buys "floating", which is below it.
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  // Chromium remembers the zoom level per origin, so a single Cmd+- in some
  // earlier session came back on every launch -- while `zoom` here resets to 2
  // and sizes the window for 2. Measured: page at 1.5 inside a 2x window, i.e.
  // the skin adrift in 124px of dead space. applyZoom sets both, so re-running
  // it once the page is up is what keeps them agreeing.
  win.webContents.once("did-finish-load", () => applyZoom(win, zoom));
  // win.webContents.openDevTools({ mode: "detach" }); // uncomment to debug

  mainWin = win;
  rebuildMenu();
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
