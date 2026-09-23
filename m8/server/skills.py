"""skill 包管理。

一个 skill 是一个**目录**，不是一个文件：

    m8/data/skills/
    └── aigc-prompt/
        ├── SKILL.md          主文件，必需
        ├── references/       资源，可选
        └── scripts/

为什么是目录：skill 常常不只是一段提示词，它还要带参考资料、模板、示例数据。
单文件的形态装不下这些，于是「照着 references/xxx 里的风格写」这类指令就成了空话 ——
模型根本拿不到那个文件。目录形态才能把资源一起带上。

**资源怎么给模型**：ComfyUI 里的模型没有读文件的工具，所以资源文件必须在
组装请求时就内联进正文（见 read_bundle）。内联有两条护栏：单文件大小上限、
总量上限；超出的不展开，但会在末尾列出清单 —— 让模型知道自己缺什么，
不至于凭空编造一个「我按参考文件写了」。

**兼容**：老的平铺 .md 文件仍然能读（当作只有一个主文件的包），
但保存一律走目录式，不再产生新的平铺文件。

安全上做三件事，都不难但一件都不能少：
  1. 名字清洗 —— 目录名只留一层，去路径分隔符和控制字符
  2. 包内相对路径逐段清洗 —— 防 ../../ 逃出 skill 目录
  3. 体积上限，且边读边判 —— 不是先收完 100 MB 再拒绝
"""

from __future__ import annotations

import re
import shutil
import time
from pathlib import Path
from typing import Any, Iterable

from ..core import paths
from ..core.errors import M8Error
from ..core.log import SHELF_SRV, log

# 目录名里保留这些字符，其余换成下划线
_SAFE_NAME = re.compile(r"[^0-9A-Za-z_\-\u4e00-\u9fff.]+")
_CHUNK = 64 * 1024

# 主文件名。放这个文件名的就是「这个 skill 是干什么的」那份正文。
MAIN_FILE = "SKILL.md"

# 内联护栏：单个资源文件、以及整个包的内联总量
MAX_RESOURCE_BYTES = 64 * 1024
MAX_BUNDLE_BYTES = 256 * 1024

# 只内联这些后缀的文件。二进制（图片、字体、压缩包）展开进提示词没有意义，
# 只会把上下文烧光 —— 它们在清单里被列出来就够了。
TEXT_SUFFIXES = {
    ".md", ".markdown", ".txt", ".rst",
    ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg",
    ".csv", ".tsv",
    ".py", ".js", ".mjs", ".ts", ".sh", ".ps1", ".bat",
    ".html", ".htm", ".css", ".sql", ".xml",
}

# 主文件里长成这样的东西，是在引用包内的文件
_RESOURCE_REF = re.compile(
    r"[A-Za-z0-9_\-][A-Za-z0-9_\-./]*\.(?:md|markdown|txt|rst|json|ya?ml|toml|ini|cfg|csv|tsv"
    r"|py|js|mjs|ts|sh|ps1|html?|css|sql|xml)",
    re.IGNORECASE,
)
# 只提到目录名的写法：「见 references/ 里的…」
_DIR_REF = re.compile(
    r"\b(references?|scripts?|assets?|templates?|examples?|data|evals?|agents?|docs?)\b\s*/",
    re.IGNORECASE,
)


# ---------------------------------------------------------------- 名字与路径

def sanitize_name(raw: str) -> str:
    """把用户给的名字收拾成一个安全的单层目录名。"""
    name = (raw or "").strip().replace("\\", "/").split("/")[-1]
    name = _SAFE_NAME.sub("_", name).strip("._")
    if not name:
        raise M8Error("M8-SRV-003", message="名字是空的或全是非法字符")
    if len(name) > 120:
        name = name[:120].strip("._") or "skill"
    return name


