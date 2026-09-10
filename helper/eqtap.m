// eqtap.m -- system-wide 10-band EQ for WinControl, via a CoreAudio process tap.
//
// The Winamp EQ sliders have nothing to equalise: this app plays no audio. So
// instead of touching Webamp's own (inert) EQ, we ask macOS for a copy of every
// process's audio output, mute the originals while we hold that copy, run it
// through ten biquads, and write the result to the real output device:
//
//     app --> macOS --X  muted at the source (CATapMutedWhenTapped)
//                     `--> tap --> 10 biquads --> default output device
//
// This is the same thing SoundSource does with its private driver, using the
// public API Apple shipped in 14.2. What it deliberately does NOT do:
//
//   - install a driver. Nothing lands in /Library, no admin prompt.
//   - change the default output device. It stays what it was, so the volume
//     slider (osascript) and helper/balance.c keep working, untouched, on the
//     real device -- downstream of us.
//   - appear anywhere. The tap and its aggregate are marked private, so they
//     are invisible in Sound settings and to other apps.
//
// eqMac's pre-14.2 route needed all three, plus a PID controller re-tuning an
// AVAudioUnitVarispeed to fight clock drift between its driver and the output
// device (bitgapp/eqMac, native/app/Source/Audio/Outputs/Output.swift:207).
// One aggregate containing both the tap and the device has a single clock, so
// kAudioSubTapDriftCompensationKey does that for free.
//
// Protocol: one line per update on stdin, eleven space-separated dB values --
// ten band gains then preamp. "quit" or EOF exits. Exit unmutes: the tap is
// owned by this process, so audio returns to the normal path when it dies,
// which makes a crash sound like "the EQ stopped" and not like "no more audio".
//
//   printf '0 0 3 0 0 0 0 0 -2 -2 0\nquit\n' | ./eqtap
//   ./eqtap selftest        # biquad math only, touches no device
//
// Build (main.js does this on first use, with the clang from the CLT):
//   /usr/bin/clang -fobjc-arc -O2 -o eqtap eqtap.m \
//       -framework Foundation -framework CoreAudio

#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/CATapDescription.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <stdatomic.h>
#import <signal.h>

// Webamp's own Band type, verbatim (built/types/js/types.d.ts:47) -- i.e.
// Winamp's frequencies, so slider N really is band N.
#define NBANDS 10
static const double kFreqs[NBANDS] = { 60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000 };

// ponytail: one Q for all ten bands. The top three (12k/14k/16k) are a third of
// an octave apart, so at Q=1 they overlap heavily and stack rather than shape.
// Per-band Q derived from neighbour spacing is the upgrade if it sounds bunched.
#define BAND_Q 1.0

// ---------------------------------------------------------------- gain channel
// The writer (stdin, main thread) only ever touches these. Individually atomic,
// so a block can never read a half-written value; it can read band 3's new gain
// beside band 7's old one for a single ~10ms block, which is inaudible and
// self-corrects. That is the whole reason there is no lock anywhere below.
static _Atomic float gGainDb[NBANDS];
static _Atomic float gPreampDb = 0;
static _Atomic int   gDirty = 1;

// ------------------------------------------------------------------- the maths
typedef struct { double b0, b1, b2, a1, a2; } Coeffs;   // already divided by a0
typedef struct { double z1, z2; } Biquad;               // transposed direct form II

// RBJ cookbook peaking EQ. At f0 the magnitude is exactly 10^(dB/20), which is
// what selftest asserts.
static Coeffs peaking(double f0, double q, double dB, double fs) {
  const double A     = pow(10.0, dB / 40.0);
  const double w0    = 2.0 * M_PI * f0 / fs;
  const double alpha = sin(w0) / (2.0 * q);
  const double cw    = cos(w0);
  const double a0    = 1.0 + alpha / A;
  Coeffs c = {
    (1.0 + alpha * A) / a0,
    (-2.0 * cw)       / a0,
    (1.0 - alpha * A) / a0,
    (-2.0 * cw)       / a0,
    (1.0 - alpha / A) / a0,
  };
  return c;
}

