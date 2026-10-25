#!/usr/bin/env python3
"""Synthesize demo music WAVs for the Volume Control live preview.

Generates two stereo 44.1kHz 16-bit clips:
1. quiet-music.wav   - gentle chord progression mixed ~-30 dBFS RMS (boost demo)
2. dynamic-music.wav - quiet verse -> loud chorus -> quiet outro (normalizer demo)

Pure stdlib synthesis (sine partials + envelopes), no dependencies.
"""
import wave
import struct
import math
import random

SR = 44100

def note_freq(midi):
    return 440.0 * (2 ** ((midi - 69) / 12))

# Am - F - C - G progression (MIDI numbers)
PROGRESSION = [
    [57, 60, 64, 69],  # Am: A3 C4 E4 A4
    [53, 57, 60, 65],  # F:  F3 A3 C4 F4
    [48, 55, 60, 64],  # C:  C3 G3 C4 E4
    [55, 59, 62, 67],  # G:  G3 B3 D4 G4
]

def synth_clip(chords, chord_dur, gain_db, style="pad", seed=42):
    """Render chord list to stereo float samples at gain_db dBFS RMS."""
    rng = random.Random(seed)
    n_chords = len(chords)
    total = int(SR * chord_dur * n_chords)
    left = [0.0] * total
    right = [0.0] * total

    for ci, chord in enumerate(chords):
        start = int(ci * chord_dur * SR)
        end = min(int((ci + 1) * chord_dur * SR) + int(0.35 * SR), total)
        length = end - start
        for i in range(length):
            t = i / SR
            # per-chord envelope: soft attack, sustain, release
            attack = min(1.0, t / 0.12)
            rel_t = (i / SR) - (chord_dur - 0.25)
            release = min(1.0, 0.25 - rel_t / 0.25) if rel_t > 0 else 1.0
            env = attack * max(0.0, release)
            # slow tremolo for musicality
            env *= 0.85 + 0.15 * math.sin(2 * math.pi * 0.7 * t + ci)
            sl = 0.0
            sr_ = 0.0
            for ni, midi in enumerate(chord):
                f = note_freq(midi)
                amp = 1.0 / (ni + 1.5)  # higher notes quieter
                # slight detune per channel for stereo width
                sl += amp * math.sin(2 * math.pi * (f * 0.999) * t)
                sr_ += amp * math.sin(2 * math.pi * (f * 1.001) * t + 0.5)
                # soft octave partial
                if ni < 2:
                    sl += 0.25 * amp * math.sin(2 * math.pi * f * 2 * t + 0.3)
                    sr_ += 0.25 * amp * math.sin(2 * math.pi * f * 2 * t + 0.8)
            if style == "arp":
                # arpeggio shimmer overlay
                arp_f = note_freq(chord[i // int(0.11 * SR) % len(chord)] + 12)
                a = 0.35 * math.sin(2 * math.pi * arp_f * t) * math.exp(-3.5 * ((i / SR) % 0.11))
                sl += a
                sr_ += 0.7 * a
            idx = start + i
            if idx < total:
                left[idx] += env * sl
                right[idx] += env * sr_

    # gentle noise floor (-66 dB) so it's never pure digital silence
    for i in range(total):
        left[i] += (rng.random() - 0.5) * 0.0005
        right[i] += (rng.random() - 0.5) * 0.0005

    # normalize then scale to target RMS
    def rms(buf):
        return math.sqrt(sum(s * s for s in buf) / len(buf))

    peak = max(max(abs(s) for s in left), max(abs(s) for s in right))
    scale_peak = 0.98 / peak
    left = [s * scale_peak for s in left]
    right = [s * scale_peak for s in right]
    target_rms = 10 ** (gain_db / 20)
    cur_rms = (rms(left) + rms(right)) / 2
    scale = target_rms / cur_rms
    left = [s * scale for s in left]
    right = [s * scale for s in right]
    return left, right

def crossfade_into(buf_l, buf_r, seg_l, seg_r, start_idx, fade=0.02):
    fade_n = int(fade * SR)
    for i in range(len(seg_l)):
        idx = start_idx + i
        if idx >= len(buf_l):
            break
        g = 1.0
        if i < fade_n:
            g = i / fade_n
        if len(seg_l) - i < fade_n:
            g = min(g, (len(seg_l) - i) / fade_n)
        buf_l[idx] = buf_l[idx] * (1 - g) + seg_l[i] * g
        buf_r[idx] = buf_r[idx] * (1 - g) + seg_r[i] * g

def concat_segments(segments):
    total = sum(len(s[0]) for s in segments)
    buf_l = [0.0] * total
    buf_r = [0.0] * total
    pos = 0
    for sl, sr_ in segments:
        crossfade_into(buf_l, buf_r, sl, sr_, pos)
        pos += len(sl)
    return buf_l, buf_r

def write_wav(path, left, right):
    # final safety clamp
    data = bytearray()
    for l, r in zip(left, right):
        l = max(-1.0, min(1.0, l))
        r = max(-1.0, min(1.0, r))
        data += struct.pack('<hh', int(l * 32767), int(r * 32767))
    with wave.open(path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(bytes(data))
    rms = math.sqrt(sum((l*l + r*r) / 2 for l, r in zip(left, right)) / len(left))
    peak = max(max(abs(s) for s in left), max(abs(s) for s in right))
    print(f"{path}: dur={len(left)/SR:.1f}s rms={20*math.log10(rms):.1f} dBFS peak={20*math.log10(peak):.1f} dBFS")

random.seed(7)

# 1) Quiet music: two passes of the progression, mixed at -30 dBFS RMS
quiet_chords = PROGRESSION + PROGRESSION
ql, qr = synth_clip(quiet_chords, 2.4, -30, style="pad", seed=11)
write_wav('/home/z/my-project/public/samples/quiet-music.wav', ql, qr)

# 2) Dynamic music: quiet verse (-32 dB) -> loud chorus (-13 dB) -> quiet (-32)
verse1 = synth_clip(PROGRESSION, 2.2, -32, style="pad", seed=21)
chorus = synth_clip(PROGRESSION * 2, 1.1, -13, style="arp", seed=22)
verse2 = synth_clip(PROGRESSION, 2.2, -32, style="pad", seed=23)
dl, dr = concat_segments([verse1, chorus, verse2])
write_wav('/home/z/my-project/public/samples/dynamic-music.wav', dl, dr)

print("done")
