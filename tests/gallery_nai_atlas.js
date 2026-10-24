/* ============================================================================
 * NAI 图鉴数据源：纯逻辑测试。
 *
 * 这里**不联网、不读任何真实数据文件** —— 只喂构造的最小 JSON 片段。
 * 图鉴的词典动辄几 MB，把它当 fixture 塞进仓库就违背「不占空间」这条了。
 *
 * 验的是三件容易静默坏掉的事：
 *   1. NAI → SD 权重语法的转换（站点那套的语义，搬错了不会报错、只会提示词变味）
 *   2. 主正向 + 角色正文的合并（丢标记、不拆散、负向不取）
 *   3. 图片地址的拼法（前缀 / assetCodexId / 文件名 / ?v=rev）
 *
 * 用法：node tests/gallery_nai_atlas.js
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');

const noop = () => {};

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) { passed++; console.log('  OK    ' + name); }
  else { failures.push(name + (detail ? ' → ' + detail : '')); console.log('  FAIL  ' + name + (detail ? ' → ' + detail : '')); }
}

/* ---------------------------------------------------------------- 加载模块 */

function loadModule(fetchImpl) {
  globalThis.fetch = fetchImpl || (async () => { throw new Error('测试里不该发网络请求'); });
  const file = path.resolve(__dirname, '..', 'js', 'gallery', 'danbooru_gallery', 'nai_atlas.js');
  let src = fs.readFileSync(file, 'utf8').replace(/\bexport\s+/g, '');
  const factory = new Function(src + `
    return { naiToSd, fmtSdWeight, entryPrompt, entryToPost, assetUrl,
             loadPosts, loadEntries, loadCodexList, loadCodexTree, loadMedia, loadSource,
             clearNaiCache, resetDirectProbe, directAvailable,
             normalizeMatchText, textIncludes, searchableText, parseQuery,
             pathInDirectory, filterPosts };
  `);
  return factory();
}

/* ---------------------------------------------------------------- 1. NAI → SD */

console.log('NAI 图鉴数据源 · 纯逻辑检查');
console.log('');

{
  const { naiToSd } = loadModule();
  const cases = [
    ['{tag}', '(tag:1.05)'],
    ['{{tag}}', '(tag:1.103)'],
    ['{{{tag}}}', '(tag:1.158)'],
    ['[tag]', '(tag:0.952)'],
    ['[[tag]]', '(tag:0.907)'],
    ['1.3::tag::', '(tag:1.3)'],
    ['0.8::tag', '(tag:0.8)'],
    ['{a, b}', '(a, b:1.05)'],
    ['plain tag', 'plain tag'],
    ['', ''],
  ];
  for (const [input, want] of cases) {
    const got = naiToSd(input);
    check('naiToSd(' + JSON.stringify(input) + ') → ' + JSON.stringify(want), got === want, JSON.stringify(got));
  }

  // 嵌套
  check('嵌套装换：{a [b]}',
    naiToSd('{a [b]}') === '(a (b:0.952):1.05)',
    JSON.stringify(naiToSd('{a [b]}')));

  // 未闭合：只丢括号本身，不悄悄给后面加权
  check('未闭合的左括号只丢括号', naiToSd('{tag') === 'tag', JSON.stringify(naiToSd('{tag')));

  // 反斜杠转义的逗号不该被当成权重内容边界切断
  check('转义括号原样保留', naiToSd('a \\(b\\)') === 'a \\(b\\)', JSON.stringify(naiToSd('a \\(b\\)')));
}

/* ---------------------------------------------------------------- 2. 提示词合并 */

