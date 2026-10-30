"""scene-spec 的 Python 侧最小实现：canonical JSON 与 FNV-1a。

只依赖标准库。这里不复刻 runner，也不认识 TwinWorld；它只保证外部 runtime
写出的 trace 与 TypeScript `scene-spec` 使用同一份字节级规范化规则。
"""

from __future__ import annotations

from decimal import Decimal
import json
import math
from typing import Any


def _number(value: int | float) -> str:
    if isinstance(value, int):
        if abs(value) < 1e21:
            return str(value)
        value = float(value)
    if not math.isfinite(value):
        raise ValueError("trace 不能包含 NaN / Infinity")
    if value == 0:
        return "0"
    if value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    text = repr(value).lower()
    if "e" not in text:
        return text
    mantissa, exponent_text = text.split("e")
    exponent = int(exponent_text)
    # JS JSON.stringify 在 [1e-6, 1e21) 用十进制，其余用指数。
    if 1e-6 <= abs(value) < 1e21:
        return format(Decimal(text), "f")
    mantissa = mantissa.rstrip("0").rstrip(".")
    return f"{mantissa}e{'+' if exponent >= 0 else ''}{exponent}"


def canonical_json(value: Any) -> str:
    """与 JS `JSON.stringify(canonicalize(value))` 对齐的紧凑 JSON。"""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return _number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        parts = []
        for key in sorted(value):
            if not isinstance(key, str):
                raise TypeError("trace 对象键必须是字符串")
            if value[key] is ...:
                continue
            parts.append(canonical_json(key) + ":" + canonical_json(value[key]))
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"trace 含不可序列化类型：{type(value).__name__}")


def stable_hash(value: Any) -> str:
    """FNV-1a 32 位；按 UTF-16 code unit 迭代，和 JS charCodeAt 一致。"""
    text = value if isinstance(value, str) else canonical_json(value)
    encoded = text.encode("utf-16-le", errors="surrogatepass")
    result = 0x811C9DC5
    for offset in range(0, len(encoded), 2):
        code_unit = encoded[offset] | (encoded[offset + 1] << 8)
        result ^= code_unit
        result = (result * 0x01000193) & 0xFFFFFFFF
    return f"{result:08x}"


def write_canonical_json(path: str, value: Any) -> None:
    """证据文件固定键序、固定缩进、UTF-8，不写挂钟时间。"""
    with open(path, "w", encoding="utf-8", newline="\n") as output:
        json.dump(value, output, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False)
        output.write("\n")
