"""后端路由：把 M8 的接口挂到 ComfyUI 的 aiohttp 上。

时机是安全的：main.py 先建 PromptServer（instance 就位）→ 加载 custom_nodes（走这里）
→ 最后才调 add_routes() 把 routes 收进 app。和 ComfyUI-CodexAtlas 里验证过的做法一致。

接口清单见 docs/ARCHITECTURE.md 第三节。改接口时**两处一起改**，别只改代码。

出参统一形状：
    成功  {"ok": true, ...}
    失败  {"ok": false, "code": "M8-XXX-###", "error": "...", "hint": "...", "detail": "..."}
前端拿 code 直接去 docs/ERROR-PLAYBOOK.md 查，不用猜。

阻塞调用（urllib 发 HTTP）一律走 asyncio.to_thread —— 直接在 handler 里发，
ComfyUI 的事件循环会被卡住，表现是整个界面僵住。
"""

from __future__ import annotations

import asyncio
import json
import re
from functools import partial
from pathlib import Path
from typing import Any, Callable

from aiohttp import web

from ..core import config, paths, webdata
from ..core.errors import M8Error
from ..core.log import SHELF_SRV, error, log, warn
from . import camera_configs, llm_api, prompt_presets, providers, shortcut, skills, webapp

try:
    from server import PromptServer
except ImportError:  # 脱离 ComfyUI（跑单元测试）时
    PromptServer = None

_DUMPS = partial(json.dumps, ensure_ascii=False)

VERSION = "0.5.0"

# 由根 __init__.py 在收集完货架后注入，供 /m8/health 使用
_RUNTIME_INFO: dict[str, Any] = {"shelves": [], "nodeCount": 0, "routeCount": 0}


def set_runtime_info(info: dict[str, Any]) -> None:
    """注入启动时的运行时快照（货架列表、节点数等）。"""
    _RUNTIME_INFO.update(info)


def _json(data: dict, status: int = 200) -> web.Response:
    return web.json_response(data, status=status, dumps=_DUMPS)


def _ok(**fields: Any) -> web.Response:
    return _json({"ok": True, **fields})


def _err(exc: M8Error) -> web.Response:
    """M8Error -> 带码的响应。状态码按语义给，不一律 500。"""
    status = 400
    if exc.code in ("M8-CORE-004", "M8-LLM-003"):
        status = 503
    elif exc.code == "M8-LLM-004":
        status = 502
    elif exc.code.endswith("005") and exc.message.startswith("响应不是"):
        status = 502
    return _json(exc.to_payload(), status)


async def _read_json(request: web.Request) -> dict:
    """读请求体 JSON。读不出来给一个说得清的错，而不是 aiohttp 的原始异常。"""
    try:
        data = await request.json()
    except Exception as exc:  # noqa: BLE001 aiohttp 的 json 错误类型不稳定
        raise M8Error("M8-SRV-002", message="请求体不是合法 JSON", detail=str(exc)) from exc
    return data if isinstance(data, dict) else {}


# ------------------------------------------------------------------ 大模型

async def handle_llm_models(request: web.Request) -> web.Response:
    """POST /m8/llm/models —— 用给定地址和密钥拉模型列表。"""
    try:
        body = await _read_json(request)
        provider_key = str(body.get("provider") or "custom")
        base_url = body.get("baseUrl") or providers.default_base_url(provider_key)
        # 密钥只在这个地址可信时才附上（见 config.resolve_api_key）——
        # base_url 是调用方给的，不能因为它就交出服务端存的密钥
        api_key = config.resolve_api_key(
            str(body.get("apiKey") or ""),
            provider_key,
            base_url,
            (providers.default_base_url(provider_key), config.saved_base_url(provider_key)),
        )
        timeout = float(body.get("timeout") or 30)

        models = await asyncio.to_thread(
            llm_api.list_models, base_url, api_key, provider_key, timeout
        )
    except M8Error as exc:
        return _err(exc)
    except Exception as exc:  # noqa: BLE001 兜底，不让裸异常冒到前端
        error(f"拉模型列表时未预料的异常：{exc}", SHELF_SRV)
        return _err(M8Error("M8-LLM-006", detail=f"{type(exc).__name__}: {exc}"))

    return _ok(models=models, count=len(models))


async def handle_llm_test(request: web.Request) -> web.Response:
    """POST /m8/llm/test —— 连通性测试。

    刻意不真的跑一次推理：那要花钱和时间。能拉到模型列表就说明
    地址通、密钥对、协议对，这三件事才是用户想确认的。
    """
    return await handle_llm_models(request)


# ------------------------------------------------------------------ 界面文案