{
  const { entryPrompt } = loadModule();

  check('只有主正向时原样转成 SD',
    entryPrompt({ tags: '{artist:foo}' }) === '(artist:foo:1.05)',
    JSON.stringify(entryPrompt({ tags: '{artist:foo}' })));

  const withChars = {
    tags: 'scenery, {outdoors}',
    characterPrompts: [
      { label: 'char1', prompt: '1girl, {red hair}' },
      { label: 'char2', prompt: '1boy, [blue eyes]' },
    ],
  };
  const merged = entryPrompt(withChars);
  const lines = merged.split('\n');
  check('主正向 + 两个角色 = 三行', lines.length === 3, String(lines.length));
  check('**角色标记被丢掉**（不能出现 char1:）', !merged.includes('char1:') && !merged.includes('char2:'), merged);
  check('三段都还在（不拆散）',
    lines[0].includes('scenery') && lines[1].includes('1girl') && lines[2].includes('1boy'),
    JSON.stringify(lines));
  check('每一段都做了 SD 权重转换',
    lines[0].includes(':1.05)') && lines[1].includes(':1.05)') && lines[2].includes(':0.952)'),
    JSON.stringify(lines));

  // 空角色跳过
  const mixed = { tags: 'a', characterPrompts: [{ label: 'x', prompt: '' }, { label: 'y', prompt: 'b' }] };
  check('空角色正文不占一行', entryPrompt(mixed).split('\n').length === 2, entryPrompt(mixed));

  // 负向绝不混进正向
  const withNeg = {
    tags: 'main',
    negativePrompts: 'bad hands, lowres',
    characterPrompts: [{ label: 'c1', prompt: 'good', negative: 'ugly' }],
  };
  const negOut = entryPrompt(withNeg);
  check('负向字段一个都不进正向', !negOut.includes('bad hands') && !negOut.includes('ugly'), negOut);
}

/* ---------------------------------------------------------------- 3. 图片地址 */

{
  const { assetUrl } = loadModule();
  const media = { baseUrl: 'https://assets.example.com', imagePrefix: 'images', originalPrefix: 'originals' };

  check('缩略图地址',
    assetUrl(media, media.imagePrefix, 'codex_a', 'codex_a_0001.jpg', 'rev1')
      === 'https://assets.example.com/images/codex_a/codex_a_0001.jpg?v=rev1',
    assetUrl(media, media.imagePrefix, 'codex_a', 'codex_a_0001.jpg', 'rev1'));

  check('原图地址走 originals 前缀',
    assetUrl(media, media.originalPrefix, 'codex_a', 'codex_a_0001.png', '')
      === 'https://assets.example.com/originals/codex_a/codex_a_0001.png',
    assetUrl(media, media.originalPrefix, 'codex_a', 'codex_a_0001.png', ''));

  check('绝对地址原样返回（带 rev）',
    assetUrl(media, 'images', 'c', 'https://cdn.example.com/x.jpg', 'v9')
      === 'https://cdn.example.com/x.jpg?v=v9');

  check('没有文件名时返回空串', assetUrl(media, 'images', 'c', '', 'v') === '');
}

/* ---------------------------------------------------------------- 4. 转成 post */

{
  const { entryToPost } = loadModule();
  const media = { baseUrl: 'https://assets.example.com', imagePrefix: 'images', originalPrefix: 'originals' };
  const entry = {
    id: 'artist_x_0001',
    title: 'demo artist',
    path: ['分类', '子分类'],
    tags: '{artist:demo}',
    image: 'artist_x_0001.jpg',
    original: 'artist_x_0001.png',
    imageWidth: 753,
    imageHeight: 1100,
    images: [
      { path: 'artist_x_0001.jpg', original: 'artist_x_0001.png' },
      { path: 'artist_x_0001-02.jpg', original: 'artist_x_0001-02.png' },
    ],
    assetCodexId: 'artist_x',
    assetRev: 'abc123',
  };
  const post = entryToPost(entry, 'artist_x', media);

  check('id 保留', post.id === 'artist_x_0001', post.id);
  check('source_site 标成 nai_atlas', post.source_site === 'nai_atlas', post.source_site);
  check('file_url 指向原图', post.file_url === 'https://assets.example.com/originals/artist_x/artist_x_0001.png?v=abc123', post.file_url);
  check('preview_file_url 指向缩略图', post.preview_file_url === 'https://assets.example.com/images/artist_x/artist_x_0001.jpg?v=abc123', post.preview_file_url);
  check('原图和缩略图不同（否则会被判成只有预览）', post.file_url !== post.preview_file_url);
  check('多图时取第一张', post._nai.imageCount === 2, String(post._nai.imageCount));
  check('尺寸带出来', post.image_width === 753 && post.image_height === 1100);
  check('**_nai_sd_prompt 已经算好且是 SD 格式**',
    post._nai_sd_prompt === '(artist:demo:1.05)',
    JSON.stringify(post._nai_sd_prompt));
  check('原始 tags 也留着（卡片展示用）', post.tag_string === '{artist:demo}', post.tag_string);
}

