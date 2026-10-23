<div align="center">

# obsidian-semantic-memory

**为 Obsidian 打造的语义记忆层 —— 本地优先索引、语义检索、全文搜索、实体、事实，以及供 agent 调用的 MCP 工具。**

[![CI](https://github.com/sterben-enec/obsidian-semantic-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/sterben-enec/obsidian-semantic-memory/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](./LICENSE)
[![MCP ready](https://img.shields.io/badge/MCP-ready-6E56CF)](https://modelcontextprotocol.io/)

**[English → README.md](README.md)** · **简体中文** · **[Русский → README.ru.md](README.ru.md)**

</div>

---

## 这是什么

`obsidian-semantic-memory` 把你的 Obsidian 笔记库变成一个本地记忆层，供 agent 和其他工具查询。

它把 Markdown 笔记索引进 SQLite + 向量检索，并暴露一套融合多路信号的检索栈：

| 信号 | 作用 |
|---|---|
| **语义相似度** | 找到换个说法、意思相同的笔记 |
| **BM25 全文检索** | 精确词、人名、报错原文、代码标识符 |
| **实体查找** | 直接跳到某个人、项目或概念 |
| **图谱关系** | 沿着你写下的双链与关系游走 |
| **结构化事实** | 需要的是确切断言，而不是一段原文 |
| **时效性加权** | 两条都命中时，新笔记优先于旧笔记 |

它的目标是**本地优先的个人知识系统** —— 不是云端看板，也不是托管式 SaaS 搜索。


## 为什么用它

- **默认私密** —— 本地向量模型、本地数据库、仅监听本机 API
- **强于纯向量检索** —— 语义 + 全文 + 图谱 + 事实多路融合
- **对 agent 友好** —— 提供 MCP 工具，可接入 Claude Code 及其他 MCP 客户端
- **Obsidian 原生** —— 直接处理 Markdown 笔记与双链
- **实时更新** —— 文件变更后数秒内完成重建索引

## 功能特性

- **本地向量化**，基于 `@xenova/transformers`
- **多信号检索**，融合语义向量 + BM25 全文 + 图谱/事实加权
- **MCP 服务端**，提供 7 个工具
- **HTTP API**，便于本地集成
- **结构化记忆**，支持实体、关系与事实
- **`.semanticignore`**，用于排除私密或噪音路径
- **会话记录** —— Claude Code 的会话可变成可检索的笔记

## 快速开始

```bash
git clone https://github.com/sterben-enec/obsidian-semantic-memory
cd obsidian-semantic-memory
cp .env.example .env
npm install
npm run build
```

在 `.env` 中设置 `VAULT_PATH`，然后：

```bash
# 全量重建索引
node dist/cli.js rebuild

# 增量索引
node dist/cli.js index

# 语义检索
node dist/cli.js search "我对项目 X 都记录了些什么"

# 监听文件变更
node dist/cli.js watch

# 启动本地 HTTP API
node dist/cli.js serve

# 启动 MCP 服务端
node dist/cli.js mcp

# 记录 Claude Code 会话到笔记库（由 Stop hook 自动触发）
node dist/cli.js log-conversation
```

## 架构

```text
Obsidian 笔记库（.md 文件）
  → 解析（frontmatter + 正文 + 双链）
  → 按标题 / token 预算切块
  → 向量化（本地模型或 OpenAI）
  → SQLite：notes、chunks、entities、facts、relations
  → FTS5 关键词索引
  → sqlite-vec 向量索引
  → 多信号融合排序
  → CLI / MCP / HTTP API
```

## 环境要求

| 要求 | 说明 |
|---|---|
| Node.js 18+ | 必需 |
| 约 560 MB 模型缓存 | 使用本地向量模型时，仅首次运行需下载 |
| `OPENAI_API_KEY` | 仅在选用 OpenAI 向量化时需要 |

## 配置项

全部通过环境变量配置。本地开发请从 `.env.example` 复制。

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `VAULT_PATH` | 是 | — | 你的 Obsidian 笔记库绝对路径 |
| `EMBEDDING_PROVIDER` | 否 | `openai` | `local` 或 `openai` |
| `EMBEDDING_MODEL` | 否 | `Xenova/multilingual-e5-base` | 本地向量模型名称 |
| `OPENAI_API_KEY` | 使用 openai 时 | — | OpenAI API 密钥 |
| `DB_PATH` | 否 | `$VAULT_PATH/.semantic-memory/index.db` | SQLite 数据库路径 |
| `MEMORY_DIR` | 否 | `Memory/Daily` | 日记记忆目录（相对笔记库） |
| `CONVERSATIONS_DIR` | 否 | `Claude Code/Conversations` | 会话笔记目录（相对笔记库） |
| `CHUNK_MAX_TOKENS` | 否 | `400` | 单块最大 token 数 |
| `CHUNK_OVERLAP_TOKENS` | 否 | `50` | 块之间重叠的 token 数 |
| `PRIORITY_PATHS` | 否 | `""` | 逗号分隔的加权路径 |
| `LLM_EXTRACTION` | 否 | `false` | 是否启用 LLM 事实抽取 |
| `INDEX_CONCURRENCY` | 否 | `5` | 并行索引工作数 |

### 推荐的本地模型

| 模型 | 维度 | 体积 | 说明 |
|------|------|------|------|
| `Xenova/multilingual-e5-base` | 768 | ~560 MB | 默认推荐，多语言 |
| `Xenova/multilingual-e5-small` | 384 | ~120 MB | 更快更轻 |
| `Xenova/all-MiniLM-L6-v2` | 384 | ~25 MB | 仅英文，速度极快 |

E5 系列模型会自动使用非对称的 `query:` / `passage:` 前缀。

## MCP 工具

MCP 服务端通过 stdio 暴露 7 个工具：

- `vault_search` —— 语义检索
- `vault_fts` —— BM25 关键词/短语检索
- `vault_entity` —— 按名称或别名查找实体
- `vault_facts` —— 查询某实体的事实
- `vault_status` —— 索引统计与健康快照
- `vault_remember` —— 追加内容到日记记忆笔记
- `vault_store_fact` —— 写入一条结构化事实

MCP 配置示例：

```json
{
  "mcpServers": {
    "obsidian-memory": {
      "command": "node",
      "args": ["/path/to/obsidian-semantic-memory/dist/cli.js", "mcp"],
      "env": {
        "VAULT_PATH": "/path/to/your/vault",
        "EMBEDDING_PROVIDER": "local",
        "EMBEDDING_MODEL": "Xenova/multilingual-e5-base"
      }
    }
  }
}
```

## HTTP API

HTTP API 仅绑定 `127.0.0.1`。

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/retrieve-context` | 语义检索 `{ query, topK? }` |
| `GET` | `/search?q=...` | 简写检索端点 |
| `GET` | `/entity/:name` | 按名称或别名查找实体 |
| `GET` | `/facts/:entityId` | 查询某实体的事实 |
| `POST` | `/memory/daily` | 追加到日记 `{ date, text, source? }` |

## `.semanticignore`

在笔记库根目录创建 `.semanticignore` 可排除文件：

```text
# 密钥与私密内容
config/secrets.md
private/env.md

# 目录
Templates/
Archive/old/
```

规则按笔记库相对路径匹配。

## Claude Code 集成

`log-conversation` 会把每次 Claude Code 会话记录成结构化 Markdown 笔记写入你的库中。运行中的 watcher 会自动发现并索引新文件 —— 数秒后这些对话即可通过 `vault_search` 检索到。

### 工作方式

1. Claude Code 在会话结束时调用 `Stop` hook
2. hook 执行 `scripts/log-conversation.sh`，设置环境变量并调用 `log-conversation`
3. 命令读取 `~/.claude/projects/<project>/<session_id>.jsonl`，抽取用户/助手对话轮次与代码改动（Edit/Write/Bash 工具调用），写入 `CONVERSATIONS_DIR`
4. watcher 重新索引新笔记

单条笔记大致如下：

```markdown
---
kind: conversation
date: 2026-04-03
time_start: 14:32
session_id: 0069c9ea-…
project: /Users/you/my-project
title: "Fix auth bug"
---

**User:** Please fix the authentication bug

**Assistant:** I'll fix it now.

> **Edit** `src/auth.ts`
> ```diff
> - return false;
> + return true;
> ```
```

### 配置步骤

1. 复制并编辑包装脚本：

```bash
cp scripts/log-conversation.sh ~/my-log-conversation.sh
# 编辑其中的 VAULT_PATH、CONVERSATIONS_DIR 与 Node.js 路径
chmod +x ~/my-log-conversation.sh
```

2. 在 `~/.claude/settings.json` 中添加 `Stop` hook：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/my-log-conversation.sh",
            "async": true
          }
        ]
      }
    ]
  }
}
```

3. 确保 watcher 处于运行状态（见下方 launchd 示例），新笔记才会被立即索引。

## macOS launchd 示例

创建 `~/Library/LaunchAgents/com.yourname.osm-watcher.plist`，在登录时启动 watcher：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.yourname.osm-watcher</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/opt/node@24/bin/node</string>
      <string>/path/to/obsidian-semantic-memory/dist/cli.js</string>
      <string>watch</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>VAULT_PATH</key>
      <string>/path/to/your/vault</string>
      <key>EMBEDDING_PROVIDER</key>
      <string>local</string>
      <key>EMBEDDING_MODEL</key>
      <string>Xenova/multilingual-e5-base</string>
      <key>HOME</key>
      <string>/Users/yourname</string>
      <key>PATH</key>
      <string>/usr/local/opt/node@24/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
  </dict>
</plist>
```

## 安全模型

- HTTP API 仅绑定 `127.0.0.1`
- MCP 传输仅支持 stdio
- 私密笔记与密钥应通过 `.semanticignore` 排除
- 本地 `.env` 文件不应提交到版本库

漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## GitHub 仓库简介

建议的仓库描述：

> Local-first semantic memory for Obsidian: SQLite + vector search + FTS + entities + facts + MCP tools.

建议的 topics：

`obsidian`, `semantic-search`, `mcp`, `knowledge-graph`, `sqlite`, `vector-search`, `local-first`, `typescript`

---

<div align="center">

**ISC 许可** · 为那些希望笔记始终属于自己的人而做

</div>

## 许可证

ISC
