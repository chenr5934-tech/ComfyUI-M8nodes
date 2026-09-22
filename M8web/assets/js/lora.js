/* ============================================================================
 * M8web · LoRA 解析
 *
 * 读 .safetensors 的**头部**，把训练参数挖出来。
 *
 * safetensors 的布局只有三层：
 *   [8 字节：header 的字节数，小端 u64]
 *   [那一段：JSON header]
 *   [剩下的：张量数据（我们一个字节都不读）]
 *
 * 所以几百 MB 的模型也是一瞬间 —— 只读开头那几 KB 到几十 KB，
 * 张量数据完全不碰，也就不用把整个文件塞进内存。
 *
 * 「读完删除上传的文件」这件事在浏览器里是这么落地的：
 *   文件本来就只存在于用户磁盘上，浏览器只是拿了个句柄；
 *   我们只 slice 出开头几段来读，读完立刻把 input 和内存里的引用清掉。
 *   全程没有任何东西被写到磁盘或发到网络上 —— 页面上也把这点写明了。
 *
 * kohya-ss 系的训练器会把参数写进 __metadata__，键名统一是 ss_ 开头。
 * ==========================================================================*/

const M8Lora = (() => {
  "use strict";

  /* header 长度的上限。正常 LoRA 的 header 也就几十 KB，
     超过这个数说明读到的不是 safetensors（或者文件坏了）。 */
  const MAX_HEADER = 64 * 1024 * 1024;
  const TOP_TAGS = 40;

  /* ss_ 键名 → 中文标签，按用途分几组，每组渲染成一张卡。
     这张表是照本机 774 个真 LoRA 的键名出现次数校准出来的 ——
     进来的键都在真实文件里见过，没见过的（比如早先猜的 ss_save_precision）已删。
     表里没有的键不会丢，会落到「其他参数」里原样显示。 */
  const FIELD_GROUPS = [
    {
      title: "训练参数", tag: "kohya",
      keys: [
        ["ss_output_name", "输出名"],
        ["ss_base_model_version", "底模版本"],
        ["ss_sd_model_name", "底模文件"],
        ["ss_network_module", "网络类型"],
        ["ss_network_spec", "网络规格"],
        ["ss_network_dim", "维度 dim"],
        ["ss_network_alpha", "alpha"],
        ["ss_learning_rate", "学习率"],
        ["ss_text_encoder_lr", "TE 学习率"],
        ["ss_unet_lr", "UNet 学习率"],
        ["ss_optimizer", "优化器"],
        ["ss_lr_scheduler", "调度器"],
        ["ss_lr_warmup_steps", "预热步数"],
        ["ss_lr_scheduler_num_cycles", "调度器周期数"],
        ["ss_lr_scheduler_power", "调度器 power"],
        ["ss_steps", "训练步数"],
        ["ss_epoch", "训练轮数"],
        ["ss_num_train_images", "训练图片数"],
        ["ss_num_reg_images", "正则图片数"],
        ["ss_batch_size_per_device", "批大小"],
        ["ss_total_batch_size", "总批大小"],
        ["ss_num_batches_per_epoch", "每轮批数"],
        ["ss_gradient_accumulation_steps", "梯度累积"],
        ["ss_resolution", "训练分辨率"],
        ["ss_mixed_precision", "混合精度"],
        ["ss_clip_skip", "CLIP skip"],
        ["ss_seed", "随机种子"],
      ],
    },
    {
      title: "训练过程", tag: "来源",
      keys: [
        /* 训练时长与开始时间由 extract 现算，插在这一组的最前面 */
        ["ss_max_grad_norm", "梯度裁剪"],
        ["ss_session_id", "会话 ID"],
        ["ss_sd_scripts_commit_hash", "训练器版本"],
        ["ss_sd_model_hash", "底模 hash"],
        ["ss_new_sd_model_hash", "底模 SHA256"],
        ["ss_vae_name", "VAE"],
        ["ss_vae_hash", "VAE hash"],
        ["ss_attn_mode", "注意力实现"],
        ["ss_attention_backend", "注意力后端"],
        ["ss_training_comment", "训练备注"],
      ],
    },
    {
      title: "数据集与标注", tag: "captions",
      keys: [
        ["ss_dataset_dirs", "数据集目录"],
        ["ss_reg_dataset_dirs", "正则数据集"],
        ["ss_enable_bucket", "分桶"],
        ["ss_min_bucket_reso", "最小桶"],
        ["ss_max_bucket_reso", "最大桶"],
        ["ss_bucket_no_upscale", "桶不放大"],
        ["ss_shuffle_caption", "打乱标注"],
        ["ss_keep_tokens", "保留 token 数"],
        ["ss_caption_dropout_rate", "标注丢弃率"],
        ["ss_caption_dropout_every_n_epochs", "标注丢弃间隔"],
        ["ss_caption_tag_dropout_rate", "tag 丢弃率"],
        ["ss_max_token_length", "最大 token"],
        ["ss_resize_interpolation", "缩放插值"],
        ["ss_skip_image_resolution", "跳过分辨率"],
        ["ss_color_aug", "颜色增强"],
        ["ss_flip_aug", "翻转增强"],
        ["ss_random_crop", "随机裁剪"],
        ["ss_face_crop_aug_range", "人脸裁剪增强"],
      ],
    },
    {
      title: "噪声与采样", tag: "进阶",
      keys: [
        ["ss_loss_type", "损失函数"],
        ["ss_weighting_scheme", "加权方式"],
        ["ss_timestep_sampling", "时间步采样"],
        ["ss_sigmoid_scale", "sigmoid 系数"],
        ["ss_logit_mean", "logit 均值"],
        ["ss_logit_std", "logit 标准差"],
        ["ss_mode_scale", "mode 系数"],
        ["ss_discrete_flow_shift", "flow shift"],
        ["ss_guidance_scale", "guidance"],
        ["ss_noise_offset", "噪声偏移"],
        ["ss_noise_offset_random_strength", "噪声偏移随机"],
        ["ss_adaptive_noise_scale", "自适应噪声"],
        ["ss_multires_noise_iterations", "多分辨率噪声迭代"],
        ["ss_multires_noise_discount", "多分辨率噪声折扣"],
        ["ss_min_snr_gamma", "Min-SNR gamma"],
        ["ss_prior_loss_weight", "先验损失权重"],
        ["ss_zero_terminal_snr", "zero terminal SNR"],
        ["ss_huber_c", "huber c"],
        ["ss_huber_schedule", "huber 调度"],
        ["ss_network_dropout", "LoRA dropout"],
        ["ss_network_args", "网络参数"],
        ["ss_gradient_checkpointing", "梯度检查点"],
        ["ss_full_fp16", "全 fp16"],
        ["ss_full_bf16", "全 bf16"],
        ["ss_fp8_base", "fp8 底模"],
        ["ss_lowram", "低显存模式"],
        ["ss_v2", "SD2 架构"],
      ],
    },
  ];

  /* 同一个东西在不同版本的 kohya 里换过名字。主键没值时回落到这几个。
     真实统计里 ss_steps 和 ss_max_train_steps 同时存在且值一样（各 460 次），
     所以只显示一个，免得同一张卡里出现两遍。 */
  const SYNONYMS = {
    ss_steps: ["ss_max_train_steps", "ss_num_train_steps"],
    ss_epoch: ["ss_num_epochs"],
    ss_batch_size_per_device: ["ss_batch_size_per_gpu"],
    ss_total_batch_size: ["ss_batch_size"],
    ss_num_train_images: ["ss_num_train_items"],
  };

  /* 一律不列的键：值是几百 KB 的 base64，跟训练参数毫无关系，
     列出来只会把「其他参数」变成一屏乱码。完整内容仍然在右上角
     「复制」拿到的原始 JSON 里，不会丢。 */
  const SKIP_KEYS = { "modelspec.thumbnail": true };

  /* 上面那些别名的反向表。别名的值已经被主键吸收（主键缺席时 pick 会回落到它），
     所以不该再作为「其他参数」单独列一遍。
     注意方向：要跳的是别名，不是主键 —— 反着写会让主键从兜底列表里冒出来。 */
  const SYNONYM_ALIASES = (function () {
    const m = {};
    Object.keys(SYNONYMS).forEach(function (k) {
      SYNONYMS[k].forEach(function (a) { m[a] = true; });
    });
    return m;
  })();

  const MODELS_SPEC = [
    ["modelspec.architecture", "架构"],
    ["modelspec.title", "标题"],
    ["modelspec.description", "说明"],
    ["modelspec.author", "作者"],
    ["modelspec.date", "日期"],
    ["modelspec.license", "许可"],
    ["modelspec.resolution", "分辨率"],
    ["modelspec.prediction_type", "预测类型"],
    ["modelspec.timestep_range", "时间步范围"],
    ["modelspec.encoder_layer", "编码层"],
    ["modelspec.merged_from", "合并来源"],
    ["modelspec.tags", "标签"],
    ["modelspec.trigger_phrase", "触发词"],
    ["modelspec.implementation", "实现"],
    ["modelspec.implementation_version", "实现版本"],
    /* 不要列 modelspec.thumbnail —— 那是 base64 缩略图，几百 KB 的一坨 */
  ];

  /* ------------------------------------------------------------ 字节小工具 */

  /* 小端 u64。header 不可能超过 2^53，用 Number 拼就够了。 */
  function readU64LE(b, o) {
    let v = 0;
    for (let i = 7; i >= 0; i--) v = v * 256 + (b[o + i] || 0);
    return v;
  }

  /* ------------------------------------------------------------ 解析（纯函数） */

  /* 吃：前 8 字节 → 吐 header 长度。给不出合理长度就返回 0。 */
  function headerLength(first8) {
    if (!first8 || first8.length < 8) return 0;
    const len = readU64LE(first8, 0);
    if (!len || len > MAX_HEADER) return 0;
    return len;
  }

  /* 吃：header 那一段字节 → 吐 { __metadata__, 张量表 }。坏 JSON 返回 null。 */
  function parseHeader(bytes) {
    if (!bytes || !bytes.length) return null;
    let text;
    if (typeof bytes === "string") {
      text = bytes;
    } else if (typeof TextDecoder === "function") {
      try { text = new TextDecoder("utf-8").decode(bytes); } catch (e) { return null; }
    } else {
      return null;
    }
    /* header 后面偶尔会跟点填充，找最后一个 } 收尾 */
    const end = text.lastIndexOf("}");
    if (end < 0) return null;
    let data = null;
    try {
      data = JSON.parse(text.slice(0, end + 1));
    } catch (e) {
      return null;
    }
    if (!data || typeof data !== "object") return null;
    const meta = data.__metadata__ && typeof data.__metadata__ === "object" ? data.__metadata__ : null;
    const tensors = [];
    Object.keys(data).forEach(function (k) {
      if (k === "__metadata__") return;
      const t = data[k];
      if (t && typeof t === "object") tensors.push({ name: k, dtype: t.dtype, shape: t.shape });
    });
    return { metadata: meta, tensors: tensors, raw: data };
  }

  /* 把 ss_tag_frequency 那种字符串化的 JSON 解出来。
     它的形状是 { "数据集名": { "标签": 次数, ... }, ... }。 */
  function parseTagFrequency(raw) {
    if (!raw) return null;
    let data = raw;
    if (typeof raw === "string") {
      try { data = JSON.parse(raw); } catch (e) { return null; }
    }
    if (!data || typeof data !== "object") return null;
    const out = [];
    Object.keys(data).forEach(function (group) {
      const tags = data[group];
      if (!tags || typeof tags !== "object") return;
      const list = Object.keys(tags).map(function (t) {
        return { tag: t, count: Number(tags[t]) || 0 };
      }).sort(function (a, b) { return b.count - a.count; });
      /* 空组要丢掉。kohya 很爱写 {"resized": {}} 这种占位 ——
         真实样本里 774 个有 41 个是空的，留着就会画出一张没内容的标签卡。 */
      if (!list.length) return;
      out.push({ group: group, tags: list });
    });
    return out.length ? out : null;
  }

  /* 一个键可能换过名字，主键没值时按 SYNONYMS 回落到旧名。
     返回 null 表示这个键在文件里真的不存在。 */
  /* kohya 是 Python 写的，没设的项会落成字符串 "None" ——
     真样本里 ss_unet_lr / ss_noise_offset / ss_min_snr_gamma / ss_network_dropout
     这些键有 430~460 个文件带的就是这个值。照实显示等于满屏 "None"，当没值处理。
     布尔值的 "True"/"False" 是真信息（某项没开），要留着。 */
  const NO_VALUE = { none: 1, nan: 1, "": 1 };

  function meaningful(v) {
    if (v === undefined || v === null) return false;
    if (typeof v === "string" && NO_VALUE[v.trim().toLowerCase()]) return false;
    return true;
  }

  function pick(metadata, key) {
    const v = metadata[key];
    if (meaningful(v)) return v;
    const alts = SYNONYMS[key] || [];
    for (let i = 0; i < alts.length; i++) {
      if (meaningful(metadata[alts[i]])) return metadata[alts[i]];
    }
    return null;
  }

  function fmtDur(sec) {
    if (sec < 60) return sec + " 秒";
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h) return h + " 小时 " + m + " 分";
    const s = sec % 60;
    return m + " 分 " + s + " 秒";
  }

  /* 起止时间都是 unix 秒（带小数）。两个都在才算得出来。 */
  function trainingSpan(metadata) {
    const a = Number(metadata.ss_training_started_at);
    const b = Number(metadata.ss_training_finished_at);
    if (!isFinite(a) || !isFinite(b) || a <= 0 || b <= a) return null;
    let started = "";
    try { started = new Date(a * 1000).toLocaleString(); } catch (e) { started = ""; }
    return {
      dur: fmtDur(Math.round(b - a)),
      started: started,
    };
  }

  /* ss_network_args 是一串 JSON：{"algo":"lora","factor":8,"preset":"anima_full"}。
     拆成一条条显示，比一整坨 JSON 好读。 */
  function networkArgs(raw) {
    if (!raw) return [];
    let d = raw;
    if (typeof raw === "string") {
      try { d = JSON.parse(raw); } catch (e) { return []; }
    }
    if (!d || typeof d !== "object" || Array.isArray(d)) return [];
    return Object.keys(d).map(function (k) {
      const v = d[k];
      return ["网络参数 · " + k, typeof v === "object" ? JSON.stringify(v) : v];
    });
  }

  /* 从 metadata 里挑出要展示的东西。
     纯函数，喂真 metadata 或喂 null 都行。 */
  function extract(metadata) {
    if (!metadata) return null;
    const out = { groups: [], fields: [], spec: [], others: [], tagGroups: null, skipped: 0 };
    const known = {};

    FIELD_GROUPS.forEach(function (g) {
      const pairs = [];
      /* 训练过程那张卡的第一行留给训练耗时 */
      if (g.title === "训练过程") {
        const span = trainingSpan(metadata);
        if (span) {
          pairs.push(["训练耗时", span.dur]);
          if (span.started) pairs.push(["训练开始", span.started]);
        }
      }
      g.keys.forEach(function (f) {
        known[f[0]] = true;
        const v = pick(metadata, f[0]);
        if (v === null) return;
        /* 网络参数拆开显示，别让一整坨 JSON 挤在格子里 */
        if (f[0] === "ss_network_args") {
          const parts = networkArgs(v);
          if (parts.length) { parts.forEach(function (p) { pairs.push(p); }); return; }
        }
        pairs.push([f[1], v]);
      });
      if (pairs.length) out.groups.push({ title: g.title, tag: g.tag, pairs: pairs });
    });

    /* 训练参数那组也单独给一份，方便外部（和测试）直接拿 */
    if (out.groups.length && out.groups[0].title === "训练参数") {
      out.fields = out.groups[0].pairs;
    }

    MODELS_SPEC.forEach(function (f) {
      known[f[0]] = true;
      const v = pick(metadata, f[0]);
      if (v === null) return;
      out.spec.push([f[1], v]);
    });

    /* 剩下没归类的键，原样列出来 */
    Object.keys(metadata).forEach(function (k) {
      if (known[k] || k === "ss_tag_frequency") return;
      /* 同义表里被主键吸收掉的旧名，也不再单独列一遍 */
      if (SYNONYM_ALIASES[k] || k === "ss_training_started_at" || k === "ss_training_finished_at") return;
      if (SKIP_KEYS[k]) { out.skipped++; return; }
      const v = metadata[k];
      if (!meaningful(v)) return;
      /* 超长的值（比如整个数据集路径表、base64 缩略图）截一下 */
      const s = String(v);
      out.others.push([k, s.length > 400 ? s.slice(0, 400) + "…" : v]);
    });
    out.others.sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });

    out.tagGroups = parseTagFrequency(metadata.ss_tag_frequency);
    return out;
  }

  /* ------------------------------------------------------------ 渲染 */

  let el = {};
  let busy = false;

  function setStatus(text, warn) {
    if (!el.status) return;
    el.status.textContent = text || "";
    el.status.classList.toggle("warn", !!warn);
  }

  function infoCard(title, tag) {
    const box = document.createElement("section");
    box.className = "info-card";
    const h = document.createElement("h2");
    h.textContent = title;
    if (tag) {
      const t = document.createElement("span");
      t.className = "info-tag";
      t.textContent = tag;
      h.appendChild(t);
    }
    box.appendChild(h);
    return box;
  }

  function kv(pairs) {
    const dl = document.createElement("dl");
    dl.className = "kv";
    pairs.forEach(function (p) {
      if (p[1] === undefined || p[1] === null || p[1] === "") return;
      const dt = document.createElement("dt");
      dt.textContent = p[0];
      const dd = document.createElement("dd");
      dd.textContent = String(p[1]);
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    return dl;
  }

  function copyButton(text) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "复制";
    b.addEventListener("click", function () {
      copyText(text).then(function () { setStatus("复制好了。"); })
        .catch(function () { setStatus("复制没成功，手动选一下吧。", true); });
    });
    return b;
  }

  function fmtSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  /* 标签频率画成横条：一眼能看出这个 LoRA 到底在练什么 */
  function tagChart(groups) {
    const wrap = document.createElement("div");
    groups.forEach(function (g) {
      const box = document.createElement("div");
      box.className = "tag-group";
      const h = document.createElement("h3");
      h.textContent = g.group;
      box.appendChild(h);

      const list = document.createElement("div");
      list.className = "tag-list";
      const top = g.tags.slice(0, TOP_TAGS);
      const max = top.length ? top[0].count : 1;
      top.forEach(function (t) {
        const row = document.createElement("div");
        row.className = "tag-row";
        const name = document.createElement("span");
        name.className = "tag-name";
        name.textContent = t.tag;
        name.title = t.tag + " × " + t.count;
        const bar = document.createElement("div");
        bar.className = "tag-bar";
        const fill = document.createElement("span");
        fill.style.width = Math.max(2, Math.round((t.count / max) * 100)) + "%";
        bar.appendChild(fill);
        const num = document.createElement("span");
        num.className = "tag-num";
        num.textContent = String(t.count);
        row.appendChild(name);
        row.appendChild(bar);
        row.appendChild(num);
        list.appendChild(row);
      });
      box.appendChild(list);
      if (g.tags.length > TOP_TAGS) {
        const more = document.createElement("p");
        more.className = "tag-more";
        more.textContent = "还有 " + (g.tags.length - TOP_TAGS) + " 个标签没列（一共 " + g.tags.length + " 个）";
        box.appendChild(more);
      }
      wrap.appendChild(box);
    });
    return wrap;
  }

  function render(info) {
    const panels = el.panels;
    panels.innerHTML = "";

    /* --- 文件 --- */
    const fCard = infoCard("文件");
    const headPairs = [
      ["文件名", info.file.name],
      ["大小", fmtSize(info.file.size)],
      ["张量数", info.tensorCount],
      ["header", fmtSize(info.headerBytes) + "（只读了这一段）"],
    ];
    /* dtype 汇总：LoRA 通常就 F16 / BF16 / F32 一两种 */
    const dtypes = {};
    (info.tensors || []).forEach(function (t) { if (t.dtype) dtypes[t.dtype] = (dtypes[t.dtype] || 0) + 1; });
    const dt = Object.keys(dtypes).map(function (k) { return k + " × " + dtypes[k]; }).join(" · ");
    if (dt) headPairs.push(["数据类型", dt]);
    fCard.appendChild(kv(headPairs));
    panels.appendChild(fCard);

    if (!info.metadata) {
      const nCard = infoCard("没有训练参数");
      const p = document.createElement("p");
      p.className = "info-note";
      p.textContent = "这个 safetensors 里没有 __metadata__ 段 —— 可能是普通模型权重，"
        + "或者合并/转换过的 LoRA（很多工具在转格式时会把训练信息丢掉）。";
      nCard.appendChild(p);
      panels.appendChild(nCard);
      return;
    }

    /* --- 模型信息 --- */
    if (info.spec.length) {
      const sCard = infoCard("模型信息", "modelspec");
      sCard.appendChild(kv(info.spec));
      panels.appendChild(sCard);
    }

    /* --- 训练参数 / 训练过程 / 数据集与标注 / 噪声与采样 ---
       真文件里 ss_ 键有一百多个，一坨列下来没人看得完。
       分组后每张卡只在「有值」时才出现，空组不占位置。 */
    (info.groups || []).forEach(function (g) {
      const card = infoCard(g.title, g.tag);
      card.appendChild(kv(g.pairs));
      panels.appendChild(card);
    });

    /* --- 标签频率 --- */
    if (info.tagGroups) {
      const gCard = infoCard("训练标签", "按出现次数");
      gCard.appendChild(tagChart(info.tagGroups));
      panels.appendChild(gCard);
    }

    /* --- 其他参数 --- */
    if (info.others.length) {
      const oCard = infoCard("其他参数");
      const acts = document.createElement("div");
      acts.className = "card-actions";
      const all = JSON.stringify(info.metadata, null, 2);
      acts.appendChild(copyButton(all));
      oCard.querySelector("h2").appendChild(acts);
      oCard.appendChild(kv(info.others.slice(0, 60)));
      if (info.others.length > 60) {
        const p = document.createElement("p");
        p.className = "info-note";
        p.style.marginTop = "8px";
        p.textContent = "还有 " + (info.others.length - 60) + " 项没列（点上面的「复制」能拿到全部）";
        oCard.appendChild(p);
      }
      if (info.skipped) {
        const p = document.createElement("p");
        p.className = "info-note";
        p.textContent = "另外省略了 " + info.skipped + " 项体积很大又没参考价值的内容"
          + "（比如内嵌缩略图），「复制」里仍然有。";
        oCard.appendChild(p);
      }
      panels.appendChild(oCard);
    }
  }

  /* ------------------------------------------------------------ 主流程 */

  function readHeaderOnly(file) {
    /* 第一步：8 字节，拿 header 长度 */
    return file.slice(0, 8).arrayBuffer().then(function (buf) {
      const len = headerLength(new Uint8Array(buf));
      if (!len) {
        throw new Error("这不是 safetensors 文件（开头 8 字节给不出合理的 header 长度）");
      }
      /* 第二步：只把 header 那一段切出来读。张量数据一个字节都不碰。 */
      return file.slice(8, 8 + len).arrayBuffer().then(function (hb) {
        const parsed = parseHeader(new Uint8Array(hb));
        if (!parsed) throw new Error("header 不是合法的 JSON");
        parsed.headerBytes = len;
        return parsed;
      });
    });
  }

  function analyze(file) {
    if (!file) return;
    if (busy) return;
    const name = (file.name || "").toLowerCase();
    if (name && !/\.safetensors$/.test(name)) {
      setStatus("只认 .safetensors 文件。", true);
      return;
    }
    busy = true;
    el.drop.classList.add("is-hidden");
    el.body.classList.remove("is-hidden");
    setStatus("正在读头部…（只读开头那一段，不会把整个文件读进来）");

    readHeaderOnly(file)
      .then(function (parsed) {
        const userMeta = parsed.metadata;
        const info = extract(userMeta);
        render({
          file: { name: file.name || "(没有名字)", size: file.size },
          headerBytes: parsed.headerBytes,
          tensorCount: parsed.tensors.length,
          tensors: parsed.tensors,
          metadata: userMeta,
          groups: info ? info.groups : [],
          fields: info ? info.fields : [],
          spec: info ? info.spec : [],
          others: info ? info.others : [],
          tagGroups: info ? info.tagGroups : null,
        });
        const bits = [];
        if (info && info.fields.length) bits.push("训练参数");
        if (info && info.tagGroups) bits.push("训练标签");
        if (info && info.spec.length) bits.push("模型信息");
        setStatus(bits.length
          ? "读完了（只读了 " + fmtSize(parsed.headerBytes + 8) + "）：" + bits.join(" · ")
          : "读完了，但里面没有训练参数。");
        el.again.classList.remove("is-hidden");
      })
      .catch(function (e) {
        el.drop.classList.remove("is-hidden");
        el.body.classList.add("is-hidden");
        setStatus(e && e.message ? e.message : "读不出来。", true);
      })
      .then(function () {
        busy = false;
        /* 读完就把 input 清掉：文件句柄不在我们手里留着。
           文件本来就没被上传，也没有任何东西落盘 —— 这里只是别让引用挂着。 */
        if (el.file) el.file.value = "";
      });
  }

  function reset() {
    if (el.file) el.file.value = "";
    el.body.classList.add("is-hidden");
    el.drop.classList.remove("is-hidden");
    el.again.classList.add("is-hidden");
    setStatus("");
  }

  function copyText(text) {
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand && document.execCommand("copy");
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error("copy failed"));
      } catch (e) { reject(e); }
    });
  }

  /* ------------------------------------------------------------ 入口 */

  function byId(id) { return document.getElementById(id); }

  function init() {
    el = {
      drop: byId("loraDrop"),
      file: byId("loraFile"),
      hint: byId("loraHint"),
      body: byId("loraBody"),
      panels: byId("loraPanels"),
      again: byId("loraAgain"),
      status: byId("loraStatus"),
    };
    if (!el.drop || !el.body) return;

    el.drop.addEventListener("click", function (ev) {
      if (ev.target !== el.file) el.file.click();
    });
    el.file.addEventListener("change", function () {
      const f = el.file.files && el.file.files[0];
      if (f) analyze(f);
      else if (el.file) el.file.value = "";
    });
    el.again.addEventListener("click", reset);

    ["dragenter", "dragover"].forEach(function (t) {
      el.drop.addEventListener(t, function (ev) {
        ev.preventDefault();
        el.drop.classList.add("over");
      });
    });
    ["dragleave", "dragend"].forEach(function (t) {
      el.drop.addEventListener(t, function () { el.drop.classList.remove("over"); });
    });
    el.drop.addEventListener("drop", function (ev) {
      ev.preventDefault();
      el.drop.classList.remove("over");
      const dt = ev.dataTransfer;
      const f = dt && dt.files && dt.files[0];
      if (f) analyze(f);
    });

    document.addEventListener("paste", function (ev) {
      const items = ev.clipboardData && ev.clipboardData.files;
      if (items && items.length) analyze(items[0]);
    });
  }

  return {
    init: init,
    headerLength: headerLength,
    parseHeader: parseHeader,
    parseTagFrequency: parseTagFrequency,
    extract: extract,
    analyze: analyze,
    copyText: copyText,
    _render: render,
    _el: function () { return el; },
  };
})();
