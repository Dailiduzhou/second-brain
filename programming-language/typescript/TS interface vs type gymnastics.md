---
title: TS interface vs type gymnastics
category: programming-language
type: language-feature
topic: typescript
status: seedling
tags:
  - programming-language
  - programming-language/typescript
aliases:
  - TS interface vs type
  - TypeScript interface 与 type 的取舍
---

# TS interface vs type gymnastics

在 TypeScript 中表示复杂类型时，到底是使用 `type`（类型别名）直接组合，还是使用 `interface XXX extends ...`（接口继承），是开发者经常遇到的一个架构选择问题。

> [!summary] 简明结论
> **没有特殊类型运算需求时，首选 `interface`；需要复杂类型推导和运算时，必须使用 `type`。**

下面从**灵活性**、**编译性能**、**扩展性与冲突处理**三个角度展开对比。

## 1. 灵活性与能力边界

`type` 和 `interface` 在能力上存在明确分野：

- `type` 支持泛型、条件类型、映射类型、模板字面量类型、`infer` 等全部高级类型运算。
- `interface` 只能描述对象结构（`extends` / 合并），无法表达 `A | B`、`Pick<T, K>` 之类的运算。

```typescript
// 这种复杂的类型转换，interface 根本做不到
type ComplexState<T> = T extends { id: infer U }
  ? U | null
  : Omit<T, 'secret'> & { status: string };
```

## 2. 编译性能

TypeScript 官方性能 Wiki 明确建议：**在表示对象结构时，优先使用 `interface` 而不是 `type` 的交叉 (`&`)**。

### `interface` 的性能优势

- `interface A extends B` 在编译器内部被视为**单一的扁平对象类型**，并带缓存。
- 编译器只检查 `A` 是否满足 `B` 的约束，计算是**惰性（Lazy）**且高效的。
- 同名 `interface` 还会触发**声明合并（Declaration Merging）**，进一步减少重复声明。

### `type` 交叉 (`&`) 的性能损耗

- `type A = B & C & D` 在每次类型检查时都会被**递归且即时地（Eagerly）**展开并合并属性。
- 在大型项目里深层嵌套交叉类型，会显著拖慢编译时间。
- 极端情况下会触发：

  > `Type instantiation is excessively deep and possibly infinite.`

## 3. 扩展性与冲突处理

当复杂类型需要继承多个父级类型时，两者处理同名属性冲突的方式完全不同：

### `interface`：声明期硬性校验

```typescript
interface A { value: string; }

// ❌ 报错：接口 'B' 错误扩展了接口 'A'。'value' 类型不兼容。
interface B extends A { value: number; }
```

### `type`：冲突静默合并为 `never`

```typescript
type A = { value: string };
type B = A & { value: number };
// B.value 的类型推导为 string & number = never
const x: B = { value: 'hello' }; // ❌ 编译报错：不能将 string 赋给 never
```

> [!warning] 静默合并的隐患
> 交叉类型中的同名属性冲突不会立刻报错，而是合并为 `never`，往往在远离定义处才暴露。`interface` 能在声明期就阻止这种写法。

## 4. 对比总览

| 特性 / 维度       | `interface extends`           | `type &`（交叉类型）              |
| ----------------- | ----------------------------- | --------------------------------- |
| 主要定位          | 面向对象、描述数据结构（Shape） | 函数式、类型推导与运算            |
| 编译性能          | 极佳（有缓存，扁平化处理）     | 较差（计算开销大，易引发深度错误） |
| 属性冲突          | 声明时报错（安全）             | 合并为 `never`（易出隐患）        |
| 同名合并          | 支持（Declaration Merging）    | 不支持                            |
| 高级类型支持      | ❌ 不支持映射、条件、联合      | ✅ 完全支持所有高级类型运算       |

## 5. 团队开发的推荐准则

1. **定义 API 响应、组件 Props、数据库模型等明确的对象结构时：** 始终优先使用 `interface`。
2. **需要从现有类型中衍生新类型（如 `Pick`、`Omit`、`ReturnType`）或使用联合类型（`A | B`）时：** 使用 `type`。
3. **开发公共 npm 包暴露给外部的类型：** 尽量使用 `interface`，以便使用者通过声明合并进行扩展。

## 相关文档

- [[Typescript]]
