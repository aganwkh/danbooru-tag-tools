# Danbooru Tag Generator

根据用户中文描述，通过 MCP 获取真实 Danbooru tag，组装 AI 绘画 prompt。

## 定位

本 Skill 是 **MCP 调度器 + tag 筛选器 + prompt 结构组装器**。

核心原则：**禁止 Claude 脑补 tag。**

最终 prompt 中的每一个 tag，都必须来自 `Confirmed Tag Pool`。`Confirmed Tag Pool` 的合法来源只有：

1. MCP `search_tags` 返回的 tag
2. MCP `get_related_tags` 返回的 tag
3. MCP `get_tag_info` 验证存在的 tag
4. 用户明确输入的英文 Danbooru tag（如 `1girl`, `kimono`）
5. hard auto_rule 输出的 tag（输出 tag 也必须被 MCP 验证过）

除此之外，任何 tag 禁止进入最终 prompt。

---

## 最高原则

**所有 tag 来自 MCP，不脑补。围绕用户给的主题，从 confirmed_tag_pool 中全面补全。严格遵守本 Skill 中的每一条规则，不跳过、不简化、不自行判断。**

**必须先构思一张完整的画面，再查MCP验证tag。** 禁止直接从用户描述中提取tag，必须先构思场景、人物、动作、表情、道具、光线、氛围等所有要素。

---

## FINALIZATION_GATE

最终输出前必须执行。任何 gate 失败，必须修复后才能输出。

### Gate 1: 来源验证

每个 tag 必须在 confirmed_tag_pool 中。不在 pool 中的 tag 直接删除。

### Gate 2: 冲突检查

删除冲突 tag：long_hair + short_hair、day + night、sunlight + moonlight 等（除非用户要求混搭）。

### Gate 3: 维度覆盖

逐层检查每段 prompt：
- 画面中有人吗？→ character
- 长什么样？→ appearance
- 什么表情？→ expression
- 穿什么？→ outfit
- 在做什么？→ pose
- 在哪？→ scene
- 什么光线？→ lighting
- 构思中的每个要素都有对应tag吗？→ 完整性

哪层答不上来就说明缺失，必须补充。

### Gate 4: Prompt 差异

每段 prompt 之间必须有明显差异。如果无法保证差异，减少段数而不是编 tag。

### Gate 5: 输出格式

```markdown
### Prompt N — 中文简介

`tag1, tag2, tag3, ...`
```

<!-- English detail 暂时关闭
English detail 直接跟在 tag 后面，1-2 句英文，只补光影/氛围，不重复 tag 已覆盖的内容。
-->

不输出中文重点、解释说明、补全对照表、Confirmed Tag Pool 汇总。

---

## 禁止行为

- **直接从用户描述中提取tag，不先构思画面**
- 根据中文含义自己翻译 tag
- 根据英文自然语言自己拼 tag
- 根据经验写"看起来像 Danbooru"的 tag
- 为达到 tag 数量补充未验证 tag
- 把抽象氛围词伪装成 tag
- **只写单个tag，不构思完整画面**（如只写"站立、呼吸"，不写具体场景和动作）

如果用户表达抽象感觉（温柔、和平、电影感、精致），优先用 MCP 查真实 tag；无对应 tag 时写进 English detail，不写进 tag 区。

---

## MCP 工具

- `mcp__danbooru__search_tags`：搜索标签（英文搜索，调用时 limit 设为 100）— 每次返回 1 个精确匹配 tag，只用于确认不确定的词
- `mcp__danbooru__get_related_tags`：获取关联标签（带 overlap 分数，调用时 limit 设为 100）— 每次返回 30+ 个共现 tag，**主要扩展手段**
- `mcp__danbooru__get_tag_info`：获取标签详情（类别、计数）
- `mcp__danbooru__search_posts`：搜索图片（默认不用，除非用户要求参考图）

调用规则：
- **优先用 `get_related_tags` 批量扩展**，不要逐个 `search_tags` 验证
- `search_tags` 只用于：确认用户输入的不确定关键词、补充 `get_related_tags` 未覆盖的维度
- 不允许中文搜索、不允许探索式调用、不允许重复查询已确认 tag
- **必须覆盖所有基本维度**：outfit、scene、lighting、pose 不能遗漏

---

## 生成流程

### Step 0: 构思画面（必须先于所有步骤）

**在查MCP之前，必须先构思一张完整的画面。** 这是最重要的步骤，决定了最终prompt的质量。

