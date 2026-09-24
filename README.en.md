# ComfyUI-M8nodes

English | [中文](README.md)

A ComfyUI custom node pack organized by **shelf** (one directory per job the node does in a workflow, one error-code range per shelf).

Three shelves, five nodes, plus a standalone web workbench:

| Shelf | Node | What it does |
| --- | --- | --- |
| LLM | `M8LLMInference` | Calls an external LLM over an OpenAI-compatible API |
| LLM | `M8SkillLoader` | Turns a text file into a knowledge pack for the inference node |
| LLM | `M8LLMLocal` | Runs a GGUF **locally**, no network; pair it with an mmproj for vision |
| Camera | `M8CameraControl` | Turns camera position / height / distance into prompt text |
| Prompt | `M8MultiCharacter` | Multi-character blocks and per-region weights |

> **Zero third-party dependencies, with one exception: the local inference node.**
> The backend uses only the Python standard library plus what ComfyUI already ships.
> `M8LLMLocal` additionally needs `llama-cpp-python`; without it the other nodes are
> unaffected and that node reports what is missing.

---

## Nodes

### M8 · 大模型推理 (LLM Inference)

Calls an external LLM via API. Defaults to DeepSeek; change `base_url` to point at any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, your own gateway).

- **Two prompt boxes**: system prompt (persona / output format) and user prompt (what you want to ask)
- **Model dropdown**: after filling in the URL and key, hit "刷新模型" (refresh models) to pull the list from the endpoint; you can also just type a model name
- **Thinking effort**: off / low / medium / high. If the provider rejects the parameter, it is dropped and the request is retried once instead of failing outright
- **Thinking output**: optionally shown in a read-only box on the node
- **`/` skill references**: type `/` in the user prompt box to open a dropdown of uploaded skills. Keep typing to narrow the list; the matching part is highlighted. Arrow keys to move, Enter to pick, Esc to cancel. The inserted `/name` is understood by the backend, which then includes that skill
- **Auto skill mode**: with `skill_auto` on, every uploaded skill is injected and **the model decides which one applies**. Many or long skills cost context; caps are configurable
- **Inputs**: skill (knowledge pack), image, audio. Image and audio are for multimodal models; leave them unconnected for plain text chat
- **Output**: a single text output

Temperature, max tokens and timeout are adjustable, plus an `extra_params` field for provider-specific JSON parameters not covered by this pack.

### M8 · Skill 装载 (Skill Loader)

Turns a prompt-text file (Markdown / plain text) into a connectable knowledge pack for the inference node.

- "上传 Skill" uploads a local file (stored server-side under `m8/data/skills/`)
- Pick one from the dropdown and wire it into the inference node's skill input
- "预览内容" expands a read-only preview of what the skill actually says
- One skill can feed several inference nodes at once

### M8 工作台 (Web Workbench)

A standalone web app for things that do not fit in a node. Open it from the `M8` button in the
ComfyUI top bar, or by double-clicking `M8web/start-workbench.bat` — that second route works with
ComfyUI closed. Both read and write the same files under `<ComfyUI>/models/M8data/webapp/`.

Its **visual design** is taken from the reference site `azusa.nyacraft.cn` (colours, layout and
motion follow its CSS — see `docs/M8WEB-DESIGN.md`); the **features** are this pack's own.

---

## Install

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/chenr5934-tech/ComfyUI-M8nodes.git
```

Restart ComfyUI. **No pip dependencies.**

The nodes appear under `M8/`, grouped by shelf: `大模型` (LLM), `相机` (Camera), `提示词` (Prompt).

---

## API keys

Two ways to supply a key:

**Recommended: store it server-side.** Paste the key into the node and hit "保存密钥到服务端" (save key to server). It is written to `m8/data/credentials.json` and the input box is cleared. **The workflow file never contains the plaintext key**, so sharing a workflow does not leak it. Leave the field empty afterwards and the stored key is used automatically.

**Temporary: type it into the node.** Applies only to that node, and it *will* be saved into the workflow file. Anyone you send the workflow to gets the key.

`m8/data/` is listed in `.gitignore`.

---

## Troubleshooting

Every failure path carries an error code. Errors look like this:

```
[M8-LLM-004] the endpoint returned 401
  Fix: wrong API key, or one without permission. Check it, or make sure it belongs to the service behind this base_url.
  Detail: {"error":{"message":"Authentication Fails"}}
```

Take that code to [docs/ERROR-PLAYBOOK.md](docs/ERROR-PLAYBOOK.md) and it points straight at the file, function, cause and fix. That doc also has a four-step self-check to run after installing.

Note on language: user-facing UI text is English in the source. Chinese translations ship in
[`locales/zh/main.json`](locales/zh/main.json) and are served to clients through `GET /m8/i18n/{lang}`,
so Chinese users see Chinese and everyone else sees English. The same file also carries the
translations for the M8web workbench.

Error messages are a separate thing: they are written for whoever is debugging, carry an error
code, and are not translated.

---

## Repository layout

Nodes are grouped by **what they do in a workflow**, one directory and one error-code range per shelf:

| Shelf | Directory | Error codes |
| --- | --- | --- |
| core | `m8/core/` | `M8-CORE-###` |
| server | `m8/server/` | `M8-SRV-###` |
| LLM | `m8/nodes/llm/` | `M8-LLM-###` |
| loaders | `m8/nodes/loaders/` | `M8-LOAD-###` |
| samplers | `m8/nodes/samplers/` | `M8-SAMP-###` |
| logic | `m8/nodes/logic/` | `M8-LOGIC-###` |
| image | `m8/nodes/image/` | `M8-IMG-###` |
| text | `m8/nodes/text/` | `M8-TXT-###` |

The layout is two levels: **one folder per shelf, one folder per feature inside it**.

```
m8/nodes/llm/llm_inference/node.py     backend: one folder per feature
js/nodes/llm/llm_inference.js          frontend: file name matches the feature folder
```

The point is that changing one feature means opening one folder. A stray `.py` dropped into a
shelf root, or a feature package registering someone else's node, is caught by the test suite.

---

## Development

| File | Contents |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Working rules, environment, shelf map, how to add a node (Chinese) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Front/back-end split, routes, data storage, visual language |
| [docs/ERROR-PLAYBOOK.md](docs/ERROR-PLAYBOOK.md) | Error-code lookup table |
| [docs/TESTING.md](docs/TESTING.md) | Who runs which tests, and the manual checklist |
| [docs/RELEASING.md](docs/RELEASING.md) | Release process |

Static checks (run without ComfyUI, no network):

```bash
python tests/smoke_import.py
```

---

## License

[MIT](LICENSE)

Third-party assets: the whale widget's artwork and overall design are ported from
[MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)
(MIT, copyright the original author); the original licence text is kept at
`js/ui/whale/assets/LICENSE.txt`. The web workbench's visual design follows the reference site
`azusa.nyacraft.cn`.