def sanitize_rel_path(raw: str) -> str:
    """把包内相对路径收拾干净，或拒绝它。

    只允许一层层普通目录名：任何一段是 . 或 ..、或者带盘符、或者空，
    一律当成非法 —— 这些正是目录穿越的写法。
    """
    text = (raw or "").strip().replace("\\", "/")
    if not text:
        raise M8Error("M8-SRV-003", message="包内路径是空的")
    if text.startswith("/") or ":" in text:
        raise M8Error("M8-SRV-003", message=f"包内路径不能是绝对路径：{raw}")

    parts: list[str] = []
    for chunk in text.split("/"):
        chunk = chunk.strip()
        if not chunk:
            continue
        if chunk == "..":
            raise M8Error("M8-SRV-003", message=f"包内路径不能有 ..：{raw}")
        if chunk == ".":
            # 开头的 ./ 是合法写法，浏览器上传时也会带，跳过即可。
            # 危险的是 .. —— 那一支上面已经拦了。
            continue
        cleaned = _SAFE_NAME.sub("_", chunk).strip("._")
        if not cleaned:
            raise M8Error("M8-SRV-003", message=f"包内路径里有一段全是非法字符：{raw}")
        parts.append(cleaned)

    if not parts:
        raise M8Error("M8-SRV-003", message=f"包内路径收拾完是空的：{raw}")
    return "/".join(parts)


def _resolve(name: str) -> Path:
    """拿到某个 skill 的目录路径，并确认它真的在 SKILLS_DIR 里。"""
    candidate = paths.SKILLS_DIR / sanitize_name(name)
    if not paths.is_inside(candidate, paths.SKILLS_DIR):
        raise M8Error("M8-SRV-003", message=f"名字会把目录建到外面去：{name}")
    return candidate


def _is_legacy_file(entry: Path) -> bool:
    """老格式：直接躺在 skills/ 下的一个 .md 文件。"""
    return entry.is_file() and entry.suffix.lower() in (".md", ".markdown", ".txt") and not entry.name.startswith(".")


def _main_file(directory: Path) -> Path | None:
    """在包里找主文件。

    优先级：SKILL.md -> 任意一个顶层 .md -> 目录里唯一的文本文件。
    找不到就返回 None，上层会报 M8-LLM-011。
    """
    if not directory.is_dir():
        return None
    preferred = directory / MAIN_FILE
    if preferred.is_file():
        return preferred

    top = sorted(
        (p for p in directory.iterdir() if p.is_file() and p.suffix.lower() in (".md", ".markdown")),
        key=lambda p: p.name.lower(),
    )
    if top:
        return top[0]

    loose = sorted(
        (p for p in directory.iterdir() if p.is_file() and p.suffix.lower() in TEXT_SUFFIXES),
        key=lambda p: p.name.lower(),
    )
    return loose[0] if len(loose) == 1 else None


# ---------------------------------------------------------------- 列表

def _package_files(directory: Path) -> list[Path]:
    """包里所有文件（不含隐藏文件），相对路径排序。"""
    found: list[Path] = []
    for path in sorted(directory.rglob("*"), key=lambda p: str(p).lower()):
        if not path.is_file():
            continue
        if any(part.startswith(".") for part in path.relative_to(directory).parts):
            continue
        found.append(path)
    return found


