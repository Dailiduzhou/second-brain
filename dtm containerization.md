---
category: microsvc
topic: dtm
type: deployment
status: seedling
---

# DTM 容器化部署

DTM 的 Docker 与 K8s 部署配置。

**DTM** 的官方镜像`yedf/dtm` 开始就运行，依赖dtm-config.yaml

`dtm-config.yaml`
```yaml
Store:        
  Driver: postgres
  Host: postgres
  Port: 5432
  User: postgres
  Password: postgres
  Db: dtm
HTTPPort: 36789
GrpcPort: 36790

```
在其中配置驱动和数据源。

在`docker-compose.yml` 中
```yaml
  dtm:
    image: yedf/dtm:latest
    ports:
      - "36789:36789"
      - "36790:36790"
    volumes:
      - ./deploy/dtm-config.yml:/app/dtm/configs/config.yml
    depends_on:
      - postgres

```

## 相关链接
- [[dtm]]
- [[微服务]]
