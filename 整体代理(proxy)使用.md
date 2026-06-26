---
category: ccnubox
type: deep-dive
topic: proxy
frameworks:
  - net/http
module: common
status: seedling
tags:
  - ccnubox
  - ccnubox/common
  - ccnubox/common/middleware
  - ccnubox/common/middleware/proxy
  - programming-language/go/http
---
## 为什么需要代理

开发环境可以直连`华师教务系统`。
但生产环境在云端，可能需要特殊处理，减少被封的可能性。

## 如何配置区分生产和开发环境

更改配置文件：
```yaml
# config-infra.yaml
proxy:
  mode: "remote"  # 改成 "direct" 则绕过代理
```

## 如何实现代理功能

### 配置选项

使用了`函数选项式`配置。
```
配置HttpProxy
|
配置HttpTransport(thin wrapper of http.Transport)
|
配置HttpClient(thin wrapper of *http.Client)
```

`HttpProxy`结构
```go
type HttpProxy struct {
	Addr       string
	AddrBackup string

	direct bool
	mu     sync.RWMutex
	p      proxyv1.ProxyClient
	l      logger.Logger
}
```

存储主副代理地址，保存`gRPC client`，通过**定时任务**更新代理地址。使用`sync.RWMutex`来保证**线程安全**。

存储代理地址和更新逻辑：
```go
func NewHttpProxy(p proxyv1.ProxyClient, l logger.Logger) Client {
	globalProxy = &HttpProxy{p: p, l: l}

	globalProxy.update()
	c := cron.New()
	_, _ = c.AddFunc("@every 15s", globalProxy.update) // 定时任务
	c.Start()

	return globalProxy
}

func (s *HttpProxy) GetProxyAddr(_ context.Context, cnt int) []string {
	if s.direct {
		return make([]string, cnt)
	}

	s.mu.RLock()
	defer s.mu.RUnlock()

	addrs := make([]string, cnt)
	for i := 0; i < cnt; i++ {
		if i == 0 {
			addrs[i] = s.Addr
		} else {
			addrs[i] = s.AddrBackup
		}
		if addrs[i] == "" && i > 0 {
			addrs[i] = addrs[0]
		}
	}
	return addrs
}

func (s *HttpProxy) update() {
	if s.direct {
		return
	}
	if s.p == nil {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second*2)
	defer cancel()

	res, err := s.p.GetProxyAddr(ctx, &proxyv1.GetProxyAddrRequest{})
	if err != nil {
		if l := s.logger(ctx); l != nil {
			l.Warn("从 be-proxy 获取代理地址失败", logger.Error(err))
		}
		return
	}

	s.mu.Lock()
	s.Addr, s.AddrBackup = res.Addr, res.Backup
	s.mu.Unlock()
}
```

> [!info]
> 代码维护了一个**全局单例**的`globalProxy` (`globalProxy = new(HttpProxy)
> 保证同一进程中的所有微服务共享代理。

> [!warning]
> 全局单例模式，违反了 **DI** 的原则。
> 对全局单例的配置，牵连过多。
### 代理具体实现

依赖了官方`net/http`中 low-level 的 `http.Transport`，顺便控制了最大连接数，保活和空闲连接数等参数。

```go
func (c *HttpClient) Use(options ...Option) {
	if len(options) == 0 {
		return
	}
	for _, option := range options {
		option(c)
	}
}
func WithTransport(tr *HttpTransport) Option {
	return func(client *HttpClient) {
		client.Transport = tr
	}
}

func WithProxyTransport(options ...RoundTripperOption) Option {
	return func(client *HttpClient) {
		tr := globalProxy.NewProxyTransport()
		if globalProxy.direct { // 使用直连模式
			tr.Use(options...)
			client.Transport = tr
			return
		}
		
		// 使用代理模式
		// 这里tr.Proxy的类型本来就是 func(*http.Request) (*url.URL, error)
		tr.Proxy = func(req *http.Request) (*url.URL, error) {
			ctx := req.Context()
			addrs := globalProxy.GetProxyAddr(ctx, 1)
			proxyAddr := strings.TrimSpace(addrs[0])
			if proxyAddr == "" {
				return nil, nil
			}
			proxyURL, err := url.Parse(proxyAddr)
			if err != nil {
				if l := globalProxy.logger(ctx); l != nil {
					l.Warn("代理地址解析失败，fallback 到直连",
						logger.String("proxy_addr", proxyAddr),
						logger.Error(err),
					)
				}
				return nil, nil
			}
			return proxyURL, nil
		}

		tr.Use(options...)
		client.Transport = tr
	}
}
```

### 微服务中调用的方式

典型流程（以 be-ccnu/crawler/common.go 为例）：
```go
// 注入 proxy.Client
func NewCrawlerClient(pc proxy.Client, t time.Duration, options ...proxy.Option) *http.Client {
    opts := []proxy.Option{
        proxy.WithProxyTransport(),          // 启用代理
        proxy.WithRedirectPolicy(proxy.RedirectPolicyAllow),
        proxy.WithTimeout(t),
        proxy.WithCookieJar(j),
    }
    return pc.NewProxyClient(opts...).Client  // 创建带代理的 http.Client
}
```