# 语言码会被拼进路径，所以只放行这一组字符，其余一律剔掉
_LANG_OK = re.compile(r"[^A-Za-z0-9_-]")


async def handle_i18n(request: web.Request) -> web.Response:
    """GET /m8/i18n/{lang} —— 这个插件的界面文案。

    ComfyUI Desktop 有自己的 /i18n 端点，会去读各插件 locales/ 下的翻译；普通
    ComfyUI 还没有那个端点。所以这里自己提供一份：前端拿它把英文原文换成对应
    语言，于是中文用户在哪个版本上都能看到中文。

    **语言码不能直接拼进路径** —— 先净化字符集，再确认最终路径确实落在 locales/
    目录内，两道都过才读。取不到就返回空对象，前端会退回英文。
    """
    raw = request.match_info.get("lang", "")
    lang = _LANG_OK.sub("", str(raw))[:8].lower()
    if not lang:
        return _ok(strings={}, lang="")

    root = paths.PLUGIN_DIR / "locales"
    path = root / lang / "main.json"
    if not paths.is_inside(path, root) or not path.is_file():
        return _ok(strings={}, lang=lang)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        warn(f"读不了界面文案 {lang}：{exc}", SHELF_SRV)
        return _ok(strings={}, lang=lang)
    return _ok(strings=data if isinstance(data, dict) else {}, lang=lang)


# ------------------------------------------------------------------ 密钥

async def handle_keys_list(request: web.Request) -> web.Response:
    """GET /m8/keys/list —— 各供应商已存密钥的**掩码**（绝不含明文）。"""
    return _ok(keys=config.list_credentials())


async def handle_keys_set(request: web.Request) -> web.Response:
    """POST /m8/keys/set —— 存密钥。存空串等于删除。"""
    try:
        body = await _read_json(request)
        provider = str(body.get("provider") or "").strip()
        if not provider:
            raise M8Error("M8-SRV-002", message="没给 provider")
        # baseUrl 一起记下：这份密钥归哪个地址用，以后只有发往它才带上
        masked = config.set_api_key(
            provider, str(body.get("apiKey") or ""), str(body.get("baseUrl") or "")
        )
    except M8Error as exc:
        return _err(exc)
    return _ok(provider=provider, masked=masked)


# ------------------------------------------------------------------ skill

async def handle_skills_list(request: web.Request) -> web.Response:
    """GET /m8/skills/list"""
    return _ok(skills=skills.list_skills(), maxBytes=paths.MAX_SKILL_BYTES)


async def handle_skills_preview(request: web.Request) -> web.Response:
    """GET /m8/skills/preview?name=xxx —— 取正文（前端用来做预览）。"""
    name = request.query.get("name", "")
    limit = int(request.query.get("limit", "4000"))
    try:
        text = await asyncio.to_thread(skills.read_skill, name)
    except M8Error as exc:
        return _err(exc)
    clipped = text[:limit]
    return _ok(
        name=name,
        text=clipped,
        truncated=len(text) > len(clipped),
        totalChars=len(text),
    )


def guess_package_name(files: dict[str, bytes]) -> str:
    """从上传的相对路径里猜包名。

    浏览器选目录时，每个 part 的 filename 会带相对路径（myskill/SKILL.md），
    取第一段就是包名。选单个文件时是 myskill.md，去掉扩展名。
    """
    first = next(iter(files))
    parts = first.replace("\\", "/").split("/")
    if len(parts) > 1 and parts[0]:
        return parts[0]
    return Path(parts[0]).stem or "skill"


async def handle_skills_upload(request: web.Request) -> web.Response:
    """POST /m8/skills/upload —— multipart 上传，单文件 / 多文件 / 整个目录都收。

    边读边判上限：超了立刻中止，不会先把几十兆收进内存再拒绝。

    收上来的是一整棵相对路径树，交给 skills.save_skill 统一落成目录式包。
    """
    try:
        reader = await request.multipart()
    except Exception as exc:  # noqa: BLE001 不是 multipart 时 aiohttp 抛的类型不稳定
        raise M8Error("M8-SRV-002", message="上传请求不是 multipart", detail=str(exc)) from exc

    overwrite = request.query.get("overwrite", "0") == "1"
    name_hint = (request.query.get("name") or "").strip()

    files: dict[str, bytes] = {}
    total = 0

    while True:
        part = await reader.next()
        if part is None:
            break
        if part.name not in ("file", "files", "data"):
            continue

        rel = (part.filename or "").replace("\\", "/")
        if not rel:
            continue

        buffer = bytearray()
        while True:
            chunk = await part.read_chunk(skills.chunk_limit())
            if not chunk:
                break
            buffer.extend(chunk)
            total += len(chunk)
            if len(buffer) > paths.MAX_SKILL_BYTES:
                raise M8Error(
                    "M8-SRV-004",
                    message=f"{rel} 超过单文件上限 {skills.human_size(paths.MAX_SKILL_BYTES)}，已中止上传",
                )
            if total > paths.MAX_PACKAGE_BYTES:
                raise M8Error(
                    "M8-SRV-004",
                    message=f"整个包超过 {skills.human_size(paths.MAX_PACKAGE_BYTES)} 上限，已中止上传",
                )
        files[rel] = bytes(buffer)

    if not files:
        raise M8Error("M8-SRV-003", message="请求里没有文件字段")

    name = name_hint or guess_package_name(files)
    try:
        saved = await asyncio.to_thread(skills.save_skill, name, files, overwrite)
    except M8Error as exc:
        return _err(exc)

    log(f"上传 {saved['name']}：{saved['fileCount']} 个文件 / {saved['sizeText']}", SHELF_SRV)
    return _ok(skill=saved, skills=skills.list_skills())


