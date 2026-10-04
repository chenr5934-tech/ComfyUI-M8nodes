# -*- coding: utf-8 -*-
"""用**真解码器**验 APNG 编码器的输出。

`tests/frontend_apng.js` 验的是「结构按规范拼对了」—— 块顺序、序列号连号、
每个块的 CRC、长度加不加得起来。那条路没有解码器，验不了「这个文件真能解码」。

这个脚本补上那一环，而且是双向的：

    Pillow 造真 PNG  ->  Node 调 M8Apng.build()  ->  Pillow 解码回来核对

核对帧数、尺寸、**每帧的实际像素**和时长。像素那一项最关键：它同时证明了
「帧数据的字节没串行」和「色彩格式声明得对」—— 只看结构是看不出这两件事的。

跑法：
    python tests/verify_apng.py

需要 Node 和 Pillow，两个跑测试的机器上都有。不联网。
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENCODER = ROOT / "M8web" / "assets" / "js" / "apng.js"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    print("没有 Pillow，跑不了这个验证。用 ComfyUI 自带的 python 跑。")
    raise SystemExit(1)


# 每帧一个纯色，颜色彼此不同、也和「默认黑」「透明」不同 ——
# 这样一旦帧数据串了或者 alpha 被丢掉，一眼就能看出来
COLORS = [
    (255, 0, 0, 255),
    (0, 255, 0, 255),
    (0, 0, 255, 255),
    (255, 255, 0, 255),
]

checks = 0
problems: list[str] = []


def ok(label: str) -> None:
    global checks
    checks += 1
    print("  OK   " + label)


def bad(label: str, detail: str = "") -> None:
    global checks
    checks += 1
    problems.append(label + ("：" + detail if detail else ""))
    print("  FAIL " + label + ("  -> " + detail if detail else ""))


def want(cond: bool, label: str, detail: str = "") -> None:
    """一句话的断言。过了和不过都记一笔。"""
    if cond:
        ok(label)
    else:
        bad(label, detail)


def make_frames(folder: Path, count: int, size: tuple) -> list:
    """用 Pillow 造 count 张纯色 PNG。"""
    out = []
    for i in range(count):
        path = folder / ("frame%d.png" % i)
        Image.new("RGBA", size, COLORS[i % len(COLORS)]).save(path)
        out.append(path)
    return out


# 编码器是 js，这里不重复实现一遍 —— 用 Node 跑它
ENCODE_JS = """
const fs = require('fs');
const path = process.argv[1];
const files = JSON.parse(process.argv[2]);
const opts = JSON.parse(process.argv[3]);
const outPath = process.argv[4];
const src = fs.readFileSync(path, 'utf8');
const A = new Function(src + ';return M8Apng;')();
const frames = files.map((f) => ({ png: new Uint8Array(fs.readFileSync(f)) }));
const out = A.build(frames, opts);
fs.writeFileSync(outPath, out);
console.log(out.length);
"""


def encode(frames: list, out_path: Path, opts: dict) -> int:
    """调 Node 把若干 PNG 合成 APNG，返回字节数。"""
    result = subprocess.run(
        ["node", "-e", ENCODE_JS, "--", str(ENCODER),
         json.dumps([str(p) for p in frames]), json.dumps(opts), str(out_path)],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError("编码器跑失败：\n" + (result.stderr or result.stdout))
    return int(result.stdout.strip().splitlines()[-1])


def read_apng(path: Path):
    """把一份 APNG 读成一份普通数据。

    **一定要在这里把文件关掉。** Pillow 对多帧图像是留着文件句柄的
    （seek 时还要读），不关的话 Windows 删不掉临时目录，报的还是一句
    和 APNG 毫无关系的 "另一个程序正在使用此文件"。
    """
    im = Image.open(path)
    try:
        n = getattr(im, "n_frames", 1)
        pixels = []
        durations = []
        for i in range(n):
            im.seek(i)
            pixels.append(im.convert("RGBA").getpixel((5, 5)))
            durations.append(im.info.get("duration"))
        return {
            "format": im.format,
            "animated": bool(getattr(im, "is_animated", False)),
            "frames": n,
            "size": im.size,
            "colors": pixels,
            "durations": durations,
            "loop": im.info.get("loop"),
        }
    finally:
        im.close()


print()
print("=== 1. 三帧 64x48，每帧 120ms ===")

with tempfile.TemporaryDirectory(prefix="m8-apng-") as tmp:
    tmpdir = Path(tmp)
    size = (64, 48)
    frames = make_frames(tmpdir, 3, size)
    out = tmpdir / "anim.png"
    nbytes = encode(frames, out, {"delayMs": 120, "loops": 0})
    ok("编码器产出 %d 字节" % nbytes)

    got = read_apng(out)

want(got["format"] == "PNG", "Pillow 认得这是 PNG", str(got["format"]))
want(got["animated"], "Pillow 认为它是动图（is_animated）")
want(got["frames"] == 3, "帧数 = 3", "实际 %d" % got["frames"])
want(got["size"] == size, "尺寸 = %dx%d" % size, "实际 %s" % (got["size"],))
# 这一项同时证明「帧数据没串」和「色彩格式声明得对」
want(got["colors"] == COLORS[:3], "每帧的像素和源图一一对应（红 / 绿 / 蓝）",
     "期望 %s，实际 %s" % (COLORS[:3], got["colors"]))
want(all(d is not None and abs(float(d) - 120) < 0.01 for d in got["durations"]),
     "每帧时长 = 120ms", str(got["durations"]))

print()
print("=== 2. 四帧，每帧 40ms，尺寸换成 37x21（奇数边）===")

with tempfile.TemporaryDirectory(prefix="m8-apng-") as tmp:
    tmpdir = Path(tmp)
    size = (37, 21)
    frames = make_frames(tmpdir, 4, size)
    out = tmpdir / "anim.png"
    encode(frames, out, {"delayMs": 40, "loops": 2})
    got = read_apng(out)

want(got["frames"] == 4 and got["size"] == size,
     "4 帧 / 37x21", "%d 帧 / %s" % (got["frames"], (got["size"],)))
want(got["colors"] == COLORS, "四帧的颜色都对", str(got["colors"]))
want(got["loop"] == 2, "循环次数 = 2", "实际 %s" % got["loop"])

print()
print("=== 3. 单帧（只有首图，不带后续帧）===")

with tempfile.TemporaryDirectory(prefix="m8-apng-") as tmp:
    tmpdir = Path(tmp)
    frames = make_frames(tmpdir, 1, (24, 24))
    out = tmpdir / "anim.png"
    encode(frames, out, {"delayMs": 100, "loops": 0})
    got = read_apng(out)

# 单帧的 APNG 应该退化成一个能正常打开的普通 PNG
want(got["size"] == (24, 24), "单帧也能被 Pillow 打开，尺寸正确",
     "实际 %s" % (got["size"],))

print()
print("=== 4. 速度档换算出来的时长，Pillow 读回来一致 ===")

with tempfile.TemporaryDirectory(prefix="m8-apng-") as tmp:
    tmpdir = Path(tmp)
    frames = make_frames(tmpdir, 2, (16, 16))
    # 页面里走的是 delayFromSpeed（基准 100ms / 倍率），这里照它算。
    # 期望值要**跟编码器用同一套对齐**：4× 算出来是 25ms，但 APNG 的延迟
    # 单位是百分之一秒，落到文件里只能是 10ms 的倍数，所以是 30ms。
    # 这不是误差被容忍掉了，是两边都对齐到了格式允许的刻度上。
    for speed, expected in ((2.0, 50), (0.5, 200), (4.0, 30)):
        out = tmpdir / ("s%s.png" % speed)
        encode(frames, out, {"delayMs": round(100 / speed), "loops": 0})
        got = read_apng(out)
        d = got["durations"][0]
        want(d is not None and abs(float(d) - expected) < 0.01,
             "%s× -> 每帧 %dms" % (speed, expected), "实际 %s" % d)

print()
print("=" * 58)
if problems:
    print("  解码验证：%d 项，其中 %d 项有问题" % (checks, len(problems)))
    for item in problems:
        print("    - " + item)
    print("=" * 58)
    raise SystemExit(1)

print("  解码验证：%d 项全部通过" % checks)
print("  （编码器的输出已被真解码器读过，不只是结构拼对了）")
print("=" * 58)