static inline double biquad(Biquad *s, const Coeffs *c, double x) {
  const double y = c->b0 * x + s->z1;
  s->z1 = c->b1 * x - c->a1 * y + s->z2;
  s->z2 = c->b2 * x - c->a2 * y;
  return y;
}

// One filter bank, owned by whoever is processing -- never shared, so changing
// gains never resets z1/z2 and therefore never clicks.
typedef struct {
  Coeffs c[NBANDS];
  Biquad s[2][NBANDS];   // [channel][band]
  double preampLin;
  int    active;         // 0 = everything flat, straight copy
  double fs;
} Bank;

static void bankRecompute(Bank *b) {
  int active = 0;
  const float pre = atomic_load_explicit(&gPreampDb, memory_order_relaxed);
  b->preampLin = pow(10.0, pre / 20.0);
  if (pre != 0.0f) active = 1;
  for (int i = 0; i < NBANDS; i++) {
    const float g = atomic_load_explicit(&gGainDb[i], memory_order_relaxed);
    // A band centred above Nyquist would be nonsense; leave it flat. Only
    // reachable on a device running below 32k, but it costs one comparison.
    const double f0 = kFreqs[i];
    b->c[i] = (f0 < b->fs * 0.5) ? peaking(f0, BAND_Q, g, b->fs) : peaking(1000, BAND_Q, 0, b->fs);
    if (g != 0.0f && f0 < b->fs * 0.5) active = 1;
  }
  b->active = active;
}

// ponytail: hard clip at full scale. Boosting a loud track will hit it; that is
// what the preamp slider is for, same as Winamp. Soft-knee limiting if anyone
// complains about the sound of it rather than about the level.
static inline float clip(double y) { return (float)(y > 1.0 ? 1.0 : (y < -1.0 ? -1.0 : y)); }

static void bankProcess(Bank *b, const float *in, int inCh, float *out, int outCh, int frames) {
  for (int f = 0; f < frames; f++) {
    double v[2];
    v[0] = in[f * inCh + 0];
    v[1] = (inCh > 1) ? in[f * inCh + 1] : v[0];
    if (b->active) {
      for (int ch = 0; ch < 2; ch++) {
        double x = v[ch] * b->preampLin;
        for (int i = 0; i < NBANDS; i++) x = biquad(&b->s[ch][i], &b->c[i], x);
        v[ch] = x;
      }
    }
    for (int ch = 0; ch < outCh; ch++)
      out[f * outCh + ch] = (ch < 2) ? clip(v[ch]) : 0.0f;
  }
}

// ---------------------------------------------------------------- diagnostics
// Written by the IOProc, read by `eqtap debug`. Plain atomics, no formatting on
// the audio thread.
static _Atomic long gBlocks = 0, gFrames = 0;
static _Atomic int  gInBufs = 0, gOutBufs = 0, gInCh = 0, gOutCh = 0;
static _Atomic int  gInPeak = 0, gOutPeak = 0;   // thousandths of full scale
static _Atomic long gInZeroX = 0, gOutZeroX = 0; // zero crossings, for an apparent-Hz check

// ------------------------------------------------------------------- self test
// Deterministic, and touches no audio device: feed a sine at each band centre
// through the cascade and check the measured gain is the requested one.
static double measureGain(double freq, double fs, int band, double dB, double preampDb) {
  for (int i = 0; i < NBANDS; i++) atomic_store(&gGainDb[i], 0.0f);
  atomic_store(&gPreampDb, (float)preampDb);
  if (band >= 0) atomic_store(&gGainDb[band], (float)dB);
  Bank b = {0}; b.fs = fs; bankRecompute(&b);

  const int n = 48000;
  float *in  = calloc(n * 2, sizeof(float));
  float *out = calloc(n * 2, sizeof(float));
  for (int f = 0; f < n; f++) {
    // 0.1 of full scale: probing at 1.0 sends every boost into the deliberate
    // hard clip below, which measures the clipper instead of the filter.
    const float s = 0.1f * (float)sin(2.0 * M_PI * freq * f / fs);
    in[f * 2] = s; in[f * 2 + 1] = s;
  }
  bankProcess(&b, in, 2, out, 2, n);
  // Second half only: the filter state has settled by then.
  double sin_ = 0, sout = 0;
  for (int f = n / 2; f < n; f++) { sin_ += in[f*2]*in[f*2]; sout += out[f*2]*out[f*2]; }
  free(in); free(out);
  return 20.0 * log10(sqrt(sout / sin_));
}

