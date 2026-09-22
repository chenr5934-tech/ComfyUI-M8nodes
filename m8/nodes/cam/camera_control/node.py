"""M8 · 相机控制（相机货架）。

把抽象的取景意图翻译成提示词：给它一个机位，它输出一串能直接进正向提示词的文字。

为什么要有这么个节点：
  相机位姿天生是数值（左右/上下/远近/翻滚），而模型只认文字。"从右前方仰拍、
  中景、长焦"这种话，靠手写既慢又难改，改一个维度就得重排整句。本节点把这两头接上 ——
  数值进，提示词出，改哪个维度只动那个维度。

## 算法（三层，各自独立）

1. **方位（azimuth）**：pos_x 乘 π 得环绕角，用 cos/sin 拆成前后左右四个分量，
   正负分离后归一化 —— 四个方向瓜分 100% 权重预算。预算 = azimuth.weight × 极向门控，
   门控在相机接近"完全指上/指下"时趋零（此时水平投影没意义，前后左右不该输出）。
   占比低于 deadzone_ratio 的方向不输出，避免一堆 0.001 权重的噪声。

2. **高度（elevation）**：互斥单档。俯视和仰视互为反义，同时出现会让模型收到冲突信号，
   所以任何时刻只出一档。eye（平视）是"中心档"—— 越接近 0 越平视、权重越大；
   bird/high/low/worm 是"极端档"—— 越偏离水平特征越明显、权重越大。两类单调方向相反，
   不能共用一条公式（共用的话最平视时 eye-level 权重会是 0，等于人站着拍却不说平视）。

3. **距离（distance）**：五档互斥，档内权重随 z 线性爬升到档外（跨档时下一档从零重新爬）。
   近景是越近权重越大，中景以上反过来 —— 见 DIST_FAR_STRONGER。

倾斜（roll）过死区输出 dutch angle。镜头/景深/运镜/构图/风格是五个独立开关，
各自带一段自定义文案，开启就原样贴上。

## 前后端分工

**本文件是提示词的唯一权威**。前端那份同名算法只用于拖拽时的实时预览 ——
两边算法必须一致，但落盘的数值只有一个来源：这里。前端算错了顶多预览难看，
不会污染工作流结果。

roll 由前端画布写入（Shift+滚轮 / , . 键），这样后端才能权威判断 tilt。
"""

from __future__ import annotations

import json
import math
from typing import Any

from ....core.errors import M8Error
from ....core.log import SHELF_CAM, log

# ============ 默认配置 ============
# 这份必须和前端 js/nodes/cam/camera_control.js 里的 DEFAULT_CONFIG 逐字一致 ——
# 两边不一致会出现「面板显示的值和实际输出的权重对不上」这种极难查的问题。
# tests/smoke_import.py 会比对两边。
DEFAULT_CONFIG: dict[str, Any] = {
    "weight_min": 0.1,
    "weight_max": 10.0,
    "no_weight": False,
    "no_weight_threshold": 0.5,
    "azimuth": {
        "enabled": True,
        "weight": 10.0,
        "deadzone_ratio": 0.2,
        "directions": {
            "front": {"tag": "from front", "enabled": True},
            "back": {"tag": "from behind", "enabled": True},
            "left": {"tag": "from right", "enabled": True},
            "right": {"tag": "from left", "enabled": True},
        },
    },
    "elevation": {
        "enabled": True,
        "extra": 10.0,
        "eye_peak": 3.0,
        "categories": {
            "bird": {"tag": "directly above, from above, aerial view,", "enabled": True},
            "high": {"tag": "high angle, from above", "enabled": True},
            "eye": {"tag": "eye-level", "enabled": True},
            "low": {"tag": "low angle, from below,", "enabled": True},
            "worm": {"tag": "directly below", "enabled": True},
        },
    },
    "distance": {
        "enabled": True,
        "extra": 0.0,
        "categories": {
            "ecu": {"tag": "extreme close-up", "enabled": True},
            "cu": {"tag": "close-up", "enabled": True},
            "medium": {"tag": "medium shot", "enabled": True},
            "full": {"tag": "full body", "enabled": True},
            "wide": {"tag": "wide shot", "enabled": True},
        },
    },
    "tilt": {
        "enabled": True,
        "deadzone": 0.15,
        "extra": 0.0,
        "dutch_tag": "dutch angle",
    },
    "extra_master": 1.0,
    "drag_step": 0.004,     # 右键拖拽调距离：每 1px 改变的 z 量，钳制 [0.0005, 0.02]
    "extras": {
        "lens": {"enabled": False, "value": "85mm lens"},
        "dof": {"enabled": False, "value": "shallow depth of field", "weight": 1.3},
        "movement": {"enabled": False, "value": "handheld camera"},
        "composition": {"enabled": False, "value": "rule of thirds"},
        "style": {"enabled": False, "value": "cinematic"},
    },
}

