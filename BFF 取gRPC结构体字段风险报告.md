---
category: ccnubox
type: vulnerability
topic: grpc-nil-safety
module: bff
status: seedling
tags:
  - ccnubox
  - ccnubox/vulnerability
  - ccnubox/bff
  - golang/grpc
vul-status: to-be-done
---

# BFF gRPC 返回值空指针风险分析

## 原理

通过 `protoc` 生成的 `xxx.pb.go` 中，结构体的字段可能为空值（`nil`）。
此时直接通过 **`.` 操作符** 取字段，会导致 `panic`。

生成的代码中，有空值安全的 **`GetXxx()`** 方法。经过校验能防止空值。

## 背景

BFF 层通过 gRPC 调用后端微服务，拿到 protobuf 生成的响应结构体后，大量使用 `.` 操作符直接访问字段。
本文档梳理其中存在空指针 panic 风险的代码段。

### 核心前提

- gRPC 网络超时/连接失败会返回 `err != nil`，BFF 已有 `if err != nil` 保护，不会走到取值逻辑
- gRPC server 端有 `recovery.Recovery()` 中间件，server panic 会转为 error 返回给客户端
- **真正的风险在于**：server 正常返回（`err == nil`），但响应结构体中的 **嵌套 message 指针字段为 nil**，或 **repeated 指针切片中包含 nil 元素**

### 危险模式一览

| 模式 | 示例 | 是否会 panic |
|------|------|-------------|
| resp 上的标量字段（string/int/bool） | `resp.Name` | 不会，值类型有零值 |
| resp 上的嵌套 message 指针字段 | `resp.SubMsg.Field` | **会**，SubMsg 可能为 nil |
| 遍历 `[]*T` 切片后访问元素字段 | `for _, item := range resp.Items { item.X }` | **会**，元素可能为 nil |

---

## 高风险：嵌套 message 指针直接 `.` 取值

### 1. `bff/web/feed/feed.go:174-180` — AllowList 空指针

```go
allowlist, err := h.feedClient.FindOrCreateAllowList(ctx, &feedv1.FindOrCreateAllowListReq{StudentId: uc.StudentId})
if err != nil {
    return web.Response{}, errs.GET_FEED_ALLOW_LIST_ERROR(err)
}
return web.Response{
    Msg: "Success",
    Data: GetFeedAllowListResp{
        Grade:    allowlist.AllowList.Grade,     // AllowList 是 *AllowList，可能为 nil
        Muxi:     allowlist.AllowList.Muxi,
        Holiday:  allowlist.AllowList.Holiday,
        Energy:   allowlist.AllowList.Energy,
        FeedBack: allowlist.AllowList.FeedBack,
    },
}, nil
```

**proto 定义**：`FindOrCreateAllowListResp.AllowList` 类型为 `*AllowList`

**风险**：如果 server 端返回的 `FindOrCreateAllowListResp` 中 `AllowList` 字段未赋值（nil），
连续 5 次 `allowlist.AllowList.Xxx` 全部会触发 nil pointer dereference panic。

**修复建议**：
```go
al := allowlist.GetAllowList() // nil-safe getter，返回零值 AllowList 而非 nil
return web.Response{
    Msg: "Success",
    Data: GetFeedAllowListResp{
        Grade:    al.GetGrade(),
        Muxi:     al.GetMuxi(),
        Holiday:  al.GetHoliday(),
        Energy:   al.GetEnergy(),
        FeedBack: al.GetFeedBack(),
    },
}, nil
```

---

### 2. `bff/web/library/library.go:196-199` — CreditSummary 空指针

```go
res, err := h.LibraryClient.GetCreditPoint(ctx, &libraryv1.GetCreditPointRequest{
    StuId: uc.StudentId,
})
if err != nil {
    return web.Response{}, errs.GET_CREDIT_POINTS_ERROR(err)
}

summary := CreditSummary{
    System: res.CreditSummary.System,   // CreditSummary 是 *CreditSummary，可能为 nil
    Remain: res.CreditSummary.Remain,
    Total:  res.CreditSummary.Total,
}
```

**proto 定义**：`GetCreditPointResponse.CreditSummary` 类型为 `*CreditSummary`

**风险**：如果 server 未设置 `CreditSummary` 字段，此处连续 3 次 nil 解引用 panic。

**修复建议**：
```go
cs := res.GetCreditSummary()
summary := CreditSummary{
    System: cs.GetSystem(),
    Remain: cs.GetRemain(),
    Total:  cs.GetTotal(),
}
```

---

### 3. `bff/web/class/class.go:72-88` — Class.Info 空指针

