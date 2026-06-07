---
category: microservice
frameworks:
  - go-kratos
topic: layout
status: seedling
tags:
  - microservice/go-kratos
  - architecture/layout
---

# kratos 目录结构

go-kratos 项目标准目录布局说明。

## api proto修改后

```bash
kratos proto client path/to/your/sth.proto
kratos proto server path/to/your/sth.proto -t path/to/your/service
```

## config.yaml修改后

`configs/config.yaml`和`internal/conf/conf.proto`的字段有对应关系。

需要同时修改。有些配置读取到`BootStrap`，也需要依靠`Bootstrap`进行解析。

修改后，需要运行
```bash
make config #如果是标准的layout

# 自己如果有本地的kratos
protoc --go_out=. \
	   --go_opt=paths=source_realtive \
	   -I. \
	   -I$(go env GOPATH)/src/github.com/go-kratos/kratos/third_party \
	   path/to/your/conf/conf.proto

# Workaround 拷贝third_party
```

## 相关链接
- [[微服务]]
- [[go-kratos架构]]