DEFAULT_CONFIG_JSON = json.dumps(DEFAULT_CONFIG, ensure_ascii=False)

# 距离档位的 z 区间：档内权重随 z 从区间起点(0% 额外权重)线性爬到终点(100%)。
# 跨档时下一档从 0% 重新开始。
DIST_RANGES: dict[str, tuple[float, float]] = {
    "ecu": (0.7, 1.0),
    "cu": (0.2, 0.7),
    "medium": (-0.2, 0.2),
    "full": (-0.7, -0.2),
    "wide": (-1.0, -0.7),
}

# 中景/全身/远景：距离越远权重越大，故档内 frac 反向算。特写/近景仍是越近越大。
DIST_FAR_STRONGER = {"medium", "full", "wide"}


class M8CameraControl:
    """可视化相机提示词控制。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "pos_x": ("FLOAT", {
                    "default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01,
                    "label": "左右 (X)",
                }),
                "pos_y": ("FLOAT", {
                    "default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01,
                    "label": "上下 (Y)",
                }),
                "pos_z": ("FLOAT", {
                    "default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01,
                    "label": "前后 (Z)",
                }),
                "roll": ("FLOAT", {
                    "default": 0.0, "min": -1.0, "max": 1.0, "step": 0.01,
                    "label": "翻滚 (Roll)",
                }),
                "config": ("STRING", {
                    "multiline": True,
                    "default": DEFAULT_CONFIG_JSON,
                }),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("相机提示词",)
    FUNCTION = "execute"
    CATEGORY = "M8/相机"
    DESCRIPTION = ("可视化控制机位，输出对应的相机提示词"
                   "（方位比例分配 + 高度/距离/倾斜 + 镜头 / 景深 / 运镜 / 构图 / 风格）")

    # 平视档的上界，与高角度档的下界重合。
    ELEV_EYE_MAX = 0.2
    # 极向门控的起效点：|pos_y| 超过它，水平方向才开始收窄直至消失。
    AZ_POLE = 0.9

    # ---------------------------------------------------------------- 小工具

    @staticmethod
    def _fmt_weight(w: float) -> str:
        """权重统一两位小数。始终占两位，不然 3.0 和 3.00 在提示词里看着像两个东西。"""
        return f"{round(float(w), 2):.2f}"

    @staticmethod
    def _split_tags(tag: Any) -> list[str]:
        """把一个可能含逗号的 tag 拆成多条。空段丢掉。"""
        return [t.strip() for t in str(tag).split(",") if t.strip()]

    @classmethod
    def _emit_weighted(cls, tag: Any, w: float) -> list[str]:
        """带权重输出。同一属性下的多个 tag 共享一个权重，各自成段。"""
        return [f"({t}:{cls._fmt_weight(w)})" for t in cls._split_tags(tag)]

    @classmethod
    def _emit_plain(cls, tag: Any) -> list[str]:
        """无权重模式：纯 tag，逗号分隔的各自成段。"""
        return cls._split_tags(tag)

    # ---------------------------------------------------------------- 配置

    @classmethod
    def _merge_defaults(cls, cfg: dict, base: dict) -> dict:
        """用默认值递归补齐缺失字段。

        旧版本或别人手写的配置常少几个键，这里补齐比在每处取值时写 get(k, 默认) 干净 ——
        补一次，后面所有读取都可以当字段一定存在。
        多余的键不删：多出来的键不影响输出，删了反而会在用户切回旧版时丢设置。
        """
        for key, default in base.items():
            if key not in cfg:
                cfg[key] = json.loads(json.dumps(default)) if isinstance(default, dict) else default
            elif isinstance(default, dict) and isinstance(cfg[key], dict):
                cls._merge_defaults(cfg[key], default)
        return cfg

    @classmethod
    def _load_config(cls, raw: str) -> dict:
        """解析配置。坏 JSON 直接报错，不静默回退。

        这一点是有意和「宽容处理」反着来的：配置坏掉时静默用默认值，用户会以为自己的
        设置生效了，然后对着一个"改了参数没反应"的现象查半天。宁可当场报出来。
        """
        if not raw or not str(raw).strip():
            return json.loads(DEFAULT_CONFIG_JSON)
        try:
            cfg = json.loads(raw)
        except (ValueError, TypeError) as exc:
            raise M8Error(
                "M8-CAM-001",
                message="相机配置不是合法 JSON",
                detail=f"{type(exc).__name__}: {exc}",
            ) from exc
        if not isinstance(cfg, dict):
            raise M8Error(
                "M8-CAM-001",
                message="相机配置的顶层必须是一个对象",
                hint="配置要写成 {...} 这种键值对形式，不能是数组或单个值",
                detail=f"实际类型：{type(cfg).__name__}",
            )
        return cls._merge_defaults(cfg, json.loads(DEFAULT_CONFIG_JSON))

    # ---------------------------------------------------------------- 高度

    @classmethod
    def _elevation_key(cls, y: float) -> str:
        """pos_y 落在哪一档。"""
        if y > 0.7:
            return "bird"
        if y > cls.ELEV_EYE_MAX:
            return "high"
        if y >= 0:
            return "eye"
        if y >= -0.7:
            return "low"
        return "worm"

    @classmethod
    def _elevation_weight(cls, cfg: dict, y: float) -> str:
        """按档型算权重，返回已格式化的字符串便于调用处直接用。"""
        key = cls._elevation_key(y)
        elev = cfg.get("elevation") or {}
        if key == "eye":
            # 中心型：平视时权重最高，往高角度档走时线性落到基础权重 1.0。
            peak = float(elev.get("eye_peak", 3.0))
            t = max(0.0, min(1.0, float(y) / cls.ELEV_EYE_MAX))
            return peak + (1.0 - peak) * t
        # 极端型：越偏离水平越明显，权重只依赖 |y|，所以跨档天然连续。
        k = 1.0 + float(cfg.get("extra_master", 1.0)) * float(elev.get("extra", 0.0))
        if k <= 0:
            return 0.0  # 额外权重负到把基础权重抵消光，这一档整体不输出
        return abs(float(y)) * k

    # ---------------------------------------------------------------- 距离

    @staticmethod
    def _distance_key(z: float) -> str:
        """pos_z 落在哪一档。"""
        if z > 0.7:
            return "ecu"
        if z > 0.2:
            return "cu"
        if z >= -0.2:
            return "medium"
        if z >= -0.7:
            return "full"
        return "wide"

    @classmethod
    def _distance_parts(cls, cfg: dict, z: float) -> list[str]:
        """距离档的加权输出。档内线性爬升，跨档归零重爬。"""
        key = cls._distance_key(float(z))
        cat = (cfg.get("distance") or {}).get("categories", {}).get(key)
        if not cat or not cat.get("tag") or not cat.get("enabled", True):
            return []

        start, end = DIST_RANGES[key]
        if key in DIST_FAR_STRONGER:
            frac = (end - float(z)) / (end - start)   # 越远权重越大
        else:
            frac = (float(z) - start) / (end - start)  # 越近权重越大
        frac = max(0.0, min(1.0, frac))

        w = 1.0 + frac * float(cfg.get("extra_master", 1.0)) * float((cfg.get("distance") or {}).get("extra", 0.0))
        w = min(cls._wmax(cfg), max(cls._wmin(cfg), w))
        return cls._emit_weighted(cat["tag"], w)

    # ---------------------------------------------------------------- 权重边界

    @staticmethod
    def _wmin(cfg: dict) -> float:
        """权重下限。配置里写坏了就退回默认，不让它把整段输出压没。"""
        try:
            return float(cfg.get("weight_min", DEFAULT_CONFIG["weight_min"]))
        except (TypeError, ValueError):
            return DEFAULT_CONFIG["weight_min"]

    @staticmethod
    def _wmax(cfg: dict) -> float:
        """权重上限。同下限，写坏了退回默认。"""
        try:
            return float(cfg.get("weight_max", DEFAULT_CONFIG["weight_max"]))
        except (TypeError, ValueError):
            return DEFAULT_CONFIG["weight_max"]

    @classmethod
    def _tilt_parts(cls, cfg: dict) -> list[str]:
        """倾斜档的加权输出。"""
        tilt = cfg.get("tilt") or {}
        w = 1.0 + float(cfg.get("extra_master", 1.0)) * float(tilt.get("extra", 0.0))
        w = min(cls._wmax(cfg), max(cls._wmin(cfg), w))
        return cls._emit_weighted(tilt.get("dutch_tag", ""), w)

    # ---------------------------------------------------------------- 主流程

    def execute(self, pos_x: float, pos_y: float, pos_z: float, roll: float, config: str):
        """数值进，提示词出。"""
        cfg = self._load_config(config)
        if cfg.get("no_weight"):
            return (self._plain_prompt(float(pos_x), float(pos_y), float(pos_z), float(roll), cfg),)

        parts: list[str] = []
        parts.extend(self._azimuth_parts(cfg, float(pos_x), float(pos_y)))
        parts.extend(self._elevation_parts(cfg, float(pos_y)))
        parts.extend(self._distance_parts(cfg, float(pos_z)))
        parts.extend(self._roll_parts(cfg, float(roll)))
        parts.extend(self._extra_parts(cfg, weighted=True))

        result = ", ".join(parts)
        log(f"机位 ({pos_x:.2f}, {pos_y:.2f}, {pos_z:.2f}) 翻滚 {roll:.2f} → {len(parts)} 段", SHELF_CAM)
        return (result + "," if result else "",)

    @classmethod
    def _azimuth_parts(cls, cfg: dict, x: float, y: float) -> list[str]:
        """方位：四个方向瓜分一个权重预算。"""
        az_cfg = cfg.get("azimuth") or {}
        if not az_cfg.get("enabled", True):
            return []

        angle = x * math.pi
        raw = {
            "front": max(0.0, math.cos(angle)),
            "back": max(0.0, -math.cos(angle)),
            "left": max(0.0, -math.sin(angle)),
            "right": max(0.0, math.sin(angle)),
        }
        total = sum(raw.values())
        if total > 0:
            raw = {k: v / total for k, v in raw.items()}

        # 相机接近完全指上/指下时水平投影失去意义，门控把预算压到零。
        gate = max(0.0, min(1.0, (1.0 - abs(y)) / (1.0 - cls.AZ_POLE)))
        budget = float(az_cfg.get("weight", DEFAULT_CONFIG["azimuth"]["weight"])) * gate
        floor = float(az_cfg.get("deadzone_ratio", DEFAULT_CONFIG["azimuth"]["deadzone_ratio"]))

        parts: list[str] = []
        for name, ratio in raw.items():
            dir_cfg = (az_cfg.get("directions") or {}).get(name) or {}
            if not dir_cfg.get("enabled", True):
                continue
            w = ratio * budget
            if ratio <= 0 or w < floor:
                continue
            parts.extend(cls._emit_weighted(dir_cfg.get("tag", ""), min(cls._wmax(cfg), max(cls._wmin(cfg), w))))
        return parts

    @classmethod
    def _elevation_parts(cls, cfg: dict, y: float) -> list[str]:
        """高度：互斥单档。"""
        if not (cfg.get("elevation") or {}).get("enabled", True):
            return []
        key = cls._elevation_key(y)
        cat = (cfg.get("elevation") or {}).get("categories", {}).get(key)
        if not cat or not cat.get("tag") or not cat.get("enabled", True):
            return []
        w = cls._elevation_weight(cfg, y)
        if w <= 0:
            return []
        return cls._emit_weighted(cat["tag"], min(cls._wmax(cfg), max(cls._wmin(cfg), w)))

    @classmethod
    def _roll_parts(cls, cfg: dict, roll: float) -> list[str]:
        """倾斜：过死区才出 dutch angle。"""
        tilt = cfg.get("tilt") or {}
        if not tilt.get("enabled", True):
            return []
        try:
            deadzone = float(tilt.get("deadzone", DEFAULT_CONFIG["tilt"]["deadzone"]))
        except (TypeError, ValueError):
            deadzone = DEFAULT_CONFIG["tilt"]["deadzone"]
        if abs(roll) < deadzone:
            return []
        return cls._tilt_parts(cfg)

    @classmethod
    def _extra_parts(cls, cfg: dict, weighted: bool) -> list[str]:
        """五个附加开关。只有景深带权重 —— 它常需要比主标签更重才压得住画面。"""
        extras = cfg.get("extras") or {}
        parts: list[str] = []
        for key in ("lens", "dof", "movement", "composition", "style"):
            item = extras.get(key)
            if not item or not item.get("enabled"):
                continue
            value = str(item.get("value") or "").strip()
            if not value:
                continue
            if weighted and key == "dof":
                parts.append(f"({value}:{cls._fmt_weight(item.get('weight', 1.3))})")
            else:
                parts.append(value)
        return parts

    # ---------------------------------------------------------------- 无权重模式

    @classmethod
    def _plain_prompt(cls, x: float, y: float, z: float, roll: float, cfg: dict) -> str:
        """纯 tag 输出，给不认 (tag:权重) 写法的模型用。

        规则：方位只报主导方向，次要方向要过阈值才一起报；高度和距离的默认档
        （eye / medium）不输出 —— 平视中景是"什么都没说"的状态，写出来是废话。
        """
        parts: list[str] = []
        threshold = float(cfg.get("no_weight_threshold", DEFAULT_CONFIG["no_weight_threshold"]))

        az_cfg = cfg.get("azimuth") or {}
        if az_cfg.get("enabled", True):
            angle = x * math.pi
            ratios = {
                "front": max(0.0, math.cos(angle)),
                "back": max(0.0, -math.cos(angle)),
                "left": max(0.0, -math.sin(angle)),
                "right": max(0.0, math.sin(angle)),
            }
            total = sum(ratios.values())
            if total > 0:
                ratios = {k: v / total for k, v in ratios.items()}
            gate = max(0.0, min(1.0, (1.0 - abs(y)) / (1.0 - cls.AZ_POLE)))
            if gate > 0:
                enabled = {
                    name: (az_cfg.get("directions") or {}).get(name) or {}
                    for name in ratios
                }
                usable = {n: r for n, r in ratios.items() if enabled[n].get("enabled", True)}
                if usable:
                    dom = max(usable, key=lambda n: usable[n])
                    if usable[dom] > 0:
                        parts.extend(cls._emit_plain(enabled[dom].get("tag", "")))
                    for name, ratio in usable.items():
                        if name != dom and ratio >= threshold:
                            parts.extend(cls._emit_plain(enabled[name].get("tag", "")))

        if (cfg.get("elevation") or {}).get("enabled", True):
            key = cls._elevation_key(y)
            if key != "eye":
                cat = (cfg.get("elevation") or {}).get("categories", {}).get(key)
                if cat and cat.get("tag") and cat.get("enabled", True):
                    parts.extend(cls._emit_plain(cat["tag"]))

        if (cfg.get("distance") or {}).get("enabled", True):
            key = cls._distance_key(z)
            if key != "medium":
                cat = (cfg.get("distance") or {}).get("categories", {}).get(key)
                if cat and cat.get("tag") and cat.get("enabled", True):
                    parts.extend(cls._emit_plain(cat["tag"]))

        tilt = cfg.get("tilt") or {}
        if tilt.get("enabled", True):
            try:
                deadzone = float(tilt.get("deadzone", DEFAULT_CONFIG["tilt"]["deadzone"]))
            except (TypeError, ValueError):
                deadzone = DEFAULT_CONFIG["tilt"]["deadzone"]
            if abs(roll) >= deadzone:
                parts.extend(cls._emit_plain(tilt.get("dutch_tag", "")))

        parts.extend(cls._extra_parts(cfg, weighted=False))
        result = ", ".join(parts)
        return result + "," if result else ""


NODE_CLASS_MAPPINGS = {
    "M8CameraControl": M8CameraControl,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "M8CameraControl": "M8 · 相机控制",
}
