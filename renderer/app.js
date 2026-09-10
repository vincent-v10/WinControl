// app.js - renders the Winamp skin and turns it into a remote control.
// Webamp never plays audio here: its playlist holds one silent dummy track and
// the transport buttons are rerouted to macOS Now Playing over IPC.
//
// The time display is driven straight from Webamp's redux store (a documented
// public field) rather than by playing anything. Deliberate: the dummy track is
// one second long, so anything that actually starts playback -- including
// setTracksToPlay -- ends after a second and resets the clock. Dispatching
// SET_MEDIA_TAGS / SET_MEDIA_DURATION / UPDATE_TIME_ELAPSED updates the marquee,
// the seek bar and the digits while playback stays STOPPED and nothing fights us.

/* global Webamp */

const DUMMY_TRACK = {
  metaData: { artist: "WinControl", title: "ready" },
  url: "silence.wav",
  duration: 1,
};

const webamp = new Webamp({
  initialTracks: [DUMMY_TRACK],
  // Startup skin: Skin > Use This Skin as Default, persisted by main in
  // settings.json and handed over as argv so it's readable here synchronously.
  // null means Webamp's own base skin, so no initialSkin at all. The switchable
  // list lives in listSkins() in main.js, which builds the Skin menu --
  // availableSkins only feeds Webamp's suppressed right-click menu.
  initialSkin: window.controller.settings.skin
    ? { url: window.controller.settings.skin }
    : undefined,
  enableHotkeys: false,
  windowLayout: {
    main:      { position: { top: 0,   left: 0 } },
    equalizer: { position: { top: 116, left: 0 } },
    // Open, and 4 sprite increments taller than base (29px each) so it shows
    // ~12 headlines instead of 4. 232 + 116 + 4*29 = 464, just inside the 470
    // content height in main.js.
    playlist:  { position: { top: 232, left: 0 }, size: { extraHeight: 4, extraWidth: 0 } },
  },
});

// Handlers return { ok, error } so the listener below can report failures the
// same way regardless of which one ran.
const INTERCEPTS = {
  "#play": () => window.controller.send("play-pause"),
  "#pause": () => window.controller.send("play-pause"),
  "#next": () => window.controller.send("next"),
  "#previous": () => window.controller.send("previous"),
  "#stop": () => window.controller.send("stop"),
  // Repurposed: shuffling a playlist of one silent track does nothing, so this
  // shuffles the skin instead. Playback shuffle is in the Playback menu.
  "#shuffle": () => window.controller.randomSkin(),
  // Repurposed: the "+" menu would add files to a playlist that must hold none.
  // Swallowing the click also keeps its add-url/dir/file submenu from opening.
  "#playlist-add-menu": () => askFeedUrl(),
  // Repurposed: select all/none/invert means nothing on a list of headlines,
  // so SEL picks the feed instead. The menu itself is native, built in main.
  "#playlist-selection-menu": () => window.controller.feedMenu(),
  // Repurposed: File Info is an alert("Not supported in Webamp") here, so the
  // MISC menu's second entry opens the current feed's site instead. Main owns
  // which URL that is. The MISC button itself is left alone, so the menu opens
  // as Winamp's does and Sort List / Misc Options still work.
  // Swallowing this click also swallows the one that would close the menu
  // (PlaylistMenu toggles itself on a bubbled click), so close it by hand: a
  // click on body reaches Webamp's useOnClickAway -- a document-capture
  // listener, so stopPropagation on *our* document listener doesn't stop it --
  // and body is outside #webamp, i.e. "away".
  "#playlist-misc-menu .file-info": () => {
    document.body.dispatchEvent(new MouseEvent("click"));
    return window.controller.feedHome();
  },
};

function installIntercepts() {
  // One capture-phase listener; swallow the click before Webamp reacts.
  document.addEventListener(
    "click",
    (e) => {
      for (const [selector, handler] of Object.entries(INTERCEPTS)) {
        if (e.target.closest(selector)) {
          e.stopPropagation();
          e.preventDefault();
          handler().then((res) => {
            if (!res.ok) console.warn(`${selector} failed:`, res.error);
          });
          return;
        }
      }
    },
    true
  );
}

// ---------------------------------------------------------------- playback time

let np = null;       // last poll result, or null until the first one lands
let seeking = false; // user is dragging the position bar; don't fight them
let lastLabel = "";
// The dummy track's id, captured once. paint() writes the now-playing tags onto
// this pinned id rather than reading state.playlist.currentTrack every time, so
// a stray selection or drop can't send the song title somewhere else.
let dummyId = null;

// Position now, extrapolated from the last poll. Pure so the self-check below
// can exercise it: `elapsed` was true at `elapsedAt`, so add the wall time since.
function extrapolate(info, now) {
  if (!info) return 0;
  const drift = info.playing ? ((now - info.elapsedAt) / 1000) * info.rate : 0;
  return Math.max(0, Math.min(info.duration || Infinity, info.elapsed + drift));
}

