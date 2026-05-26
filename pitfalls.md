---
category: microsvc
framework: go-zero
topic: pitfalls
status: seedling
---

# go-zero 踩坑记录

go-zero 框架使用过程中遇到的问题与解决方案。

# 记录一些搞这个项目遇到的坑

## 创建微服务
```bash
goctl rpc new XXX
```
会自动查找父目录中的`go.mod`，并且根据那个`go.mod`进行import代码的生成。

注意要创建自己针对这个项目的`go.mod`。

## 更新根据`.proto`文件生成的代码

例如：
```bash
goctl rpc new user
cd user
# 更改了.proto
goctl rpc protoc -go_out=. -go-grpc_out=. -zrpc_out=.
```

`zrpc`是`go-zero`的各个grpc微服务互相调用的依赖包。
## Redis字段冲突

`zrpc.RpcServerConf`中有`Redis`字段，所以在`/etc/XXX.yaml`中需要用`BizRedis`来避免冲突


## grpc互相调用
即使定义是是用**XXX**的，在`goctl rpc protoc`生成之后，包名可能会出现`client`后缀。

## 错误处理
官方认定的最佳实践[go-zero-looklook](https://github.com/Mikaelemmmm/go-zero-looklook)

其中使用的就是`github.com/pkg/errors`作为错误处理包。
internal/logic层返回的error一般都是使用`errors.Wrapf`包裹。

## 相关链接
- [[微服务]]
- [[go-zero key takeaway]]
