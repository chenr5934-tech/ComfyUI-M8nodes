/* ============================================================================
 * M8 小鲸鱼 · 对话窗口
 *
 * 非模态：开着它照样能操作画布，不挡路、不抢焦点。
 * 可拖拽（标题栏）、可缩放（右下角），几何信息存服务端设置，下次打开还在原位。
 *
 * 这是**重写版**。上一版的窗口看得见、却谁都点不到 —— 根因是内容区用了
 * .m8-whale-body 这个名字，和挂件里承载 Q 弹的那个同名（position:absolute;
 * inset:0）。后写的规则不重置 position，内容区就脱离文档流铺满整窗，
 * 按绘制顺序盖住了标题栏和输入框。整套重做，类名一律 m8-cw- 前缀，
 * 样式独立成 chat.css 由本文件注入，不再和挂件共用任何选择器。
 *
 * 定位也不再由 JS 写 left/top：基准位置交给 CSS 的 right/bottom，
 * 拖动只改 transform 的偏移量 —— 少一处能算出 NaN 的地方。
 *
 * 对话历史存**服务端**（m8/data/whale-history.json）。一度存在浏览器的
 * localStorage 里，结果关掉 ComfyUI 再打开就空了，写失败还不报错。
 * ==========================================================================*/

import * as M8 from '../../m8_core.js';
import { API_BASE, assetUrl } from './whale.js';
import { toolLabel, runToolCall, snapshotCanvas } from './canvas.js';

/* 界面文案：代码里写英文，中文由 locales/zh/main.json 的 ui.M8Whale 段提供。
   下面的预设每条都现取 —— 界面文案是异步拉回来的，模块顶层求值只会拿到英文。 */
const T = M8.tFor('M8Whale');

/* 样式表由本文件自己注入 —— 自包含，不碰挂件那边的加载逻辑 */
let cssInjected = false;
function injectCss() {
  if (cssInjected) return;
  cssInjected = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./chat.css', import.meta.url).href;
  document.head.appendChild(link);
}

/**
 * 输入框上面的快捷选项。
 *
 * 每条都是一段写好的指令，点了直接发出去 —— 相当于替用户把话说全了。
 * 措辞上刻意做了两件事：
 *
 *   1. **要求它先把话说到位再动手**（先告诉我缺什么，别乱改）——
 *      模型面对不熟的工作流时最爱自作主张，这里提前摁住。
 *   2. **要求它如实说**（没有失败就直说，别编）——
 *      这类检查任务，编一个答案比不回答还糟。
 */
function presets() {
  return [
    {
      label: T('presetRunLabel', 'Run one image'),
      prompt: T('presetRunPrompt', [
        'Run one image on this canvas. Please work like this:',
        '1. Look at the canvas structure first and find where the prompt goes (keyword or positive-prompt nodes).',
        '2. Write a prompt yourself and fill it in; the subject and style are up to you.',
        '3. Queue it once it is filled in.',
        '4. Tell me what prompt you wrote and which node you put it in.',
        '',
        'If this canvas cannot be run directly (missing models, no prompt node, structure unclear),',
        'explain what is missing first. Do not change my parameters on your own.',
      ].join('\n')),
    },
    {
      label: T('presetLoraLabel', 'Pick LoRAs'),
      prompt: T('presetLoraPrompt', [
        'Help me pick a few LoRAs. Call list_loras first to see what I have installed,',
        'then recommend 3 to 5 that fit what this canvas is currently doing:',
        'what each one does and why it suits this scene.',
        'If the canvas has a node that takes a LoRA, ask whether I want it filled in - do not change it directly.',
      ].join('\n')),
    },
    {
      label: T('presetErrorsLabel', 'Check errors'),
      prompt: T('presetErrorsPrompt', [
        'Check whether any recent task failed. Call get_recent_errors to get the records.',
        'If something failed, say clearly: which node, what the message was, the likely cause, and how to fix it.',
        'If nothing failed, just say so. Do not make one up for me.',
      ].join('\n')),
    },
  ];
}