```go
for _, class := range getResp.Classes {
    respClasses = append(respClasses, &ClassInfo{
        ID:           class.Info.Id,            // Info 是 *ClassInfo，可能为 nil
        Day:          class.Info.Day,
        Teacher:      class.Info.Teacher,
        Where:        class.Info.Where,
        ClassWhen:    class.Info.ClassWhen,
        WeekDuration: class.Info.WeekDuration,
        Classname:    class.Info.Classname,
        Credit:       class.Info.Credit,
        Weeks:        convertWeekFromIntToArray(class.Info.Weeks),
        Semester:     class.Info.Semester,
        Year:         class.Info.Year,
        Note:         class.Info.Note,
        IsOfficial:   class.Info.IsOfficial,
        Nature:       class.Info.Nature,
    })
}
```

**proto 定义**：`Class.Info` 类型为 `*ClassInfo`；`GetClassResponse.Classes` 类型为 `[]*Class`

**风险**：`class` 本身是 `*Class`（可能为 nil），`class.Info` 是 `*ClassInfo`（也可能为 nil）。
13 次连续 `.` 访问，任一为 nil 即 panic。

**修复建议**：
```go
for _, class := range getResp.GetClasses() {
    if class == nil {
        continue
    }
    info := class.GetInfo() // nil-safe
    respClasses = append(respClasses, &ClassInfo{
        ID:           info.GetId(),
        Day:          info.GetDay(),
        // ... 其余字段同理使用 GetXxx()
    })
}
```

---

### 4. `bff/web/health/health.go:50-59` — 健康检查 resp 空指针

```go
func (h *HealthHandler) ReadyCheck(c *gin.Context) (web.Response, error) {
    var res = make(map[string]string)
    for n, client := range h.clients {
        resp, err := client.Check(c, &healthpb.HealthCheckRequest{})
        if err != nil {
            res[n] = err.Error()
            log.Printf("服务 %s 健康检查失败: %v", n, err)
        }
        res[n] = resp.Status.String()   // err != nil 时没有 continue，resp 可能为 nil
    }
    // ...
}
```

**风险**：当 `err != nil` 时，gRPC 返回的 `resp` 通常为 nil。
代码在 `if err != nil` 块后没有 `continue`，直接执行 `resp.Status.String()` 会导致 nil pointer dereference panic。

**修复建议**：
```go
if err != nil {
    res[n] = err.Error()
    log.Printf("服务 %s 健康检查失败: %v", n, err)
    continue   // 添加 continue，跳过后续 resp 访问
}
res[n] = resp.Status.String()
```

---

## 中风险：`[]*T` 切片元素可能为 nil

以下代码遍历的切片元素类型为指针（`*T`），如果 server 端序列化时某个元素为 nil，
遍历时直接 `.` 取值会 panic。

### 5. `bff/web/grade/grade.go:77-93` — Grades 切片元素

```go
for _, grade := range grades.Grades {     // Grades 是 []*Grade
    resp.Grades = append(resp.Grades, Grade{
        Xnm:    grade.Xnm,                // grade 可能为 nil
        Xqm:    grade.Xqm,
        Kcmc:   grade.Kcmc,
        // ... 12 个字段全部直接 . 取值
    })
}
```

**修复建议**：
```go
for _, grade := range grades.GetGrades() {
    if grade == nil {
        continue
    }
    resp.Grades = append(resp.Grades, Grade{
        Xnm: grade.GetXnm(),
        // ...
    })
}
```

---

### 6. `bff/web/grade/grade.go:178-193` — TypeOfGradeScore / GradeScoreList 双层嵌套

```go
for _, grade := range score.TypeOfGradeScore {          // []*TypeOfGradeScore，grade 可能为 nil
    typeOfGradeScore := TypeOfGradeScore{
        Kcxzmc:         grade.Kcxzmc,
        GradeScoreList: make([]*GradeScore, len(grade.GradeScoreList)),
    }
    for i := range grade.GradeScoreList {               // []*GradeScore，元素可能为 nil
        typeOfGradeScore.GradeScoreList[i] = &GradeScore{
            Kcmc: grade.GradeScoreList[i].Kcmc,         // 元素可能为 nil
            Xf:   grade.GradeScoreList[i].Xf,
        }
    }
    resp.TypeOfGradeScores = append(resp.TypeOfGradeScores, typeOfGradeScore)
}
```

**修复建议**：
```go
for _, grade := range score.GetTypeOfGradeScore() {
    if grade == nil {
        continue
    }
    // ...
    for i, gs := range grade.GetGradeScoreList() {
        if gs == nil {
            continue
        }
        typeOfGradeScore.GradeScoreList[i] = &GradeScore{
            Kcmc: gs.GetKcmc(),
            Xf:   gs.GetXf(),
        }
    }
}
```

---

### 7. `bff/web/library/library.go:62-87` — RoomSeats / Seats / FreeList 三层嵌套