def list_skills() -> list[dict[str, Any]]:
    """列出已上传的 skill 包，按名字排序。

    目录式（新格式）和散落的 .md（老格式）都会列出来 ——
    读取时两种都认，只是保存只会产生目录式。
    """
    paths.ensure_data_dirs()
    items: list[dict[str, Any]] = []

    for entry in sorted(paths.SKILLS_DIR.iterdir(), key=lambda p: p.name.lower()):
        if entry.name.startswith("."):
            continue

        if entry.is_dir():
            main = _main_file(entry)
            files = _package_files(entry)
            if not files:
                continue  # 空目录不算 skill
            try:
                stat = entry.stat()
            except OSError:
                continue
            title = ""
            if main is not None:
                try:
                    with open(main, "r", encoding="utf-8", errors="replace") as handle:
                        title = title_of(handle.read(4000))
                except OSError:
                    pass
            total = sum(p.stat().st_size for p in files if p.exists())
            items.append({
                "name": entry.name,
                "stem": entry.name,
                "title": title,
                "size": total,
                "sizeText": human_size(total),
                "fileCount": len(files),
                "resourceCount": max(0, len(files) - 1),
                "legacy": False,
                "mtime": time.strftime("%Y-%m-%d %H:%M", time.localtime(stat.st_mtime)),
            })
            continue

        if _is_legacy_file(entry):
            try:
                stat = entry.stat()
                with open(entry, "r", encoding="utf-8", errors="replace") as handle:
                    title = title_of(handle.read(4000))
            except OSError:
                continue
            items.append({
                "name": entry.name,
                "stem": display_name(entry.name),
                "title": title,
                "size": stat.st_size,
                "sizeText": human_size(stat.st_size),
                "fileCount": 1,
                "resourceCount": 0,
                "legacy": True,
                "mtime": time.strftime("%Y-%m-%d %H:%M", time.localtime(stat.st_mtime)),
            })

    return items


def skill_names() -> list[str]:
    """所有 skill 的名字（目录名或文件名），给引用解析用。"""
    return [item["name"] for item in list_skills()]


# ---------------------------------------------------------------- 读取

def _read_text(path: Path) -> str:
    return path.read_text("utf-8", errors="replace")


def read_skill(name: str) -> str:
    """读一个 skill 的主文件正文。读不到就是 M8-LLM-011。"""
    target = _resolve(name)

    if target.is_dir():
        main = _main_file(target)
        if main is None:
            raise M8Error("M8-LLM-011", message=f"skill 里没有主文件：{name}（需要 {MAIN_FILE}）")
        path = main
    elif target.is_file():
        path = target
    else:
        raise M8Error("M8-LLM-011", message=f"skill 不存在：{name}")

    try:
        return _read_text(path)
    except OSError as exc:
        raise M8Error("M8-LLM-011", message=f"skill 读不出来：{name}", detail=str(exc)) from exc


def list_resources(name: str) -> list[dict[str, Any]]:
    """列出一个包里的附属文件（不含主文件）。"""
    target = _resolve(name)
    if not target.is_dir():
        return []

    main = _main_file(target)
    items: list[dict[str, Any]] = []
    for path in _package_files(target):
        if main is not None and path == main:
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        items.append({
            "path": path.relative_to(target).as_posix(),
            "size": stat.st_size,
            "sizeText": human_size(stat.st_size),
            "text": path.suffix.lower() in TEXT_SUFFIXES,
        })
    return items


def _referenced_resources(main_text: str, directory: Path) -> list[str]:
    """主文件里引用到的包内文件，按出现顺序去重。

    两种写法都认：
        references/style.md      具体文件
        见 references/ 里的说明   只提目录 -> 把该目录下的文本文件都算上
    """
    found: list[str] = []
    seen: set[str] = set()

    def offer(rel: str) -> None:
        rel = rel.lstrip("./")
        if not rel or rel in seen:
            return
        seen.add(rel)
        found.append(rel)

    for raw in _RESOURCE_REF.findall(main_text or ""):
        candidate = raw.strip().strip(",.;:)\"'")
        if candidate.lower() == MAIN_FILE.lower():
            continue
        offer(candidate)

    for dirname in {name.lower() for name in _DIR_REF.findall(main_text or "")}:
        for path in _package_files(directory):
            rel = path.relative_to(directory).as_posix()
            if rel.lower().startswith(dirname + "/"):
                offer(rel)

    return found


