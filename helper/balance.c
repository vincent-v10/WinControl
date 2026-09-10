// balance.c -- read/write the stereo balance of the macOS default output device.
//
//   clang -O2 -o balance balance.c -framework CoreFoundation -framework CoreAudio
//
//   ./balance            prints the current pan, -1 (full left) .. 1 (full right)
//   ./balance <-1..1>    sets it
//   ./balance selftest   exercises the pan math, no device touched
//
// Why a binary at all: `media-control` has no balance command (MediaRemote
// doesn't model one), AppleScript's `volume settings` exposes only output/input/
// alert volume and muted, and CoreAudio ships no BridgeSupport metadata for
// AudioObject*, so osascript -l JavaScript can't reach it either.
//
// Two routes, because no single property works on every device (measured on
// this machine, Sept 2026):
//   kAudioDevicePropertyStereoPan         -- MacBook Pro Speakers
//   kAudioDevicePropertyVolumeScalar 1/2  -- AIAIAI TMA-2 and most USB DACs
//   neither                               -- DELL S2725DS, exits 1
// kAudioHardwareServiceDeviceProperty_VirtualMasterBalance ('vmbl') -- the one
// the old Sound prefpane used -- is NOT an option: every device here answers
// 'who?' (2003332927) for it. Don't reach for it again.
//
// The device is looked up fresh on every run, so switching output picks up the
// new one. Balance is a property OF the device, though: it is not carried over
// when you switch.

#include <CoreAudio/CoreAudio.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// ------------------------------------------------------------------ pan math
// Constant-gain pan: the louder side stays at the master level and the other is
// scaled down, which is the shape the Sound prefpane's balance slider had.
// Pure, so selftest can check them without an audio device.

static void channels_from_pan(float master, float pan, float *l, float *r) {
    *l = master * fminf(1.f, 1.f - pan);
    *r = master * fminf(1.f, 1.f + pan);
}

static float pan_from_channels(float l, float r) {
    float m = fmaxf(l, r);
    if (m <= 0.f) return 0.f;  // muted device isn't panned anywhere
    return (l >= r) ? (r / m - 1.f) : (1.f - l / m);
}

static int selftest(void) {
    int bad = 0;
    const float pans[] = {-1.f, -0.5f, -0.01f, 0.f, 0.25f, 0.9f, 1.f};
    for (unsigned i = 0; i < sizeof(pans) / sizeof(*pans); i++) {
        for (float m = 0.25f; m <= 1.f; m += 0.375f) {
            float l, r;
            channels_from_pan(m, pans[i], &l, &r);
            float back = pan_from_channels(l, r);
            if (fabsf(back - pans[i]) > 1e-5f) {
                printf("FAIL roundtrip: pan %.3f @ master %.3f -> %.3f/%.3f -> %.3f\n",
                       pans[i], m, l, r, back);
                bad = 1;
            }
            if (fmaxf(l, r) > m + 1e-6f) {
                printf("FAIL louder side above master: pan %.3f @ %.3f -> %.3f/%.3f\n",
                       pans[i], m, l, r);
                bad = 1;
            }
        }
    }
    if (pan_from_channels(0.f, 0.f) != 0.f) { puts("FAIL silent device reads panned"); bad = 1; }
    puts(bad ? "selftest FAILED" : "selftest ok");
    return bad;
}

// --------------------------------------------------------------- core audio

static AudioObjectID default_output(void) {
    AudioObjectID dev = kAudioObjectUnknown;
    UInt32 size = sizeof(dev);
    AudioObjectPropertyAddress a = {kAudioHardwarePropertyDefaultOutputDevice,
                                    kAudioObjectPropertyScopeGlobal,
                                    kAudioObjectPropertyElementMain};
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &size, &dev) != noErr)
        return kAudioObjectUnknown;
    return dev;
}

static AudioObjectPropertyAddress out_addr(AudioObjectPropertySelector sel, UInt32 elem) {
    AudioObjectPropertyAddress a = {sel, kAudioObjectPropertyScopeOutput, elem};
    return a;
}

// Has it AND will it take a write -- plenty of devices report a property they
// then refuse to set.
static int settable(AudioObjectID dev, AudioObjectPropertyAddress a) {
    Boolean yes = false;
    return AudioObjectHasProperty(dev, &a) &&
           AudioObjectIsPropertySettable(dev, &a, &yes) == noErr && yes;
}

static OSStatus get_f32(AudioObjectID dev, AudioObjectPropertyAddress a, Float32 *out) {
    UInt32 size = sizeof(*out);
    return AudioObjectGetPropertyData(dev, &a, 0, NULL, &size, out);
}

static OSStatus set_f32(AudioObjectID dev, AudioObjectPropertyAddress a, Float32 v) {
    return AudioObjectSetPropertyData(dev, &a, 0, NULL, sizeof(v), &v);
}

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "selftest") == 0) return selftest();

    AudioObjectID dev = default_output();
    if (dev == kAudioObjectUnknown) {
        fprintf(stderr, "no default output device\n");
        return 1;
    }

    AudioObjectPropertyAddress pan = out_addr(kAudioDevicePropertyStereoPan,
                                              kAudioObjectPropertyElementMain);
    AudioObjectPropertyAddress lv = out_addr(kAudioDevicePropertyVolumeScalar, 1);
    AudioObjectPropertyAddress rv = out_addr(kAudioDevicePropertyVolumeScalar, 2);

    // StereoPan first where both exist: it's a property of its own, so it
    // survives the volume slider writing both channels.
    int has_pan = settable(dev, pan);
    int has_chan = settable(dev, lv) && settable(dev, rv);
    if (!has_pan && !has_chan) {
        fprintf(stderr, "device 0x%x has no StereoPan and no per-channel volume\n", dev);
        return 1;
    }

    if (argc < 2) {  // read
        Float32 l = 0, r = 0, p = 0.5f;
        if (has_pan) {
            if (get_f32(dev, pan, &p) != noErr) return 1;
            printf("%.4f\n", p * 2.f - 1.f);  // device is 0..1, we speak -1..1
        } else {
            if (get_f32(dev, lv, &l) != noErr || get_f32(dev, rv, &r) != noErr) return 1;
            printf("%.4f\n", pan_from_channels(l, r));
        }
        return 0;
    }

    char *end = NULL;
    float p = strtof(argv[1], &end);
    if (end == argv[1] || *end != '\0') {
        fprintf(stderr, "usage: balance [-1..1 | selftest]\n");
        return 2;
    }
    p = fmaxf(-1.f, fminf(1.f, p));

    if (has_pan) return set_f32(dev, pan, (p + 1.f) / 2.f) == noErr ? 0 : 1;

    // Per-channel route: the master level is whatever the louder side is at now,
    // so panning never changes how loud the track is.
    Float32 l = 0, r = 0, nl, nr;
    if (get_f32(dev, lv, &l) != noErr || get_f32(dev, rv, &r) != noErr) return 1;
    channels_from_pan(fmaxf(l, r), p, &nl, &nr);
    return (set_f32(dev, lv, nl) == noErr && set_f32(dev, rv, nr) == noErr) ? 0 : 1;
}
