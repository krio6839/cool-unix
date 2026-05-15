# BOOM COACH AI对话页面接口文档

***

## 接口1：获取对话历史列表


**请求方式：** GET

**请求参数：** 无

### 响应示例

```json
{
  "code": 0,
  "data": [
    {
      "conversationId": "conv001",
      "title": "关于昨天训练计划的讨论",
      "createTime": "2026-04-28 10:00:00",
      "updateTime": "2026-04-28 14:30:00",
      "messageCount": 12
    },
    {
      "conversationId": "conv002",
      "title": "睡眠质量分析",
      "createTime": "2026-04-27 09:00:00",
      "updateTime": "2026-04-27 11:20:00",
      "messageCount": 8
    }
  ]
}
```

### 响应字段说明

| 名称           | 类型    | 说明                   |
| -------------- | ------- | ---------------------- |
| conversationId | String  | 对话唯一标识           |
| title          | String  | 对话标题（AI自动生成） |
| createTime     | String  | 创建时间               |
| updateTime     | String  | 最后更新时间           |
| messageCount   | Integer | 消息数量               |

***



**请求方式：** GET

**请求参数：**

| 名称           | 类型   | 必填 | 说明         |
| -------------- | ------ | ---- | ------------ |
| conversationId | String | 是   | 对话唯一标识 |

### 响应示例

```json
{
  "code": 0,
  "data": [
    {
      "messageId": "msg001",
      "role": "user",
      "type": "text",
      "content": "昨天睡得好吗？",
      "createTime": "2026-04-28 10:00:00"
    },
    {
      "messageId": "msg002",
      "role": "ai",
      "type": "text",
      "content": "根据你的睡眠数据，昨天睡了7小时30分钟，深睡时长占比35%，睡眠质量不错。建议今晚保持相同的作息时间。",
      "createTime": "2026-04-28 10:00:05"
    },
    {
      "messageId": "msg003",
      "role": "user",
      "type": "voice",
      "content": "",
      "audioUrl": "https://example.com/audio/msg003.m4a",
      "transcript": "那今天适合做什么训练？",
      "createTime": "2026-04-28 10:01:00"
    }
  ]
}
```

### 响应字段说明

| 名称       | 类型   | 说明                       |
| ---------- | ------ | -------------------------- |
| messageId  | String | 消息唯一标识               |
| role       | String | 角色：user/ai              |
| type       | String | 消息类型：text/voice       |
| content    | String | 文本内容                   |
| audioUrl   | String | 语音URL（仅语音消息有）    |
| transcript | String | 语音转文本（仅语音消息有） |
| createTime | String | 创建时间                   |

***



## 接口3：发送消息


**请求方式：** POST

**请求参数：**

| 名称           | 类型   | 必填 | 说明                     |
| -------------- | ------ | ---- | ------------------------ |
| content        | String | 是   | 消息内容                 |
| type           | String | 是   | 消息类型：text/voice     |
| conversationId | String | 否   | 对话ID，不传则创建新对话 |
| audioUrl       | String | 否   | 语音URL（仅语音消息有）  |

### 响应示例

```json
{
  "code": 0,
  "data": {
    "conversationId": "conv001",
    "messageId": "msg004",
    "aiResponse": {
      "messageId": "msg005",
      "role": "ai",
      "type": "text",
      "content": "根据你目前的训练状态，今天建议进行中等强度的有氧训练，如慢跑或骑行40-60分钟。",
      "createTime": "2026-04-28 15:30:00"
    }
  }
}
```

### 响应字段说明

| 名称                  | 类型   | 说明             |
| --------------------- | ------ | ---------------- |
| conversationId        | String | 对话唯一标识     |
| messageId             | String | 用户消息ID       |
| aiResponse.messageId  | String | AI回复消息ID     |
| aiResponse.role       | String | 角色（固定为ai） |
| aiResponse.type       | String | 消息类型         |
| aiResponse.content    | String | AI回复内容       |
| aiResponse.createTime | String | 创建时间         |

***



## 接口4：发送消息（流式输出）


**请求方式：** POST

**Content-Type：** application/json

**请求参数：**