def read_bundle(name: str, *, inline: bool = True) -> dict[str, Any]:
    """读一个 skill 包：主文件 + 内联它引用到的资源。

    这是给「组装请求」用的入口 —— 模型没有读文件的工具，资源必须在
    这一刻就变成正文的一部分。

    返回：
        text       已经拼好的正文（主文件 + 各附属文件的段落）
        resources  包里全部附属文件的清单
        inlined    这次真的展开了哪些
        skipped    因为体积或格式没展开的
    """
    target = _resolve(name)
    main_text = read_skill(name)
    result: dict[str, Any] = {
        "name": name,
        "text": main_text,
        "chars": len(main_text),
        "resources": list_resources(name),
        "inlined": [],
        "skipped": [],
    }

    if not inline or not target.is_dir():
        return result

    budget = MAX_BUNDLE_BYTES
    inlined: list[str] = []
    skipped: list[str] = []
    chunks: list[str] = []

    for rel in _referenced_resources(main_text, target):
        path = target / rel
        if not path.is_file():
            continue
        size = path.stat().st_size
        if path.suffix.lower() not in TEXT_SUFFIXES:
            skipped.append(f"{rel}（非文本）")
            continue
        if size > MAX_RESOURCE_BYTES:
            skipped.append(f"{rel}（{human_size(size)}，超过单文件上限）")
            continue
        if size > budget:
            skipped.append(f"{rel}（剩余预算不足）")
            continue

        try:
            body = _read_text(path)
        except OSError:
            skipped.append(f"{rel}（读取失败）")
            continue

        budget -= size
        inlined.append(rel)
        chunks.append(f"--- 附带文件：{rel} ---\n{body}")

    if chunks:
        text = main_text.rstrip() + "\n\n" + "\n\n".join(chunks)
        if skipped:
            text += "\n\n（以下资源未展开：" + "、".join(skipped) + "）"
        result["text"] = text
        result["chars"] = len(text)

    result["inlined"] = inlined
    result["skipped"] = skipped

    # 主文件提到了资源，但一个都没展开 —— 这件事要说出来。
    # 不说的话，模型会以为参考文件就在手边，然后编一个「我已按参考文件」的答案。
    if skipped and not inlined:
        result["text"] = (
            main_text.rstrip()
            + "\n\n（这个 skill 带了资源文件但未能展开："
            + "、".join(skipped)
            + "。请只依据上面的正文作答，不要假设你能读到那些文件。）"
        )
    elif not inlined and result["resources"]:
        listed = "、".join(item["path"] for item in result["resources"][:12])
        result["text"] = (
            main_text.rstrip()
            + f"\n\n（这个 skill 还带有资源文件：{listed}。它们没有被展开，"
            + "请只依据上面的正文作答。）"
        )

    return result


def read_many(names: Iterable[str]) -> list[tuple[str, str]]:
    """批量读 skill 的完整包文本，返回 [(名字, 正文)]。

    读不到的跳过（记日志），不让一个坏包废掉整次请求。
    """
    result: list[tuple[str, str]] = []
    for name in names:
        try:
            bundle = read_bundle(name)
            result.append((name, bundle["text"]))
            if bundle["inlined"]:
                log(
                    f"{name}：内联了 {len(bundle['inlined'])} 个附属文件"
                    f"（{', '.join(bundle['inlined'][:4])}{'…' if len(bundle['inlined']) > 4 else ''}）",
                    SHELF_SRV,
                )
        except M8Error as exc:
            log(f"跳过读不到的 skill：{name}（{exc.message}）", SHELF_SRV)
    return result


# ---------------------------------------------------------------- 写入

def _unique_dir(path: Path) -> Path:
    """给重名目录找一个没被占用的名字：a -> a-1 -> a-2"""
    for index in range(1, 1000):
        candidate = path.with_name(f"{path.name}-{index}")
        if not candidate.exists():
            return candidate
    raise M8Error("M8-SRV-004", message="同名的包太多了，换个名字")