构思必须包含以下要素，缺一不可：

#### 场景要素
- 在哪？（室内/室外/具体地点：公园、海边、咖啡厅、图书馆、天台等）
- 什么时候？（白天/夜晚/季节：春日午后、夏夜、冬日傍晚等）
- 环境细节？（周围有什么物体、植物、建筑：长椅、树木、书架、窗户等）

#### 人物要素
- 有谁？（一个人/多人）
- 在干嘛？（具体动作，不是抽象概念：坐在长椅上、站在海边、躺在草地上）
- 什么姿势？（站/坐/躺/走/跑/弯腰/回头）
- 表情如何？（开心/害羞/专注/放松/惊讶/悲伤）

#### 道具要素
- 手里拿着什么？（杯子/书/手机/乐器/食物/花）
- 身上穿着什么？（LoRA处理，但可以补充配饰：围巾、手套、耳机、发饰）
- 周围有什么？（家具/食物/植物/装饰品）

#### 光线要素
- 什么光线？（阳光/月光/灯光/逆光/侧光）
- 光线从哪来？（从左/从右/从上/从背后/从窗户）
- 光线效果？（柔和/强烈/温暖/冷调/光束/光晕）

#### 氛围要素
- 什么氛围？（温馨/孤独/浪漫/热闹/宁静/神秘）
- 有什么特效？（花瓣飘落/雪花/雨滴/光晕/烟雾/蒸汽）

### 构思示例

**用户说："爱音在雪天公园"**

**完整构思：**
爱音一个人坐在公园长椅上，双手捧着热咖啡，呼出白气。她微笑着看向观众，脸颊因为寒冷而泛红。围巾还没摘，手套放在旁边。冬日午后的阳光透过树枝洒下来，雪花轻轻飘落，热饮冒着蒸汽。周围是积雪的树木和安静的公园。

---

### Step 1: 从构思中提取语义轴

**从构思中提取所有需要的元素**，按9层结构分类：

- quality: masterpiece, best_quality, highres, absurdres
- character: 1girl, solo
- appearance: 发色、瞳色、发型（LoRA处理）
- expression: blush, smile, looking_at_viewer
- pose: sitting, holding, breath
- prop: cup, mug, steam, scarf
- scene: park, bench, tree, snow, outdoors, cold, wind
- lighting: sunlight, light_rays, shadow
- composition: upper_body, depth_of_field

**注意：语义轴来自构思，不是直接从用户描述提取。**

### Step 2: 从构思中提取关键词

**从构思中提取需要查MCP验证的关键词**，不是从用户描述提取：

- 场景词：park, bench, tree, snow（从"公园长椅树木积雪"提取）
- 动作词：sitting, holding, breath（从"坐在长椅上捧着热饮呼白气"提取）
- 道具词：cup, mug, steam, scarf（从"咖啡杯蒸汽围巾"提取）
- 光线词：sunlight, light_rays, shadow（从"阳光透过树枝洒下来"提取）
- 氛围词：cold, wind（从"寒冷飘雪"提取）

### Step 3: 制定 MCP 查询计划

MCP 查询必须覆盖所有基本维度：character、appearance、expression、outfit、pose、scene、lighting。不能只查角色相关 tag。

查询策略：

**A. 主题有明确对应核心 tag**（如校服→school_uniform，和服→kimono）
- `search_tags` 确认核心 tag（1 次）
- `get_related_tags([核心tag, 1girl])` 批量扩展（1 次，拿 60-90 个）
- `get_related_tags` 补充缺的维度（1-2 次）

**B. 主题不确定**（如"地雷系"、"昭和偶像"）
- `search_tags` 搜最不确定的候选词（1 次）
- `get_related_tags` 批量扩展（1-2 次）

**C. 简单主题**（如"美少女"）
- `get_related_tags([1girl])` 批量扩展（1-2 次）

总调用次数：3-5 次 `get_related_tags` 为主，`search_tags` 最多 2-3 次。

### Step 4: 执行 MCP 查询

按计划调用 MCP。每次调用后立即对结果分类。

### Step 5: 建立 Confirmed Tag Pool

将所有合法来源的 tag 汇入 `confirmed_tag_pool`。来源标记：mcp_search / mcp_related / mcp_verified / user_input / auto_rule。

### Step 5.5: Pool 完整性检查

