import re

# 导入提示词格式化模块
from ..utils.prompt_formatter import PromptFormatter

LORA_PATTERN = re.compile(r"<lora:[^>]+>")

# 特殊语法关键字列表 - 需要保护括号不被转义
# 只保留大写版本，因为后续比较时会统一转换为大写
SYNTAX_KEYWORDS = [
    'COUPLE', 'MASK', 'FEATHER', 'FILL', 'AND', 'BREAK',
    'IMASK', 'AREA', 'MASK_SIZE', 'MASKW',
]

# 预编译的 COUPLE MASK 转换模式
# 用于将 COUPLE MASK(...) 转换为 COUPLE(...)，提高 prompt control 解析兼容性
_COUPLE_MASK_PATTERN = re.compile(r'\bCOUPLE\s+MASK\s*\(', re.IGNORECASE)

# 特殊语法模式 - 用于精确匹配语法结构
SYNTAX_PATTERNS = [
    _COUPLE_MASK_PATTERN,                                     # COUPLE MASK(...)
    re.compile(r'\bCOUPLE\s*\(', re.IGNORECASE),              # COUPLE(...) 简写语法
    re.compile(r'\bMASK\s*\(', re.IGNORECASE),                # MASK(...)
    re.compile(r'\bFEATHER\s*\(', re.IGNORECASE),             # FEATHER(...)
    re.compile(r'\bFILL\s*\(', re.IGNORECASE),                # FILL(...)
    re.compile(r'\bIMASK\s*\(', re.IGNORECASE),               # IMASK(...) 自定义遮罩引用
    re.compile(r'\bAREA\s*\(', re.IGNORECASE),                # AREA(...) 区域指定
    re.compile(r'\bMASK_SIZE\s*\(', re.IGNORECASE),           # MASK_SIZE(...) 遮罩大小
    re.compile(r'\bMASKW\s*\(', re.IGNORECASE),               # MASKW(...) 组合遮罩权重
]

# 分区语法函数列表 - 用于括号修复
REGION_SYNTAX_FUNCTIONS = ['COUPLE', 'MASK', 'FEATHER', 'FILL', 'IMASK', 'AREA', 'MASK_SIZE', 'MASKW']

# 预编译的分区语法检测模式
_FILL_PATTERN = re.compile(r'\bFILL\s*\(\s*\)', re.IGNORECASE)
_AND_SEPARATOR_PATTERN = re.compile(r'\s+AND\s+', re.IGNORECASE)
_MASK_OR_AREA_PATTERN = re.compile(r'\b(MASK|AREA|IMASK)\s*\(', re.IGNORECASE)

# 预编译的关键字边界模式（用于参数结束检测）
# 包含 REGION_SYNTAX_FUNCTIONS 以及额外的 AND、BREAK 关键字
_KEYWORD_BOUNDARY_PATTERNS = {
    kw: re.compile(rf'\s+{kw}\b', re.IGNORECASE)
    for kw in REGION_SYNTAX_FUNCTIONS + ['AND', 'BREAK']
}

# 预编译的逗号后跟字母模式
_COMMA_LETTER_PATTERN = re.compile(r',\s*([a-zA-Z_])')

# 预编译的分区函数匹配模式（用于括号修复）
_REGION_FUNC_PATTERNS = {
    func: re.compile(rf'\b{func}\s*\(', re.IGNORECASE)
    for func in REGION_SYNTAX_FUNCTIONS
}