def save_skill(
    name: str,
    files: dict[str, bytes],
    overwrite: bool = True,
) -> dict[str, Any]:
    """保存一个 skill 包。

    files 是 {包内相对路径: 内容}。必须有一个主文件：
    叫 SKILL.md 的优先；没有的话，只有一个顶层 .md 时把它提为主文件 ——
    这样「传一个单独的 md」也能得到一个规整的包，而不是散在根目录的裸文件。

    先写进临时目录，全部成功后再整体替换 —— 中途失败不会留下半个包。
    """
    paths.ensure_data_dirs()
    if not files:
        raise M8Error("M8-SRV-002")

    total = sum(len(data) for data in files.values())
    if total > paths.MAX_PACKAGE_BYTES:
        raise M8Error(
            "M8-SRV-004",
            message=f"整个包 {human_size(total)}，超过 {human_size(paths.MAX_PACKAGE_BYTES)} 上限",
        )

    # 清洗路径并拒绝重复
    cleaned: dict[str, bytes] = {}
    for raw_path, data in files.items():
        rel = sanitize_rel_path(raw_path)
        if rel in cleaned:
            raise M8Error("M8-SRV-003", message=f"包里有重复路径：{rel}")
        cleaned[rel] = data

    cleaned = _promote_main_file(cleaned, name)

    target = _resolve(name)
    if target.exists() and not overwrite:
        target = _unique_dir(target)

    staging = target.with_name(target.name + ".staging")
    if staging.exists():
        shutil.rmtree(staging, ignore_errors=True)

    try:
        staging.mkdir(parents=True)
        for rel, data in cleaned.items():
            destination = staging / rel
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
    except OSError as exc:
        shutil.rmtree(staging, ignore_errors=True)
        raise M8Error("M8-CORE-004", message=f"写不进 {name}", detail=str(exc)) from exc

    # 老的平铺文件同名的话，先让路，否则目录建不出来
    legacy = paths.SKILLS_DIR / sanitize_name(name)
    for suffix in (".md", ".markdown", ".txt"):
        stale = paths.SKILLS_DIR / (sanitize_name(name) + suffix)
        if stale.is_file():
            stale.unlink(missing_ok=True)

    try:
        if target.exists():
            shutil.rmtree(target)
        staging.replace(target)
    except OSError as exc:
        shutil.rmtree(staging, ignore_errors=True)
        raise M8Error("M8-CORE-004", message=f"替换 {name} 失败", detail=str(exc)) from exc

    log(f"skill 包已保存：{target.name}（{len(cleaned)} 个文件 / {human_size(total)}）", SHELF_SRV)
    return {
        "name": target.name,
        "size": total,
        "sizeText": human_size(total),
        "fileCount": len(cleaned),
    }


def _promote_main_file(files: dict[str, bytes], name: str) -> dict[str, bytes]:
    """确保包里有一个主文件。

    情况一：已经有 SKILL.md -> 不动
    情况二：顶层只有一个 .md，叫别的名字 -> 它当主文件，保持原名（不改名，
            免得文件里互相引用的路径失效）
    情况三：没有任何 .md -> 报错，因为一个没有正文的包没法用
    """
    if MAIN_FILE in files:
        return files

    top_md = sorted(
        rel for rel in files
        if "/" not in rel and Path(rel).suffix.lower() in (".md", ".markdown")
    )
    if top_md:
        return files

    single_md = sorted(
        rel for rel in files if Path(rel).suffix.lower() in (".md", ".markdown")
    )
    if single_md:
        return files

    raise M8Error("M8-SRV-006", message=f"包里没有 Markdown 主文件：{name}")


def save_skill_text(name: str, text: str, filename: str = MAIN_FILE) -> dict[str, Any]:
    """把一段纯文本存成一个包。上传单个文件时走这里。"""
    rel = sanitize_rel_path(filename)
    if Path(rel).suffix.lower() not in (".md", ".markdown", ".txt"):
        rel = rel + ".md"
    return save_skill(name, {rel: text.encode("utf-8")})


