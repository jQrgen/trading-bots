#!/usr/bin/env python3
"""Generates the app icon asset catalogs for iOS, macOS and tvOS (App Store uploads require them).

Usage: python3 scripts/make_icons.py   (from apps/apple; needs Pillow)
Writes Resources/<platform>/Assets.xcassets. Re-run after changing the drawing below.
"""
import json
import os
import shutil

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "Resources")
TOP = (18, 22, 48)
BOTTOM = (46, 20, 84)
LINE = (52, 211, 153)
GLOW = (52, 211, 153, 90)
COIN = (250, 204, 21)


def gradient(w, h):
    column = Image.new("RGB", (1, h))
    for y in range(h):
        t = y / max(h - 1, 1)
        column.putpixel((0, y), tuple(int(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)))
    return column.resize((w, h))


def chart_points(w, h, box):
    x0, y0, x1, y1 = box
    ys = [0.72, 0.62, 0.68, 0.48, 0.55, 0.36, 0.42, 0.2]
    return [(x0 + (x1 - x0) * i / (len(ys) - 1), y0 + (y1 - y0) * v) for i, v in enumerate(ys)]


def draw_chart(layer, box, width):
    pts = chart_points(layer.width, layer.height, box)
    glow = Image.new("RGBA", layer.size, (0, 0, 0, 0))
    ImageDraw.Draw(glow).line(pts, fill=GLOW, width=int(width * 2.6), joint="curve")
    layer.alpha_composite(glow.filter(ImageFilter.GaussianBlur(width)))
    d = ImageDraw.Draw(layer)
    d.line(pts, fill=LINE + (255,), width=width, joint="curve")
    x, y = pts[-1]
    r = width * 1.6
    d.ellipse([x - r, y - r, x + r, y + r], fill=COIN + (255,))


def foreground(w, h):
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    s = min(w, h)
    pad_x, pad_y = (w - s) / 2 + s * 0.2, (h - s) / 2 + s * 0.22
    draw_chart(layer, (pad_x, pad_y, w - pad_x, h - pad_y), max(int(s * 0.045), 2))
    return layer


def icon(w, h):
    img = gradient(w, h).convert("RGBA")
    img.alpha_composite(foreground(w, h))
    return img.convert("RGB")


def save(img, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path)


def write_json(path, data):
    os.makedirs(path, exist_ok=True)
    with open(os.path.join(path, "Contents.json"), "w") as f:
        json.dump(data, f, indent=2)


INFO = {"author": "xcode", "version": 1}


def catalog(platform):
    path = os.path.join(ROOT, platform, "Assets.xcassets")
    shutil.rmtree(path, ignore_errors=True)
    write_json(path, {"info": INFO})
    accent = os.path.join(path, "AccentColor.colorset")
    write_json(accent, {"colors": [{"idiom": "universal", "color": {"color-space": "srgb", "components": {
        "red": f"{LINE[0] / 255:.3f}", "green": f"{LINE[1] / 255:.3f}", "blue": f"{LINE[2] / 255:.3f}", "alpha": "1.000"}}}],
        "info": INFO})
    return path


def ios():
    path = os.path.join(catalog("iOS"), "AppIcon.appiconset")
    save(icon(1024, 1024), os.path.join(path, "icon-1024.png"))
    write_json(path, {"images": [{"filename": "icon-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"}],
                      "info": INFO})


def macos():
    path = os.path.join(catalog("macOS"), "AppIcon.appiconset")
    images = []
    for size in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = size * scale
            # macOS icons are a rounded square with margin, per the Big Sur template.
            canvas = Image.new("RGBA", (px, px), (0, 0, 0, 0))
            inset = round(px * 0.1)
            body = icon(px - 2 * inset, px - 2 * inset).convert("RGBA")
            mask = Image.new("L", body.size, 0)
            ImageDraw.Draw(mask).rounded_rectangle([0, 0, body.width - 1, body.height - 1], radius=body.width * 0.225, fill=255)
            canvas.paste(body, (inset, inset), mask)
            name = f"icon-{size}@{scale}x.png"
            save(canvas, os.path.join(path, name))
            images.append({"filename": name, "idiom": "mac", "scale": f"{scale}x", "size": f"{size}x{size}"})
    write_json(path, {"images": images, "info": INFO})


def imagestack(path, w, h, scales):
    """A two-layer parallax stack: gradient back, chart front."""
    write_json(path, {"info": INFO, "layers": [{"filename": "Front.imagestacklayer"}, {"filename": "Back.imagestacklayer"}]})
    for layer, make in (("Front", lambda W, H: foreground(W, H)), ("Back", lambda W, H: gradient(W, H))):
        lp = os.path.join(path, f"{layer}.imagestacklayer")
        write_json(lp, {"info": INFO})
        cp = os.path.join(lp, "Content.imageset")
        images = []
        for scale in scales:
            name = f"{layer.lower()}@{scale}x.png"
            save(make(w * scale, h * scale), os.path.join(cp, name))
            images.append({"filename": name, "idiom": "tv", "scale": f"{scale}x"})
        write_json(cp, {"images": images, "info": INFO})


def imageset(path, w, h, scales):
    images = []
    for scale in scales:
        name = f"image@{scale}x.png"
        save(icon(w * scale, h * scale), os.path.join(path, name))
        images.append({"filename": name, "idiom": "tv", "scale": f"{scale}x"})
    write_json(path, {"images": images, "info": INFO})


def tvos():
    brand = os.path.join(catalog("tvOS"), "App Icon & Top Shelf Image.brandassets")
    write_json(brand, {"info": INFO, "assets": [
        {"filename": "App Icon - App Store.imagestack", "idiom": "tv", "role": "primary-app-icon", "size": "1280x768"},
        {"filename": "App Icon.imagestack", "idiom": "tv", "role": "primary-app-icon", "size": "400x240"},
        {"filename": "Top Shelf Image Wide.imageset", "idiom": "tv", "role": "top-shelf-image-wide", "size": "2320x720"},
        {"filename": "Top Shelf Image.imageset", "idiom": "tv", "role": "top-shelf-image", "size": "1920x720"},
    ]})
    imagestack(os.path.join(brand, "App Icon - App Store.imagestack"), 1280, 768, [1])
    imagestack(os.path.join(brand, "App Icon.imagestack"), 400, 240, [1, 2])
    imageset(os.path.join(brand, "Top Shelf Image Wide.imageset"), 2320, 720, [1, 2])
    imageset(os.path.join(brand, "Top Shelf Image.imageset"), 1920, 720, [1, 2])


if __name__ == "__main__":
    ios()
    macos()
    tvos()
    print("Wrote", os.path.normpath(ROOT))
