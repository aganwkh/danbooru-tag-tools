# Danbooru Tag Tools

Claude Code 工具链：通过 Danbooru API 自动生成 AI 绘画 prompt。

## 包含内容

| 组件 | 说明 |
|------|------|
| `mcp-server/` | Danbooru MCP 服务器 — 提供标签搜索、关联标签、帖子搜索 |
| `skill/` | Claude Code Skill — 自动从中文描述生成完整 prompt |
| `scripts/` | CLI 备用脚本 — MCP 不可用时的降级方案 |

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

> API 凭据可选，不填也能用（匿名访问），但有速率限制。
> 在 https://danbooru.donmai.us/profile 获取 API key。

配置文件位置：
- Windows: `C:\Users\<username>\.claude.json`（`mcpServers` 字段）
- macOS/Linux: `~/.claude.json`

### 2. 安装 Skill

将 `skill/` 目录复制到 Claude Code 的 skills 目录：

```bash
# Windows
cp -r skill/ C:\Users\<username>\.claude\skills\danbooru-tag\

# macOS/Linux
cp -r skill/ ~/.claude/skills/danbooru-tag/
```

### 3. 使用

在 Claude Code 中说以下任意关键词即可触发：

> 帮我写tag、生图提示词、画一个xxx、AI绘画、prompt、tags

## MCP 工具

| 工具 | 用途 |
|------|------|
| `search_tags` | 搜索标签（支持英文） |
| `get_related_tags` | 获取关联标签（带 overlap 分数） |
| `get_tag_info` | 获取标签详情（类别、计数） |
| `search_posts` | 搜索图片帖子 |

## 依赖

- Node.js（运行 MCP 服务器）
- Claude Code（使用 Skill）
- 无外部 npm 依赖，直接调用 Danbooru API

## 许可

MIT
