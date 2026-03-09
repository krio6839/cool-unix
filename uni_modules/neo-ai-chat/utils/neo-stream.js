// uni_modules/neo-ai-chat/utils/neo-stream.js

/**
 * 🛠️ ArrayBuffer 解码器
 * 解决微信小程序 enableChunked 返回二进制数据的问题
 */
function decodeArrayBuffer(arrayBuffer) {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8').decode(arrayBuffer);
  }
  // 兜底解码逻辑 (兼容低版本基础库)
  let u8arr = new Uint8Array(arrayBuffer);
  let out = "", i = 0, len = u8arr.length, c, char2, char3;
  while (i < len) {
    c = u8arr[i++];
    switch (c >> 4) {
      case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7:
        out += String.fromCharCode(c);
        break;
      case 12: case 13:
        char2 = u8arr[i++];
        out += String.fromCharCode(((c & 0x1F) << 6) | (char2 & 0x3F));
        break;
      case 14:
        char2 = u8arr[i++];
        char3 = u8arr[i++];
        out += String.fromCharCode(((c & 0x0F) << 12) | ((char2 & 0x3F) << 6) | ((char3 & 0x3F) << 0));
        break;
    }
  }
  return out;
}

/**
 * 🎮 模拟流式请求 (Mock Mode)
 * 让用户在没有 API Key 的情况下也能体验打字机效果
 */
export function mockStreamRequest({ prompt, onMessage, onSuccess }) {
  const mockResponse = `收到你的问题："${prompt}"。\n\n这是一个 **模拟的流式回复**。我正在模仿 AI 一个字一个字地输出：\n\n\`\`\`javascript\n// 模拟延时\nconst delay = (ms) => new Promise(r => setTimeout(r, ms));\nawait delay(50);\n\`\`\`\n\n你觉得这个速度怎么样？是不是很有感觉？`;

  let index = 0;
  const timer = setInterval(() => {
    if (index >= mockResponse.length) {
      clearInterval(timer);
      if (onSuccess) onSuccess();
      return;
    }
    // 随机输出 1-3 个字符，模拟网络抖动
    const chunk = mockResponse.slice(index, index + Math.floor(Math.random() * 3) + 1);
    index += chunk.length;
    if (onMessage) onMessage(chunk);
  }, 50); // 打字速度：50ms

  return { abort: () => clearInterval(timer) };
}

/**
 * 🌐 真实 API 请求 (Real Mode)
 * 对接 DeepSeek / ChatGPT / 通义千问
 */
export function streamRequest({ url, apiKey, model, messages, onMessage, onSuccess, onError }) {
  console.log('[NeoStream] Requesting:', url);
  console.log('[NeoStream] API Key:', apiKey ? `${apiKey.slice(0, 4)}******${apiKey.slice(-4)}` : 'None');

  const requestTask = uni.request({
    url: url || 'https://api.deepseek.com/chat/completions', // 默认 DeepSeek
    method: 'POST',
    header: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    data: {
      model: model || 'deepseek-chat',
      messages: messages,
      stream: true // 开启流式
    },
    enableChunked: true, // 小程序核心配置
    responseType: 'text',
    success: (res) => {
      if (res.statusCode >= 400) {
        if (onError) onError(new Error(`API Error: ${res.statusCode}`));
      } else {
        if (onSuccess) onSuccess();
      }
    },
    fail: (err) => {
      if (onError) onError(err);
    }
  });

  // 监听流式切片
  requestTask.onChunkReceived((res) => {
    const chunk = decodeArrayBuffer(res.data);

    // 解析 SSE 数据 (data: {...})
    // 简单处理：提取 content 字段
    // 实际项目中这里需要处理“粘包”逻辑，但在 Demo 中我们可以简化正则提取
    const lines = chunk.split('\n');
    lines.forEach(line => {
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        try {
          const jsonStr = line.replace('data: ', '');
          const data = JSON.parse(jsonStr);
          const content = data.choices?.[0]?.delta?.content || '';
          if (content && onMessage) onMessage(content);
        } catch (e) {
          // 忽略解析错误
        }
      }
    });
  });

  return requestTask;
}