"""Packs PNG images into one .ico file with PNG-compressed entries (Windows Vista and later read these at every size).

    python tools/pack-ico.py out.ico icon-16.png icon-32.png ... icon-256.png
"""
import struct
import sys

from PIL import Image


def main(out, pngs):
    entries = []
    for path in pngs:
        with Image.open(path) as im:
            w, h = im.size
        data = open(path, "rb").read()
        entries.append((w, h, data))
    entries.sort(key=lambda e: e[0])
    header = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    table, blobs = b"", b""
    for w, h, data in entries:
        table += struct.pack("<BBBBHHII", w % 256, h % 256, 0, 0, 1, 32, len(data), offset + len(blobs))
        blobs += data
    with open(out, "wb") as f:
        f.write(header + table + blobs)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