static int selftest(void) {
  int fails = 0;
  const double fs = 48000;
  #define CHECK(cond, fmt, ...) do { if (!(cond)) { printf("FAIL " fmt "\n", __VA_ARGS__); fails++; } \
                                     else printf("ok   " fmt "\n", __VA_ARGS__); } while (0)

  const double flat = measureGain(1000, fs, -1, 0, 0);
  CHECK(fabs(flat) < 0.05, "flat: 1kHz through ten flat bands = %+.3f dB (want 0)", flat);

  for (int i = 0; i < NBANDS; i++) {
    const double g = measureGain(kFreqs[i], fs, i, 6.0, 0);
    CHECK(fabs(g - 6.0) < 0.25, "band %d (%5.0f Hz) +6 dB -> %+.2f dB", i, kFreqs[i], g);
    const double c = measureGain(kFreqs[i], fs, i, -9.0, 0);
    CHECK(fabs(c + 9.0) < 0.25, "band %d (%5.0f Hz) -9 dB -> %+.2f dB", i, kFreqs[i], c);
  }

  const double pre = measureGain(1000, fs, -1, 0, -6.0);
  CHECK(fabs(pre + 6.0) < 0.05, "preamp -6 dB alone -> %+.2f dB", pre);

  // A band left flat must not be moved by its neighbours being flat either.
  const double bleed = measureGain(60, fs, 9, 12.0, 0);
  CHECK(fabs(bleed) < 0.5, "16kHz +12 dB does not move 60Hz (%+.2f dB)", bleed);

  printf("\n%s (%d failure%s)\n", fails ? "FAILED" : "PASSED", fails, fails == 1 ? "" : "s");
  return fails ? 1 : 0;
}

// ----------------------------------------------------------------- coreaudio
static AudioObjectID gTap = kAudioObjectUnknown;
static AudioObjectID gAgg = kAudioObjectUnknown;
static AudioDeviceIOProcID gProc = NULL;

static void teardown(void) {
  if (gProc && gAgg != kAudioObjectUnknown) {
    AudioDeviceStop(gAgg, gProc);
    AudioDeviceDestroyIOProcID(gAgg, gProc);
    gProc = NULL;
  }
  if (gAgg != kAudioObjectUnknown) { AudioHardwareDestroyAggregateDevice(gAgg); gAgg = kAudioObjectUnknown; }
  // Destroying the tap is what unmutes everything. It also happens for free if
  // we are killed -- the tap belongs to this process -- but do it properly when
  // we can, so the usual path leaves nothing behind for coreaudiod to reap.
  if (gTap != kAudioObjectUnknown) { AudioHardwareDestroyProcessTap(gTap); gTap = kAudioObjectUnknown; }
}

static void onSignal(int sig) { (void)sig; teardown(); _exit(0); }

// Our own AudioObjectID. A global tap MUST exclude us: the tap captures every
// process's output including this one's, and CATapMutedWhenTapped then mutes our
// re-emission along with the originals. Measured, with a -20 dBFS tone playing:
// input peak climbed 0.099 -> 1.1 and saturated while the speakers stayed silent.
// That is the "EQ on -> no sound" bug, and this is the whole fix.
static AudioObjectID selfProcessObject(void) {
  AudioObjectPropertyAddress a = { kAudioHardwarePropertyTranslatePIDToProcessObject,
                                   kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  pid_t me = getpid();
  AudioObjectID obj = kAudioObjectUnknown; UInt32 sz = sizeof(obj);
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, sizeof(me), &me, &sz, &obj) != noErr)
    return kAudioObjectUnknown;
  return obj;
}

