from PIL import Image, ImageDraw

NAVY = (20, 33, 61, 255)
PAPER = (250, 250, 248, 255)
INK = (27, 36, 48, 255)
AMBER = (255, 200, 87, 255)
TRANSPARENT = (0, 0, 0, 0)


def draw_icon(size):
    img = Image.new("RGBA", (size, size), TRANSPARENT)
    d = ImageDraw.Draw(img)

    s = size / 128.0  # scale factor from a 128 design grid

    def pt(x, y):
        return (x * s, y * s)

    # Highlighter swipe behind the page (signature motif), drawn first so it sits underneath
    d.rounded_rectangle(
        [pt(18, 78), pt(74, 96)], radius=6 * s, fill=AMBER
    )

    # Small "page" (book) sitting inside the lens area
    page_box = [pt(30, 34), pt(70, 84)]
    d.rounded_rectangle(page_box, radius=4 * s, fill=PAPER, outline=INK, width=max(1, round(3 * s)))
    line_x0, line_x1 = 38, 62
    for ly in (46, 56, 66):
        d.line([pt(line_x0, ly), pt(line_x1, ly)], fill=INK, width=max(1, round(3 * s)))

    # Magnifying-glass / lens ring
    ring_box = [pt(14, 10), pt(96, 92)]
    ring_width = max(2, round(9 * s))
    d.ellipse(ring_box, outline=NAVY, width=ring_width)

    # Lens handle
    d.line([pt(84, 80), pt(112, 108)], fill=NAVY, width=max(2, round(11 * s)))
    # Round the tip of the handle
    handle_r = max(1, round(5.5 * s))
    hx, hy = pt(112, 108)
    d.ellipse([hx - handle_r, hy - handle_r, hx + handle_r, hy + handle_r], fill=NAVY)

    return img


for size in (16, 48, 128):
    icon = draw_icon(size)
    icon.save(f"icons/icon{size}.png")

print("icons generated")
