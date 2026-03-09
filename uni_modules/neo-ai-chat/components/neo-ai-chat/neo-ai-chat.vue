<template>
  <view class="neo-chat-container">
    <!-- 顶部代理人信息 -->
    <view class="agent-profile">
      <view class="agent-avatar-wrap">
        <view class="agent-avatar">
          <text class="icon-placeholder">AI</text>
          <view class="online-dot"></view>
        </view>
      </view>
      <view class="agent-info">
        <text class="agent-name">Neo AI</text>
        <text class="agent-role">智能助手</text>
      </view>
    </view>
    
    <view class="divider"></view>

    <scroll-view 
      class="chat-scroll-area" 
      scroll-y 
      :scroll-top="scrollTop"
      :scroll-with-animation="true"
      :enable-back-to-top="true"
    >
      <view class="scroll-inner">
        <block v-for="(msg, index) in messages" :key="index">
          
          <!-- Chip -->
          <view v-if="msg.type === 'chip'" class="chip-row">
            <view class="msg-meta">
              <view class="msg-icon"><text class="icon-placeholder-small">⚡</text></view>
              <text class="msg-name">Neo AI</text>
              <text class="msg-time">{{ msg.time }}</text>
            </view>
            <view class="chip-container">
              <view class="chip-btn" @click="onChipClick(msg.content)">{{ msg.content }}</view>
            </view>
          </view>

          <!-- AI Bubble -->
          <view v-else-if="msg.role === 'ai'" class="msg-row ai">
            <view class="msg-meta">
              <view class="msg-icon"><text class="icon-placeholder-small">🤖</text></view>
              <text class="msg-name">Neo AI</text>
              <text v-if="msg.time" class="msg-time">{{ msg.time }}</text>
            </view>
            
            <view class="msg-bubble ai">
              <!-- 混合渲染 -->
              <block v-for="(node, nIndex) in parseMessageContent(msg.content)" :key="nIndex">
                
                <!-- 文本 -->
                <rich-text 
                  v-if="node.type === 'html'" 
                  :nodes="node.content" 
                  class="markdown-body" 
                  user-select
                ></rich-text>

                <!-- 代码块 (原生渲染) -->
                <view v-else-if="node.type === 'code'" class="native-code-block">
                  <view class="native-header">
                    <view class="window-controls">
                      <view class="dot red"></view>
                      <view class="dot yellow"></view>
                      <view class="dot green"></view>
                    </view>
                    <!-- 从 node.lang 获取语言 -->
                    <text class="lang-name">{{ node.lang || '代码' }}</text>
                    <text class="copy-btn" @click="copyCode(node.rawCode)">复制</text>
                  </view>
                  
                  <view class="native-scroll">
                    <!-- 核心：只渲染代码内容 -->
                    <rich-text :nodes="node.codeHtml" class="code-body"></rich-text>
                  </view>
                </view>

              </block>

              <view v-if="!msg.content" class="typing-dots">
                <text class="dot">.</text><text class="dot">.</text><text class="dot">.</text>
              </view>
            </view>
          </view>

          <!-- User Bubble -->
          <view v-else class="msg-row user">
             <view class="msg-meta-right">
               <text class="msg-name">我</text>
               <text class="msg-time">{{ msg.time }}</text>
             </view>
             <view class="msg-bubble user">
               <text>{{ msg.content }}</text>
             </view>
             <text class="read-status">已读</text>
          </view>

        </block>
        <view style="height: 40rpx;"></view>
      </view>
    </scroll-view>

    <!-- Footer -->
    <view class="chat-footer">
      <view class="footer-input-wrap">
        <input class="chat-input" type="text" v-model="inputValue" placeholder="请输入消息..." placeholder-style="color: #999;" confirm-type="send" @confirm="sendMessage"/>
        <view class="send-btn" @click="sendMessage"><text class="icon-placeholder-white">➤</text></view>
      </view>
    </view>
  </view>
</template>

<script setup>
import { ref, nextTick } from 'vue';
import NeoParser from '../../utils/neo-parser.js';
import { mockStreamRequest, streamRequest } from '../../utils/neo-stream.js';

const props = defineProps({
  apiKey: {
    type: String,
    default: ''
  },
  baseUrl: {
    type: String,
    default: 'https://api.deepseek.com/chat/completions'
  },
  model: {
    type: String,
    default: 'deepseek-chat'
  },
  useMock: {
    type: Boolean,
    default: false
  }
});

const inputValue = ref('');
const scrollTop = ref(0);
const isTyping = ref(false);

const messages = ref([
  { type: 'chip', role: 'ai', content: '你好', time: '02:10 PM' },
  { type: 'text', role: 'ai', content: '欢迎使用 Neo AI\n\n试试发送一段 JavaScript 代码看看？', time: '' },
  { type: 'text', role: 'user', content: '你好', time: '02:12 PM' }
]);

