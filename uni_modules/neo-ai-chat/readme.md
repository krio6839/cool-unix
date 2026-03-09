# Neo AI Chat - 企业级 AI 对话组件

Neo AI Chat 是专为 Uni-app 生态（特别是微信小程序）打造的高性能 AI 对话 UI 组件。

它采用创新的 “HTML 节点拆分 + 原生混合渲染” 技术，完美解决了小程序代码块无法横向滑动的痛点，实现了 1:1 复刻 DeepSeek App 的丝滑体验。

## 核心卖点

- **独家原生代码块**：代码块内部使用小程序原生的 `<scroll-view>` 组件，支持丝滑的横向惯性滚动，彻底解决 `rich-text` 渲染代码块无法滚动的难题。
- **极速流式响应**：内置 SSE 解析器，支持 `enableChunked` 模式，完美兼容 DeepSeek、OpenAI、通义千问、腾讯混元等大模型 API，打字机效果流畅自然。
- **DeepSeek 风格 UI**：深色护眼代码块背景 (#0d1117)，Mac 风格窗口头部，一键复制功能，10+ 种主流编程语言高亮。
- **开箱即用**：支持 Mock 模式，无需 API Key 即可体验 UI 交互。

## 兼容性

| Vue2 | Vue3 | H5 | App | 微信小程序 | 支付宝小程序 | 百度小程序 | 字节小程序 | QQ小程序 |
|------|------|----|----|--------|----------|--------|--------|---------|
| N   | ✅   | ✅ | ✅  | ✅     | ✅       | ✅     | ✅     | ✅      |

## 安装

在 HBuilderX 中右键 `uni_modules` 目录，选择 `从插件市场导入`，搜索 `neo-ai-chat` 安装。

或者直接复制 `neo-ai-chat` 目录到项目的 `uni_modules` 目录下。

在neo-ai-chat 目录下 执行 `npm install` 安装依赖，只支持Vue3，使用Vue2 需要自己看源码修改

## 快速开始

### 基础用法 (Mock 模式)

无需任何配置，直接引入组件即可体验模拟对话。

```vue
<template>
  <view style="height: 100vh;">
    <neo-ai-chat :use-mock="true" />
  </view>
</template>
```

### 真实 API 对接 (OpenAI 兼容模式)

组件完美支持所有兼容 OpenAI 接口格式的大模型 API，包括但不限于：
- **DeepSeek**
- **腾讯混元 (Hunyuan)**
- **阿里通义千问 (Qwen)**
- **OpenAI (ChatGPT)**
- **智谱 GLM**
- **Moonshot (Kimi)**

只需配置 `base-url` 和 `api-key` 即可。

#### 示例：对接腾讯混元

```vue
<template>
  <view style="height: 100vh;">
    <neo-ai-chat 
      api-key="sk-xxxxxxxxxxxxxxxx" 
      base-url="https://api.hunyuan.cloud.tencent.com/v1/chat/completions"
      model="hunyuan-turbos-latest"
    />
  </view>
</template>
```

#### 示例：对接 DeepSeek

```vue
<template>
  <view style="height: 100vh;">
    <neo-ai-chat 
      api-key="sk-xxxxxxxxxxxxxxxx" 
      base-url="https://api.deepseek.com/chat/completions"
      model="deepseek-chat"
    />
  </view>
</template>
```

## API

### Props

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| apiKey | String | - | API 密钥 (Bearer Token) |
| baseUrl | String | https://api.deepseek.com/chat/completions | API 请求完整地址 |
| model | String | deepseek-chat | 模型名称 |
| useMock | Boolean | false | 是否强制使用模拟数据 |

### Events

目前组件内部处理了发送和接收逻辑，暂无对外事件暴露。后续版本将支持更多自定义事件。

## 技术架构

### 混合渲染引擎

Neo AI Chat 使用 `markdown-it` 将 Markdown 转为 HTML，然后通过正则将 HTML 拆分为“普通文本”和“代码块”两部分：

- **普通文本**：使用 `<rich-text>` 渲染，保证排版性能。
- **代码块**：使用 `<view>` + `<scroll-view>` 原生渲染，实现横向滚动和交互。

这种架构既保留了 `rich-text` 的渲染能力，又突破了其交互限制。

## 常见问题

### 1. 腾讯混元 API 报错 401？

请确保您使用的是 **API Key** (通常以 `sk-` 开头)，而不是腾讯云的 `SecretId` / `SecretKey`。请前往 [混元控制台 > API Key 管理](https://console.cloud.tencent.com/hunyuan/api-key) 获取。

### 2. 代码块不显示高亮？

组件内置了 `highlight.js` 的样式，通常会自动生效。如果未生效，请检查是否覆盖了相关 CSS。

## 许可

MIT License

## 更新日志

见 [changelog.md](./changelog.md)