| 名称           | 类型   | 必填 | 说明                     |
| -------------- | ------ | ---- | ------------------------ |
| content        | String | 是   | 消息内容                 |
| type           | String | 是   | 消息类型：text/voice     |
| conversationId | String | 否   | 对话ID，不传则创建新对话 |
| audioUrl       | String | 否   | 语音URL（仅语音消息有）  |

### 响应示例（SSE流式）

```
event: message
data: {"messageId": "msg005", "content": "根据", "done": false}

event: message
data: {"messageId": "msg005", "content": "你的", "done": false}

event: message
data: {"messageId": "msg005", "content": "训练", "done": false}

event: message
data: {"messageId": "msg005", "content": "状态...", "done": false}

event: done
data: {"messageId": "msg005", "done": true}
```

### 流式事件说明

| 事件    | 说明                               |
| ------- | ---------------------------------- |
| message | 逐字返回内容，done=false表示未完成 |
| done    | 最终完成信号，done=true            |

***



## 接口5：新建对话


**请求方式：** POST

**请求参数：** 无

### 响应示例

```json
{
  "code": 0,
  "data": {
    "conversationId": "conv003",
    "title": "新对话",
    "createTime": "2026-04-29 10:00:00"
  }
}
```

### 响应字段说明

| 名称           | 类型   | 说明                     |
| -------------- | ------ | ------------------------ |
| conversationId | String | 对话唯一标识             |
| title          | String | 对话标题（默认"新对话"） |
| createTime     | String | 创建时间                 |

***



## 接口6：删除对话


**请求方式：** DELETE

**请求参数：**

| 名称           | 类型   | 必填 | 说明         |
| -------------- | ------ | ---- | ------------ |
| conversationId | String | 是   | 对话唯一标识 |

### 响应示例

```json
{
  "code": 0,
  "msg": ""
}
```

***



## 接口7：删除消息


**请求方式：** DELETE

**请求参数：**

| 名称      | 类型   | 必填 | 说明         |
| --------- | ------ | ---- | ------------ |
| messageId | String | 是   | 消息唯一标识 |

### 响应示例

```json
{
  "code": 0,
  "msg": ""
}
```

***



## 接口8：获取欢迎语


**请求方式：** GET

**请求参数：** 无

### 响应示例

```json
{
  "code": 0,
  "data": {
    "title": "BOOM COACH",
    "message": "昨天你睡的好吗？"
  }
}
```

### 响应字段说明

| 名称    | 类型   | 说明          |
| ------- | ------ | ------------- |
| title   | String | 欢迎标题      |
| message | String | 欢迎语/开场白 |

***



## 接口9：上传语音


**请求方式：** POST

**Content-Type：** multipart/form-data

**请求参数：**

| 名称           | 类型   | 必填 | 说明                    |
| -------------- | ------ | ---- | ----------------------- |
| file           | File   | 是   | 语音文件（m4a/wav/mp3） |
| conversationId | String | 否   | 对话ID                  |

### 响应示例

```json
{
  "code": 0,
  "data": {
    "audioUrl": "https://example.com/audio/voice001.m4a",
    "duration": 5,
    "transcript": "今天适合做什么运动？"
  }
}
```

### 响应字段说明

| 名称       | 类型    | 说明           |
| ---------- | ------- | -------------- |
| audioUrl   | String  | 语音文件URL    |
| duration   | Integer | 语音时长（秒） |
| transcript | String  | 语音转文本结果 |

***



## 接口10：中断流式输出


**请求方式：** POST

**请求参数：**

| 名称           | 类型   | 必填 | 说明         |
| -------------- | ------ | ---- | ------------ |
| conversationId | String | 是   | 对话唯一标识 |

### 响应示例

```json
{
  "code": 0,
  "msg": ""
}
```

***


## 接口11：消息反馈


**请求方式：** POST

**请求参数：**

| 名称      | 类型   | 必填 | 说明                   |
| --------- | ------ | ---- | ---------------------- |
| messageId | String | 是   | 消息唯一标识           |
| feedback  | String | 是   | 反馈类型：like/dislike |

### 响应示例

```json
{
  "code": 0,
  "msg": ""
}
```

***


