#!/usr/bin/env python3
"""Génère les icônes de l'extension (placeholders).

Dessine un carré arrondi bleu portant deux lignes de « texte » blanches et un
soulignement rouge ondulé — le motif de l'extension. Tout est rastérisé à la
main (suréchantillonnage 8×8 puis moyenne) et encodé en PNG avec zlib :
aucune dépendance n'est nécessaire.

    python tools/make_icons.py

Remplacez librement ces fichiers par de vraies icônes.
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path
from typing import List, Sequence, Tuple

SIZES = (16, 48, 128)
SUPERSAMPLE = 8

BACKGROUND = (37, 99, 235, 255)   # bleu
INK = (255, 255, 255, 255)        # lignes de texte
UNDERLINE = (255, 90, 82, 255)    # ondulation rouge

# Coordonnées normalisées (0 → 1), indépendantes de la taille finale.
CARD = (0.02, 0.02, 0.98, 0.98)
CARD_RADIUS = 0.22
BARS = (
    (0.18, 0.27, 0.82, 0.37),
    (0.18, 0.45, 0.70, 0.55),
)
BAR_RADIUS = 0.05
WAVE = {"x0": 0.18, "x1": 0.82, "y": 0.71, "amplitude": 0.045, "period": 0.20, "thickness": 0.055}

Color = Tuple[int, int, int, int]


def in_rounded_rect(x: float, y: float, box: Sequence[float], radius: float) -> bool:
    x0, y0, x1, y1 = box
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    radius = min(radius, (x1 - x0) / 2, (y1 - y0) / 2)
    cx = min(max(x, x0 + radius), x1 - radius)
    cy = min(max(y, y0 + radius), y1 - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


def in_wave(x: float, y: float) -> bool:
    if not (WAVE["x0"] <= x <= WAVE["x1"]):
        return False
    phase = 2 * math.pi * (x - WAVE["x0"]) / WAVE["period"]
    wave_y = WAVE["y"] + WAVE["amplitude"] * math.sin(phase)
    slope = WAVE["amplitude"] * (2 * math.pi / WAVE["period"]) * math.cos(phase)
    # Distance perpendiculaire approchée : sans cela le trait s'épaissit dans
    # les parties les plus pentues de la sinusoïde.
    distance = abs(y - wave_y) / math.sqrt(1 + slope * slope)
    return distance <= WAVE["thickness"] / 2


def sample(x: float, y: float) -> Color:
    if in_wave(x, y):
        return UNDERLINE
    for bar in BARS:
        if in_rounded_rect(x, y, bar, BAR_RADIUS):
            return INK
    if in_rounded_rect(x, y, CARD, CARD_RADIUS):
        return BACKGROUND
    return (0, 0, 0, 0)


def render(size: int) -> List[bytes]:
    """Rastérise l'icône ; renvoie une ligne d'octets RGBA par pixel de hauteur."""
    rows: List[bytes] = []
    step = 1.0 / (size * SUPERSAMPLE)
    for py in range(size):
        row = bytearray()
        for px in range(size):
            red = green = blue = alpha = 0.0
            for sy in range(SUPERSAMPLE):
                y = (py * SUPERSAMPLE + sy + 0.5) * step
                for sx in range(SUPERSAMPLE):
                    x = (px * SUPERSAMPLE + sx + 0.5) * step
                    r, g, b, a = sample(x, y)
                    weight = a / 255.0
                    # Moyenne en couleurs prémultipliées : évite un liseré
                    # sombre sur les bords arrondis.
                    red += r * weight
                    green += g * weight
                    blue += b * weight
                    alpha += weight
            total = SUPERSAMPLE * SUPERSAMPLE
            if alpha <= 0:
                row += b"\x00\x00\x00\x00"
                continue
            row += bytes(
                (
                    round(red / alpha),
                    round(green / alpha),
                    round(blue / alpha),
                    round(255 * alpha / total),
                )
            )
        rows.append(bytes(row))
    return rows


def write_png(path: Path, rows: Sequence[bytes], size: int) -> None:
    raw = b"".join(b"\x00" + row for row in rows)  # filtre 0 (None) par ligne

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8 bits, RGBA
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def main() -> None:
    target = Path(__file__).resolve().parent.parent / "extension" / "icons"
    target.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        path = target / f"icon{size}.png"
        write_png(path, render(size), size)
        print(f"{path.relative_to(target.parent.parent)} ({path.stat().st_size} octets)")


if __name__ == "__main__":
    main()