/* 一轮对话里最多允许几次工具往返。给足改参数 → 提交这种两步操作，
   但不至于让它在某件事上无限绕圈。 */
const MAX_TOOL_ROUNDS = 6;

/* 图片上限。单张按 4 MB 卡：再大的图 base64 之后能有五六兆，
   发得慢、吃 token，接口还可能直接拒。 */
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const MIN_W = 300;
const MIN_H = 240;
const DEFAULT_W = 400;
const DEFAULT_H = 520;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error(T('readFileFailed', 'Could not read the file')));
    reader.readAsDataURL(file);
  });
}

function clamp(value, low, high) {
  return Math.min(Math.max(low, value), high);
}

export class WhaleDialog {
  constructor(ctx) {
    this.ctx = ctx;
    this.history = [];
    this.attachments = [];
    this.busy = false;
    /* 相对 CSS 基准位置的偏移。初始就是 0，没有 NaN 的余地 */
    this.dx = 0;
    this.dy = 0;
    this.keyNoticeShown = false;

    this.build();
    // 记录在服务端，只能异步取。先按空的把界面立起来，
    // 拿到之后重画一遍 —— 比卡着不动强。
    this.loadHistory();
  }

  /* -------------------------------------------------------------- 记录 */

  async loadHistory() {
    try {
      const data = await M8.apiGet(API_BASE + '/history');
      this.history = data.history?.turns || [];
      this.renderHistory();
      if (this.history.length) {
        M8.log('读回 ' + this.history.length + ' 条对话记录');
      }
    } catch (exc) {
      // 读不到就当空的，但要说一声 —— 静默会让「记录又没了」变成悬案
      M8.warn('读对话记录失败：', exc.code, exc.message);
      this.history = [];
    }
  }

  async persist() {
    try {
      await M8.apiPost(API_BASE + '/history', { history: this.history });
    } catch (exc) {
      // **存不上必须说出来**。上次丢记录就是因为写失败被前端静默 catch 了。
      M8.warn('对话记录没存上：', exc.code, exc.message, exc.detail || '');
    }
  }

  /* -------------------------------------------------------------- 搭壳 */

  build() {
    injectCss();

    const el = document.createElement('div');
    el.className = 'm8-cw';
    el.innerHTML = [
      '<div class="m8-cw-head">',
      '  <img src="' + assetUrl('whale.png') + '" alt="">',
      '  <span class="m8-cw-title">' + T('dialogTitle', 'Little Whale') + '</span>',
      '  <button class="m8-cw-btn" data-act="clear" title="' + T('clearTitle', 'Clear this conversation') + '">⌫</button>',
      '  <button class="m8-cw-btn" data-act="close" title="' + T('closeTitle', 'Close') + '">×</button>',
      '</div>',
      '<div class="m8-cw-body"></div>',
      '<div class="m8-cw-attach"></div>',
      '<div class="m8-cw-chips"></div>',
      '<div class="m8-cw-foot">',
      '  <button class="m8-cw-btn" data-act="attach" title="' + T('attachTitle', 'Add images (for models that can see them)') + '">＋</button>',
      '  <textarea class="m8-cw-input" rows="1" placeholder="' + T('inputPlaceholder', 'Say something... (type / to reference a skill, Shift+Enter for a newline)') + '"></textarea>',
      '  <button class="m8-cw-send">' + T('send', 'Send') + '</button>',
      '</div>',
      '<div class="m8-cw-resize" title="' + T('resizeTitle', 'Drag to resize') + '"></div>',
    ].join('\n');
    document.body.appendChild(el);

    this.el = el;
    this.headEl = el.querySelector('.m8-cw-head');
    this.bodyEl = el.querySelector('.m8-cw-body');
    this.chipsEl = el.querySelector('.m8-cw-chips');
    this.attachEl = el.querySelector('.m8-cw-attach');
    this.inputEl = el.querySelector('.m8-cw-input');
    this.sendEl = el.querySelector('.m8-cw-send');
    this.pickEl = el.querySelector('[data-act="attach"]');
    this.resizeEl = el.querySelector('.m8-cw-resize');
    this.attachments = [];

    this.buildChips();
    this.pickEl.addEventListener('click', () => this.pickImages());
    el.querySelector('[data-act="close"]').addEventListener('click', () => this.close());
    el.querySelector('[data-act="clear"]').addEventListener('click', () => this.clear());
    this.sendEl.addEventListener('click', () => this.send());

    this.bindDrag();
    this.bindResize();
    this.bindInput();

    // 窗口内部的事件不要漏到画布上（尤其滚轮和按键）
    el.addEventListener('pointerdown', (event) => event.stopPropagation());
    el.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
  }

