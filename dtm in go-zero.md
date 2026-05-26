---
category: microsvc
framework: go-zero
topic: dtm
status: seedling
---

# go-zero 中使用 DTM

在 go-zero 框架中集成 DTM 分布式事务。
#microsvc/go-kratos/dtm
#dtm/go-zero

## 事务屏障和连接复用

使用事务屏障需要数据库的连接。
**错误做法**：
```go
	db, err := sqlx.NewMysql(l.svcCtx.Config.Mysql.DataSource).RawDB()
	if err != nil {
		return nil, status.Error(500, err.Error())
	}

	// 获取子事务屏障对象
	barrier, err := dtmgrpc.BarrierFromGrpc(l.ctx)
	if err != nil {
		return nil, status.Error(500, err.Error())
	}
	// 开启子事务屏障
	err = barrier.CallWithDB(db, func(tx *sql.Tx) error {
		// 更新产品库存
		_, err := l.svcCtx.ProductModel.TxAdjustStock(l.ctx, tx, in.Id, 1)
		return err
	
```
`sqlx.NewMysql`每次重新建立数据库连接，非常影响性能。

**最佳实践**是保留原本数据库的连接池，进行连接复用：
`internal/svc/servicecontext.go`
```go
type ServiceContext struct {
    Config config.Config
    
    // 保存 SqlConn 接口
    DB         sqlx.SqlConn
    OrderModel model.OrderModel
    UserRpc    user.User
    ProductRpc product.Product
}
func NewServiceContext(c config.Config) *ServiceContext {
    conn := sqlx.NewMysql(c.Mysql.DataSource)  // ✅ 只创建一次
    
    return &ServiceContext{
        Config:     c,
        DB:         conn,  // 保存连接池
        OrderModel: model.NewOrderModel(conn, c.CacheRedis),
        UserRpc:    user.NewUser(zrpc.MustNewClient(c.UserRpc)),
        ProductRpc: product.NewProduct(zrpc.MustNewClient(c.ProductRpc)),
    }
}
// GetRawDB 获取底层 *sql.DB 用于 DTM barrier
func (s *ServiceContext) GetRawDB() (*sql.DB, error) {
    return s.DB.RawDB()
}
```

`internal/logic/XXX.go`
```go
func (l *CreateLogic) Create(in *order.CreateRequest) (*order.CreateResponse, error) {
    // ✅ 复用 ServiceContext 中的连接池
    db, err := l.svcCtx.GetRawDB()
    if err != nil {
        return nil, status.Error(500, err.Error())
    }
    // 获取子事务屏障对象
    barrier, err := dtmgrpc.BarrierFromGrpc(l.ctx)
    if err != nil {
        return nil, status.Error(500, err.Error())
    }
    
    // 开启子事务屏障
    if err := barrier.CallWithDB(db, func(tx *sql.Tx) error {
        // ... 业务逻辑
    }); err != nil {
        return nil, status.Error(500, err.Error())
    }
    return &order.CreateResponse{}, nil
}
```

## 相关链接
- [[dtm]]
- [[微服务]]
