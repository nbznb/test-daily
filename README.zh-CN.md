[English](README.md) | **中文**

# USTC Daily News

一个 AI 驱动的日报项目，用于跟踪中科大官方信息、院系动态、就业信息、精选科技资讯和科研论文动态，并将其整理成简洁摘要。

## 你会得到什么

每日或每周摘要，包含：

- 中科大官方新闻与通知
- 已选院系的动态与公告
- 校园就业与招聘信息
- 公开科技资讯源的精选内容
- 公开论文 feed 的研究亮点
- 所有原始链接
- 英文、中文或双语输出

## 架构说明

- `config/default-sources.json`：定义所有数据源，包括院系官网和就业信息网
- `config/config-schema.json`：定义用户配置结构，包括 `selectedDepartments`
- `scripts/generate-feed.js`：抓取数据源、筛选候选内容、写出 feeds，并可生成校验报告
- `scripts/prepare-digest.js`：读取 feeds，按配置过滤院系内容，并整理给 LLM
- `scripts/deliver.js`：负责 stdout、Telegram 或邮件投递
- `prompts/`：控制摘要风格和章节顺序
- `.github/workflows/generate-feed.yml`：定时刷新 feed

## 院系选择

在 `~/.ustc-dailynews/config.json` 中配置：

```json
{
  "selectedDepartments": ["少年班学院"]
}
```

- 默认只推送 1 个院系：`少年班学院`
- 可以手动追加多个院系名称
- 摘要生成阶段只会注入所选院系的内容

## 校验命令

```bash
cd scripts && npm run validate-sources
```

执行后会在项目根目录生成 `source-validation-report.json`。

## 系统要求

- Node.js 20+
- 可访问外部网络

## 许可证

MIT
