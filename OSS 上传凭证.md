---
category: ecommerce
type: object-storage
topic: oss
status: seedling
tags:
  - ecommerce/oss
---

# OSS 上传凭证

上传凭证是前端直传方案的安全边界。后端不接收文件本体，但必须通过 Policy 把允许上传的对象、大小、过期时间和回调参数限制住。

## 后端 Policy 约束

后端调用 OSS SDK 生成 PostPolicy 或 STS 临时凭证时，需要硬性设置以下条件：

| 约束 | 目的 |
|------|------|
| `content-length-range` | 限制文件大小，避免超限文件消耗存储和带宽 |
| `key` 或 `starts-with key` | 限制对象路径，避免覆盖任意文件 |
| 过期时间 | 缩短凭证泄漏后的可利用窗口 |
| `callback` | 指定 OSS 上传成功后的业务回调地址 |
| 自定义变量 | 带上 `goods_id`、`media_id` 等业务关联信息 |

示例限制：

- 商品图片：0-5 MB。
- 商品视频：0-500 MB。
- 临时目录：`tmp/{user_id}/{uuid}`。

## 前端预校验

前端仍然要在上传前读取 `File.size` 做一次体验层校验。

- 超限时直接提示用户，不发起 OSS 请求。
- 前端校验只改善体验，不能替代后端 Policy。
- 后端返回的限制值可以直接驱动上传组件，避免前后端规则不一致。

## 返回给前端的数据

凭证接口通常返回：

```json
{
  "url": "https://bucket.endpoint",
  "object_key": "tmp/42/01HX...",
  "expire_at": "2026-06-07T12:15:00Z",
  "form_data": {
    "key": "tmp/42/01HX...",
    "policy": "...",
    "signature": "..."
  }
}
```

前端把 `form_data` 展开放入 `multipart/form-data`，并把文件本体作为 `file` 字段提交给 OSS。

## 相关链接

- [[OSS 实现]]
- [[OSS 直传流程]]
- [[OSS 回调处理]]
- [[OSS + MQ整体流程]]
