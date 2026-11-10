#!/usr/bin/env python3
"""
Metal Slug Web - ROM & Core Builder
===================================
Reconstructs bit-exact MAME/FBNeo Neo Geo ROM archives (neogeo.zip, mslug.zip,
mslug2.zip, mslug3.zip) from the local DotEmu GOG releases of Metal Slug 1, 2, & 3,
patches and gzip-compresses the FBNeo Libretro WebAssembly core, and splits any
archive >19 MiB into Cloudflare Workers / GitHub compatible chunks.
"""

import gzip
import json
import os
import struct
import zipfile
import zlib
import numpy as np

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PROJECT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
PUBLIC_DIR = os.path.join(PROJECT_DIR, "public")
ROMS_DIR = os.path.join(PUBLIC_DIR, "roms")
CHUNKS_DIR = os.path.join(ROMS_DIR, "chunks")
CORES_DIR = os.path.join(PUBLIC_DIR, "cores")
ASSETS_DIR = os.path.join(PUBLIC_DIR, "assets")

SCRATCH_DIR = r"C:\Users\isjohans\.gemini\antigravity\brain\77d9d880-cdbc-4e7c-84bd-1a602c0b2a36\scratch"
CHUNK_LIMIT_BYTES = 18 * 1024 * 1024  # 18 MiB per chunk (<25 MiB Cloudflare & GitHub limit)


def crc32_hex(data: bytes) -> str:
    return f"{zlib.crc32(data) & 0xFFFFFFFF:08x}"


def unpermute_sfix(sfix_bytes: bytes) -> bytes:
    """Invert DotEmu 8x8 tile column permutation on a 128 KB SFIX ROM."""
    arr = np.frombuffer(sfix_bytes, dtype=np.uint8).reshape(-1, 8, 4)
    out = np.empty((-1 if arr.shape[0] == 0 else arr.shape[0], 4, 8), dtype=np.uint8)
    perm = (2, 3, 0, 1)
    for c in range(4):
        out[:, perm[c], :] = arr[:, :, c]
    return out.tobytes()


def unpack_c_pair(raw_bytes: bytes) -> tuple[bytes, bytes]:
    """Invert DotEmu 16x16 sprite tile nibble packing back into odd/even Neo Geo C-ROM bitplanes."""
    tiles = np.frombuffer(raw_bytes, dtype=np.uint8).reshape(-1, 16, 8)
    halves = np.concatenate([tiles[:, :, 4:8], tiles[:, :, 0:4]], axis=1)  # (N, 32, 4)
    pix = np.empty((tiles.shape[0], 32, 8), dtype=np.uint8)
    pix[:, :, 0::2] = halves & 0x0F
    pix[:, :, 1::2] = (halves >> 4) & 0x0F

    bp = np.zeros((tiles.shape[0], 32, 4), dtype=np.uint8)
    for b in range(4):
        for x in range(8):
            bp[:, :, b] |= ((pix[:, :, x] >> b) & 1) << (7 - x)

    c_odd = bp[:, :, 0:2].tobytes()
    c_even = bp[:, :, 2:4].tobytes()
    return c_odd, c_even


def unperm_mslug3_sma_prom(p3_bytes: bytes) -> tuple[bytes, bytes]:
    """Invert mslug3SMADecrypt on mslug3_game_m68k[0x100000:0x900000] to recover 256-pg1.p1 & 256-pg2.p2."""
    rom8m = np.frombuffer(p3_bytes[0x100000:0x900000], dtype=np.uint16).copy()
    j = np.arange(0x8000, dtype=np.uint32)
    addr_bits = [1, 12, 5, 7, 10, 3, 9, 8, 13, 4, 6, 14, 0, 11, 2, 15]
    perm_j = np.zeros_like(j)
    for out_bit, in_bit in enumerate(addr_bits):
        perm_j |= ((j >> in_bit) & 1) << out_bit

    blocks = rom8m.reshape(-1, 0x8000)
    unloop3 = np.empty_like(blocks)
    unloop3[:, perm_j] = blocks

    data_bits = [6, 5, 9, 10, 15, 12, 8, 2, 7, 0, 13, 1, 3, 14, 11, 4]
    unloop1 = np.zeros_like(unloop3)
    for out_bit, in_bit in enumerate(data_bits):
        unloop1 |= ((unloop3 >> out_bit) & 1) << in_bit

    raw_out = unloop1.tobytes()
    return raw_out[:0x400000], raw_out[0x400000:]


