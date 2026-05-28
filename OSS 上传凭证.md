---
category: ecommerce
type: object-storage
status: seedling
tags: ecommerce
---
# OSS 上传凭证

## 核心防御：后端 Policy 限制

前端直传方案中，后端在生成上传凭证（PostPolicy / STS Token）时硬性规定文件大小。

- **实现方式：** 调用 OSS SDK 生成签名时设置 `content-length-range` 条件
- **效果：** 伪造请求或超限文件直接被 OSS 服务端拒绝（`400 Bad Request`），保护存储和带宽
- **示例（阿里云）：** 图片 0-5MB，视频 0-500MB

## 用户体验：前端预校验

- **实现方式：** 上传组件中读取 `File.size` 属性
- **效果：** 超限直接在 UI 弹窗提示，秒拒，避免浪费用户时间和流量

## 相关链接

- [[OSS 实现]]
- [[OSS 直传流程]]
- [[OSS 回调处理]]