// Webamp builds the marquee as "<playlist number>. <track>", and the dummy is
// deliberately kept out of the playlist so the list holds only headlines --
// which makes that number 0 (`trackOrder.indexOf(currentTrack)` is -1).
// getMarqueeText checks state.userInput.userMessage before anything else, and
// nothing in Webamp ever dispatches SET_USER_MESSAGE (grepped), so that slot is
// ours to own. Cleared whenever a control has focus, or the readouts Webamp
// puts there itself -- "Volume: 50%", the scrub position, the EQ bands -- would
// never get through. Driven from the store subscription as well as from paint(),
// so grabbing a slider swaps the text at once instead of up to 500ms later.
let marqueeText = null;
let lastMessage;

function syncMarquee() {
  const wanted = webamp.store.getState().userInput.focus ? null : marqueeText;
  if (wanted === lastMessage) return;
  lastMessage = wanted;
  webamp.store.dispatch(wanted == null
    ? { type: "UNSET_USER_MESSAGE" }
    : { type: "SET_USER_MESSAGE", message: wanted });
}

function paint() {
  if (!np || seeking) return;
  const id = dummyId;
  if (id == null) return;

  const label = np.artist ? `${np.artist} - ${np.title}` : np.title;
  if (label !== lastLabel) {
    lastLabel = label;
    document.title = label;
    webamp.store.dispatch({ type: "SET_MEDIA_TAGS", id, title: np.title, artist: np.artist || "" });
    if (np.duration) {
      webamp.store.dispatch({ type: "SET_MEDIA_DURATION", id, duration: np.duration });
    }
    // Webamp's own format, minus the playlist number it can't produce here.
    marqueeText = np.duration ? `${label} (${timeStr(np.duration)})` : label;
  }
  syncMarquee();
  syncStatus();
  // floor, not round: 132.9s is 2:12 everywhere else -- rounding showed 2:13,
  // i.e. the skin ran a second ahead of the player it is reading.
  webamp.store.dispatch({ type: "UPDATE_TIME_ELAPSED", elapsed: Math.floor(extrapolate(np, Date.now())) });
}

// The digits are hidden while the player is STOPPED -- which is the state this
// app deliberately never leaves, so the clock ticked into an invisible element.
// It's CSS in the bundle (`#webamp .stop .webamp-status #time { display: none }`)
// and, in shade mode, <MiniTime> blanking itself, so neither is reachable from
// a dispatch. Mirror the *real* player's status instead; the play/pause
// indicator stops lying as a side effect.
//
// IS_PLAYING is the one status action mediaMiddleware's switch does NOT act on
// (it handles PLAY / PAUSE / STOP -- grepped), so it moves the skin without
// touching the audio element: measured, no <audio> is ever created and the
// 1s dummy still never runs. PAUSE does reach media.pause(), a no-op on an
// element that never played, but its statusChange emits one UPDATE_TIME_ELAPSED
// of 0 -- harmless only because paint() dispatches the real elapsed right after
// this call. Keep that order.
function syncStatus() {
  const want = np.playing ? "PLAYING" : "PAUSED";
  if (webamp.store.getState().media.status === want) return;
  webamp.store.dispatch({ type: np.playing ? "IS_PLAYING" : "PAUSE" });
}

