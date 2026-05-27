---
category: ecommerce
type: OSS
status: seedling
---
## 图片和视频大小校验

**前端**和**OSS后端**处理

### OSS后端Policy
在前端直传方案中，前端需要先向 go-kratos 请求一个“上传凭证（PostPolicy）”或“STS Token”。在 kratos 后端生成这个 Policy 时，可以直接硬性规定文件大小。
- **实现方式：** 在调用 OSS SDK 生成签名时，设置 `content-length-range` 条件。
- **效果：** 如果前端伪造请求或强行上传超过此限制的文件，OSS 服务端会直接拒绝接收，返回 `400 Bad Request`，从而保护了你的存储空间。
- _示例（以阿里云为例）：_ 限制图片为 0 - 5MB，视频为 0 - 500MB。

### 前端预校验
- **实现方式：** 在前端（如 Vue/React/小程序）的上传组件中，读取文件的 `File.size` 属性。
- **效果：** 如果超出限制，直接在 UI 弹窗提示用户“文件过大”，实现“秒拒”，避免浪费用户的上传时间和网络流量。

## 前端直传 OSS 的核心流程（配合 go-kratos）

在 Kratos 中，你需要设计两个核心的 API 接口：**获取凭证接口** 和 **OSS回调接口**。

**完整交互步骤如下：**

1. **前端请求凭证：** 前端在用户选择文件后，调用 Kratos 接口 `GET /v1/oss/upload-token`。
2. **Kratos 下发凭证：** Kratos 调用 OSS SDK 生成带有过期时间（如 15 分钟）和大小限制的 PostPolicy 及签名，返回给前端。
3. **前端直接上传：** 前端携带文件实体和获取到的签名，**直接发起 POST 请求到 OSS 的公网/内网 Endpoint**。
4. **OSS 回调（关键）：** OSS 接收文件成功后，会主动向你的 Kratos 服务器发起一个 POST 请求（即回调，地址在步骤 2 中由 Kratos 指定给 OSS）。
5. **Kratos 确认回调：** Kratos 收到 OSS 的回调请求，校验签名无误后，将业务数据（如：商品图片URL、商品ID）写入数据库，并向 OSS 返回 `{"Status":"OK"}`。
6. **前端获取结果：** OSS 收到 Kratos 的确认后，将 HTTP 200 返回给前端。前端提示用户“上传成功”。