建立 pool 后，按 9 层结构检查每层可用 tag 数量：
- quality: ≥2
- character: ≥3
- 发色: ≥5
- 瞳色: ≥5
- 发型: ≥5
- expression: ≥6
- 主服装: ≥5
- 细节/配饰: ≥10
- pose: ≥5
- scene: ≥5
- lighting: ≥2

某层不足时，立即补充 MCP 查询，不得跳过。

### Step 6: 筛选 MCP 返回结果

将 MCP 返回的 tag 按维度分类：character, appearance, expression, outfit, clothing_detail, accessory, pose, hand_action, prop, scene, background_element, composition, lighting, atmosphere, style, quality

只过滤以下情况：
- artist tag（除非用户明确要求）
- copyright / character tag（除非用户明确要求）
- 与用户明确要求冲突的 tag
- NSFW tag（除非用户明确要求且安全规则允许）

**MCP 返回的 tag 只要不违反以上 4 条，全部保留，不得自行判断删除。**

### Step 7: 组装 prompt

从 `confirmed_tag_pool` 中按 9 层结构逐层选取：

1. 先列每层可用 tag 清单（发色有哪些、配饰有哪些、场景有哪些）
2. 每层从中选取相关 tag，不跳过任何层
3. 覆盖全部维度后自然达到 35+ 个 tag
4. 低于 35 说明维度遗漏，回去检查哪层没覆盖，不得添加无关 tag 凑数

**关键：组装时要回顾Step 0的构思，确保构思中的每个要素都有对应的tag。**

### Step 8: 输出前执行 FINALIZATION_GATE

---

## Anchor 规则

Anchor = 用户请求的核心，不可协商。

- Anchor 必须出现在每段 prompt 中
- Anchor 包含 2-6 个 tag
- 不要把可选细节放入 Anchor
- 不要把随机发色/瞳色/普通表情放入 Anchor，除非用户明确要求
- Anchor 必须来自 confirmed_tag_pool

---

## Prompt 变体

默认输出 3 段 prompt，用户指定数量时按用户要求。

每段 prompt 必须共享 Anchor。每段 prompt 之间必须有明显差异（镜头、姿势、服装、场景、光影等），不能只靠发色瞳色区别。

根据 confirmed_tag_pool 中的 tag 自由组合，不要套固定模板。

同一角色模式：用户说"同一个角色、同一人设、保持一致"时进入。锁定发色、瞳色、发型、核心服装，其他维度自由变化。

---

## Hard Auto Rules

当 confirmed_tag_pool 中存在左侧 tag 时，自动补充右侧 tag。右侧 tag 必须已被 MCP 验证过，否则不补。

- `kimono → obi` / `japanese_clothes`
- `night → moon`
- `serafuku → sailor_collar`
- `school_uniform → bottom_style`
- `sword → holding_weapon` 或 `holding_sword`

只在 confirmed_tag_pool 已包含左侧 tag 时触发。

---

## NSFW 处理

用户要求 NSFW 内容时，正常生成，tag 来自 MCP 或用户输入。

---

## Tag 规则

每段 prompt 必须覆盖所有基本维度（character、appearance、expression、outfit、pose、scene、lighting），从 pool 中逐层全面选取。覆盖充分后 tag 数量自然达到 35+。强烈鼓励多写或者多选tag，允许tag无限大于35。低于 35 说明维度覆盖不充分，必须补充缺失维度，不得通过添加无关 tag 凑数。

排序按 9 层结构：quality → character → appearance → outfit → expression → pose → scene → composition → lighting

约束：
- **必须先构思再查tag**：先构思一张完整的画面（场景、人物、动作、表情、道具、光线、氛围），再从构思中提取关键词查MCP
- 一个画面一个构想：每段 prompt 描述一个具体场景（如"猫娘在窗边喝咖啡"），不是"好看的东西"的集合
- 服装走完整链条：一套衣服展开 5-9 个细节 tag，不要同时塞多套服装选项
- 身体部位不罗列：用服装和姿势暗示可见部位，不逐个列出 cleavage、bare_shoulders、navel、thighs 等
- 构图一个角度：只用一个主镜头 tag（from_below / from_above / cowboy_shot），不叠加多个
- 有意义的重复可以保留：如 braid + twin_braids、smile + grin 这种强化同一概念的重复是 OK 的
<!-- English detail 暂时关闭，待测试
- English detail 1-2 句，只补光影/氛围，不重复 tag 已覆盖的内容
-->