// mm:ss, matching the "(5:30)" Webamp appends to the marquee itself.
function timeStr(secs) {
  const s = Math.round(secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function poll() {
  const info = await window.controller.nowPlaying();
  if (info && info.title) np = info;
}

// Webamp's own seek would only move the silent dummy track, so drive the real
// player instead. Delegated, because React can replace #position on re-render.
function installSeek() {
  document.addEventListener("pointerdown", (e) => {
    if (e.target.id === "position") seeking = true;
  }, true);

  // Capture phase, and 'pointerup' rather than 'change' -- both are load-bearing.
  // #position is a *controlled* React input, and Webamp commits from onPointerUp:
  // SEEK_TO_PERCENT_COMPLETE (which seeks the 1s dummy, so timeElapsed becomes
  // ~0.7) plus UNSET_FOCUS, which drops displayedPosition back from the scrub
  // position to the real one. React 18 flushes discrete events synchronously, so
  // by the time the event has bubbled from React's root to document the value is
  // already reset. Measured, one drag to 73%:
  //   pointerup capture -> value 73, focus "position"
  //   pointerup bubble  -> value 0,  focus null
  // 'change' fires later still, so the bubble-phase 'change' listener this
  // replaces read 0 and seeked every drag to the start of the track.
  // 'input' would spam a command per pixel.
  document.addEventListener("pointerup", (e) => {
    if (e.target.id !== "position") return;
    seeking = false;
    // Webamp's own commit is pure damage here: SEEK_TO_PERCENT_COMPLETE seeks the
    // 1s dummy, so timeElapsed lands at ~0.7 and the thumb snaps to the start
    // until paint()'s next 250ms tick moves it back -- visible as a flash to the
    // front of the bar. Capture + stopPropagation is the house idiom for killing
    // a Webamp behaviour; UNSET_FOCUS is the only half of it worth keeping, or
    // displayedPosition stays pinned to scrubPosition and the thumb never tracks
    // the player again. Both run before the np guard below: with no now-playing
    // data there is nothing to seek to, but the flash would still happen.
    e.stopPropagation();
    webamp.store.dispatch({ type: "UNSET_FOCUS" });
    if (!np || !np.duration) return;
    const secs = (Number(e.target.value) / 100) * np.duration;
    // Assume it took; the next poll corrects us if it didn't.
    np.elapsed = secs;
    np.elapsedAt = Date.now();
    // Same dispatch batch as the UNSET_FOCUS above, so no frame is ever rendered
    // between the two showing the thumb at 0.
    paint();
    window.controller.send("seek", secs).then((res) => {
      if (!res.ok) console.warn("seek failed:", res.error);
    });
  }, true);
}

// ----------------------------------------------------------------------- volume
// Webamp's volume slider would only change the gain on the silent dummy track,
// so mirror it onto the macOS system output volume instead (main.js explains
// why that, and not media-control).
//
// Watched on the store rather than on the slider's DOM events: SET_VOLUME is
// where every path lands -- the main slider (whose <input> has no id, only its
// wrapper div does), the EQ shade slider #equalizer-volume, and the mouse wheel
// over the main window. One subscriber covers all three.

let lastVolume = null;      // last value we've seen/sent; also suppresses the seed echo

// Dragging a slider dispatches per pixel and every backend call costs real time
// (~40ms for an osascript, ~10ms for the balance helper), so cap each action at
// one command in flight and park only the newest value. Debouncing instead
// would make the control move only after the drag stops.
function throttled(action) {
  let inFlight = false;
  let pending = null;
  const run = (v) => {
    inFlight = true;
    window.controller.send(action, v).then((res) => {
      if (!res.ok) console.warn(`${action} failed:`, res.error);
      inFlight = false;
      if (pending !== null) {
        const next = pending;
        pending = null;
        run(next);
      }
    });
  };
  return (v) => { if (inFlight) pending = v; else run(v); };
}

const sendVolume = throttled("volume");

async function installVolume() {
  const res = await window.controller.send("volume", "get");
  if (res.ok && res.volume >= 0) {
    // Set lastVolume first: the dispatch below wakes the subscriber, and there's
    // no point sending the system its own volume straight back.
    lastVolume = res.volume;
    webamp.store.dispatch({ type: "SET_VOLUME", volume: res.volume });
  } else {
    lastVolume = webamp.store.getState().media.volume;
    if (!res.ok) console.warn("volume read failed:", res.error);
  }

  webamp.store.subscribe(() => {
    const v = webamp.store.getState().media.volume;
    if (v === lastVolume) return;  // fires on every action; most aren't ours
    lastVolume = v;
    sendVolume(v);
  });
}

// ---------------------------------------------------------------------- balance
// Webamp's balance would only pan the silent dummy track, so it goes to the
// CoreAudio balance of the default output device instead -- same reach as the
// volume slider. main.js and helper/balance.c cover why that one needs a
// compiled helper and which property each kind of device answers to.
//
// Store units are -100..100, the helper speaks -1..1. No detent needed here:
// Webamp's own setBalance already clips anything under |25| to dead centre,
// exactly like Winamp's slider did. Watched on the store for the same reason
// volume is -- one subscriber covers every way the value can move.

const sendBalance = throttled("balance");
let lastBalance = null;

async function installBalance() {
  const res = await window.controller.send("balance", "get");
  if (res.ok) {
    // lastBalance first: the dispatch below wakes the subscriber, and there's
    // no point sending the device its own pan straight back.
    lastBalance = Math.round(res.balance * 100);
    webamp.store.dispatch({ type: "SET_BALANCE", balance: lastBalance });
  } else {
    // No StereoPan and no per-channel volume (measured: DELL S2725DS), or no
    // clang to build the helper. The slider still moves, it just does nothing.
    lastBalance = webamp.store.getState().media.balance;
    console.warn("balance read failed:", res.error);
  }

  webamp.store.subscribe(() => {
    const b = webamp.store.getState().media.balance;
    if (b === lastBalance) return;  // fires on every action; most aren't ours
    lastBalance = b;
    sendBalance(b / 100);
  });
}

// --------------------------------------------------------------------- eq
// The EQ sliders used to be the one control with nothing behind it: Webamp's own
// equalizer filters the silent dummy track. They now drive a real system-wide EQ
// through helper/eqtap.m -- see main.js for how (a CoreAudio process tap, muting
// the originals and re-emitting them filtered).
//
// Watched on the store, for the same reason volume and balance are: the value
// can move from the ten sliders, the preamp, the EQ window's presets, the ON
// button, "auto", and the shade-mode mini sliders. All of them land in
// state.equalizer, so one subscriber covers every route in.
//
// Webamp's Band type (built/types/js/types.d.ts:47) is Winamp's own frequency
// set, and eqtap.m uses exactly the same list in the same order -- so slider N
// really is band N, with no mapping table in between.
const EQ_BANDS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
const sendEq = throttled("eq");
let lastEq = null;

function installEqualizer() {
  webamp.store.subscribe(() => {
    const { on, sliders } = webamp.store.getState().equalizer;
    // Sliders are 0..100 with 50 flat; Winamp's range is +/-12 dB.
    const dB = (v) => ((Number(v) || 0) - 50) / 50 * 12;
    const payload = { on, gains: EQ_BANDS.map((f) => dB(sliders[f])), preamp: dB(sliders.preamp) };
    // Off is one state, not one per curve: dragging a slider with the EQ off
    // must not keep re-sending. main.js treats flat as off for the same reason.
    const key = on ? JSON.stringify(payload) : "off";
    if (key === lastEq) return;   // fires on every action; most aren't ours
    lastEq = key;
    sendEq(payload);
  });
}

// ------------------------------------------------------------------- rss feed
// Headlines go in the playlist window as tracks that will never be played:
// ADD_TRACK_FROM_URL is a plain reducer action, so a row costs one dispatch and
// zero network requests (verified: nothing but silence.wav is ever fetched).
// The real article link is kept out of the store, in feedItems.

const FEED_BASE_ID = 9000;  // well clear of Webamp's own 0,1,2… track ids
const FEED_MAX = 25;
const FEED_REFRESH_MS = 15 * 60 * 1000;

let feedItems = new Map(); // track id -> { title, link }

// DOMParser is native and handles both flavours: RSS puts the URL in <link>'s
// text, Atom puts it in <link href>.
function parseFeed(xml) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) return [];
  return [...doc.querySelectorAll("item, entry")].map((n) => {
    const link = n.querySelector("link");
    return {
      title: (n.querySelector("title")?.textContent || "(untitled)").trim().replace(/\s+/g, " "),
      link: (link?.getAttribute("href") || link?.textContent || "").trim(),
    };
  });
}

