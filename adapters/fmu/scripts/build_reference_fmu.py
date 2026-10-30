#!/usr/bin/env python3
"""把参考水箱 FMU 的 C 源码编译成 FMI 2.0 的 .fmu（zip）与解包目录。"""

from __future__ import annotations

import argparse
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile


ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "models" / "tank"
PLATFORM = {
    "linux": "linux64",
    "darwin": "darwin64",
    "win32": "win64",
}.get(sys.platform, sys.platform)


def library_name(platform: str) -> str:
    if platform == "win64":
        return "tank.dll"
    if platform == "darwin64":
        return "libtank.dylib"
    return "libtank.so"


def build(compiler: str, out_dir: Path, fmu_path: Path | None) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    binary_dir = out_dir / "binaries" / PLATFORM
    binary_dir.mkdir(parents=True, exist_ok=True)
    library = binary_dir / library_name(PLATFORM)
    command = [compiler, "-std=c99", "-O2", "-fPIC", "-shared", str(MODEL / "sources" / "tank.c"), "-o", str(library)]
    if compiler.endswith("cl"):
        command = [compiler, str(MODEL / "sources" / "tank.c"), f"/Fo:{library}"]
    subprocess.run(command, check=True)
    shutil.copyfile(MODEL / "modelDescription.xml", out_dir / "modelDescription.xml")
    if fmu_path:
        fmu_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(fmu_path, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.write(out_dir / "modelDescription.xml", "modelDescription.xml")
            archive.write(library, f"binaries/{PLATFORM}/{library.name}")
            archive.write(MODEL / "sources" / "tank.c", "sources/tank.c")
    return library


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="构建参考水箱 FMU")
    parser.add_argument("--out-dir", required=True, help="解包目录（含 modelDescription.xml 与 binaries/）")
    parser.add_argument("--fmu", help="同时打包成 .fmu")
    parser.add_argument("--compiler", default=shutil.which("cc") or shutil.which("gcc") or "cc")
    args = parser.parse_args(argv)
    library = build(args.compiler, Path(args.out_dir), Path(args.fmu) if args.fmu else None)
    print(f"已构建 {library}")
    if args.fmu:
        print(f"已打包 {args.fmu}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