const onChipClick = (text) => {
  if(isTyping.value) return;
  inputValue.value = text;
  sendMessage();
};

const sendMessage = () => {
  if (!inputValue.value.trim() || isTyping.value) return;
  
  const now = new Date();
  const timeString = `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
  const userPrompt = inputValue.value;

  messages.value.push({ type: 'text', role: 'user', content: userPrompt, time: timeString });
  inputValue.value = '';
  scrollToBottom();
  isTyping.value = true;

  const aiMsgIndex = messages.value.push({ type: 'text', role: 'ai', content: '', time: timeString }) - 1;
  scrollToBottom();

  const handleChunk = (chunk) => {
    messages.value[aiMsgIndex].content += chunk;
    scrollToBottom();
  };

  const handleFinish = () => { isTyping.value = false; };
  const handleError = (err) => { messages.value[aiMsgIndex].content += `\n\n[Error: ${err.message}]`; isTyping.value = false; };

  if (props.useMock) {
    mockStreamRequest({ prompt: userPrompt, onMessage: handleChunk, onSuccess: handleFinish });
  } else {
    streamRequest({ 
      url: props.baseUrl, 
      apiKey: props.apiKey, 
      model: props.model, 
      messages: [{role:'user',content:userPrompt}], 
      onMessage: handleChunk, 
      onSuccess: handleFinish, 
      onError: handleError 
    });
  }
};

const scrollToBottom = () => {
  nextTick(() => { scrollTop.value += 10000; });
};

const copyCode = (code) => {
  uni.setClipboardData({ data: code || '' });
};

// =================================================================
// 🟢 最终修复的解析逻辑
// =================================================================
const parseMessageContent = (markdownText) => {
  if (!markdownText) return [];
  
  let html = NeoParser.render(markdownText);
  
  // 1. 使用正则把代码块切出来
  // 匹配我们在 neo-parser.js 里生成的 <div class="neo-code-block" data-lang="...">
  const regex = /<div class="neo-code-block" data-lang="([^"]*)">([\s\S]*?)<\/div>/g;
  
  const nodes = [];
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(html)) !== null) {
    // 1. 把前面的普通 HTML 文本加进去
    if (match.index > lastIndex) {
      const textPart = html.substring(lastIndex, match.index);
      if (textPart.trim()) {
        nodes.push({ type: 'html', content: textPart });
      }
    }

    // 2. 处理匹配到的代码块
    const lang = match[1]; // 捕获组1：语言
    const innerHtml = match[2]; // 捕获组2：内部的 <pre>...</pre>
    
    // 进一步清洗内部 HTML，只保留 code 标签内的内容用于显示
    // 我们需要构造一个干净的 div 给 rich-text
    const codeHtml = `<div style="display:inline-block; white-space: pre; font-family: Consolas, monospace; font-size: 26rpx; color: #c9d1d9;">${innerHtml}</div>`;

    nodes.push({
      type: 'code',
      lang: lang,
      codeHtml: codeHtml,
      // 尝试提取纯文本用于复制 (简单去标签)
      rawCode: innerHtml.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    });

    lastIndex = regex.lastIndex;
  }

  // 3. 把剩下的普通文本加进去
  if (lastIndex < html.length) {
    const textPart = html.substring(lastIndex);
    if (textPart.trim()) {
      nodes.push({ type: 'html', content: textPart });
    }
  }
  
  return nodes;
};
</script>

<style lang="scss" scoped>
$primary-blue: #0055FF;
$bg-color: #F7F8FA;
$text-main: #333333;
$text-light: #999999;

.neo-chat-container { display: flex; flex-direction: column; height: 100vh; background-color: #FFFFFF; }
.icon-placeholder { font-size: 24rpx; color: #666; }
.icon-placeholder-small { font-size: 20rpx; color: $primary-blue; }
.icon-placeholder-white { font-size: 24rpx; color: #fff; }
.typing-dots { display: flex; gap: 4rpx; padding: 10rpx 0; .dot { animation: bounce 1.4s infinite ease-in-out both; font-size: 40rpx; line-height: 20rpx; color: #999; } .dot:nth-child(1) { animation-delay: -0.32s; } .dot:nth-child(2) { animation-delay: -0.16s; } }
@keyframes bounce { 0%, 80%, 100% { transform: scale(0); } 40% { transform: scale(1); } }

/* Header */
.agent-profile { padding: 30rpx 40rpx; display: flex; align-items: center; background: #fff; z-index: 10; .agent-avatar-wrap { position: relative; margin-right: 24rpx; .agent-avatar { width: 80rpx; height: 80rpx; border-radius: 50%; border: 2rpx solid #EBEBEB; display: flex; align-items: center; justify-content: center; background: #fff; } .online-dot { position: absolute; bottom: 4rpx; right: 4rpx; width: 16rpx; height: 16rpx; background: #00C853; border-radius: 50%; border: 4rpx solid #fff; } } .agent-info { display: flex; flex-direction: column; .agent-name { font-size: 30rpx; font-weight: 600; color: $text-main; margin-bottom: 4rpx; } .agent-role { font-size: 22rpx; color: $text-light; } } }
.divider { height: 2rpx; background: #F0F0F0; width: 92%; margin: 0 auto; }
.chat-scroll-area { flex: 1; background-color: $bg-color; height: 0; }
.scroll-inner { padding: 30rpx 40rpx; }
.msg-meta { display: flex; align-items: center; margin-bottom: 12rpx; .msg-icon { margin-right: 12rpx; display: flex; align-items: center; } .msg-name { font-size: 24rpx; color: $text-light; margin-right: 12rpx; } .msg-time { font-size: 22rpx; color: $text-light; } }
.chip-row { margin-bottom: 30rpx; .chip-container { padding-left: 0; } .chip-btn { display: inline-block; background: #fff; border: 2rpx solid #E5E7EB; padding: 16rpx 32rpx; border-radius: 16rpx; font-size: 26rpx; color: $text-main; box-shadow: 0 4rpx 8rpx rgba(0,0,0,0.02); } }
.msg-row.ai { margin-bottom: 40rpx; .msg-bubble.ai { background: #fff; padding: 30rpx; border-radius: 0 24rpx 24rpx 24rpx; border: 2rpx solid #EDEDED; box-shadow: 0 4rpx 12rpx rgba(0,0,0,0.02); max-width: 88%; min-height: 40rpx; } }
.msg-row.user { margin-bottom: 40rpx; display: flex; flex-direction: column; align-items: flex-end; .msg-meta-right { margin-bottom: 10rpx; text-align: right; display: flex; justify-content: flex-end; align-items: center; .msg-name { font-size: 24rpx; color: $text-light; margin-right: 10rpx; } .msg-time { font-size: 22rpx; color: $text-light; } } .msg-bubble.user { background-color: $primary-blue; color: #fff; padding: 24rpx 32rpx; border-radius: 24rpx 0 24rpx 24rpx; font-size: 28rpx; box-shadow: 0 8rpx 20rpx rgba(0, 85, 255, 0.2); max-width: 80%; } .read-status { font-size: 20rpx; color: $text-light; margin-top: 8rpx; text-align: right; width: 100%; } }
.chat-footer { background: #fff; padding: 20rpx 34rpx; padding-bottom: calc(20rpx + constant(safe-area-inset-bottom)); padding-bottom: calc(20rpx + env(safe-area-inset-bottom)); border-top: 2rpx solid #F5F5F5; }
.footer-input-wrap { display: flex; align-items: center; position: relative; .chat-input { flex: 1; height: 80rpx; font-size: 28rpx; color: $text-main; padding-left: 0; margin-right: 20rpx; } .input-icon { width: 60rpx; height: 80rpx; display: flex; align-items: center; justify-content: center; } .send-btn { width: 72rpx; height: 72rpx; background: $primary-blue; border-radius: 16rpx; display: flex; align-items: center; justify-content: center; box-shadow: 0 4rpx 10rpx rgba(0, 85, 255, 0.3); } }

/* 🟢 原生代码块样式 */
.native-code-block {
  margin: 24rpx 0;
  border-radius: 16rpx;
  background-color: #0d1117; 
  border: 1px solid #30363d;
  overflow: hidden;
  max-width: 100%;
  
  .native-header {
    background-color: #161b22;
    padding: 12rpx 24rpx;
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid #30363d;
    
    .window-controls {
      display: flex; gap: 12rpx;
      .dot { width: 18rpx; height: 18rpx; border-radius: 50%; }
      .red { background: #FF5F56; }
      .yellow { background: #FFBD2E; }
      .green { background: #27C93F; }
    }
    .lang-name { font-family: monospace; font-size: 24rpx; color: #7d8590; }
    .copy-btn { font-size: 22rpx; color: #7d8590; padding: 4rpx 12rpx; }
  }
  
  .native-scroll { 
    width: 100%; 
    white-space: nowrap; 
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  
  .code-body {
    display: inline-block;
    min-width: 100%;
    padding: 24rpx;
    box-sizing: border-box;
  }
}

:deep(.markdown-body) {
  font-size: 30rpx; line-height: 1.6; color: #333;
  p { margin-bottom: 16rpx; }
  strong { font-weight: 600; color: #000; }
  /* 隐藏重复的 div */
  .neo-code-block { display: none; }
}
</style>