async function loadFeed() {
  const res = await window.controller.feed();
  if (!res.ok) {
    console.warn("feed failed:", res.error);
    return { ok: false, error: res.error };
  }
  const items = parseFeed(res.xml).slice(0, FEED_MAX);
  if (!items.length) return { ok: false, error: "no <item>/<entry> found - is that a feed URL?" };

  // Drop the previous batch. The dummy is already out of trackOrder, so this
  // leaves the list holding nothing but the incoming headlines.
  const stale = [...feedItems.keys()];
  if (stale.length) webamp.store.dispatch({ type: "REMOVE_TRACKS", ids: stale });

  feedItems = new Map();
  items.forEach((item, i) => {
    const id = FEED_BASE_ID + i;
    feedItems.set(id, item);
    webamp.store.dispatch({
      type: "ADD_TRACK_FROM_URL",
      atIndex: null,
      id,
      defaultName: item.title,
      duration: null,   // blank duration column
      // Deliberately not item.link: nothing should be able to fetch this, and
      // "feed:" has no handler.
      url: `feed:${i}`,
    });
  });
  // Adding tracks one dispatch at a time can leave the list auto-scrolled to
  // the bottom, depending on when React re-renders between them -- so with a
  // real (slow) feed it sometimes opened showing the oldest headlines. Pin it
  // back to the top; newest first is the point of a feed.
  webamp.store.dispatch({ type: "SET_PLAYLIST_SCROLL_POSITION", position: 0 });
  return { ok: true, count: items.length };
}

// Prompt for a feed URL and reload the list with it. A cancel is not a
// failure, so it reports ok and changes nothing.
//
// The field is in-page (#feed-prompt in index.html), not an osascript
// `display dialog`: spawning osascript took the better part of a second to
// put a field on screen and drew an unstyled system dialog on top of the
// skin. Nothing needs suppressing to type in it -- Webamp installs no
// document-level key handlers at all (grepped the bundle: its only global
// listeners are click/mousemove/touch, for menus and sliders). Paste does
// need `{ role: "editMenu" }` in main.js, though: without those roles macOS
// has no Cmd+V accelerator registered and the shortcut is simply dead in a
// frameless Electron window.
function askFeedUrl() {
  const panel = document.getElementById("feed-prompt");
  const input = document.getElementById("feed-url");
  const hint = panel.querySelector(".hint");

  panel.hidden = false;
  hint.textContent = "enter to add · esc to cancel";
  hint.classList.remove("error");
  input.focus();

  return new Promise((resolve) => {
    const close = (res) => {
      panel.hidden = true;
      input.value = "";
      window.removeEventListener("keydown", onKey, true);
      resolve(res);
    };

    async function onKey(e) {
      if (e.key !== "Enter" && e.key !== "Escape") return;
      // These two are ours whatever has focus; nothing else should see them.
      e.stopPropagation();
      e.preventDefault();
      const url = input.value.trim();
      if (e.key === "Escape" || !url) return close({ ok: true });

      // The scheme check stays in main: this URL comes from outside, and one
      // guard there covers the article links too.
      const res = await window.controller.addFeed(url);
      if (!res.ok) {
        // Stay open so a typo can be fixed instead of retyped.
        hint.textContent = res.error.replace(/^\w*Error:\s*/, "");
        hint.classList.add("error");
        return;
      }
      close(await loadFeed());
    }

    // On window rather than on the input: a click on the skin moves focus out
    // of the field, and Esc has to still close the panel when it does.
    window.addEventListener("keydown", onKey, true);
  });
}