def delete_skill(name: str) -> bool:
    """删一个 skill。不存在返回 False（删两次不该报错）。"""
    target = _resolve(name)

    if target.is_dir():
        try:
            shutil.rmtree(target)
        except OSError as exc:
            raise M8Error("M8-SRV-005", message=f"删不掉 {name}", detail=str(exc)) from exc
        log(f"skill 包已删除：{target.name}", SHELF_SRV)
        return True

    if target.is_file():
        try:
            target.unlink()
        except OSError as exc:
            raise M8Error("M8-SRV-005", message=f"删不掉 {name}", detail=str(exc)) from exc
        log(f"skill 已删除：{target.name}", SHELF_SRV)
        return True

    # 老格式：给的是显示名（如 翻译规范），实际文件是 翻译规范.md。
    # 这里必须自己再查一次 containment：上面 _resolve 走过的那道检查管不到
    # 这个分支，而 Python 的 pathlib 遇到绝对路径会把左边整个换掉 ——
    # name 传 "/etc/passwd" 就不再是「skills 目录下的文件」了。
    for path in (
        paths.SKILLS_DIR / sanitize_name(name),
        paths.SKILLS_DIR / (sanitize_name(name) + ".md"),
    ):
        if not paths.is_inside(path, paths.SKILLS_DIR):
            continue
        if path.is_file():
            path.unlink(missing_ok=True)
            log(f"skill 已删除：{path.name}", SHELF_SRV)
            return True

    return False


# ---------------------------------------------------------------- 引用解析

# 只找「像引用起点」的斜杠：前面不能是字母数字、冒号或斜杠。
# 这一条就挡掉了 http://x、a/b、C:/path 里的斜杠 —— 那些不是引用。
# 中文放行：Python 的字符类在这里是显式列举的，"用/翻译规范" 里的 / 前面是汉字，通过。
_SLASH = re.compile(r"(?<![A-Za-z0-9:/])/")

# 引用词到哪里结束：空白和常见中英标点
_TOKEN_END = re.compile(r"[\s，。；：！？、,.;:!?（）()\[\]【】\x22\x27“”‘’]")


def display_name(filename: str) -> str:
    """去掉扩展名的显示名。用户输入 /翻译规范 不必带 .md。"""
    return Path(filename).stem


def parse_frontmatter(text: str) -> dict[str, str]:
    """读文件头部 YAML frontmatter 里的标量字段。

    为什么不 import yaml：这里只要 name / description 两个字符串，
    为它们装一个依赖不划算（本包是零依赖的）。而且真 YAML 的坑
    （锚点、嵌套、类型转换）在这份文件里一个都用不上。

    处理两种写法：

        description: 一句话
        description: >
          多行折叠，
          缩进续行都算同一段
    """
    body = text or ""
    if not body.startswith("---"):
        return {}
    end = body.find("\n---", 3)
    if end < 0:
        return {}

    meta: dict[str, str] = {}
    key = ""
    parts: list[str] = []

    def flush() -> None:
        if key:
            meta[key] = " ".join(parts).strip()

    for raw in body[3:end].splitlines():
        if not raw.strip():
            continue
        # 缩进行（或以 - 开头的列表项）算上一个键的续行
        if raw[0].isspace() or raw.lstrip().startswith("- "):
            if key:
                parts.append(raw.strip())
            continue
        if ":" not in raw:
            continue
        flush()
        key_name, _, value = raw.partition(":")
        key = key_name.strip().lower()
        value = value.strip()
        # > 和 | 是 YAML 的多行标记，本身不是内容
        parts = [] if value in (">", "|", ">-", "|-", ">+", "|+") else [value]
    flush()
    return meta


def strip_frontmatter(text: str) -> str:
    """去掉头部 frontmatter，只留正文。"""
    body = text or ""
    if not body.startswith("---"):
        return body
    end = body.find("\n---", 3)
    if end < 0:
        return body
    return body[end + 4:].lstrip("\n")


def _first_sentence(text: str, limit: int) -> str:
    """压平换行后取第一句，太长就截断。"""
    flat = " ".join((text or "").split())
    for sep in ("。", ". "):
        at = flat.find(sep)
        if 0 < at < limit:
            return flat[: at + len(sep)].strip()
    return flat[:limit] + ("…" if len(flat) > limit else "")