class PromptCleaningMaid:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "string": ("STRING", {"forceInput": True}),
                "清理逗号 (cleanup_commas)": ("BOOLEAN", {"default": True, "tooltip": "清理多余的逗号（如果两个逗号之间没有标签）"}),
                "清理空白 (cleanup_whitespace)": ("BOOLEAN", {"default": True, "tooltip": "清理首尾空白和多余的空白字符"}),
                "移除LoRA标签 (remove_lora_tags)": ("BOOLEAN", {"default": False, "tooltip": "完全移除字符串中的 LoRA 标签"}),
                "清理换行 (cleanup_newlines)": (["否 (false)", "空格 (space)", "逗号 (comma)"], {"default": "否 (false)", "tooltip": "将换行符 (\\n) 替换为空格或逗号"}),
                "修复括号 (fix_brackets)": (["否 (false)", "圆括号 (parenthesis)", "方括号 (brackets)", "两者 (both)"], {"default": "两者 (both)", "tooltip": "移除不匹配的括号"}),
                "提示词格式化 (prompt_formatting)": ("BOOLEAN", {"default": True, "tooltip": "启用完整的提示词格式化：下划线转空格、权重语法补全、智能括号转义、漏逗号检测等"}),
                "下划线转空格 (underscore_to_space)": ("BOOLEAN", {"default": True, "tooltip": "将下划线转换为空格"}),
                "权重语法补全 (complete_weight_syntax)": ("BOOLEAN", {"default": True, "tooltip": "为不合规的权重语法添加括号，如 tag:1.2 → (tag:1.2)"}),
                "智能括号转义 (smart_bracket_escaping)": ("BOOLEAN", {"default": True, "tooltip": "智能转义括号，区分权重语法和角色系列名称，并检测漏逗号情况"}),
                "标准化逗号 (standardize_commas)": ("BOOLEAN", {"default": True, "tooltip": "将逗号标准化为英文逗号+空格格式"}),
                "修复分区语法 (fix_region_syntax)": ("BOOLEAN", {"default": True, "tooltip": "自动修复分区语法中的括号不匹配问题（如 MASK、COUPLE、FEATHER 等），防止解析器进入无限循环"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("string",)
    FUNCTION = "process"
    CATEGORY = "M8/Gallery"

    @staticmethod
    def _remove_unmatched(s: str, open_ch: str, close_ch: str) -> str:
        """Removes unmatched brackets of one type while preserving valid pairs."""
        stack = []
        remove_idx = set()

        for i, ch in enumerate(s):
            if ch == open_ch:
                stack.append(i)
            elif ch == close_ch:
                if stack:
                    stack.pop()  # matched → keep both
                else:
                    remove_idx.add(i)  # unmatched close → remove later

        # any opens still in stack are unmatched → remove them
        remove_idx.update(stack)

        # build cleaned string
        return "".join(ch for i, ch in enumerate(s) if i not in remove_idx)

    @staticmethod
    def process(string, **kwargs):
        # 健壮性检查：处理 None 或空输入
        if string is None:
            return ("",)
        if not isinstance(string, str):
            string = str(string)

        # 获取原有功能参数
        cleanup_commas = kwargs.get("清理逗号 (cleanup_commas)", True)
        cleanup_whitespace = kwargs.get("清理空白 (cleanup_whitespace)", True)
        remove_lora_tags = kwargs.get("移除LoRA标签 (remove_lora_tags)", False)
        cleanup_newlines = kwargs.get("清理换行 (cleanup_newlines)", "否 (false)")
        fix_brackets = kwargs.get("修复括号 (fix_brackets)", "两者 (both)")

        # 获取新的格式化参数
        prompt_formatting = kwargs.get("提示词格式化 (prompt_formatting)", True)
        underscore_to_space = kwargs.get("下划线转空格 (underscore_to_space)", True)
        complete_weight_syntax = kwargs.get("权重语法补全 (complete_weight_syntax)", True)
        smart_bracket_escaping = kwargs.get("智能括号转义 (smart_bracket_escaping)", True)
        standardize_commas = kwargs.get("标准化逗号 (standardize_commas)", True)
        fix_region_syntax = kwargs.get("修复分区语法 (fix_region_syntax)", True)

        # 将中英双语选项值映射回英文值
        cleanup_newlines_map = {
            "否 (false)": "false",
            "空格 (space)": "space",
            "逗号 (comma)": "comma"
        }
        fix_brackets_map = {
            "否 (false)": "false",
            "圆括号 (parenthesis)": "(parenthesis)",
            "方括号 (brackets)": "[brackets]",
            "两者 (both)": "([both])"
        }

        cleanup_newlines = cleanup_newlines_map.get(cleanup_newlines, cleanup_newlines)
        fix_brackets = fix_brackets_map.get(fix_brackets, fix_brackets)

        # Stage 1: Remove LoRA tags (原有功能)
        if remove_lora_tags:
            string = re.sub(LORA_PATTERN, "", string)

        # 预先检测是否包含多区域语法（避免重复检测）
        has_multi_region_syntax = PromptCleaningMaid._contains_multi_region_syntax(string)

        # Stage 1.5: 修复分区语法中的括号问题（防止下游解析器无限循环）
        if fix_region_syntax and has_multi_region_syntax:
            string = PromptCleaningMaid._fix_region_syntax(string)

        # Stage 2: Replace newlines with space (原有功能)
        # 但如果包含多区域语法，只允许替换为空格，不允许替换为逗号（避免破坏语法结构）
        if cleanup_newlines != "false":
            if has_multi_region_syntax:
                # 多区域语法：只允许替换为空格，不允许替换为逗号
                if cleanup_newlines in ["space", "comma"]:
                    string = string.replace("\n", " ")
            else:
                # 普通提示词：按用户选择处理
                if cleanup_newlines == "space":
                    string = string.replace("\n", " ")
                elif cleanup_newlines == "comma":
                    string = string.replace("\n", ", ")

        # Stage 3: 高级提示词格式化 (本小姐的完美格式化逻辑!)
        if prompt_formatting:
            # 应用完整的PromptFormatter格式化
            # 由于原版PromptFormatter是固定的格式化流程，我们需要根据用户选择的选项来定制
            string = PromptCleaningMaid._apply_custom_formatting(
                string,
                underscore_to_space,
                complete_weight_syntax,
                smart_bracket_escaping,
                standardize_commas
            )

        # Stage 4: Remove empty comma sections (原有功能，但在高级格式化后可能不需要)
        if cleanup_commas and not prompt_formatting:
            # 只有在未启用高级格式化时才执行原有的逗号清理
            # Iteratively remove leading commas
            while re.match(r"^[ \t]*,[ \t]*", string):
                string = re.sub(r"^[ \t]*,[ \t]*", "", string)

            # Iteratively remove trailing commas
            while re.search(r"[ \t]*,[ \t]*$", string):
                string = re.sub(r"[ \t]*,[ \t]*$", "", string)

            # Remove empty comma sections inside the string
            while re.search(r",[ \t]*,", string):
                string = re.sub(r",[ \t]*,", ",", string)

        # Stage 5: Fix stray brackets (原有功能，但在高级格式化后可能不需要)
        if fix_brackets != "false" and not prompt_formatting:
            # 只有在未启用高级格式化时才执行原有的括号修复
            if fix_brackets in ("(parenthesis)", "([both])"):
                string = PromptCleaningMaid._remove_unmatched(string, "(", ")")
            if fix_brackets in ("[brackets]", "([both])"):
                string = PromptCleaningMaid._remove_unmatched(string, "[", "]")

        # Stage 6: Whitespace cleanup (原有功能)
        if cleanup_whitespace:
            string = string.strip(" \t")
            string = re.sub(r"[ \t]{2,}", " ", string)              # collapse spaces/tabs
            string = re.sub(r"[ \t]*,[ \t]*", ", ", string)         # normalize comma spacing

        return (string,)

    @staticmethod
    def _apply_custom_formatting(prompt: str, underscore_to_space: bool, complete_weight_syntax: bool,
                                smart_bracket_escaping: bool, standardize_commas: bool) -> str:
        """
        应用定制的格式化逻辑 - 本小姐的完美格式化！
        """
        if not prompt or not prompt.strip():
            return prompt

        # 🔧 检测多区域语法，如果包含则跳过可能破坏结构的处理
        if PromptCleaningMaid._contains_multi_region_syntax(prompt):
            # 只做安全的处理：下划线转空格（但跳过 MASK_SIZE 等关键字）
            if underscore_to_space:
                # 保护特殊关键字中的下划线
                protected_keywords = ['MASK_SIZE', 'mask_size']
                result = prompt
                for keyword in protected_keywords:
                    placeholder = f"__PROTECTED_{keyword}__"
                    result = result.replace(keyword, placeholder)
                result = result.replace('_', ' ')
                for keyword in protected_keywords:
                    placeholder = f"__PROTECTED_{keyword}__"
                    # 还原时注意：placeholder 中的下划线也被替换了
                    result = result.replace(placeholder.replace('_', ' '), keyword)
                return result
            return prompt

        # 阶段1：智能逗号分割成独立标签（兼容中英文逗号，考虑括号嵌套）
        raw_tags = PromptFormatter._smart_comma_split(prompt)

        tags = []
        for tag in raw_tags:
            tag = tag.strip()
            if not tag:
                continue

            # 阶段2：根据用户选择对每个标签单独处理
            processed_tag = PromptCleaningMaid._process_single_tag_custom(
                tag, underscore_to_space, complete_weight_syntax, smart_bracket_escaping
            )
            tags.append(processed_tag)

        # 阶段3：根据用户选择重新连接
        if standardize_commas:
            # 标准化：英文逗号+空格
            return ', '.join(tags)
        else:
            # 保持原有逗号格式（使用原始连接方式）
            return ','.join(tags)

    @staticmethod
    def _contains_special_syntax(tag: str) -> bool:
        """
        检测标签是否包含特殊语法（如 COUPLE MASK、FEATHER 等）
        如果包含特殊语法，则不应该对其括号进行转义
        """
        # 方法1: 检查是否匹配特殊语法模式
        for pattern in SYNTAX_PATTERNS:
            if pattern.search(tag):
                return True

        # 方法2: 检查是否包含语法关键字（SYNTAX_KEYWORDS 已全为大写）
        tag_upper = tag.upper()
        for keyword in SYNTAX_KEYWORDS:
            if keyword in tag_upper:
                return True

        return False

    @staticmethod
    def _contains_multi_region_syntax(prompt: str) -> bool:
        """
        检测提示词是否包含多区域语法（Attention Couple 或 Regional Prompts）
        如果包含，应该跳过可能破坏结构的处理（如逗号分割重组）

        检测范围包括：
        - 完整的 COUPLE MASK 语法
        - 独立的 MASK(、FILL(、FEATHER( 等分区函数
        - Regional Prompts 的 AND + MASK 语法
        """
        # 快速检查：使用大写字符串进行简单匹配
        prompt_upper = prompt.upper()

        # 检查 Attention Couple 语法
        # COUPLE 关键字 + MASK/IMASK 或 FILL
        if 'COUPLE' in prompt_upper:
            return True

        # 检查任何分区语法函数调用（包括不完整的）
        # 这样可以检测到 MASK(0.5 1girl 这类错误语法
        for func in REGION_SYNTAX_FUNCTIONS:
            pattern = _REGION_FUNC_PATTERNS.get(func)
            if pattern and pattern.search(prompt):
                return True

        # 检查 Regional Prompts 语法
        # 使用 AND 分隔符 + MASK/AREA - 使用预编译正则
        if _AND_SEPARATOR_PATTERN.search(prompt) and _MASK_OR_AREA_PATTERN.search(prompt):
            return True

        return False

    @staticmethod
    def _process_single_tag_custom(tag: str, underscore_to_space: bool, complete_weight_syntax: bool,
                                 smart_bracket_escaping: bool) -> str:
        """处理单个标签 - 定制版格式化逻辑"""

        # 步骤1: 下划线转空格（如果启用）
        # 但要保护特殊语法关键字中的下划线
        if underscore_to_space:
            # 检查是否包含需要保护的关键字
            if not PromptCleaningMaid._contains_special_syntax(tag):
                tag = tag.replace('_', ' ')
            else:
                # 包含特殊语法时，只处理非关键字部分
                # 保护 MASK_SIZE 等关键字
                protected_keywords = ['MASK_SIZE', 'mask_size']
                for keyword in protected_keywords:
                    if keyword in tag:
                        placeholder = f"__PROTECTED_{keyword.replace('_', '')}__"
                        tag = tag.replace(keyword, placeholder)
                tag = tag.replace('_', ' ')
                for keyword in protected_keywords:
                    placeholder = f"__PROTECTED_{keyword.replace('_', '')}__"
                    # 还原时注意：placeholder 中的下划线也被替换了
                    tag = tag.replace(placeholder.replace('_', ' '), keyword)

        # 步骤2: 权重语法检测和补全（如果启用）
        # 跳过包含特殊语法的标签
        if complete_weight_syntax and not PromptCleaningMaid._contains_special_syntax(tag):
            tag = PromptCleaningMaid._normalize_weight_syntax_custom(tag)

        # 步骤3: 智能括号转义（如果启用）
        # 但是！如果标签包含特殊语法（如 COUPLE MASK），则跳过括号转义
        if smart_bracket_escaping and not PromptCleaningMaid._contains_special_syntax(tag):
            tag = PromptCleaningMaid._escape_brackets_in_tag_custom(tag)

        return tag

    @staticmethod
    def _normalize_weight_syntax_custom(tag: str) -> str:
        """标准化权重语法 - 为不合规的权重语法添加括号"""
        # 使用PromptFormatter的正则表达式
        match = PromptFormatter.WEIGHT_PATTERN.match(tag.strip())
        if match:
            content = match.group(1).strip()
            weight = match.group(2)

            # 如果不是已经用括号包围的权重语法，则添加括号
            if weight == ':':
                return f'({content}:)'
            else:
                return f'({content}:{weight})'

        return tag

    @staticmethod
    def _escape_brackets_in_tag_custom(tag: str) -> str:
        """在标签中智能转义括号 - 定制版"""
        result = []
        i = 0

        while i < len(tag):
            if tag[i] == '(':
                # 查找对应的右括号
                bracket_depth = 1
                j = i + 1
                content_start = i + 1

                while j < len(tag) and bracket_depth > 0:
                    if tag[j] == '(':
                        bracket_depth += 1
                    elif tag[j] == ')':
                        bracket_depth -= 1
                    elif tag[j] == '\\':
                        j += 1  # 跳过已转义字符
                    j += 1

                if bracket_depth == 0:  # 找到匹配的右括号
                    bracket_content = tag[content_start:j-1]

                    # 检查括号前面的字符
                    has_word_before = False
                    if i > 0:
                        # 检查前面是否有非空白字符
                        for k in range(i-1, -1, -1):
                            if tag[k] not in [' ', '\t', '\n']:
                                has_word_before = True
                                break

                    # 情况1: 前面有单词
                    if has_word_before:
                        # 检查括号内容是否包含权重语法或多标签语法
                        # 如果包含，说明这是漏逗号的情况，需要分成两个标签
                        if ':' in bracket_content or ',' in bracket_content:
                            # 漏逗号：添加逗号分隔
                            result.append(', ')
                            result.append(f'({bracket_content})')
                        else:
                            # 正常的tag(content)格式：需要转义（系列名称等）
                            # 统一处理空格插入：所有括号前都检查是否需要空格
                            if tag[i-1] not in [' ', '\t', '\n']:
                                result.append(' ')
                            result.append(f'\\({bracket_content}\\)')
                        i = j

                    # 情况2: 前面没有单词（整个标签就是括号）
                    else:
                        if ':' in bracket_content:
                            # 权重语法：(content) - 保持括号，包括多标签权重语法
                            result.append(f'({bracket_content})')
                            i = j
                        else:
                            # 普通内容：移除括号，只保留内容
                            result.append(bracket_content)
                            i = j
                else:
                    # 不匹配的左括号，保持原样
                    result.append(tag[i])
                    i += 1
            else:
                result.append(tag[i])
                i += 1

        return ''.join(result)

    # ========== 分区语法自动纠错功能 ==========

    @staticmethod
    def _fix_region_syntax(prompt: str) -> str:
        """
        修复分区语法中的括号不匹配问题
        防止 comfyui-prompt-control 进入无限循环

        处理的语法函数：COUPLE, MASK, FEATHER, FILL, IMASK, AREA, MASK_SIZE, MASKW
        """
        if not prompt:
            return prompt

        # 首先将 COUPLE MASK(...) 转换为 COUPLE(...)
        # 这是 prompt control 官方推荐的简写形式，解析更可靠
        result = PromptCleaningMaid._convert_couple_mask_syntax(prompt)

        # 使用预定义的语法函数列表
        for func in REGION_SYNTAX_FUNCTIONS:
            result = PromptCleaningMaid._fix_function_brackets(result, func)

        # 清理多余的右括号
        result = PromptCleaningMaid._clean_extra_parens(result)

        return result

    @staticmethod
    def _convert_couple_mask_syntax(text: str) -> str:
        """
        将 COUPLE MASK(...) 转换为 COUPLE(...)

        COUPLE(maskparams) 是 COUPLE MASK(maskparams) 的官方简写形式
        使用简写形式可以避免 prompt control 在多个 COUPLE 区块时的解析问题
        """
        if not text:
            return text

        # 直接使用 re.sub 进行替换，更简洁高效
        # 将 "COUPLE MASK(" 替换为 "COUPLE("
        return _COUPLE_MASK_PATTERN.sub('COUPLE(', text)

    @staticmethod
    def _fix_function_brackets(text: str, func_name: str) -> str:
        """
        修复特定函数调用的括号匹配问题

        Args:
            text: 输入文本
            func_name: 函数名称（如 'MASK', 'COUPLE' 等）

        Returns:
            修复后的文本，确保所有函数调用的括号都匹配

        处理策略：
        1. 找到所有 FUNC( 的位置
        2. 检查每个位置的括号是否匹配
        3. 如果不匹配，尝试推测参数边界并修复
        """
        # 使用预编译的模式，如果不存在则动态创建
        pattern = _REGION_FUNC_PATTERNS.get(func_name.upper())
        if pattern is None:
            pattern = re.compile(rf'\b{func_name}\s*\(', re.IGNORECASE)

        result = []
        last_end = 0

        for match in pattern.finditer(text):
            start = match.start()
            paren_start = match.end() - 1  # '(' 的位置

            # 添加匹配之前的内容
            result.append(text[last_end:start])

            # 尝试找到匹配的右括号
            closing_pos = PromptCleaningMaid._find_matching_paren(text, paren_start)

            if closing_pos == -1:
                # 没有找到匹配的右括号，需要修复
                func_call = text[start:match.end()]
                remaining = text[match.end():]

                # 使用智能参数边界推测
                repair_pos = PromptCleaningMaid._find_param_end(remaining, func_name)

                if repair_pos > 0:
                    # 可以修复：在参数结束处添加右括号
                    params = remaining[:repair_pos].rstrip()  # 去除尾部空白
                    result.append(func_call + params + ')')
                    last_end = match.end() + repair_pos
                elif repair_pos == 0:
                    # 空参数，直接添加右括号（如 FILL()）
                    result.append(func_call + ')')
                    last_end = match.end()
                else:
                    # 无法推测，保留原始内容但添加空括号闭合
                    # 这至少可以防止无限循环
                    result.append(func_call + ')')
                    last_end = match.end()
            else:
                # 括号匹配正常
                result.append(text[start:closing_pos + 1])
                last_end = closing_pos + 1

        # 添加剩余内容
        result.append(text[last_end:])

        return ''.join(result)

    @staticmethod
    def _find_matching_paren(text: str, open_pos: int) -> int:
        """
        从指定位置开始查找匹配的右括号

        Args:
            text: 要搜索的文本
            open_pos: 左括号 '(' 的位置索引

        Returns:
            匹配的右括号位置，如果找不到返回 -1
        """
        if open_pos >= len(text) or text[open_pos] != '(':
            return -1

        stack = 1
        for i in range(open_pos + 1, len(text)):
            if text[i] == '(':
                stack += 1
            elif text[i] == ')':
                stack -= 1
                if stack == 0:
                    return i

        return -1

    @staticmethod
    def _find_param_end(text: str, func_name: str = 'MASK') -> int:
        """
        智能查找参数的自然结束位置

        Args:
            text: 函数调用括号后的剩余文本
            func_name: 函数名称，用于判断参数格式

        Returns:
            参数结束位置的索引，0 表示空参数，-1 表示无法确定

        通过分析参数内容格式来推测边界：
        1. MASK/COUPLE/AREA 参数格式：数字 数字, 数字 数字, 权重
        2. FEATHER 参数格式：数字 数字 数字 数字（空格分隔）
        3. FILL 无参数
        """
        if not text:
            return 0

        # 特殊处理 FILL - 通常无参数
        if func_name.upper() == 'FILL':
            # 如果开头就是右括号或空白后跟右括号，返回0
            stripped = text.lstrip()
            if stripped.startswith(')'):
                return 0
            # 否则查找第一个右括号
            paren_pos = text.find(')')
            if paren_pos != -1:
                return paren_pos
            return 0

        # 方法0：优先基于数字参数格式推测（最精确的方法）
        # 分区语法的参数都是数字，遇到非数字字符（空白和逗号除外）就是参数结束
        param_end = PromptCleaningMaid._find_numeric_params_end(text, func_name)
        if param_end > 0:
            return param_end

        # 方法1：基于关键字边界 - 使用预编译的正则模式
        min_pos = len(text)

        for kw, kw_pattern in _KEYWORD_BOUNDARY_PATTERNS.items():
            kw_match = kw_pattern.search(text)
            if kw_match and kw_match.start() < min_pos:
                min_pos = kw_match.start()

        # 如果找到关键字边界，返回
        if min_pos < len(text):
            return min_pos

        # 方法2：基于换行符
        newline_pos = text.find('\n')
        if newline_pos != -1:
            return newline_pos

        # 方法3：基于逗号后跟非数字（标签边界）- 使用预编译正则
        # 检测类似 "0.5, 1girl" 的情况
        comma_match = _COMMA_LETTER_PATTERN.search(text)
        if comma_match:
            return comma_match.start()

        return -1

    @staticmethod
    def _find_numeric_params_end(text: str, func_name: str) -> int:
        """
        分析参数内容，找到数字参数序列的结束位置

        参数格式：
        - MASK: "x1 x2, y1 y2, weight" 或简写 "x1 x2"
        - FEATHER: "left top right bottom" 或简写 "value"

        返回值：
        - 参数结束的位置（包含最后一个数字/逗号之后的空白）
        - 遇到右括号时返回右括号位置
        - 无法找到时返回 -1

        特殊处理：
        - 区分纯数字参数（如 0.5）和数字开头的标签（如 1girl）
        - 支持负数参数（如 -0.5）
        """
        # 扫描文本，找到数字序列的结束点
        i = 0
        last_number_end = 0  # 最后一个数字结束的位置
        in_number = False
        found_any_number = False

        while i < len(text):
            char = text[i]

            if char.isdigit() or char == '.':
                # 正在读取数字，但需要检查是否是标签（如 1girl）
                if not in_number:
                    # 检查这个数字后面是否紧跟字母（说明是标签而非参数）
                    # 向前看，找到这个"数字"的结束位置
                    j = i
                    while j < len(text) and (text[j].isdigit() or text[j] == '.'):
                        j += 1
                    # 检查数字后面是否紧跟字母（不包括空白）
                    if j < len(text) and text[j].isalpha():
                        # 这是一个标签（如 1girl），不是参数
                        if found_any_number:
                            return last_number_end
                        break
                    in_number = True
                    found_any_number = True
                i += 1
                last_number_end = i
            elif char == '-':
                # 负号处理：检查是否是负数的开始
                # 负号后面必须紧跟数字或小数点才算是负数
                if i + 1 < len(text) and (text[i + 1].isdigit() or text[i + 1] == '.'):
                    # 这是一个负数的开始
                    in_number = True
                    found_any_number = True
                    i += 1
                    # 继续读取数字部分
                    while i < len(text) and (text[i].isdigit() or text[i] == '.'):
                        i += 1
                    last_number_end = i
                    in_number = False
                else:
                    # 不是负数，参数结束
                    if found_any_number:
                        return last_number_end
                    break
            elif char in ' \t':
                # 空白字符，可能是参数分隔
                in_number = False
                i += 1
            elif char == ',':
                # 逗号分隔，检查后面是否还有数字
                in_number = False
                i += 1
                # 跳过逗号后的空白
                while i < len(text) and text[i] in ' \t':
                    i += 1
                # 检查后面是否是数字（包括负数）
                if i < len(text) and (text[i].isdigit() or text[i] == '.' or text[i] == '-'):
                    # 如果是负号，需要额外验证后面是数字
                    if text[i] == '-':
                        if i + 1 < len(text) and (text[i + 1].isdigit() or text[i + 1] == '.'):
                            continue  # 是负数，继续解析
                        else:
                            return last_number_end  # 不是负数，参数结束
                    else:
                        # 继续解析下一个数字
                        continue
                else:
                    # 逗号后不是数字，说明参数在逗号之前结束
                    return last_number_end
            elif char == ')':
                # 遇到右括号，参数结束（正常情况）
                return i
            else:
                # 遇到非数字/空白/逗号字符，参数结束
                if found_any_number:
                    return last_number_end
                break

        return last_number_end if last_number_end > 0 else -1

    @staticmethod
    def _clean_extra_parens(text: str) -> str:
        """
        清理多余的右括号
        处理类似 MASK(0 0.5)) 的情况

        Args:
            text: 输入文本

        Returns:
            清理后的文本，移除多余的右括号

        注意：这个函数只处理分区语法相关的多余括号
        不会影响权重语法如 (tag:1.2)
        """
        # 找到所有分区语法函数调用的位置 - 使用预编译模式
        func_positions = []

        for func in REGION_SYNTAX_FUNCTIONS:
            pattern = _REGION_FUNC_PATTERNS.get(func)
            if pattern is None:
                continue
            for match in pattern.finditer(text):
                # 找到匹配的右括号
                paren_start = match.end() - 1
                closing_pos = PromptCleaningMaid._find_matching_paren(text, paren_start)
                if closing_pos != -1:
                    func_positions.append((paren_start, closing_pos))

        # 如果没有找到任何分区语法，直接返回
        if not func_positions:
            return text

        # 按位置排序
        func_positions.sort()

        # 检查每个函数调用后是否有多余的右括号
        result = list(text)
        chars_to_remove = set()

        for paren_start, closing_pos in func_positions:
            # 检查 closing_pos 后面是否紧跟着多余的右括号
            i = closing_pos + 1
            while i < len(text) and text[i] in ' \t':
                i += 1
            # 如果后面紧跟右括号，并且这个右括号没有对应的左括号，标记删除
            while i < len(text) and text[i] == ')':
                # 检查这个右括号是否有对应的左括号
                # 简单方法：检查从开头到这个位置的括号平衡
                left_count = text[:i].count('(')
                right_count = text[:i+1].count(')')
                if right_count > left_count:
                    chars_to_remove.add(i)
                i += 1

        # 构建结果
        return ''.join(char for idx, char in enumerate(result) if idx not in chars_to_remove)