/* ---------------------------------------------------------------- 5. 缓存与取数 */

(async () => {
  {
    const calls = [];
    const payloads = {
      // 键必须是模块里那个固定入口（它是唯一写死的常量）
      'https://novelai.quicktagcloud.com/data-source.json': { baseUrl: 'https://data.example', pointer: 'current.json' },
      'https://data.example/current.json': { release: 'r-test' },
      'https://data.example/releases/r-test/codexes.json': [
        { id: 'codex_a', title: '词典 A', entryCount: 2, hasOriginal: true },
      ],
      'https://data.example/releases/r-test/media.json': { baseUrl: 'https://assets.example' },
      'https://data.example/releases/r-test/codex_a.json': {
        entries: [
          { id: 'e1', tags: '{a}', image: 'e1.jpg', original: 'e1.png', assetCodexId: 'codex_a', assetRev: 'r1' },
          { id: 'e2', tags: '[b]', image: 'e2.jpg', assetCodexId: 'codex_a', assetRev: 'r2' },
        ],
      },
    };
    const mod = loadModule(async (url) => {
      calls.push(url);
      if (!(url in payloads)) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => payloads[url] };
    });

    const posts = await mod.loadPosts('codex_a');
    check('词典条目被转成 post 列表', posts.length === 2, String(posts.length));
    check('没有原图的条目用缩略图顶 file_url', posts[1].file_url === posts[1].preview_file_url);

    const before = calls.length;
    await mod.loadPosts('codex_a');
    check('第二次取同一词典不再发请求（内存缓存）', calls.length === before,
      before + ' → ' + calls.length);

    const codexes = await mod.loadCodexList();
    check('词典清单结构正确', codexes.length === 1 && codexes[0].title === '词典 A', JSON.stringify(codexes));

    mod.clearNaiCache();
    await mod.loadEntries('codex_a');
    check('清除缓存后会重新取数', calls.length > before, String(calls.length));
  }

  /* ---- 6. 检索：规则照法典站那套 ---- */
  {
    const { normalizeMatchText, textIncludes, parseQuery, searchableText } = loadModule();

    check('归一化：下划线当空格', normalizeMatchText('ask_(askzy)') === 'ask (askzy)',
      normalizeMatchText('ask_(askzy)'));
    check('归一化：转小写去首尾', normalizeMatchText('  Red_Hair  ') === 'red hair',
      JSON.stringify(normalizeMatchText('  Red_Hair  ')));
    check('归一化：连续空白压成一个', normalizeMatchText('a\t\tb') === 'a b',
      JSON.stringify(normalizeMatchText('a\t\tb')));

    check('词边界：cat 不命中 category', textIncludes('category', 'cat') === false);
    check('词边界：cat 命中 cat girl', textIncludes('cat girl', 'cat') === true);
    check('词边界：中文子串照常命中', textIncludes('构图风格', '构图') === true);
    check('词边界：term 两端都不是英文时不做边界检查', textIncludes('xx@yy', '@') === true);

    check('分词：空格切开且全小写',
      JSON.stringify(parseQuery('Red  Hair')) === JSON.stringify(['red', 'hair']),
      JSON.stringify(parseQuery('Red  Hair')));
    check('空查询不产生词', parseQuery('   ').length === 0);

    const text = searchableText({ title: '静谧时刻', tags: '{artist:foo}, red_hair' });
    check('可搜文本含标题', text.includes('静谧时刻'), text);
    check('可搜文本含标签且已归一化', text.includes('red hair'), text);
    check('可搜文本含权重标记原文（去掉花括号后）', text.includes('artist:foo'), text);
  }

  /* ---- 7. 分类：前缀匹配 ---- */
  {
    const { pathInDirectory, filterPosts } = loadModule();

    check('没选分类时全通过', pathInDirectory(['a', 'b'], []) === true);
    check('分类前缀命中', pathInDirectory(['a', 'b', 'c'], ['a', 'b']) === true);
    check('分类不匹配', pathInDirectory(['a', 'x'], ['a', 'b']) === false);
    check('条目的路径比选中分类浅时不匹配', pathInDirectory(['a'], ['a', 'b']) === false);

    const posts = [
      { id: '1', _nai: { path: ['单画师', 'A'], searchText: 'red hair 标题一' } },
      { id: '2', _nai: { path: ['单画师', 'B'], searchText: 'blue eyes 标题二' } },
      { id: '3', _nai: { path: ['画风组', 'C'], searchText: 'red eyes 标题三' } },
    ];
    const byDir = filterPosts(posts, { dirPath: ['单画师'] });
    check('按分类筛选只留该分支', byDir.length === 2, String(byDir.length));

    const byQuery = filterPosts(posts, { query: 'red' });
    check('按关键词筛选', byQuery.length === 2, String(byQuery.length));

    const both = filterPosts(posts, { query: 'red', dirPath: ['单画师'] });
    check('关键词和分类同时生效', both.length === 1 && both[0].id === '1',
      JSON.stringify(both.map(p => p.id)));

    const andQuery = filterPosts(posts, { query: 'red 标题一' });
    check('多个词是 AND 不是 OR', andQuery.length === 1 && andQuery[0].id === '1',
      JSON.stringify(andQuery.map(p => p.id)));
  }

  /* ---- 8. 分类树拍平（每部词典的 tree 都不一样，按数据展开，不写死）---- */
  {
    const tree = [
      { name: '单画师词典', count: 5005, children: [
        { name: '第一组', count: 300, children: [{ name: 'A-F', count: 120 }] },
        { name: '第二组', count: 200, children: [] },
      ] },
      { name: '画风组词典', count: 658, children: [] },
    ];
    const mod = loadModule(async (url) => {
      if (url.endsWith('data-source.json')) return { ok: true, status: 200, json: async () => ({ baseUrl: 'https://d.example', pointer: 'current.json' }) };
      if (url.endsWith('current.json')) return { ok: true, status: 200, json: async () => ({ release: 'r1' }) };
      if (url.endsWith('media.json')) return { ok: true, status: 200, json: async () => ({ baseUrl: 'https://a.example' }) };
      return { ok: true, status: 200, json: async () => ({ tree, entries: [] }) };
    });

    const flat = await mod.loadCodexTree('codex_a');
    check('拍平后节点数对得上（2 顶层 + 2 子 + 1 孙）', flat.length === 5, String(flat.length));
    check('第一层 depth=0', flat[0].depth === 0, String(flat[0].depth));
    check('子层 depth 递增', flat[1].depth === 1 && flat[2].depth === 2,
      flat[1].depth + '/' + flat[2].depth);
    check('路径按层级拼出来',
      JSON.stringify(flat[2].path) === JSON.stringify(['单画师词典', '第一组', 'A-F']),
      JSON.stringify(flat[2].path));
    check('label 用 / 分隔便于显示', flat[2].label === '单画师词典 / 第一组 / A-F', flat[2].label);
    check('数量带出来', flat[0].count === 5005, String(flat[0].count));

    // 拍平出来的路径要能直接喂给分类筛选
    const { pathInDirectory } = mod;
    check('拍平路径与「单画师词典/第一组」前缀匹配',
      pathInDirectory(['单画师词典', '第一组', 'A-F', 'extra'], flat[1].path) === true);
  }

  /* ---- 9. 词典缓存有上限，不能越切越占内存 ---- */
  {
    const calls = [];
    const mod = loadModule(async (url) => {
      calls.push(url);
      const m = String(url).match(/releases\/[^/]+\/([A-Za-z0-9_-]+)\.json/);
      if (url.endsWith('data-source.json')) return { ok: true, status: 200, json: async () => ({ baseUrl: 'https://d.example', pointer: 'current.json' }) };
      if (url.endsWith('current.json')) return { ok: true, status: 200, json: async () => ({ release: 'r1' }) };
      if (url.endsWith('media.json')) return { ok: true, status: 200, json: async () => ({ baseUrl: 'https://a.example' }) };
      if (m) return { ok: true, status: 200, json: async () => ({ entries: [{ id: m[1] + '_1', tags: 'x', image: 'i.jpg', assetCodexId: m[1] }] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    });

    await mod.loadPosts('codex_a');
    await mod.loadPosts('codex_b');
    await mod.loadPosts('codex_c');
    const before = calls.length;
    // A 已经被挤出去了，应该重新取；C 是最新的，不该重新取
    await mod.loadPosts('codex_c');
    const afterC = calls.length;
    check('最近用过的词典命中缓存', afterC === before, before + ' → ' + afterC);

    await mod.loadPosts('codex_a');
    check('被挤掉的词典会重新取（缓存不是无上限的）', calls.length > afterC, String(calls.length));
  }

  /* ---- 7. 直连被挡 → 自动走后端代理 ---- */
  {
    const calls = [];
    const mod = loadModule(async (url) => {
      calls.push(url);
      // 第一次（直连）抛 TypeError，模拟浏览器对 CORS 的拒绝
      if (!url.startsWith("/danbooru_gallery/nai_atlas")) {
        throw new TypeError("Failed to fetch");
      }
      if (url.includes("kind=codexes")) {
        return { ok: true, status: 200, json: async () => ([{ id: "codex_a", title: "词典 A", entryCount: 1 }]) };
      }
      if (url.includes("kind=media")) {
        return { ok: true, status: 200, json: async () => ({ baseUrl: "https://assets.example" }) };
      }
      if (url.includes("kind=codex")) {
        return {
          ok: true, status: 200, json: async () => ({
            entries: [{ id: "e1", tags: "{a}", image: "e1.jpg", original: "e1.png", assetCodexId: "codex_a", assetRev: "r1" }],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    check('一开始认为直连可用', mod.directAvailable() === true);

    const codexes = await mod.loadCodexList();
    check('直连被挡时自动改走代理，词典清单照样拿到',
      codexes.length === 1 && codexes[0].title === '词典 A', JSON.stringify(codexes));
    check('发现直连不可用后状态翻转', mod.directAvailable() === false);

    const posts = await mod.loadPosts('codex_a');
    check('代理也能拿到词典条目', posts.length === 1, String(posts.length));
    check('代理路径下图片地址仍然拼得对',
      posts[0].preview_file_url === 'https://assets.example/images/codex_a/e1.jpg?v=r1',
      posts[0].preview_file_url);

    // 切到代理之后不该再浪费一次失败的直连往返
    const before = calls.filter((u) => !u.startsWith('/danbooru_gallery')).length;
    mod.clearNaiCache();
    await mod.loadCodexList();
    const after = calls.filter((u) => !u.startsWith('/danbooru_gallery')).length;
    check('切代理后不再尝试直连', after === before, before + ' → ' + after);
  }

  /* ---- 7. 代理自己失败时要报清楚 ---- */
  {
    const mod = loadModule(async (url) => {
      if (!url.startsWith("/danbooru_gallery/nai_atlas")) throw new TypeError("blocked");
      return { ok: false, status: 502, json: async () => ({ error: "ValueError: upstream down" }) };
    });
    let message = "";
    try { await mod.loadCodexList(); } catch (exc) { message = String(exc.message || exc); }
    check('代理 502 时报出状态码和上游原因',
      message.includes('502') && message.includes('upstream down'), message || '(没抛错)');
  }

  /* 接口报错要抛出可读信息，不能静默返回空列表 */
  {
    const mod = loadModule(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    let message = '';
    try { await mod.loadPosts('codex_a'); } catch (exc) { message = String(exc.message || exc); }
    check('接口 403 时报错而不是静默空列表',
      message.includes('403') || message.includes('图鉴'), message || '(没有抛错)');
  }

  /* CORS 没配好时 fetch 会直接 reject —— 这个错要能冒出来 */
  {
    const mod = loadModule(async () => { throw new TypeError('Failed to fetch'); });
    let threw = false;
    try { await mod.loadPosts('codex_a'); } catch { threw = true; }
    check('网络/CORS 失败时抛错（不吞）', threw);
  }

  console.log('');
  if (failures.length) {
    console.log('NAI 图鉴纯逻辑检查：' + failures.length + ' 个失败');
    for (const f of failures) console.log('  - ' + f);
    process.exitCode = 1;
  } else {
    console.log('NAI 图鉴纯逻辑检查：' + passed + ' 个全部通过');
  }
})();