def title_of(text: str, limit: int = 80) -> str:
    """给下拉列表显示的一行说明。

    优先用 frontmatter 的 description：Claude 那套 skill 的 description
    比正文标题更能说明用途（标题常常是「TAG 创作工程师」这种名字，
    看列表时分不出它是干什么的）。

    没有 frontmatter 就退回正文第一行有意义的文字，Markdown 的 # 剥掉。
    """
    meta = parse_frontmatter(text or "")
    description = meta.get("description", "").strip()
    if description:
        return _first_sentence(description, limit)

    for line in strip_frontmatter(text or "").splitlines():
        cleaned = line.strip().lstrip("#").strip()
        if cleaned:
            return cleaned[:limit]
    return ""


def extract_skill_mentions(text: str, available: list[str]) -> tuple[list[str], list[str]]:
    """从提示词里找出 /skill名 形式的引用。

    返回 (命中的名字列表, 没命中的引用词列表)。

    算法是**反向**的：不是先切词再去比对，而是拿已知的 skill 名去文本里找。
    原因是中文没有空格分词 —— 「用/翻译规范改一下」里的引用和后面的正文连成一片，
    先切词的话会把「翻译规范改一下」整个当成名字，永远匹配不上。反过来用候选名去
    贴，就能正确地只吃掉「翻译规范」这一段。

    三条规则，按顺序试：

        1. 完整匹配 —— 引用词正好等于某个 skill 的名字（带不带扩展名都行）
        2. 候选名是引用词的前缀 —— 处理上面那种中文连写，多个候选时取最长的
        3. 引用词是候选名的前缀，且候选唯一 —— 输入 /翻译 命中 翻译规范

    规则 2、3 都要求**没有歧义**。对上多个候选时一个都不注入：
    猜错会把错的资料塞给模型，那比不带资料糟得多，而且用户完全看不出问题在哪。

    没命中的引用不报错、不改写正文，原样留给模型看 ——
    提示词里出现斜杠太常见了（路径、URL、日期），为这个报错只会啰嗦。
    """
    if not text or not available:
        return [], []

    # 候选表：显示名（去扩展名）+ 原名，都算合法写法
    candidates: list[tuple[str, str]] = []
    for name in available:
        stem = display_name(name)
        candidates.append((stem, name))
        if stem.lower() != name.lower():
            candidates.append((name, name))
    # 长的排前面：名字有包含关系时（翻译 / 翻译规范）要优先命中更具体的那个
    candidates.sort(key=lambda pair: len(pair[0]), reverse=True)

    exact: dict[str, str] = {cand.lower(): filename for cand, filename in candidates}

    hits: list[str] = []
    misses: list[str] = []

    def add(filename: str) -> None:
        if filename not in hits:
            hits.append(filename)

    for match in _SLASH.finditer(text):
        tail = text[match.end():]
        token = _TOKEN_END.split(tail, maxsplit=1)[0].strip()
        if not token:
            continue
        key = token.lower()

        # 1. 完整匹配
        if key in exact:
            add(exact[key])
            continue

        # 2. 候选名是引用词的前缀（中文连写的救星），最长的优先
        prefix_hit = next(
            (filename for cand, filename in candidates if key.startswith(cand.lower())),
            None,
        )
        if prefix_hit:
            add(prefix_hit)
            continue

        # 3. 引用词是候选名的前缀，且唯一
        forward = {filename for cand, filename in candidates if cand.lower().startswith(key)}
        if len(forward) == 1:
            add(next(iter(forward)))
            continue

        # 歧义或完全对不上：都不注入
        misses.append(token)

    return hits, misses


# ---------------------------------------------------------------- 杂项

def human_size(size: int) -> str:
    """1536 -> 1.5 KB。给界面显示用。"""
    value = float(size)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} GB"


def chunk_limit() -> int:
    """上传时的分块读大小。路由层边读边判上限，用得上。"""
    return _CHUNK
