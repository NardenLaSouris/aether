"""Generates the Aether icons (app PNG, multi-size ICO, in-app logo) from the official logo artwork.
Source: build/logo-source.webp (square artwork, mark centred on a forest background).
Run: python build/generate-icons.py"""
from PIL import Image, ImageDraw

SOURCE_PATH = "build/logo-source.webp"
# Square crop around the mark (fractions of the source width/height), so the "A" fills the icon.
CROP_CENTER_X = 0.50
CROP_CENTER_Y = 0.497
CROP_SIZE = 0.63
CORNER_RADIUS_RATIO = 0.22


def cropped_mark(source: Image.Image) -> Image.Image:
    width, height = source.size
    half = CROP_SIZE * width / 2
    center_x = CROP_CENTER_X * width
    center_y = CROP_CENTER_Y * height
    box = (round(center_x - half), round(center_y - half), round(center_x + half), round(center_y + half))
    return source.crop(box).convert("RGBA")


def rounded(image: Image.Image, size: int) -> Image.Image:
    supersample = 4
    resized = image.resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size * supersample, size * supersample), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size * supersample - 1, size * supersample - 1], radius=int(size * supersample * CORNER_RADIUS_RATIO), fill=255)
    resized.putalpha(mask.resize((size, size), Image.LANCZOS))
    return resized


mark = cropped_mark(Image.open(SOURCE_PATH))
icon = rounded(mark, 1024)
icon.save("resources/icon.png")
icon.resize((512, 512), Image.LANCZOS).save("build/icon.png")
ICO_SIZES = [(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (128, 128), (256, 256)]
icon.save("build/icon.ico", sizes=ICO_SIZES)
# Window/taskbar icon at run time (Windows picks the right size from the .ico).
icon.save("resources/icon.ico", sizes=ICO_SIZES)
rounded(mark, 192).save("src/renderer/src/assets/logo.png", optimize=True)
print("icons written")