// Double-clicking a playlist row is Winamp's "play this one". Verified what
// Webamp does with a row it can't play: it takes over currentTrack, flips
// status to PLAYING and walks down the list looking for something playable.
// So swallow the double-click and open the article instead.
function installFeedClicks() {
  document.addEventListener("dblclick", (e) => {
    const cell = e.target.closest("#playlist-window .playlist-track-titles .track-cell");
    if (!cell) return;
    e.stopPropagation();
    e.preventDefault();

    // Webamp only renders the rows currently scrolled into view, so the cell's
    // position among its siblings is not its position in the playlist. The row
    // text is "12. Some headline" -- that number is the 1-based playlist index,
    // which stays correct however the list is scrolled or reordered.
    const n = parseInt(cell.textContent, 10);
    if (!n) return;
    const id = webamp.store.getState().playlist.trackOrder[n - 1];
    const item = feedItems.get(id);
    if (!item) return;
    if (!item.link) {
      console.warn("feed item has no link:", item.title);
      return;
    }
    window.controller.openLink(item.link).then((r) => {
      if (!r.ok) console.warn("openLink failed:", r.error);
    });
  }, true);
}

// The billboard scroll of a selected headline is CSS (index.html); the one
// thing it cannot work out for itself is the duration, because there is no
// length-to-time conversion in CSS. A fixed duration means a long headline
// scrolls faster than a short one, so the duration is measured here: the text
// travels the part of itself that doesn't fit, and at a fixed px/s that is the
// time it takes -- plus the two fixed-length waits, which for the same reason
// can't be keyframe stops either. See the easing below.
//
// This is also the overflow gate. With `--bb-time` unset the CSS `animation`
// shorthand is invalid at computed-value time, so animation-name falls back to
// `none` and a title that already fits never moves at all.
//
// It rides on the fit rAF because it wants exactly the same two things: run
// after the render that changed the row, and at most once per frame. And it has
// to keep running rather than fire once on selection -- Webamp renders only the
// rows scrolled into view, so the selected track moves to a different DOM node
// as the list scrolls, and the row's width changes on a resize.
const BILLBOARD_PX_PER_S = 75;    // the speed knob, and it is a real speed
const BILLBOARD_HOLD_S = 2;       // still at each end of a pass
// Below this there is nothing to read: the overflow is narrower than the "..."
// it would replace, so scrolling it is a few pixels of twitch. Ellipsis wins.
const BILLBOARD_MIN_PX = 12;

// Sweeps every rendered row, not just the selected one, to clear the duration
// off the rows that lost it: Webamp recycles these DOM nodes as the list
// scrolls, so a stale value left on one would be the next track's duration for
// a frame. Unselected rows cost a property read and no layout.
function syncBillboard() {
  const cells = document.querySelectorAll(
    "#playlist-window .playlist-track-titles .track-cell");
  for (const cell of cells) {
    const span = cell.firstElementChild;
    let time = "", ease = "", delay = "";   // getPropertyValue returns "" for unset
    if (span && (cell.classList.contains("selected") || cell.matches(":hover"))) {
      // The same two boxes the CSS compares -- 100% is the span's own width,
      // 100cqw the row's content box. No padding on either, so clientWidth is it.
      const row = cell.clientWidth;
      const travel = span.getBoundingClientRect().width - row;
      if (travel > BILLBOARD_MIN_PX) {
        const move = travel / BILLBOARD_PX_PER_S;
        const total = move + 2 * BILLBOARD_HOLD_S;
        time = `${total.toFixed(3)}s`;
        // The waits have to be a fixed two seconds, not a share of the
        // duration -- otherwise a long headline waits longer than a short one,
        // the same mistake a fixed duration makes with the speed. A keyframe
        // offset can't be a var(), so they live in the *easing* instead: flat,
        // a straight ramp (so still a constant speed), flat.
        const at = (t) => ((t / total) * 100).toFixed(3);
        ease = `linear(0 0%, 0 ${at(BILLBOARD_HOLD_S)}%, ` +
               `1 ${at(BILLBOARD_HOLD_S + move)}%, 1 100%)`;
        // ...and the front wait is then skipped exactly once, by starting the
        // animation as if it had already been running for it. A negative delay
        // only shifts the timeline, so every iteration after the first plays
        // the easing whole, which is the asymmetry wanted: move the moment you
        // touch the row, wait 2s before each repeat.
        delay = `-${BILLBOARD_HOLD_S}s`;
      }
    }
    // Keyed on the duration alone: the easing is derived from the same
    // measurement, so it can't be stale while that matches, and a short
    // numeric string is the one of the two that round-trips through
    // getPropertyValue for sure.
    if (cell.style.getPropertyValue("--bb-time") === time) continue;
    if (time) {
      cell.style.setProperty("--bb-time", time);
      cell.style.setProperty("--bb-ease", ease);
      cell.style.setProperty("--bb-delay", delay);
    } else {
      for (const prop of ["--bb-time", "--bb-ease", "--bb-delay"]) {
        cell.style.removeProperty(prop);
      }
    }
  }
}