async def handle_skills_tree(request: web.Request) -> web.Response:
    """GET /m8/skills/tree?name=xxx —— 列出一个包的文件结构。

    前端用它显示「这个 skill 带了哪些资源」，也方便排查内联了哪些、没内联哪些。
    """
    name = request.query.get("name", "")
    try:
        resources = await asyncio.to_thread(skills.list_resources, name)
        bundle = await asyncio.to_thread(skills.read_bundle, name)
    except M8Error as exc:
        return _err(exc)

    return _ok(
        name=name,
        resources=resources,
        inlined=bundle["inlined"],
        skipped=bundle["skipped"],
        chars=bundle["chars"],
        maxResourceBytes=skills.MAX_RESOURCE_BYTES,
        maxBundleBytes=skills.MAX_BUNDLE_BYTES,
    )


async def handle_skills_delete(request: web.Request) -> web.Response:
    """POST /m8/skills/delete"""
    try:
        body = await _read_json(request)
        removed = await asyncio.to_thread(skills.delete_skill, str(body.get("name") or ""))
    except M8Error as exc:
        return _err(exc)
    return _ok(deleted=removed, skills=skills.list_skills())


# ------------------------------------------------------------------ 自检

# ------------------------------------------------------------------ 本地模型

async def handle_local_models(request: web.Request) -> web.Response:
    """GET /m8/llm-local/models —— models/LLM 里有哪些 GGUF。

    前端那个「刷新模型」按钮用的。模型是用户往目录里丢的，节点建好之后
    才放进去很常见，所以得能手动重扫一次，不能只在建节点时看一眼。
    """
    try:
        from ..nodes.llm.llm_local import models as local_models
    except Exception as exc:
        return _err(M8Error(
            "M8-LLM-015",
            message="本地模型货架加载不了",
            hint="看启动日志里 m8/nodes/llm/llm_local 有没有报错",
            detail=f"{type(exc).__name__}: {exc}",
        ))
    # 用 refresh 而不是 list_models：能走到这条路由，就是用户按了「刷新模型列表」，
    # 他要的是「现在盘上到底有什么」，所以这次强制重扫，不吃 ComfyUI 的文件名缓存。
    models, mmproj = local_models.refresh()
    return _ok(
        dir=local_models.ensure_folder_registered(),
        models=models,
        mmproj=mmproj,
        loaded=local_models.cached_count(),
        gpu=local_models.gpu_offload_available(),
    )


# ------------------------------------------------------------------ 工作台数据

# 这四条读写的是**用户目录**下的文件（~/M8/webapp），不是浏览器里的 IndexedDB。
# 换过来的理由是：数据得能在 CUI 关着的时候照样用，而且插件更新、ComfyUI 重装
# 都不能把它带走。独立服务（m8-serve.py）提供了完全一样的四条接口、读同一份文件，
# 所以从哪个门进去看到的数据都一样。

async def handle_data_get(request: web.Request) -> web.Response:
    """GET /m8/data/{kind} —— 读一整类。"""
    try:
        kind = request.match_info.get("kind", "")
        rows = await asyncio.to_thread(webdata.read, kind)
    except M8Error as exc:
        return _err(exc)
    return _ok(kind=kind, rows=rows)


async def handle_data_put(request: web.Request) -> web.Response:
    """POST /m8/data/{kind}/put {record} —— 存一条。没带 id 就分配一个。"""
    try:
        kind = request.match_info.get("kind", "")
        body = await _read_json(request)
        rec = body.get("record")
        if not isinstance(rec, dict):
            raise M8Error("M8-WEB-010", message="要存的不是一条记录", hint="这是内部调用出错")
        rid = await asyncio.to_thread(webdata.put, kind, rec)
    except M8Error as exc:
        return _err(exc)
    return _ok(kind=kind, id=rid)


