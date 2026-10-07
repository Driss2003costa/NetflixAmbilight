"""Génère les icônes de CinéHalo : un écran sombre avec une lueur chaude à gauche et froide à droite.

Usage : python3 tools/make_icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SIZES = (16, 32, 48, 128)
BASE = 512  # on dessine en grand puis on réduit, c'est plus propre


def rounded_mask(size, radius):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def render():
    s = BASE
    img = Image.new("RGBA", (s, s), (10, 11, 15, 255))

    # Lueurs latérales, très floutées
    glow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    g.ellipse((-0.05 * s, 0.18 * s, 0.48 * s, 0.82 * s), fill=(255, 138, 61, 255))
    g.ellipse((0.52 * s, 0.18 * s, 1.05 * s, 0.82 * s), fill=(76, 184, 255, 255))
    glow = glow.filter(ImageFilter.GaussianBlur(s * 0.09))
    img.alpha_composite(glow)

    # L'écran au centre
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = 0.25 * s, 0.335 * s, 0.75 * s, 0.665 * s
    picture = Image.new("RGBA", (int(x1 - x0), int(y1 - y0)))
    pw, ph = picture.size
    pd = ImageDraw.Draw(picture)
    for x in range(pw):
        t = x / max(1, pw - 1)
        r = int(200 * (1 - t) + 42 * t)
        gg = int(104 * (1 - t) + 95 * t)
        b = int(46 * (1 - t) + 147 * t)
        pd.line((x, 0, x, ph), fill=(r, gg, b, 255))
    pmask = Image.new("L", picture.size, 0)
    ImageDraw.Draw(pmask).rounded_rectangle((0, 0, pw - 1, ph - 1), radius=int(s * 0.03), fill=255)
    img.paste(picture, (int(x0), int(y0)), pmask)
    d.rounded_rectangle((x0, y0, x1, y1), radius=int(s * 0.03), outline=(255, 255, 255, 70), width=int(s * 0.012))

    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(img, (0, 0), rounded_mask(s, int(s * 0.22)))
    return out


def main():
    big = render()
    for size in SIZES:
        icon = big.resize((size, size), Image.LANCZOS)
        icon.save(ROOT / "icons" / f"icon{size}.png")
    big.resize((256, 256), Image.LANCZOS).save(ROOT / "icons" / "icon256.png")
    print("icônes générées dans", ROOT / "icons")


if __name__ == "__main__":
    main()