// The one trigger the store subscription can't provide: a hover dispatches
// nothing at all. Delegated on document because Webamp's rows don't exist yet
// at startup and are recycled as the list scrolls. `mouseout` matters as much
// as `mouseover` -- leaving the list for another window fires no mouseover on a
// row, and without it the last row hovered would keep scrolling.
//
// Selection needs nothing extra: React commits `.selected` synchronously inside
// the discrete event that dispatched it, i.e. before the frame the store
// subscription's rAF measures in. Verified over 12 clicks, the duration was
// written on frame 0 every time -- so no class observer, which an earlier
// misread of a flaky harness had briefly put here.
function installBillboardHover() {
  for (const evt of ["mouseover", "mouseout"]) {
    document.addEventListener(evt, (e) => {
      if (e.target.closest("#playlist-window .playlist-track-titles")) queueFit();
    });
  }
}

// ------------------------------------------------------------------ window fit
// The BrowserWindow is sized to the skin, not the other way round -- and the
// stack's layout is ours, not Webamp's. This packs the open windows top-down at
// x=0 and reports the total to main, which scales it by the zoom factor. Without
// it the window is a fixed 320x470 and the skin floats in transparent dead space
// (measured: 23px each side, 6px below), and dragging the playlist's resize grip
// grows the list under a window that doesn't follow.
//
// Packing, not measuring a bounding box, because a bounding box has holes in it:
// closing the EQ out of the middle of the stack left its 116px as transparent
// dead space inside the window. Winamp does that too, but there the windows
// float on the desktop -- here the window *is* the stack, so a hole is a hole.
// Webamp's windows can't be dragged apart anyway (index.html puts the OS drag
// region on every title bar), so top-down at x=0 is the only layout there is.
//
// Positions are compared against the *store*, never against the DOM: a rounded
// height that the DOM reports back a fraction off would otherwise re-dispatch
// itself every frame. `absolute: true` also pins the startup centering off for
// good (it's what put the stack at left=23) -- see getPositionsAreRelative.

// Store window id -> the skin window's own div. The wrapper div that carries the
// position has no class, so match the child: it is what has a size, and it sits
// at 0,0 inside the wrapper. The playlist renders a different id in shade mode.
const STACK = [
  ["main", "#main-window"],
  ["equalizer", "#equalizer-window"],
  ["playlist", "#playlist-window, #playlist-window-shade"],
];

let lastFit = "";

function fitWindow() {
  const positions = {};
  let width = 0, y = 0;
  for (const [id, sel] of STACK) {
    const el = document.querySelector(sel);
    if (!el) continue;  // closed windows unmount
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    positions[id] = { x: 0, y };
    y += Math.ceil(box.height);
    width = Math.max(width, Math.ceil(box.width));
  }
  if (!y) return;  // every window closed: keep the last size
  const g = webamp.store.getState().windows.genWindows;
  const moved = Object.entries(positions).some(
    ([id, p]) => g[id].position.x !== p.x || g[id].position.y !== p.y
  );
  if (moved) {
    webamp.store.dispatch({ type: "UPDATE_WINDOW_POSITIONS", positions, absolute: true });
  }
  const key = `${width}x${y}`;
  if (key === lastFit) return;
  lastFit = key;
  window.controller.fit(width, y);
}

// Sizes live in the store (WINDOW_SIZE_CHANGED, TOGGLE_WINDOW, shade), but the
// DOM they produce is one render behind it -- so measure on the next frame, and
// only once per frame however many actions land in it.
let fitQueued = false;
function queueFit() {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    fitWindow();
    syncBillboard();   // same trigger, same frame -- see above
  });
}

// Webamp only listens for drops on its own skin windows, and the window used to
// be bigger than the skin (which sits horizontally centred), so a .wsz dropped
// on the transparent dead space around it falls through to Chromium -- which
// navigates to the file and blanks the UI until restart. Webamp's own handlers
// have already run by the time the event bubbles here, so cancelling the default
// is safe for hits and misses alike.
function blockStrayDrops() {
  for (const evt of ["dragover", "drop"]) {
    document.addEventListener(evt, (e) => e.preventDefault());
  }
}

// The menu bar in main.js drives these. Webamp's own right-click menu is
// suppressed: it renders inside this small overflow:hidden window, so it gets
// clipped near the edges. Delete the contextmenu listener to get it back.
function installMenuCommands() {
  // Capture phase + stopPropagation: preventDefault alone only kills the native
  // browser menu, Webamp's own React handler still runs and renders its menu.
  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
  }, true);

  window.controller.onMenu((cmd, arg) => {
    switch (cmd) {
      case "skin":
        if (arg) webamp.setSkinFromUrl(arg);
        else webamp.store.dispatch({ type: "LOAD_DEFAULT_SKIN" });
        break;
      case "window":
        webamp.store.dispatch({ type: "TOGGLE_WINDOW", windowId: arg });
        break;
      case "icon":
        iconMode = arg;
        syncDockIcon();
        break;
      case "timemode":
        webamp.store.dispatch({ type: "TOGGLE_TIME_MODE" });
        break;
      case "add-feed":
        askFeedUrl().then((r) => {
          if (!r.ok) console.warn("add feed failed:", r.error);
        });
        break;
      case "feed":
        loadFeed().then((r) => {
          if (!r.ok) console.warn("feed refresh failed:", r.error);
        });
        break;
      default:
        console.warn("unknown menu command:", cmd);
    }
  });
}

