# 🛠️ Danbooru Gallery 工具集

本目录包含用于调试和测试的实用工具脚本。

## 📋 工具列表

### `debug_metadata.py`

**功能：** PNG 元数据深度对比工具

**用途：**
- 读取并显示 PNG 图片的所有元数据字段
- 对比两张图片的元数据差异
- 可视化不可见字符（换行、空格等）
- 检查关键字段的存在性
- 字节级别的差异分析

**使用方法：**

**单文件模式（查看单张图片元数据）：**
```bash
cd <ComfyUI>\custom_nodes\ComfyUI-M8nodes\m8\nodes\gallery\tools
python debug_metadata.py "路径\到\图片.png"
```

**对比模式（对比两张图片）：**
```bash
python debug_metadata.py "图片1.png" "图片2.png"
```

**示例：**
```bash
# 查看 SaveImagePlus 生成的图片元数据
python debug_metadata.py "<ComfyUI>\output\test_00001_.png"

# 对比 SaveImagePlus 和 LoRA Manager 生成的图片
python debug_metadata.py ^
  "<ComfyUI>\output\saveimageplus_00001_.png" ^
  "<ComfyUI>\output\loramanager_00001_.png"
```

**输出内容：**
- ✅ 所有 PNG 文本块（parameters, workflow 等）
- ✅ 逐行对比差异
- ✅ 关键字段存在性检查（Negative prompt, Steps, Sampler, CFG, Seed, Size, Model, LoRA hashes）
- ✅ 不可见字符可视化
- ✅ 字节级差异定位

---

## 🔧 开发说明

如需添加新的工具脚本，请：
1. 将脚本放置在 `tools/` 目录下
2. 在本 README 中添加工具说明
3. 提供清晰的使用示例

---

## 📝 维护日志

- **2025-11-05**: 创建 tools 目录，移动 debug_metadata.py
- **2025-11-05**: 删除过时的调试脚本（analyze_hash.py, check_full_metadata.py, test_png_metadata.py）