```go
for _, room := range res.RoomSeats {              // []*RoomSeat，room 可能为 nil
    for _, seat := range room.Seats {             // []*Seat，seat 可能为 nil
        for _, ts := range seat.FreeList {        // []*FreeTime，ts 可能为 nil
            freeList = append(freeList, FreeTime{
                Start: ts.Start,                  // nil 时 panic
                End:   ts.End,
            })
        }
        seatList = append(seatList, Seat{
            ID:     seat.ID,                      // nil 时 panic
            // ...
        })
    }
    roomList = append(roomList, Room{
        RoomID: room.RoomId,                      // nil 时 panic
    })
}
```

**修复建议**：每层遍历时加 nil 检查，或使用 `GetXxx()` getter。

---

### 8. `bff/web/library/library.go:247-262` — Discussions / DisableList 双层嵌套

```go
for _, d := range res.Discussions {              // []*Discussion，d 可能为 nil
    for _, t := range d.DisableList {            // []*DisableTime，t 可能为 nil
        ts = append(ts, DisableTime{
            Start: t.Start,                      // nil 时 panic
            End:   t.End,
        })
    }
    discussions = append(discussions, Discussion{
        RoomID:  d.RoomId,                       // nil 时 panic
        // ...
    })
}
```

---

### 9. `bff/web/library/library.go:149-164` — Record 切片元素

```go
for _, record := range res.Record {              // []*Record，record 可能为 nil
    respRecords = append(respRecords, Record{
        ID:        record.Id,                    // nil 时 panic
        SeatId:    record.SeatId,
        RoomName:  record.RoomName,
        // ... 12 个字段
    })
}
```

---

## 唯一的安全范例

`bff/web/classroom/classroom_vo.go:24-39` 是整个 BFF 中**唯一做了 nil 检查**的代码：

```go
func convertToGetFreeClassRoomResp(protoResp *cs.QueryFreeClassroomResp) *GetFreeClassRoomResp {
    if protoResp == nil {                    // 检查了顶层 resp
        return &GetFreeClassRoomResp{}
    }
    for _, stat := range protoResp.Stat {
        if stat == nil {                     // 检查了切片元素
            continue
        }
        result.Stat = append(result.Stat, ClassroomAvailableStat{
            Classroom:     stat.Classroom,
            AvailableStat: stat.AvailableStat,
        })
    }
    return &result
}
```

这是推荐的安全模式，其他 handler 应对齐此写法。

---

## 修复策略总结

### 方案 A：使用 protobuf 生成的 `GetXxx()` getter（推荐）

protobuf-go 为每个字段生成了 nil-safe 的 getter 方法：
- 对 message 指针字段：若 receiver 为 nil，返回零值而非 panic
- 对 repeated 字段：若 receiver 为 nil，返回 nil slice（range 安全）

```go
// 危险
allowlist.AllowList.Grade

// 安全 — 链式调用全用 getter
allowlist.GetAllowList().GetGrade()
```

### 方案 B：手动 nil 检查

```go
if class != nil && class.Info != nil {
    // 安全取值
}
```

### 方案 C：统一转换函数 + nil guard（参照 classroom_vo.go）

将 proto → VO 的转换逻辑抽到独立函数，在函数内做完整的 nil 检查，
handler 只调用转换函数，不直接 `.` 访问 proto 字段。

---

## 风险汇总表

| 文件 | 行号 | 风险字段 | proto 类型 | 严重度 |
|------|------|----------|-----------|--------|
| `feed/feed.go` | 174-180 | `allowlist.AllowList.X` | `*AllowList` | **高** |
| `library/library.go` | 197-199 | `res.CreditSummary.X` | `*CreditSummary` | **高** |
| `class/class.go` | 72-88 | `class.Info.X`（13次） | `*ClassInfo` | **高** |
| `health/health.go` | 53-58 | `resp.Status` | resp 可能 nil | **高** |
| `grade/grade.go` | 77-93 | `grade.X`（12次） | `[]*Grade` 元素 nil | 中 |
| `grade/grade.go` | 178-193 | 双层嵌套 | `[]*TypeOfGradeScore` / `[]*GradeScore` | 中 |
| `library/library.go` | 62-87 | 三层嵌套 | `[]*RoomSeat` / `[]*Seat` / `[]*FreeTime` | 中 |
| `library/library.go` | 149-164 | `record.X`（12次） | `[]*Record` 元素 nil | 中 |
| `library/library.go` | 247-262 | 双层嵌套 | `[]*Discussion` / `[]*DisableTime` | 中 |

## 跨主题链接

- [[华师匣子BFF结构]] — BFF 整体架构与代码分层
- [[华师匣子框架]] — 微服务架构与技术栈
- [[华师匣子-代码结构]] — 仓库目录布局
- [[华师匣子]] — 项目总览