// Self-check for the clock math: deterministic, so it either always passes or
// always fails. Throws loudly in the console if someone breaks extrapolate().
function checkExtrapolate() {
  const t = 1000000;
  const base = { elapsed: 100, elapsedAt: t, rate: 1, duration: 442, playing: true };
  const eq = (got, want, msg) => {
    if (Math.abs(got - want) > 0.01) throw new Error(`extrapolate ${msg}: ${got} != ${want}`);
  };
  eq(extrapolate(base, t), 100, "no drift at t0");
  eq(extrapolate(base, t + 5000), 105, "5s of drift");
  eq(extrapolate({ ...base, playing: false }, t + 5000), 100, "paused must not drift");
  eq(extrapolate({ ...base, rate: 2 }, t + 5000), 110, "double speed");
  eq(extrapolate(base, t + 9990000), 442, "clamped to duration");
  eq(extrapolate({ ...base, elapsed: -5, playing: false }, t), 0, "clamped at zero");
  eq(extrapolate(null, t), 0, "no data yet");
}

// -------------------------------------------------------------- dock icon
// The Dock icon is `renderer/icon-32.png` -- the chosen app icon, the real
// 32x32 Winamp 2.95 one -- re-hued to whatever skin is loaded, on a tile in
// the skin's own window-border colour. So it stays the same icon, it just
// changes colour with the Skin menu, #shuffle, a .wsz drop or Cmd+O.
//
// Recolouring beats shipping pre-made variants here, and it's also the cheaper
// half: the art is 32x32, i.e. 1024 pixels, so a full re-hue is a 1024-step
// loop -- less work than deciding which of N files to fetch, and it covers
// every hue instead of the N that got drawn. Measured cost of a whole repaint
// is in the notes; it happens once per skin change, never per frame.
//
// This only repaints the *running* app's icon. `build/icon.icns` is still what
// Finder, the Dock's "Keep in Dock" entry and the dmg show; a running app
// cannot rewrite its own bundle icon, so the two are necessarily separate.
const ICON_PX = 1024;       // icns's largest slot, so macOS never has to upscale
const ICON_SRC = "icon-32.png";
const ICON_MIN_SAT = 0.25;  // below this the skin has no accent worth using

const rgbTriple = (s) => (String(s).match(/\d+/g) || []).slice(0, 3).map(Number);
const satOf = ([r, g, b]) => {
  const v = Math.max(r, g, b);
  return v ? (v - Math.min(r, g, b)) / v : 0;
};

const loadImage = (src) => new Promise((res, rej) => {
  const i = new Image();
  i.onload = () => res(i);
  i.onerror = rej;
  i.src = src;
});

// The skin's accent: the most saturated entry in viscolor.txt, brightest first
// on a tie, ignoring anything too dark to have a readable hue. Webamp parses
// that file into state.display.skinColors as "rgb(r,g,b)" strings, so this
// opens no zip and reads no file. It's the *visualizer* palette -- which is
// never shown here, the visualizer is pinned to NONE -- but it is the one place
// a skin author states their accent colours as colours, and empirically it
// matches the skin: Hello Kitty pink, Zelda green, The Furnace cyan.
// null means leave the icon alone: a greyscale ramp (SONY3 tops out at 0.15,
// Bento at 0.21) would wash the bolt out to white rather than recolour it.
function skinAccent(colors) {
  const best = (colors || [])
    .map(rgbTriple)
    .filter((c) => c.length === 3 && Math.max(...c) >= 60)
    .sort((a, b) => satOf(b) - satOf(a) || Math.max(...b) - Math.max(...a))[0];
  return best && satOf(best) >= ICON_MIN_SAT ? best : null;
}

// Branch-free re-hue, in place: out = ((1 - s) + s * t) * v, per channel, where
// s and v are the pixel's own saturation and value and t is the accent
// normalised to its brightest channel (so a dark navy accent still gives a
// vivid blue). It is the identity for greys (s = 0), which is what keeps the
// black diamond black and the silver bevel silver; it gives the full accent hue
// at s = 1, which is the bolt; and the bolt's near-white hot core stays
// near-white. Brightness is carried by v, so the art's internal shading
// survives. No HSL round trip, no lookup table.
function recolour(data, accent) {
  const m = Math.max(...accent);
  const t = [accent[0] / m, accent[1] / m, accent[2] / m];
  for (let i = 0; i < data.length; i += 4) {
    const v = Math.max(data[i], data[i + 1], data[i + 2]);
    if (!v) continue;
    const s = (v - Math.min(data[i], data[i + 1], data[i + 2])) / v;
    for (let c = 0; c < 3; c++) data[i + c] = ((1 - s) + s * t[c]) * v;
  }
}

let iconArt = null;   // loaded once; the file never changes