  /* -------------------------------------------------------------- 图片 */

  /** 选图。读成 data URL 直接带走 —— 不落盘、不走上传接口。 */
  async pickImages() {
    const files = await new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = true;
      input.style.display = 'none';
      document.body.appendChild(input);

      const finish = (list) => {
        input.remove();
        resolve(list || []);
      };
      input.addEventListener('change', () => finish([...input.files]));
      window.addEventListener(
        'focus',
        () => setTimeout(() => { if (document.body.contains(input)) finish([]); }, 400),
        { once: true },
      );
      input.click();
    });

    for (const file of files) {
      if (this.attachments.length >= MAX_IMAGES) {
        M8.notify(T('tooManyImages', 'At most {n} images at a time', { n: MAX_IMAGES }), { kind: 'warn' });
        break;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        M8.notify(
          T('imageTooLarge', '{name} is too large ({mb} MB); pick a smaller one', {
            name: file.name,
            mb: Math.round(file.size / 1024 / 1024),
          }),
          {
            kind: 'warn',
            hint: T('imageTooLargeHint', 'Oversized images get rejected by the API and burn tokens'),
          },
        );
        continue;
      }
      try {
        this.attachments.push({ name: file.name, dataUrl: await readAsDataUrl(file) });
      } catch (exc) {
        M8.warn('读图失败：', exc);
      }
    }
    this.renderAttachments();
  }

  renderAttachments() {
    this.attachEl.innerHTML = '';
    if (!this.attachments.length) return;

    this.attachments.forEach((item, index) => {
      const box = document.createElement('div');
      box.className = 'm8-cw-thumb';
      box.title = item.name;

      const img = document.createElement('img');
      img.src = item.dataUrl;
      img.alt = item.name;
      box.appendChild(img);

      const del = document.createElement('button');
      del.className = 'm8-cw-thumb-del';
      del.textContent = '×';
      del.title = T('removeAttachment', 'Remove');
      del.addEventListener('click', () => {
        this.attachments.splice(index, 1);
        this.renderAttachments();
      });
      box.appendChild(del);

      this.attachEl.appendChild(box);
    });
  }

  /** 把文字和图片拼成一条消息的 content。没有图就还是纯字符串。 */
  buildUserContent(text) {
    if (!this.attachments.length) return text;
    const parts = [];
    if (text) parts.push({ type: 'text', text });
    for (const item of this.attachments) {
      parts.push({ type: 'image_url', image_url: { url: item.dataUrl } });
    }
    return parts;
  }

  buildChips() {
    for (const preset of presets()) {
      const chip = document.createElement('button');
      chip.className = 'm8-cw-chip';
      chip.textContent = preset.label;
      chip.title = preset.prompt.split('\n')[0];
      chip.addEventListener('click', () => this.sendPreset(preset.prompt));
      this.chipsEl.appendChild(chip);
    }
  }

  /**
   * 发一条预设指令。
   *
   * 先把它写进输入框再发 —— 用户得看得见自己说了什么，
   * 否则对话里突然冒出一句他没打过的话，会以为见了鬼。
   */
  async sendPreset(prompt) {
    if (this.busy) return;
    this.inputEl.value = prompt;
    this.autoGrow();
    await this.send();
  }

  bindInput() {
    this.inputEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      // 补全面板开着时它已经处理过回车了（preventDefault），这里让开
      if (event.defaultPrevented) return;
      event.preventDefault();
      this.send();
    });

    this.inputEl.addEventListener('input', () => this.autoGrow());

    // 打 / 弹出已上传的 skill，和节点上是同一套交互
    M8.attachMention(this.inputEl, {
      getItems: async () => (await M8.apiGet('/skills/list')).skills,
      emptyHint: T('noSkillsHint', 'No skill uploaded yet. Upload one from the Skill Loader node.'),
    });
  }

  autoGrow() {
    this.inputEl.style.height = 'auto';
    this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
  }

  /* -------------------------------------------------------------- 拖动 */

  /** 偏移写进 transform —— 基准位置始终由 CSS 的 right/bottom 决定 */
  applyTransform() {
    this.el.style.transform = 'translate3d(' + this.dx + 'px, ' + this.dy + 'px, 0)';
  }

  bindDrag() {
    this.headEl.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;
      event.preventDefault();

      const startX = event.clientX;
      const startY = event.clientY;
      const baseX = this.dx;
      const baseY = this.dy;
      // 视口坐标拍一次快照，用来算边界；每帧重读会积累误差
      const rect = this.el.getBoundingClientRect();
      this.el.classList.add('-dragging');

      // 监听挂 document 而不是用 setPointerCapture —— 鼠标飞出窗口也不丢跟手
      const onMove = (moveEvent) => {
        const wantLeft = rect.left + (moveEvent.clientX - startX);
        const wantTop = rect.top + (moveEvent.clientY - startY);
        // 至少留 60px 在视口里，免得拖到找不回来
        const left = clamp(wantLeft, -(rect.width - 60), window.innerWidth - 60);
        const top = clamp(wantTop, 0, window.innerHeight - 40);
        this.dx = baseX + (left - rect.left);
        this.dy = baseY + (top - rect.top);
        this.applyTransform();
      };

      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        this.el.classList.remove('-dragging');
        this.saveGeometry();
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  bindResize() {
    this.resizeEl.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();

      const startX = event.clientX;
      const startY = event.clientY;
      const startW = this.el.offsetWidth;
      const startH = this.el.offsetHeight;

      const onMove = (moveEvent) => {
        const width = Math.max(MIN_W, startW + (moveEvent.clientX - startX));
        const height = Math.max(MIN_H, startH + (moveEvent.clientY - startY));
        this.el.style.width = width + 'px';
        this.el.style.height = height + 'px';
      };

      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        this.saveGeometry();
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
  }

  restoreGeometry() {
    const g = this.ctx.settings?.dialogSize || {};
    const width = Number(g.w) || DEFAULT_W;
    const height = Number(g.h) || DEFAULT_H;
    this.el.style.width = width + 'px';
    this.el.style.height = height + 'px';
    this.dx = Number.isFinite(g.dx) ? g.dx : 0;
    this.dy = Number.isFinite(g.dy) ? g.dy : 0;
    this.applyTransform();
  }

  saveGeometry() {
    this.ctx.save({
      dialogSize: {
        w: this.el.offsetWidth,
        h: this.el.offsetHeight,
        dx: Math.round(this.dx),
        dy: Math.round(this.dy),
      },
    }).catch(() => { /* 存不上不影响用 */ });
  }

  /* -------------------------------------------------------------- 显隐 */

  toggle() {
    if (this.el.classList.contains('-open')) this.close();
    else this.open();
  }

  open() {
    this.restoreGeometry();
    this.el.classList.add('-open');
    // 没配密钥时提醒一句，但**每个会话只提醒一次** ——
    // 每次打开都追一条的话，反复开关几次就堆一屏重复的话。
    if (!this.ctx.state?.hasKey && !this.keyNoticeShown) {
      this.keyNoticeShown = true;
      this.note(T('noKeyNotice', 'No DeepSeek API key configured yet. Fill one in under "Little Whale" in the sidebar, or save one from the inference node.'));
    }
    this.inputEl.focus();
    this.scrollToEnd();
  }

  close() {
    this.el.classList.remove('-open');
  }

  /* -------------------------------------------------------------- 渲染 */

  renderHistory() {
    this.bodyEl.innerHTML = '';
    if (!this.history.length) {
      // 空着一片黑看着像窗口坏了 —— 给一句照着能做的话
      const tip = document.createElement('div');
      tip.className = 'm8-cw-empty';
      tip.textContent = T('emptyHint', 'Type something below to start. Use / to reference an installed skill.');
      this.bodyEl.appendChild(tip);
      return;
    }
    for (const item of this.history) {
      this.appendMessage(item.role, item.content, { thinking: item.thinking, silent: true });
    }
    this.scrollToEnd();
  }

  appendMessage(role, content, { thinking = '', kind = '', silent = false, images = [] } = {}) {
    const el = document.createElement('div');
    el.className = 'm8-cw-msg -' + (kind || role);

    // content 可能是多模态数组 —— 带图的消息刚发出去时就是那个形状。
    // 直接 textContent 会把它渲染成 [object Object]。取出文本部分拼起来。
    const text = Array.isArray(content)
      ? content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
      : content;
    el.textContent = text;

    if (images.length) {
      const strip = document.createElement('div');
      strip.className = 'm8-cw-msg-images';
      for (const url of images) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = T('attachmentAlt', 'Attachment');
        strip.appendChild(img);
      }
      el.appendChild(strip);
    }

    if (thinking) {
      const box = document.createElement('div');
      box.className = 'm8-cw-think';
      box.textContent = T('thinkingShow', 'Thinking ▾');
      const inner = document.createElement('div');
      inner.className = 'm8-cw-think-body';
      inner.textContent = thinking;
      box.appendChild(inner);
      box.addEventListener('click', () => {
        box.classList.toggle('-open');
        box.firstChild.textContent = box.classList.contains('-open')
          ? T('thinkingHide', 'Thinking ▴')
          : T('thinkingShow', 'Thinking ▾');
      });
      el.appendChild(box);
    }

    this.bodyEl.appendChild(el);
    if (!silent) this.scrollToEnd();
    return el;
  }

  note(text, kind = 'err') {
    return this.appendMessage('assistant', text, { kind });
  }

  scrollToEnd() {
    requestAnimationFrame(() => {
      this.bodyEl.scrollTop = this.bodyEl.scrollHeight;
    });
  }

  /* -------------------------------------------------------------- 对话 */

  async send() {
    if (this.busy) return;
    const text = this.inputEl.value.trim();
    if (!text) return;

    this.inputEl.value = '';
    this.autoGrow();

    // 图片跟着消息走：读成 data URL 直接塞进 content，不落盘、不走上传接口
    const images = this.attachments.map((item) => item.dataUrl);
    this.history.push({ role: 'user', content: this.buildUserContent(text) });
    this.appendMessage('user', text || T('imageOnly', '(image)'), { images });

    this.attachments = [];
    this.renderAttachments();
    this.persist();

    this.busy = true;
    this.sendEl.disabled = true;
    this.chipsEl.classList.add('-busy');

    try {
      await this.runLoop();
    } catch (exc) {
      const hint = exc.hint ? '\n' + exc.hint : '';
      this.note('[' + (exc.code || 'M8-???-###') + '] ' + exc.message + hint);
      M8.warn('小鲸鱼对话失败：', exc.code, exc.message, exc.detail || '');
    } finally {
      this.busy = false;
      this.sendEl.disabled = false;
      this.chipsEl.classList.remove('-busy');
      this.inputEl.focus();
      this.persist();
    }
  }

  /**
   * 工具循环。
   *
   * 后端只跑一步：要么给回答，要么要求调工具。工具在前端执行 ——
   * 读队列、改画布、排队都是浏览器的能力，后端够不着。
   *
   * 每轮都重新拍一次画布快照：上一轮可能刚改过参数，
   * 拿旧快照接着判断会让模型对着过期数据做决定。
   */
  async runLoop() {
    for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
      const busyEl = this.appendMessage(
        'assistant',
        round === 1 ? T('thinking', 'Little Whale is thinking...') : T('stillThinking', 'Still thinking...'),
        { kind: 'busy' },
      );

      let data;
      try {
        data = await M8.apiPost(API_BASE + '/chat', {
          messages: this.history,
          canvas: snapshotCanvas(),
        });
      } finally {
        busyEl.remove();
      }

      const calls = data.toolCalls || [];

      if (data.text) {
        this.appendMessage('assistant', data.text, { thinking: data.thinking || '' });
      }
      if (data.skills?.length) {
        M8.log('这轮带上了知识包：', data.skills.join('、'));
      }

      // 带工具调用的 assistant 消息要原样进历史：格式必须和模型给的一致，
      // 少一个字段下一轮请求就会被接口拒掉。
      const turn = { role: 'assistant', content: data.text || '' };
      if (calls.length) turn.tool_calls = calls;
      this.history.push(turn);

      if (!calls.length) {
        if (!data.text) this.note(T('emptyReply', 'The model returned no content this time.'));
        this.reportCost(data);
        return;
      }

      for (const call of calls) {
        const name = call.function?.name || '?';
        const label = toolLabel(name);
        const pending = this.note(T('runningTool', 'Running {label}...', { label }), 'busy');
        const result = await runToolCall(call);
        pending.remove();
        // 工具干了什么要留在对话里 —— 尤其改参数和排队，
        // 用户得能回头看见它到底动了什么
        this.note(T('toolResult', '[{label}] {result}', { label, result }), 'tool');
        this.history.push({ role: 'tool', tool_call_id: call.id, content: result });
      }

      this.persist();
    }

    this.note(T('toolRoundsExceeded', 'The tool went back and forth {n} rounds without finishing, so I stopped - I may be going in circles on something.', { n: MAX_TOOL_ROUNDS }));
  }

  /**
   * 报一下这轮花了多少钱。
   *
   * 对话里留一行（回头能算总账），挂件上弹个气泡（当下能看见）——
   * 后者受设置里的开关控制，前者总是显示。
   */
  reportCost(data) {
    if (!data || !(data.cost > 0)) return;

    const peak = data.peak ? T('peakSuffix', ' (peak rate)') : '';
    this.note(T('turnCostNote', 'This turn cost {cost}{peak}', { cost: data.costText, peak }), 'tool');

    if (this.ctx.settings?.turnCost === false) return;

    const widget = this.ctx.widget;
    if (!widget) return;
    // 用挂件那套气泡渲染，样式和余额提示保持一致 ——
    // 同一只鲸鱼说两种长相的话，看着像两个插件拼起来的
    widget.showBubble(
      widget.renderBubble({
        label: T('turnCostBubbleLabel', 'Last turn cost'),
        symbol: '¥',
        amount: String(data.costText || '').replace(/^¥/, ''),
        hint: data.peak ? T('peakRate', 'peak rate') : T('offPeakRate', 'off-peak rate'),
      }),
      Number(this.ctx.settings?.turnCostCloseMs ?? 4000),
    );
  }

  clear() {
    this.history = [];
    this.renderHistory();
    M8.apiPost(API_BASE + '/history/clear').catch((exc) => {
      M8.warn('清空对话记录失败：', exc.code, exc.message);
    });
    M8.log('小鲸鱼的对话已清空');
  }
}