def write_zip_and_verify(zip_path: str, files_dict: dict[str, tuple[bytes, str]]) -> dict:
    """Write a deflated ZIP archive, verify every file's CRC32, and chunk if >18 MiB."""
    print(f"\n[ZIP] Building {os.path.basename(zip_path)}...")
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for fname, (data, expected_crc) in files_dict.items():
            actual_crc = crc32_hex(data)
            assert actual_crc == expected_crc, (
                f"CRC mismatch for {fname}: got {actual_crc}, expected {expected_crc}"
            )
            print(f"  + {fname:<16} {len(data):>10,} bytes  CRC32={actual_crc} [OK]")
            zf.writestr(fname, data)

    total_size = os.path.getsize(zip_path)
    zip_name = os.path.basename(zip_path)
    with open(zip_path, "rb") as f:
        zip_bytes = f.read()
    zip_crc = crc32_hex(zip_bytes)
    print(f"  => {zip_name}: {total_size:,} bytes ({total_size / (1024*1024):.2f} MiB), CRC32={zip_crc}")

    if total_size > CHUNK_LIMIT_BYTES:
        os.makedirs(CHUNKS_DIR, exist_ok=True)
        chunks = []
        for idx, offset in enumerate(range(0, total_size, CHUNK_LIMIT_BYTES)):
            part_bytes = zip_bytes[offset : offset + CHUNK_LIMIT_BYTES]
            part_name = f"{zip_name}.part{idx:02d}"
            part_path = os.path.join(CHUNKS_DIR, part_name)
            with open(part_path, "wb") as pf:
                pf.write(part_bytes)
            chunks.append(f"/roms/chunks/{part_name}")
            print(f"  => Chunk {part_name}: {len(part_bytes):,} bytes ({len(part_bytes)/(1024*1024):.2f} MiB)")
        # Remove the oversized single zip so Cloudflare Workers / GitHub never see a >25 MiB file
        os.remove(zip_path)
        return {
            "name": zip_name,
            "size": total_size,
            "crc32": zip_crc,
            "chunked": True,
            "chunks": chunks,
        }
    else:
        return {
            "name": zip_name,
            "size": total_size,
            "crc32": zip_crc,
            "chunked": False,
            "url": f"/roms/{zip_name}",
        }