async def handle_data_delete(request: web.Request) -> web.Response:
    """POST /m8/data/{kind}/delete {id} —— 删一条。"""
    try:
        kind = request.match_info.get("kind", "")
        body = await _read_json(request)
        gone = await asyncio.to_thread(webdata.drop, kind, body.get("id"))
    except M8Error as exc:
        return _err(exc)
    return _ok(kind=kind, removed=gone)


async def handle_data_replace(request: web.Request) -> web.Response:
    """POST /m8/data/{kind}/replace {rows} —— 整份换掉。导入备份走这条。"""
    try:
        kind = request.match_info.get("kind", "")
        body = await _read_json(request)
        rows = body.get("rows")
        if not isinstance(rows, list):
            raise M8Error("M8-WEB-010", message="要替换的不是一个列表", hint="这是导入备份的内部调用")
        n = await asyncio.to_thread(webdata.replace, kind, rows)
    except M8Error as exc:
        return _err(exc)
    return _ok(kind=kind, count=n)


async def handle_shortcut_desktop(request: web.Request) -> web.Response:
    """POST /m8/shortcut/desktop {url, name} —— 往桌面放一个工作台快捷方式。

    浏览器自己建不了快捷方式（网页没有文件系统权限），所以由后端代劳。
    写的是 .url 而不是 .lnk：纯文本一行就够，不用碰 COM，也不挑系统语言。

    地址由前端把当前 location 传过来 —— 后端不知道自己被哪个地址访问着，
    而工作台的数据是挂在「源」上的，地址必须和用户平时用的那个一致。
    """
    try:
        body = await _read_json(request)
        url = str(body.get("url") or "").strip()
        name = str(body.get("name") or shortcut.DEFAULT_NAME)
        path = shortcut.make_shortcut(url, name)
    except M8Error as exc:
        return _err(exc)
    return _ok(path=str(path), fileName=path.name)


async def handle_health(request: web.Request) -> web.Response:
    """GET /m8/health —— 一键体检。

    出问题时先打这个接口，一眼看出插件到底加载到哪一步了。
    """
    settings = config.load_settings()
    return _ok(
        version=VERSION,
        shelves=_RUNTIME_INFO.get("shelves", []),
        nodeCount=_RUNTIME_INFO.get("nodeCount", 0),
        routeCount=_RUNTIME_INFO.get("routeCount", 0),
        providerOptions=providers.describe_all(),
        thinkingOptions=providers.THINKING_OPTIONS,
        skillsCount=len(skills.list_skills()),
        dataDir=str(paths.DATA_DIR),
        dataDirWritable=paths.DATA_DIR.exists(),
        credentials=config.list_credentials(),
        settings=settings,
    )



# ------------------------------------------------------------------ 相机机位配置

async def handle_cam_configs_list(request: web.Request) -> web.Response:
    """GET /m8/cam/configs —— 列出已存的机位配置名。"""
    try:
        names = await asyncio.to_thread(camera_configs.available)
    except M8Error as exc:
        return _err(exc)
    return _ok(files=names, maxBytes=camera_configs.MAX_CONFIG_BYTES)


async def handle_cam_configs_save(request: web.Request) -> web.Response:
    """POST /m8/cam/configs/save {name, config}"""
    try:
        body = await _read_json(request)
        name = await asyncio.to_thread(
            camera_configs.save,
            str(body.get("name") or ""),
            body.get("config"),
        )
    except M8Error as exc:
        return _err(exc)
    return _ok(name=name)


async def handle_cam_configs_load(request: web.Request) -> web.Response:
    """POST /m8/cam/configs/load {name} —— 取一份配置的正文。"""
    try:
        body = await _read_json(request)
        name = str(body.get("name") or "")
        cfg = await asyncio.to_thread(camera_configs.load, name)
    except M8Error as exc:
        return _err(exc)
    return _ok(name=name, config=cfg)



# ------------------------------------------------------------------ 角色配置预设

async def handle_prompt_presets_list(request: web.Request) -> web.Response:
    """GET /m8/prompt/presets —— 列出已存的角色配置预设名。"""
    try:
        names = await asyncio.to_thread(prompt_presets.available)
    except M8Error as exc:
        return _err(exc)
    return _ok(files=names, maxBytes=prompt_presets.MAX_PRESET_BYTES)