// accent=null is Skin > App Icon > Default Icon: the art exactly as it ships,
// i.e. what build/icon.icns holds. It's painted here rather than loaded from
// the bundle because nativeImage cannot read an .icns at all (measured:
// createFromPath returns an empty image).
//
// No background: the icon is the bolt on transparency, like the original, so
// the Dock shows the shape and not a tile. The skin therefore reaches the icon
// through the accent and nothing else.
async function paintDockIcon(accent) {
  iconArt ??= await loadImage(ICON_SRC);

  // Recolour at source size -- 32x32 is 1024 pixels, against 1M if this ran at
  // icon size -- then upscale by an integer factor so the pixels stay hard.
  const scale = Math.max(1, Math.floor(ICON_PX / iconArt.width));
  const art = document.createElement("canvas");
  art.width = iconArt.width;
  art.height = iconArt.height;
  const actx = art.getContext("2d");
  actx.drawImage(iconArt, 0, 0);
  if (accent) {
    const px = actx.getImageData(0, 0, art.width, art.height);
    recolour(px.data, accent);
    actx.putImageData(px, 0, 0);
  }

  const c = document.createElement("canvas");
  c.width = c.height = ICON_PX;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingEnabled = false;   // pixel art, at 32x here

  const w = iconArt.width * scale, h = iconArt.height * scale;
  ctx.drawImage(art, (ICON_PX - w) / 2, (ICON_PX - h) / 2, w, h);
  window.controller.dockIcon(c.toDataURL());
}

// Watched on the store, like volume/balance/EQ: the skin can change from the
// Skin menu, from #shuffle, from a .wsz drop or from Cmd+O, and all of them
// land on the same state.
//
// Gated on skinColors by *reference*, plus the mode. Reference because the
// subscriber runs on every dispatch and that keeps it O(1) -- Webamp builds a
// fresh array per skin load (parseViscolors spreads DEFAULT_SKIN.colors), and
// hands back the one shared DEFAULT_SKIN.colors for LOAD_DEFAULT_SKIN, so the
// identity moves exactly when the skin does. skinAccent() then runs only on a
// real change. Re-picking the same skin re-parses and so repaints once; that's
// the whole cost of not hashing anything.
//
// It must NOT be gated on skinImages.MAIN_WINDOW_BACKGROUND, which is what it
// used to key on when the icon still had a tile: for Webamp's **base skin**
// that value is the empty string, so with `skin: null` in settings.json the
// gate never opened and the Dock kept Electron's own icon in dev. skinColors
// is populated for the base skin ([214,90,0], the classic ramp).
let iconMode = window.controller.settings.icon || "skin";
let syncDockIcon = () => {};

function installDockIcon() {
  let lastColors = null;
  let lastThemed = null;
  syncDockIcon = () => {
    const { skinColors } = webamp.store.getState().display;
    const themed = iconMode === "skin";
    if (skinColors === lastColors && themed === lastThemed) return;
    lastColors = skinColors;
    lastThemed = themed;
    paintDockIcon(themed ? skinAccent(skinColors) : null)
      .catch((e) => console.warn("dock icon:", e));
  };
  webamp.store.subscribe(syncDockIcon);
  syncDockIcon();   // the initial skin is already loaded by the time this runs
}

webamp.renderWhenReady(document.getElementById("app")).then(async () => {
  checkExtrapolate();
  dummyId = webamp.store.getState().playlist.currentTrack;
  // Take the dummy out of the playlist so the window holds nothing but
  // headlines, numbered from 1. It stays in state.tracks (that reducer has no
  // REMOVE_TRACKS case at all) and stays playlist.currentTrack, which is what
  // the marquee, the duration and the seek bar actually read -- only the
  // trackOrder array feeds the list. SET_TRACK_ORDER doesn't touch currentTrack.
  webamp.store.dispatch({ type: "SET_TRACK_ORDER", trackOrder: [] });
  // Start the visualizer off. It has nothing to show -- the dummy <audio> never
  // plays -- but Webamp only skips its rAF loop at VISUALIZERS.NONE; at any
  // other style it redraws the background and paints a flat line every frame
  // for as long as the real player is PLAYING. Measured: 13.9% of a core on a
  // 120Hz screen, 78% of the whole app's running cost, for a flat line.
  // The canvas stays mounted and keeps its onClick, so clicking the vis area
  // still cycles it back. VISUALIZER_ORDER is [BAR, OSCILLOSCOPE, NONE].
  while (webamp.store.getState().display.visualizerStyle !== 2) {
    webamp.store.dispatch({ type: "TOGGLE_VISUALIZER_STYLE" });
  }
  webamp.store.subscribe(syncMarquee);
  webamp.store.subscribe(queueFit);
  fitWindow();
  installIntercepts();
  installSeek();
  installVolume();
  installBalance();
  installEqualizer();
  blockStrayDrops();
  installMenuCommands();
  installFeedClicks();
  installBillboardHover();
  installDockIcon();

  loadFeed();
  setInterval(loadFeed, FEED_REFRESH_MS);

  const info = await window.controller.backendInfo();
  if (!info.mediaControl) {
    console.warn(
      "media-control not found - falling back to AppleScript (Spotify app only).\n" +
      "For browser/Bandcamp control: brew tap ungive/media-control && brew install media-control"
    );
  } else {
    poll();
    setInterval(poll, 3000);  // metadata + a fresh position anchor
    // 250ms, not 500: the digits floor, so the tick rate is how late a second
    // can flip over. A quarter second is under what you can catch next to
    // Spotify's own clock; the dispatch is a reducer write and a small render.
    setInterval(paint, 250);  // ticks the digits between polls
  }
});