def build_roms() -> dict:
    os.makedirs(ROMS_DIR, exist_ok=True)
    manifest = {}

    # 1. neogeo.zip + mslug.zip from Metal Slug
    ms1_dir = os.path.join(ROOT_DIR, "Metal Slug", "resources", "game")
    bios_m68k = open(os.path.join(ms1_dir, "mslug_bios_m68k"), "rb").read()
    bios_sfix = unpermute_sfix(open(os.path.join(ms1_dir, "mslug_bios_sfix"), "rb").read())
    zoom_tbl = open(os.path.join(ms1_dir, "mslug_zoom_table"), "rb").read()
    ms1_z80 = open(os.path.join(ms1_dir, "mslug_game_z80"), "rb").read()

    neogeo_files = {
        "sp-s3.sp1": (bios_m68k, "e72943de"),
        "sp-u2.sp1": (bios_m68k, "e72943de"),
        "sfix.sfix": (bios_sfix, "c2ea0cfd"),
        "000-lo.lo": (zoom_tbl, "5a86cff2"),
        "sm1.sm1": (ms1_z80, "c28b3253"),
    }
    manifest["neogeo"] = write_zip_and_verify(os.path.join(ROMS_DIR, "neogeo.zip"), neogeo_files)

    ms1_m68k = open(os.path.join(ms1_dir, "mslug_game_m68k"), "rb").read()
    ms1_p1 = ms1_m68k[0x100000:0x200000] + ms1_m68k[0x000000:0x100000]
    ms1_s1 = unpermute_sfix(open(os.path.join(ms1_dir, "mslug_game_sfix"), "rb").read())
    ms1_adpcm = open(os.path.join(ms1_dir, "mslug_adpcm"), "rb").read()
    ms1_tiles = open(os.path.join(ms1_dir, "mslug_tiles"), "rb").read()
    ms1_c1, ms1_c2 = unpack_c_pair(ms1_tiles[0x000000:0x800000])
    ms1_c3, ms1_c4 = unpack_c_pair(ms1_tiles[0x800000:0x1000000])

    mslug1_files = {
        "201-p1.p1": (ms1_p1, "08d8daa5"),
        "201-s1.s1": (ms1_s1, "2f55958d"),
        "201-m1.m1": (ms1_z80, "c28b3253"),
        "201-v1.v1": (ms1_adpcm[0x000000:0x400000], "23d22ed1"),
        "201-v2.v2": (ms1_adpcm[0x400000:0x800000], "472cf9db"),
        "201-c1.c1": (ms1_c1, "72813676"),
        "201-c2.c2": (ms1_c2, "96f62574"),
        "201-c3.c3": (ms1_c3, "5121456a"),
        "201-c4.c4": (ms1_c4, "f4ad59a3"),
    }
    manifest["mslug"] = write_zip_and_verify(os.path.join(ROMS_DIR, "mslug.zip"), mslug1_files)

    # 2. mslug2.zip from Metal Slug 2
    ms2_dir = os.path.join(ROOT_DIR, "Metal Slug 2", "resources", "game")
    ms2_m68k = open(os.path.join(ms2_dir, "mslug2_game_m68k"), "rb").read()
    ms2_s1 = unpermute_sfix(open(os.path.join(ms2_dir, "mslug2_game_sfix"), "rb").read())
    ms2_z80 = open(os.path.join(ms2_dir, "mslug2_game_z80"), "rb").read()
    ms2_adpcm = open(os.path.join(ms2_dir, "mslug2_adpcm"), "rb").read()
    ms2_tiles = open(os.path.join(ms2_dir, "mslug2_tiles"), "rb").read()
    ms2_c1, ms2_c2 = unpack_c_pair(ms2_tiles[0x0000000:0x1000000])
    ms2_c3, ms2_c4 = unpack_c_pair(ms2_tiles[0x1000000:0x2000000])

    mslug2_files = {
        "241-p1.p1": (ms2_m68k[0x000000:0x100000], "2a53c5da"),
        "241-p2.sp2": (ms2_m68k[0x100000:0x300000], "38883f44"),
        "241-s1.s1": (ms2_s1, "f3d32f0f"),
        "241-m1.m1": (ms2_z80, "94520ebd"),
        "241-v1.v1": (ms2_adpcm[0x000000:0x400000], "99ec20e8"),
        "241-v2.v2": (ms2_adpcm[0x400000:0x800000], "ecb16799"),
        "241-c1.c1": (ms2_c1, "394b5e0d"),
        "241-c2.c2": (ms2_c2, "e5806221"),
        "241-c3.c3": (ms2_c3, "9f6bfa6f"),
        "241-c4.c4": (ms2_c4, "7d3e306f"),
    }
    manifest["mslug2"] = write_zip_and_verify(os.path.join(ROMS_DIR, "mslug2.zip"), mslug2_files)

    # 3. mslug3.zip from Metal Slug 3
    ms3_dir = os.path.join(ROOT_DIR, "Metal Slug 3", "resources", "game")
    ms3_m68k = open(os.path.join(ms3_dir, "mslug3_game_m68k"), "rb").read()
    ms3_sma = ms3_m68k[0x0C0000:0x100000]
    ms3_pg1, ms3_pg2 = unperm_mslug3_sma_prom(ms3_m68k)
    ms3_z80 = open(os.path.join(ms3_dir, "mslug3_game_z80"), "rb").read()
    ms3_adpcm = open(os.path.join(ms3_dir, "mslug3_adpcm"), "rb").read()
    ms3_tiles = open(os.path.join(ms3_dir, "mslug3_tiles"), "rb").read()
    ms3_c1, ms3_c2 = unpack_c_pair(ms3_tiles[0x0000000:0x1000000])
    ms3_c3, ms3_c4 = unpack_c_pair(ms3_tiles[0x1000000:0x2000000])
    ms3_c5, ms3_c6 = unpack_c_pair(ms3_tiles[0x2000000:0x3000000])
    ms3_c7, ms3_c8 = unpack_c_pair(ms3_tiles[0x3000000:0x4000000])

    mslug3_files = {
        "green.neo-sma": (ms3_sma, "9cd55736"),
        "256-pg1.p1": (ms3_pg1, "b07edfd5"),
        "256-pg2.p2": (ms3_pg2, "6097c26b"),
        "256-m1.m1": (ms3_z80, "eaeec116"),
        "256-v1.v1": (ms3_adpcm[0x0000000:0x0400000], "f2690241"),
        "256-v2.v2": (ms3_adpcm[0x0400000:0x0800000], "7e2a10bd"),
        "256-v3.v3": (ms3_adpcm[0x0800000:0x0C00000], "0eaec17c"),
        "256-v4.v4": (ms3_adpcm[0x0C00000:0x1000000], "9b4b22d4"),
        "256-c1.c1": (ms3_c1, "3540398c"),
        "256-c2.c2": (ms3_c2, "bdd220f0"),
        "256-c3.c3": (ms3_c3, "bfaade82"),
        "256-c4.c4": (ms3_c4, "1463add6"),
        "256-c5.c5": (ms3_c5, "48ca7f28"),
        "256-c6.c6": (ms3_c6, "806eb36f"),
        "256-c7.c7": (ms3_c7, "9395b809"),
        "256-c8.c8": (ms3_c8, "a369f9d4"),
    }
    manifest["mslug3"] = write_zip_and_verify(os.path.join(ROMS_DIR, "mslug3.zip"), mslug3_files)

    manifest_path = os.path.join(ROMS_DIR, "roms.manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as mf:
        json.dump(manifest, mf, indent=2)
    print(f"\n[MANIFEST] Wrote {manifest_path}")
    return manifest


def build_patched_core():
    os.makedirs(CORES_DIR, exist_ok=True)
    wasm_src = os.path.join(SCRATCH_DIR, "fbneo_libretro.wasm")
    js_src = os.path.join(SCRATCH_DIR, "fbneo_libretro.js")

    print("\n[CORE] Patching fbneo_libretro.wasm...")
    with open(wasm_src, "rb") as f:
        wasm = bytearray(f.read())

    # 1. Patch sp-s3.sp1 CRC (0x91b64be3 -> 0xe72943de)
    old_sp = struct.pack("<I", 0x91B64BE3)
    new_sp = struct.pack("<I", 0xE72943DE)
    for pos in (0x22A7B73, 0x22A8422, 0x261B399):
        assert wasm[pos : pos + 4] == old_sp, f"Unexpected bytes at {hex(pos)}"
        wasm[pos : pos + 4] = new_sp

    # 2. Patch sm1.sm1 CRC (0x94416d67 -> 0xc28b3253)
    old_sm1 = struct.pack("<I", 0x94416D67)
    new_sm1 = struct.pack("<I", 0xC28B3253)
    for pos in (0x22A7DBA, 0x22A8669):
        assert wasm[pos : pos + 4] == old_sm1, f"Unexpected bytes at {hex(pos)}"
        wasm[pos : pos + 4] = new_sm1

    # 3. Patch BurnDrvMslug3.nHardwareCode (0x48000000 -> 0x40000000) to skip CMC42 C-ROM decryption
    hw_pos = 0x271E135 + 48
    assert struct.unpack_from("<I", wasm, hw_pos)[0] == 0x48000000
    struct.pack_into("<I", wasm, hw_pos, 0x40000000)

    # 4. Patch mslug3RomDesc C1..C8 CRCs to match MSLUG3_DECRYPTED_COMPONENTS
    dec_crcs = [
        0x3540398C,
        0xBDD220F0,
        0xBFAADE82,
        0x1463ADD6,
        0x48CA7F28,
        0x806EB36F,
        0x9395B809,
        0xA369F9D4,
    ]
    c_desc_base = 0x22B033B + 3 * 16  # Entry 3 is 256-c1.c1
    for i, crc in enumerate(dec_crcs):
        struct.pack_into("<I", wasm, c_desc_base + i * 16 + 8, crc)

    wasm_gz_path = os.path.join(CORES_DIR, "fbneo_libretro.wasm.bin")
    print(f"[CORE] Compressing patched WASM ({len(wasm):,} bytes) -> {wasm_gz_path}...")
    compressed = gzip.compress(bytes(wasm), compresslevel=9)
    with open(wasm_gz_path, "wb") as f:
        f.write(compressed)
    print(f"  => fbneo_libretro.wasm.bin: {len(compressed):,} bytes ({len(compressed)/(1024*1024):.2f} MiB)")

    # 5. Patch fbneo_libretro.js to expose MainLoop and callUserCallback on Module
    with open(js_src, "r", encoding="utf-8") as f:
        js_code = f.read()

    target = 'Module["AL"]=AL;'
    replacement = 'Module["AL"]=AL;Module["MainLoop"]=MainLoop;Module["callUserCallback"]=callUserCallback;Module["removeAllEventListeners"]=_emscripten_html5_remove_all_event_listeners;'
    assert target in js_code, "Could not find Module['AL']=AL; in fbneo_libretro.js"
    js_code = js_code.replace(target, replacement, 1)

    js_dst = os.path.join(CORES_DIR, "fbneo_libretro.js")
    with open(js_dst, "w", encoding="utf-8") as f:
        f.write(js_code)
    print(f"  => fbneo_libretro.js: {len(js_code):,} bytes")


def extract_ui_assets():
    os.makedirs(ASSETS_DIR, exist_ok=True)
    print("\n[ASSETS] Extracting UI artwork from Metal Slug 1, 2, & 3 resources/datas...")
    game_sources = [
        ("ms1", os.path.join(ROOT_DIR, "Metal Slug", "resources", "datas")),
        ("ms2", os.path.join(ROOT_DIR, "Metal Slug 2", "resources", "datas")),
        ("ms3", os.path.join(ROOT_DIR, "Metal Slug 3", "resources", "datas")),
    ]
    for prefix, datas_path in game_sources:
        with zipfile.ZipFile(datas_path, "r") as zf:
            if "backgrounds/bg_mainmenu.png" in zf.namelist():
                data = zf.read("backgrounds/bg_mainmenu.png")
                out_name = f"{prefix}_bg.png"
                with open(os.path.join(ASSETS_DIR, out_name), "wb") as out_f:
                    out_f.write(data)
                print(f"  + {out_name:<22} {len(data):>8,} bytes")

    ms1_datas = os.path.join(ROOT_DIR, "Metal Slug", "resources", "datas")
    with zipfile.ZipFile(ms1_datas, "r") as zf:
        for zpath in ("backgrounds/bg_multiplayer.png", "splashes/splash_neogeo.png", "splashes/splash_snk.png"):
            if zpath in zf.namelist():
                data = zf.read(zpath)
                out_name = os.path.basename(zpath)
                with open(os.path.join(ASSETS_DIR, out_name), "wb") as out_f:
                    out_f.write(data)
                print(f"  + {out_name:<22} {len(data):>8,} bytes")


if __name__ == "__main__":
    build_roms()
    build_patched_core()
    extract_ui_assets()
    print("\n[DONE] All Metal Slug Web ROMs, cores, and assets built successfully!")