static NSString *deviceUID(AudioObjectID dev) {
  AudioObjectPropertyAddress a = { kAudioDevicePropertyDeviceUID,
                                   kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  CFStringRef uid = NULL; UInt32 sz = sizeof(uid);
  if (AudioObjectGetPropertyData(dev, &a, 0, NULL, &sz, &uid) != noErr || !uid) return nil;
  return (__bridge_transfer NSString *)uid;
}

static double nominalRate(AudioObjectID dev) {
  AudioObjectPropertyAddress a = { kAudioDevicePropertyNominalSampleRate,
                                   kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
  Float64 sr = 0; UInt32 sz = sizeof(sr);
  return (AudioObjectGetPropertyData(dev, &a, 0, NULL, &sz, &sr) == noErr) ? (double)sr : 48000.0;
}

int main(int argc, const char **argv) {
  if (argc > 1 && strcmp(argv[1], "selftest") == 0) return selftest();

  @autoreleasepool {
    AudioObjectPropertyAddress dfltAddr = { kAudioHardwarePropertyDefaultOutputDevice,
                                            kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    AudioObjectID out = kAudioObjectUnknown; UInt32 sz = sizeof(out);
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &dfltAddr, 0, NULL, &sz, &out) != noErr) {
      fprintf(stderr, "eqtap: no default output device\n"); return 1;
    }
    NSString *outUID = deviceUID(out);
    if (!outUID) { fprintf(stderr, "eqtap: output device has no UID\n"); return 1; }

    // Refuse to run rather than tap ourselves: an unexcluded global tap is the
    // silent-feedback state, which is worse than no EQ.
    const AudioObjectID me = selfProcessObject();
    if (me == kAudioObjectUnknown) {
      fprintf(stderr, "eqtap: cannot resolve own audio process object; refusing to self-tap\n");
      return 5;
    }
    CATapDescription *d = [[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:@[ @(me) ]];
    d.name         = @"WinControl EQ";
    d.muteBehavior = CATapMutedWhenTapped;   // the whole trick: no doubled audio
    d.privateTap   = YES;
    if (AudioHardwareCreateProcessTap(d, &gTap) != noErr) {
      fprintf(stderr, "eqtap: tap refused (audio-capture permission?)\n"); return 2;
    }

    // One aggregate holding the tap and the real device => one clock, so drift
    // compensation is a dictionary key rather than a control loop.
    NSDictionary *desc = @{
      @kAudioAggregateDeviceNameKey:          @"WinControl EQ",
      @kAudioAggregateDeviceUIDKey:           @"be.flux.wincontrol.eq",
      @kAudioAggregateDeviceIsPrivateKey:     @YES,
      @kAudioAggregateDeviceMainSubDeviceKey: outUID,
      @kAudioAggregateDeviceSubDeviceListKey: @[ @{ @kAudioSubDeviceUIDKey: outUID } ],
      @kAudioAggregateDeviceTapAutoStartKey:  @YES,
      @kAudioAggregateDeviceTapListKey:       @[ @{ @kAudioSubTapUIDKey: d.UUID.UUIDString,
                                                    @kAudioSubTapDriftCompensationKey: @YES } ],
    };
    if (AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)desc, &gAgg) != noErr) {
      fprintf(stderr, "eqtap: aggregate refused\n"); teardown(); return 3;
    }

    atexit(teardown);
    signal(SIGTERM, onSignal);
    signal(SIGINT,  onSignal);
    signal(SIGHUP,  onSignal);
    signal(SIGPIPE, SIG_IGN);

    static Bank bank;
    bank.fs = nominalRate(gAgg);
    bankRecompute(&bank);

    AudioDeviceIOBlock block = ^(const AudioTimeStamp *now, const AudioBufferList *inData,
                                 const AudioTimeStamp *inTime, AudioBufferList *outData,
                                 const AudioTimeStamp *outTime) {
      (void)now; (void)inTime; (void)outTime;
      if (!outData || outData->mNumberBuffers == 0) return;
      // Silence anything we are not going to fill (extra buffers of a
      // non-interleaved or >2ch device), so stale frames never leak through.
      for (UInt32 i = 1; i < outData->mNumberBuffers; i++)
        memset(outData->mBuffers[i].mData, 0, outData->mBuffers[i].mDataByteSize);

      AudioBuffer *ob = &outData->mBuffers[0];
      const int outCh = (int)ob->mNumberChannels;
      float *op = (float *)ob->mData;
      const int outFrames = outCh ? (int)(ob->mDataByteSize / (sizeof(float) * outCh)) : 0;

      if (!inData || inData->mNumberBuffers == 0 || !inData->mBuffers[0].mData) {
        memset(op, 0, ob->mDataByteSize);
        return;
      }
      const AudioBuffer *ib = &inData->mBuffers[0];
      const int inCh = (int)ib->mNumberChannels;
      const int inFrames = inCh ? (int)(ib->mDataByteSize / (sizeof(float) * inCh)) : 0;
      const int frames = inFrames < outFrames ? inFrames : outFrames;
      if (frames <= 0 || inCh <= 0) { memset(op, 0, ob->mDataByteSize); return; }

      // Coefficients are recomputed here, on the audio thread, deliberately:
      // ten peaking-EQ evaluations is a couple of microseconds inside a ~10ms
      // block, and it means no coefficient set is ever shared with the writer,
      // so there is nothing to double-buffer and no lock to get wrong.
      if (atomic_exchange_explicit(&gDirty, 0, memory_order_acquire)) bankRecompute(&bank);

      const float *ip = (const float *)ib->mData;
      bankProcess(&bank, ip, inCh, op, outCh, frames);

      static double lastIn = 0, lastOut = 0;
      long ix = 0, ox = 0;
      for (int f = 0; f < frames; f++) {
        const double a = ip[f * inCh], b = op[f * outCh];
        if ((a >= 0) != (lastIn  >= 0)) ix++;
        if ((b >= 0) != (lastOut >= 0)) ox++;
        lastIn = a; lastOut = b;
      }
      atomic_fetch_add_explicit(&gInZeroX,  ix, memory_order_relaxed);
      atomic_fetch_add_explicit(&gOutZeroX, ox, memory_order_relaxed);

      double ipk = 0, opk = 0;
      for (int i = 0; i < frames * inCh; i++)  { const double a = fabs(ip[i]); if (a > ipk) ipk = a; }
      for (int i = 0; i < frames * outCh; i++) { const double a = fabs(op[i]); if (a > opk) opk = a; }
      atomic_store_explicit(&gInPeak,  (int)(ipk * 1000), memory_order_relaxed);
      atomic_store_explicit(&gOutPeak, (int)(opk * 1000), memory_order_relaxed);
      atomic_store_explicit(&gInBufs,  (int)inData->mNumberBuffers, memory_order_relaxed);
      atomic_store_explicit(&gOutBufs, (int)outData->mNumberBuffers, memory_order_relaxed);
      atomic_store_explicit(&gInCh, inCh, memory_order_relaxed);
      atomic_store_explicit(&gOutCh, outCh, memory_order_relaxed);
      atomic_fetch_add_explicit(&gBlocks, 1, memory_order_relaxed);
      atomic_fetch_add_explicit(&gFrames, frames, memory_order_relaxed);
      if (frames < outFrames)
        memset(op + frames * outCh, 0, (outFrames - frames) * outCh * sizeof(float));
    };

    if (AudioDeviceCreateIOProcIDWithBlock(&gProc, gAgg, NULL, block) != noErr ||
        AudioDeviceStart(gAgg, gProc) != noErr) {
      fprintf(stderr, "eqtap: could not start IO\n"); return 4;
    }
    printf("ready %.0f\n", bank.fs);
    fflush(stdout);

    // Output device changed under us. Balance is a property of a device and so
    // is this aggregate's membership, so rebuilding is main.js's job: exit and
    // let it respawn against the new default.
    AudioObjectAddPropertyListenerBlock(kAudioObjectSystemObject, &dfltAddr, dispatch_get_main_queue(),
      ^(UInt32 n, const AudioObjectPropertyAddress *addrs) {
        (void)n; (void)addrs;
        fprintf(stderr, "eqtap: default output device changed, exiting\n");
        teardown(); _exit(0);
      });

    // `eqtap debug`: hold a loud, obvious curve for 5s and report what the
    // IOProc is actually seeing. Diagnoses "EQ on -> silence" in one run.
    if (argc > 1 && strcmp(argv[1], "debug") == 0) {
      const float curve[NBANDS + 1] = { 12, 12, 6, 0, 0, 0, -12, -12, -12, -12, -6 };
      for (int i = 0; i < NBANDS; i++) atomic_store(&gGainDb[i], curve[i]);
      atomic_store(&gPreampDb, curve[NBANDS]);
      atomic_store(&gDirty, 1);
      double worstIn = 0;
      long blocks = 0;
      for (int t = 0; t < 10; t++) {
        usleep(500000);
        const double ipk = atomic_load(&gInPeak) / 1000.0;
        if (ipk > worstIn) worstIn = ipk;
        blocks = atomic_load(&gBlocks);
        const double secs = atomic_load(&gFrames) / bank.fs;
        printf("blocks=%-5ld frames=%-7ld in:%dbuf/%dch peak=%.3f %.0fHz  out:%dbuf/%dch peak=%.3f %.0fHz\n",
               atomic_load(&gBlocks), atomic_load(&gFrames),
               atomic_load(&gInBufs), atomic_load(&gInCh), atomic_load(&gInPeak) / 1000.0,
               secs > 0 ? atomic_load(&gInZeroX) / 2.0 / secs : 0,
               atomic_load(&gOutBufs), atomic_load(&gOutCh), atomic_load(&gOutPeak) / 1000.0,
               secs > 0 ? atomic_load(&gOutZeroX) / 2.0 / secs : 0);
        fflush(stdout);
      }
      // The tap sits after the system mixer, so its input cannot legitimately
      // exceed full scale for long. If it does, our own output has re-entered
      // the tap -- i.e. the self-exclusion above has regressed, and the audible
      // symptom is silence, because MutedWhenTapped then mutes us too.
      printf("\n");
      if (blocks == 0) {
        printf("INCONCLUSIVE: no IO blocks. A global tap has no stream while nothing\n"
               "              is playing -- start some audio and run this again.\n");
        teardown();
        return 2;
      }
      const int fed_back = worstIn > 1.05;
      printf("%s: worst input peak %.3f over %ld blocks\n",
             fed_back ? "FEEDBACK" : "OK", worstIn, blocks);
      teardown();
      return fed_back ? 1 : 0;
    }

    // Reader loop. Eleven dB values per line: ten bands then preamp.
    char line[512];
    while (fgets(line, sizeof(line), stdin)) {
      if (strncmp(line, "quit", 4) == 0) break;
      float g[NBANDS + 1] = {0};
      int n = 0;
      for (char *p = line, *end; n < NBANDS + 1; n++) {
        const float v = strtof(p, &end);
        if (end == p) break;
        g[n] = v; p = end;
      }
      if (n < NBANDS) continue;   // partial line: ignore rather than half-apply
      for (int i = 0; i < NBANDS; i++) atomic_store_explicit(&gGainDb[i], g[i], memory_order_relaxed);
      atomic_store_explicit(&gPreampDb, n > NBANDS ? g[NBANDS] : 0.0f, memory_order_relaxed);
      atomic_store_explicit(&gDirty, 1, memory_order_release);
    }
    teardown();
    return 0;
  }
}
