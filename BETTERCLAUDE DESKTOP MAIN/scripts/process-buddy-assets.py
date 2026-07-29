#!/usr/bin/env python3
"""
One-time asset pipeline for Settings -> Buddies.

Takes the raw Gemini-generated buddy assets (1 idle still + 3 action clips),
strips their flat background to real transparency, and writes bundled assets
into resources/buddies/<buddy>/ so the app never reads from outside the repo.

    python3 scripts/process-buddy-assets.py --src "/path/to/BUDDIES/ASTRONAUT"

Requires: ffmpeg/ffprobe on PATH, plus numpy + scipy + Pillow.


Why not a plain colour key
--------------------------
The astronaut's suit is white/light-grey and so is the background, so
`-fuzz N -transparent white` (or ffmpeg colorkey) punches holes straight
through the suit. Instead this keys on *connectivity*: only near-background
pixels that are reachable from the frame border are erased. Interior
near-white pixels (the suit) are unreachable and stay fully opaque.

Three properties of the source material make that work, all verified by
measurement rather than assumption -- see the printed diagnostics:

  * The background is NOT white. It is per-asset: idle ~(247,251,254),
    typing ~(228,228,228), thinking ~(234,234,234). So the reference colour
    is sampled from each asset, never hardcoded to white.
  * The character has dark pixel-art outlines. They form a barrier that stops
    the fill leaking through the silhouette into the suit, which is why the
    measured content bbox is stable across thresholds 10..34.
  * The blast-off clip's smoke plume TOUCHES ALL FOUR BORDERS. Border pixels
    therefore cannot be trusted as "known background" on those frames, so the
    reference colour is taken from frame 0 (clean) and reused for the clip.
    The fill still cannot eat the smoke, because smoke is far from the
    reference colour and so is never a fill candidate in the first place.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

# Shared output canvas. All four assets are emitted at this size so the
# character never jumps in scale or position when the state machine swaps
# one clip for another. 16:9 matches the source clips natively, which keeps
# the blast-off smoke plume un-clipped (it spans nearly the full frame).
OUT_W, OUT_H = 640, 360
FPS = 24

# Colour distance (0..441 over RGB) below which a pixel is a fill candidate.
# Measured background noise is std ~0.6 (idle) to ~2.2 (typing), and the
# nearest suit white sits ~9 away from the idle background -- connectivity,
# not this threshold, is what protects the suit. 24 is comfortably above the
# noise floor and well below the outline contrast.
DEFAULT_THRESHOLD = 24.0

# Foreground islands smaller than this are compression smudges and the little
# background sparkles, not character. Measured character area is >= 80k px.
MIN_ISLAND_PX = 350

# Mask-only pre-blur, to stop macroblock noise from pinholing the fill.
PRE_BLUR_SIGMA = 0.6
# Edge softness of the final alpha ramp.
FEATHER_SIGMA = 0.8
# Pull the matte inward by this much before feathering. The feather then eats
# into the character instead of into the background, which is what kills the
# white fringe; at 640px wide on art this soft it costs no visible detail.
ERODE_PX = 1.0

SRC_NAMES = {
    "typing": "ASTRONAUT TYPING.mp4",
    "thinking": "ASTRONAUT THINKING.mp4",
    "blastoff": "ASTRONAUT FLYING.mp4",
}


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, **kw)


def probe(path):
    out = run(["ffprobe", "-v", "error", "-select_streams", "v:0",
               "-show_entries", "stream=width,height,nb_frames,r_frame_rate",
               "-of", "json", str(path)]).stdout
    s = json.loads(out)["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    return int(s["width"]), int(s["height"]), int(s.get("nb_frames") or 0), float(num) / float(den)


def iter_frames(path, w, h):
    """Stream RGB frames from ffmpeg rather than buffering the whole clip
    (240 frames of 1280x720 RGB is ~660MB held at once)."""
    n = w * h * 3
    p = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        while True:
            raw = p.stdout.read(n)
            if len(raw) < n:
                break
            yield np.frombuffer(raw, dtype=np.uint8).reshape(h, w, 3)
    finally:
        # Callers may stop early (the bbox probe reads one frame). Kill rather
        # than wait, or ffmpeg blocks writing into a pipe nobody is draining.
        p.stdout.close()
        if p.poll() is None:
            p.kill()
        p.wait()


def border_reference(img, strip=6):
    """Median (not mean) of the border strips -- robust to a border that is
    partly covered by content, which is exactly the blast-off case."""
    b = np.concatenate([
        img[:strip, :, :].reshape(-1, 3), img[-strip:, :, :].reshape(-1, 3),
        img[:, :strip, :].reshape(-1, 3), img[:, -strip:, :].reshape(-1, 3)])
    return np.median(b, axis=0).astype(np.float32)


def alpha_matte(img, ref, threshold, stats=None):
    """Edge-connected background removal. Returns float alpha in [0,1]."""
    f = img.astype(np.float32)

    # Blur a COPY for mask decisions only; output colour stays untouched.
    blurred = np.stack([ndimage.gaussian_filter(f[:, :, c], PRE_BLUR_SIGMA) for c in range(3)], axis=2)
    dist = np.sqrt(((blurred - ref) ** 2).sum(axis=2))
    candidate = dist <= threshold

    # "Flood fill inward from every border pixel" == label the candidate
    # regions and keep those that reach the border. One O(n) pass instead of
    # a per-seed traversal, and it cannot leak into unconnected interiors.
    lab, n = ndimage.label(candidate)
    if n == 0:
        return np.ones(img.shape[:2], dtype=np.float32)
    edge_labels = np.unique(np.concatenate([lab[0, :], lab[-1, :], lab[:, 0], lab[:, -1]]))
    edge_labels = edge_labels[edge_labels != 0]
    background = np.isin(lab, edge_labels)

    fg = ~background
    # Drop sparkles/smudges so they don't float in the overlay as specks.
    flab, fn = ndimage.label(fg)
    if fn:
        sizes = ndimage.sum(fg, flab, range(1, fn + 1))
        small = {i + 1 for i, s in enumerate(sizes) if s < MIN_ISLAND_PX}
        if small:
            fg = fg & ~np.isin(flab, list(small))

    if stats is not None:
        border_bg = background[0, :].mean() + background[-1, :].mean() \
            + background[:, 0].mean() + background[:, -1].mean()
        stats.append((int(fg.sum()), border_bg / 4.0))

    # Erode then feather: the soft ramp lands inside the silhouette, so no
    # background-coloured pixels survive at partial alpha to read as a halo.
    a = fg.astype(np.float32)
    if ERODE_PX > 0:
        a = np.clip((ndimage.gaussian_filter(a, ERODE_PX) - 0.5) * 2.0 + 0.5, 0, 1)
        a = (a > 0.75).astype(np.float32)
    return np.clip(ndimage.gaussian_filter(a, FEATHER_SIGMA), 0, 1)


def decontaminate(img, alpha, ref):
    """Un-blend the background out of partially transparent edge pixels.

    An edge pixel is observed = a*C + (1-a)*ref, so the true character colour
    is (observed - (1-a)*ref)/a. Skipping this is the other, subtler way to
    get a white fringe: the geometry is right but every edge pixel is still
    physically part-background."""
    f = img.astype(np.float32)
    a = alpha[:, :, None]
    safe = np.maximum(a, 1e-3)
    out = (f - (1.0 - a) * ref[None, None, :]) / safe
    # Only trust the correction where there's enough signal to divide by.
    return np.where(a > 0.05, np.clip(out, 0, 255), f).astype(np.uint8)


def to_rgba(img, ref, threshold, stats=None):
    a = alpha_matte(img, ref, threshold, stats)
    rgb = decontaminate(img, a, ref)
    return np.dstack([rgb, (a * 255.0 + 0.5).astype(np.uint8)])


def content_bbox(rgba, min_alpha=32):
    ys, xs = np.where(rgba[:, :, 3] > min_alpha)
    if len(ys) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def resize_rgba(rgba, w, h):
    return np.array(Image.fromarray(rgba, "RGBA").resize((w, h), Image.LANCZOS))


def encode_webm(frames_iter, dst, w, h, fps, crf):
    """VP9 + yuva420p is the one widely-supported alpha video format Chromium
    plays natively in a <video>. -an guarantees the audio stream is absent
    rather than merely silent."""
    cmd = ["ffmpeg", "-y", "-v", "error",
           "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
           "-an",
           "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
           "-b:v", "0", "-crf", str(crf), "-row-mt", "1",
           "-auto-alt-ref", "0",
           str(dst)]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    count = 0
    for fr in frames_iter:
        p.stdin.write(fr.tobytes())
        count += 1
    p.stdin.close()
    if p.wait() != 0:
        raise RuntimeError(f"ffmpeg failed encoding {dst}")
    return count


def process_clip(src, dst, threshold, crf, verbose):
    w, h, nframes, fps = probe(src)
    state = {"ref": None}
    stats = []

    def gen():
        for fr in iter_frames(src, w, h):
            if state["ref"] is None:
                # Frame 0 only: on the blast-off clip later frames have smoke
                # sitting on the border, which would poison the reference.
                state["ref"] = border_reference(fr)
                if verbose:
                    print(f"    background reference = {state['ref'].round(1)}")
            rgba = to_rgba(fr, state["ref"], threshold, stats)
            yield resize_rgba(rgba, OUT_W, OUT_H)

    n = encode_webm(gen(), dst, OUT_W, OUT_H, fps if fps else FPS, crf)
    areas = [s[0] for s in stats]
    borders = [s[1] for s in stats]
    if verbose:
        print(f"    {n} frames, fg area min={min(areas)} max={max(areas)}, "
              f"border-classified-bg min={min(borders):.2%}")
    return n, state["ref"], min(borders)


def process_idle(src, dst, threshold, align_to, verbose):
    """The still is 1024x559 while the clips are 1280x720, and its character is
    drawn smaller. Compositing it onto the shared canvas -- scaled and
    bottom-aligned to the thinking clip's character -- is what stops the buddy
    visibly resizing on the idle -> typing transition."""
    img = np.array(Image.open(src).convert("RGB"))
    ref = border_reference(img)
    if verbose:
        print(f"    background reference = {ref.round(1)}")
    rgba = to_rgba(img, ref, threshold)
    bb = content_bbox(rgba)
    if bb is None:
        raise RuntimeError("idle image: no content found")
    x0, y0, x1, y1 = bb
    cropped = rgba[y0:y1 + 1, x0:x1 + 1]
    ch, cw = cropped.shape[:2]

    tx0, ty0, tx1, ty1 = align_to
    target_h = (ty1 - ty0 + 1) * OUT_H / 720.0
    scale = target_h / ch
    nw, nh = max(1, round(cw * scale)), max(1, round(ch * scale))
    scaled = resize_rgba(cropped, nw, nh)

    canvas = np.zeros((OUT_H, OUT_W, 4), dtype=np.uint8)
    cx = (tx0 + tx1) / 2.0 * OUT_W / 1280.0          # match horizontal centre
    by = (ty1 + 1) * OUT_H / 720.0                    # match feet line
    left = int(round(cx - nw / 2.0))
    top = int(round(by - nh))
    # Clip against the canvas so an off-canvas placement can't throw.
    sl, st = max(0, -left), max(0, -top)
    left, top = max(0, left), max(0, top)
    pw, ph = min(nw - sl, OUT_W - left), min(nh - st, OUT_H - top)
    canvas[top:top + ph, left:left + pw] = scaled[st:st + ph, sl:sl + pw]

    Image.fromarray(canvas, "RGBA").save(dst, optimize=True)
    if verbose:
        print(f"    character {cw}x{ch} -> {nw}x{nh} at ({left},{top}) on {OUT_W}x{OUT_H}")
    return bb


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True, help="folder holding the raw buddy assets")
    ap.add_argument("--buddy", default="astronaut")
    ap.add_argument("--out", default=None, help="defaults to <repo>/resources/buddies/<buddy>")
    ap.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    ap.add_argument("--crf", type=int, default=30)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    verbose = not args.quiet
    src_dir = Path(args.src).expanduser()
    if not src_dir.is_dir():
        sys.exit(f"source folder not found: {src_dir}")

    out_dir = Path(args.out).expanduser() if args.out else \
        Path(__file__).resolve().parent.parent / "resources" / "buddies" / args.buddy
    out_dir.mkdir(parents=True, exist_ok=True)

    stills = sorted([p for p in src_dir.iterdir()
                     if p.suffix.lower() in (".jpg", ".jpeg", ".png")])
    if len(stills) != 1:
        sys.exit(f"expected exactly 1 still image in {src_dir}, found {len(stills)}: "
                 f"{[p.name for p in stills]}")

    missing = [n for n in SRC_NAMES.values() if not (src_dir / n).exists()]
    if missing:
        sys.exit(f"missing expected clips in {src_dir}: {missing}")

    print(f"source : {src_dir}")
    print(f"output : {out_dir}")
    print(f"canvas : {OUT_W}x{OUT_H}  threshold={args.threshold}  crf={args.crf}")

    # Do the clips first: the idle still is aligned to the thinking clip's
    # character, so that measurement has to exist before the still is built.
    thinking_bbox = None
    for state in ("typing", "thinking", "blastoff"):
        src = src_dir / SRC_NAMES[state]
        dst = out_dir / f"{args.buddy}-{state}.webm"
        print(f"  {state:9s} {src.name}")
        process_clip(src, dst, args.threshold, args.crf, verbose)
        if state == "thinking":
            w, h, _, _ = probe(src)
            first = next(iter_frames(src, w, h))
            thinking_bbox = content_bbox(to_rgba(first, border_reference(first), args.threshold))
            if verbose:
                print(f"    reference character bbox = {thinking_bbox}")

    print(f"  {'idle':9s} {stills[0].name}")
    process_idle(stills[0], out_dir / f"{args.buddy}-idle.png",
                 args.threshold, thinking_bbox, verbose)

    print("\nwrote:")
    for p in sorted(out_dir.iterdir()):
        print(f"  {p.name:28s} {p.stat().st_size / 1024:8.1f} KB")


if __name__ == "__main__":
    main()
