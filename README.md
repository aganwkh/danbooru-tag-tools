# Danbooru Tag Tools

人物插画提示词工具链：通过 Danbooru API 检索标签，由支持 Skill 的 AI 客户端构思和组装英文描述与 tag。支持完整场景、局部修改、标签及同义候选查询；不直接生成图片。

不指定单一生图底模，Skill 面向支持 Danbooru tag、自然语言或两者混合输入的 Anime 类图像模型。完整场景默认输出 3 段 prompt，用户指定数量时遵循用户要求；单标签和局部补全只输出对应结果，不主动增加变体。流程不设置构思审阅环节。下面以 Claude Code 安装为例。

## 环境要求

- **Node.js >= 16**（用到可选链等语法；`node --version` 确认）
- 无任何外部 npm 依赖，仅使用 Node 内置模块，`npm install` 都不需要
- 一个支持 MCP 与 Skill 的 AI 客户端（下面以 Claude Code 为例）

## 包含内容

| 组件 | 说明 |
|------|------|
| `mcp-server/` | Danbooru MCP 服务器 — 提供标签搜索、关联标签、帖子搜索 |
| `skill/` | Claude Code Skill — 自动从中文描述生成完整 prompt |
| `scripts/` | CLI 备用脚本 — MCP 不可用时的降级方案 |
| `test/` | 离线冒烟与单元测试（`npm test`，不访问网络） |

## 快速开始

### 1. 安装 MCP 服务器

在 Claude Code 的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "danbooru": {
      "type": "stdio",
      "command": "node",
      "args": ["<path-to>/mcp-server/danbooru-mcp-server.js"],
      "env": {
        "DANBOORU_LOGIN": "<your-login>",
        "DANBOORU_API_KEY": "<your-api-key>"
      }
    }
  }
}
```

> 服务器同时兼容**标准 MCP `Content-Length` 分帧**和逐行 JSON，因此可直接接入按标准 MCP 协议通信的客户端。
>
> API 凭据可选，不填也能用（匿名访问），但有速率限制。在 https://danbooru.donmai.us/profile 获取 API key。

配置文件位置：
- Windows: `C:\Users\<username>\.claude.json`（`mcpServers` 字段）
- macOS/Linux: `~/.claude.json`

### 2. 安装 Skill

将 `skill/` 目录复制到客户端的 skills 目录，命名为 `danbooru-tag`：

**Windows（PowerShell）：**

```powershell
Copy-Item -Recurse .\skill\ "$env:USERPROFILE\.claude\skills\danbooru-tag"
```

**macOS / Linux：**

```bash
cp -r skill/ ~/.claude/skills/danbooru-tag/
```

### 3. 使用

在客户端中说以下任意关键词即可触发：

> 帮我写tag、生图提示词、画一个xxx、AI绘画、prompt、tags

### 4. CLI 备用调用

默认启动本地 stdio MCP。参数 JSON 有三种传入方式：

**macOS / Linux（bash、zsh，内联单引号）：**

```bash
node scripts/danbooru-call.js search_tags '{"query":"1girl","limit":5}'
```

**Windows CMD（内联，双引号并转义内部引号）：**

```cmd
node scripts\danbooru-call.js search_posts "{\"tags\":\"1girl solo\",\"limit\":2}"
```

**Windows PowerShell（推荐用文件，避免引号/空格被拆散）：**

```powershell
'{"tags":"1girl solo","limit":2}' | Set-Content args.json -Encoding utf8
node scripts/danbooru-call.js search_posts @args.json
```

也可以用管道从标准输入传入（参数写 `-`）：

```bash
echo '{"query":"kimono"}' | node scripts/danbooru-call.js search_tags -
```

> 说明：`@路径` 表示从文件读取 JSON，`-` 表示从 stdin 读取；文件带 UTF-8 BOM 也能正常解析。
> 如需调用 HTTP MCP，设置 `MCP_URL` 环境变量；HTTPS 默认校验证书。

## MCP 工具

| 工具 | 用途 |
|------|------|
| `search_tags` | 搜索标签（英文，支持 `*` 通配；无通配时先精确、空结果再模糊） |
| `get_related_tags` | 获取关联标签（最多 5 个锚点，`overlap` 取自 `cosine_similarity`，非适配分数） |
| `get_tag_info` | 获取标签详情（类别、计数；一次最多 10 个） |
| `search_posts` | 搜索图片帖子（默认不用，除非需要参考图） |

### 内容分级（search_posts）

Danbooru 含成人内容。`search_posts` **默认排除 explicit（`rating:e`）帖子**，避免普通标签查询直接返回露骨原图：

- 默认等价于在查询中追加 `-rating:e`；
- 显式传 `rating`（`g`/`s`/`q`/`e`）时按该评级过滤；
- 确需包含 e 级内容时，传 `allow_explicit: true`，或在 `tags` 里自行写明 `rating:e`。

## 测试

```bash
npm test
```

测试完全离线，覆盖：两种 stdio 分帧握手、分块送达、输入校验、`search_posts` 标签合并逻辑。真实 API 的端到端行为需联网手动验证。

## 许可

MIT，见 [LICENSE](LICENSE)。
