#microsvc/go-kratos/architect

## MonoRepo(单体仓库)
#microsvc/go-kratos/architect/monorepo 

1. 先新建仓库
```bash
mkdir monorepo
cd monorepo
go mod init monorepo && go mod tidy
```
2. 创建api定义和业务的layout
```bash
mkdir api
mkdir app
kratos proto add api/user/v1/product.proto
# 使用--nomod不创建go mod
kratos new app/product --nomod 
```

```
.
├── api         // <--- api定义， api_proto,error_proto文件所在
│   ├── product
│   └── user
├── app         // <--- 实际业务
│   ├── product
│   └── user
├── docker-compose.yml
├── go.mod       // 仓库仅有的go.mod
├── go.sum
├── openapi.yaml
├── pkg
│   ├── logger
│   └── trace
├── test_replicas.txt
├── test.txt
├── third_party // <-- 第三方proto库
│   ├── errors
│   └── google
```

**注意**：因为`Dockerfile`在各个子目录中，并且不同微服务可能需要共同依赖`logger`, `trace`等包，所以`Dockerfile`需要更改。`docker-compose.yml`中，启动微服务的时候，需要设置`build context`

### workaround
**`Dockerfile`** 
```Dockerfile
FROM golang:1.25-alpine AS builder

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories && \
    apk add --no-cache git make

WORKDIR /src

ENV GOPROXY=https://goproxy.cn,direct

COPY go.mod go.sum ./
RUN go mod download

COPY api/ ./api/
COPY app/product/ ./app/product/
COPY pkg/ ./pkg/

# 编译二进制文件
RUN cd app/product/cmd/product && \
    CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /bin/product .

FROM alpine:3.21 AS runner

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories && \
    apk add --no-cache ca-certificates tzdata

WORKDIR /app

COPY --from=builder /bin/product /app/product

RUN mkdir -p /app/logs

EXPOSE 8000 9000
VOLUME /data/conf

CMD ["./product", "-conf", "/data/conf"]
```

**`docker-compose.yml`** 

```yaml
services:
  product:
    build:
      context: .
      dockerfile: app/product/Dockerfile
    ports:
      - "8000:8000"
      - "9000:9000"
    volumes:
      - ./app/product/configs:/data/conf
      - product_logs:/app/logs
    depends_on:
      - postgres
```

## 各微服务拆分
#microsvc/go-kratos/architect/independent 

每个微服务拥有各自的`Git`仓库和独自的`go.mod`

## 微服务集成架构
#microsvc/go-kratos/architect/integration 

为了部署到性能差的云服务器上，需要把部分微服务集成在同一个binary中，以减少进程数量和内存占用。