async def handle_prompt_presets_save(request: web.Request) -> web.Response:
    """POST /m8/prompt/presets/save {name, config}"""
    try:
        body = await _read_json(request)
        name = await asyncio.to_thread(
            prompt_presets.save,
            str(body.get("name") or ""),
            body.get("config"),
        )
    except M8Error as exc:
        return _err(exc)
    return _ok(name=name)


async def handle_prompt_presets_load(request: web.Request) -> web.Response:
    """POST /m8/prompt/presets/load {name}"""
    try:
        body = await _read_json(request)
        name = str(body.get("name") or "")
        cfg = await asyncio.to_thread(prompt_presets.load, name)
    except M8Error as exc:
        return _err(exc)
    return _ok(name=name, config=cfg)


async def handle_prompt_presets_delete(request: web.Request) -> web.Response:
    """POST /m8/prompt/presets/delete {name}"""
    try:
        body = await _read_json(request)
        name = await asyncio.to_thread(prompt_presets.remove, str(body.get("name") or ""))
    except M8Error as exc:
        return _err(exc)
    return _ok(name=name)



# ------------------------------------------------------------------ 网页

async def handle_webapp(request: web.Request) -> web.Response:
    """GET /m8/web/{path} —— M8web/ 下的静态资源。空路径回 index.html。

    错误包装在这一层做：webapp 只管取文件、抛 M8Error，不直接产 HTTP 响应。
    这样两边都不依赖对方的内部实现。
    """
    try:
        return await webapp.serve(request.match_info.get("path", ""))
    except M8Error as exc:
        return _err(exc)


# ------------------------------------------------------------------ 注册

# (方法, 路径, 处理函数)。加接口就往这里加一行，测试会拿它做断言。
ROUTES: list[tuple[str, str, Callable]] = [
    ("POST", "/m8/llm/models", handle_llm_models),
    ("POST", "/m8/llm/test", handle_llm_test),
    ("GET", "/m8/keys/list", handle_keys_list),
    ("POST", "/m8/keys/set", handle_keys_set),
    ("GET", "/m8/skills/list", handle_skills_list),
    ("GET", "/m8/skills/preview", handle_skills_preview),
    ("GET", "/m8/skills/tree", handle_skills_tree),
    ("POST", "/m8/skills/upload", handle_skills_upload),
    ("POST", "/m8/skills/delete", handle_skills_delete),
    ("GET", "/m8/cam/configs", handle_cam_configs_list),
    ("POST", "/m8/cam/configs/save", handle_cam_configs_save),
    ("POST", "/m8/cam/configs/load", handle_cam_configs_load),
    ("GET", "/m8/prompt/presets", handle_prompt_presets_list),
    ("POST", "/m8/prompt/presets/save", handle_prompt_presets_save),
    ("POST", "/m8/prompt/presets/load", handle_prompt_presets_load),
    ("POST", "/m8/prompt/presets/delete", handle_prompt_presets_delete),
    ("GET", "/m8/llm-local/models", handle_local_models),
    ("GET", "/m8/i18n/{lang}", handle_i18n),
    ("GET", "/m8/data/{kind}", handle_data_get),
    ("POST", "/m8/data/{kind}/put", handle_data_put),
    ("POST", "/m8/data/{kind}/delete", handle_data_delete),
    ("POST", "/m8/data/{kind}/replace", handle_data_replace),
    ("POST", "/m8/shortcut/desktop", handle_shortcut_desktop),
    ("GET", "/m8/web/{path:.*}", handle_webapp),
    ("GET", "/m8/health", handle_health),
]


def get_server() -> Any:
    """拿 PromptServer 实例。界面扩展货架注册接口时要用同一个。"""
    return getattr(PromptServer, "instance", None) if PromptServer is not None else None


def register_all(server: Any = None) -> int:
    """把 ROUTES 挂到 server.routes 上，返回挂了几条。

    没有 PromptServer 时不硬崩 —— 插件其余部分（节点本身）照常可用，
    只是前端那些按钮会报「接口没注册」。启动日志里会说清楚。
    """
    server = server or get_server()
    if server is None:
        warn("没有 PromptServer，跳过接口注册（节点本身仍可用）", SHELF_SRV)
        return 0

    routes_table = getattr(server, "routes", None)
    if routes_table is None:
        error("PromptServer 上没有 routes，接口全部没挂上", SHELF_SRV)
        return 0

    count = 0
    for method, path, handler in ROUTES:
        getattr(routes_table, method.lower())(path)(handler)
        count += 1

    log(f"已挂载 {count} 条接口：{', '.join(p for _, p, _ in ROUTES)}", SHELF_SRV)
    _RUNTIME_INFO["routeCount"] = count
    return count
