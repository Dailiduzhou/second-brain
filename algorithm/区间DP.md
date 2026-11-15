---
category: algorithm
type: technique
topic: interval-dp
status: seedling
tags:
  - algorithm/dynamic-programming
  - algorithm/interval-dp
aliases:
  - 区间动态规划
---

# 区间DP

区间 DP 用 `dp[i][j]` 表示「下标 `i` 到 `j` 这段连续区间」的最优值，枚举分割点把区间切成左右两段，再由两段的最优值合并出整段的最优值。它由线性 DP 扩展而来：状态多了左右端点，转移多了一层分割点枚举，基础复杂度是 $O(n^3)$。入口见 [[Index Page#算法]]。

> [!important] 核心转移
> 令 $f(i, j)$ 表示将下标位置 $i$ 到 $j$ 的所有元素合并能获得的价值最大值，则
> $$f(i, j) = \max \{ f(i, k) + f(k+1, j) + cost \}$$
> 其中 $cost$ 是把这两组元素合并起来的价值。**$cost$ 只取决于区间的位置和处理的先后顺序，不取决于区间内部是怎么合并出来的**，否则左右子段的最优值无法直接复用，区间 DP 就不成立。

## 一、适用特征

- **合并**：即将两个或多个部分进行整合，当然也可以反过来。
- **特征**：能将问题分解为两两合并的形式。
- **求解**：对整个问题设最优值，枚举合并点，将问题分解为左右两个部分，最后合并两个部分的最优值得到原问题的最优值。也就是设置拆分点，使用不同的切分方式获取理想结果。

## 二、核心代码

先考虑短长度区间的最大/最小值，再枚举左边界，算出右边界，在边界中间进行分割点的枚举。

```cpp
for (int len = 2; len <= n; len++) {     // 区间长度
    for (int i = 0; i + len - 1 < n; i++) { // 左边界
        int j = i + len - 1;                // 左边界 + 区间长度 - 1 = 右边界
        for (int k = i + 1; k < j; k++) {   // 分割点
            dp[i][j] = max(dp[i][j], dp[i][k] + dp[k + 1][j] + cost);
        }
    }
}
```

外层必须按**区间长度递增**枚举：算 `dp[i][j]` 时依赖的所有严格子区间 `dp[i][k]`、`dp[k+1][j]` 都比它短，长度递增能保证它们已经算完。`len` 从 2 起，因为长度为 1 的区间是无需合并的初始状态。

> [!warning] 初始化决定答案对不对
> 求最大值时 `dp` 初值要小于任何可能结果（元素可为负时不能用 0），求最小值时要用 `INF`（如 `memset(dp, 0x3f, sizeof(dp))`）再单独回填长度为 1 的区间。环形例题里 `dpMin` 用 `0x3f` 灌满、`dpMax` 置 0，就是按各自的极值方向初始化的。

区间合并代价常常等于区间和，用前缀和在 $O(1)$ 取出，参考[[前缀和与差分]]。

## 三、例题

### 例 1：常规 —— 最后戳破的那个气球

#### 题面

[LeetCode 312 戳气球](https://leetcode.cn/problems/burst-balloons/description/)
有 `n` 个气球，编号为 `0` 到 `n - 1`，每个气球上都标有一个数字，这些数字存在数组 `nums` 中。

现在要求你戳破所有的气球。戳破第 `i` 个气球，你可以获得 `nums[i - 1] * nums[i] * nums[i + 1]` 枚硬币。这里的 `i - 1` 和 `i + 1` 代表和 `i` 相邻的两个气球的序号。如果 `i - 1` 或 `i + 1` 超出了数组的边界，那么就当它是一个数字为 `1` 的气球。

求所能获得硬币的最大数量。

#### 题解

这里对应 $cost$ 的是 `nums[i - 1] * nums[i] * nums[i + 1]`。
因为要考虑边界，所以将原来的数组 `nums` 扩展成首尾元素都为 1 的数组 `a`。
这里的 `dp[l][r]` 表示的是 `(l, r)` **开区间**的最大数值，`a[l]`、`a[r]` 是当前区间的左右边界气球；枚举的 `k` 是 `(l, r)` 中**最后一个**被戳破的气球，此时它的邻居恰好就是 `a[l]` 和 `a[r]`，代价与区间内部的戳破顺序无关，因此可以拆成 `dp[l][k] + dp[k][r]`。

```cpp
class Solution {
public:
  int maxCoins(vector<int> &nums) {
    int n = nums.size();
    vector<int> a(n + 2, 1);
    for (int i = 0; i < n; i++) {
      a[i + 1] = nums[i];
    }
    vector<vector<int>> dp(n + 2, vector<int>(n + 2, 0));
    for (int len = 2; len <= n + 2; len++) {
      for (int l = 0; l + len - 1 < n + 2; l++) {
        int r = l + len - 1;
        for (int k = l + 1; k < r; k++) {
          dp[l][r] = max(dp[l][r], dp[l][k] + a[l] * a[k] * a[r] + dp[k][r]);
        }
      }
    }

    return dp[0][n + 1];
  }
};
```

> [!note] 开区间状态
> 因为 `dp[l][r]` 是开区间，长度为 1 的区间（`r = l + 1`）是空区间，初值 0 即最优，所以循环从 `len = 2` 起、答案取 `dp[0][n + 1]`，整个数组用 `a[0] = a[n + 1] = 1` 补齐边界。

### 例 2：先取分割点，再加 $cost$ —— 合并石头

#### 题面

[LeetCode 1000 合并石头的最小成本](https://leetcode.cn/problems/minimum-cost-to-merge-stones/description/)
有 `n` 堆石头排成一排，第 `i` 堆中有 `stones[i]` 块石头。

每次 **移动** 需要将 **连续的** `k` 堆石头合并为一堆，而这次移动的成本为这 `k` 堆中石头的总数。

返回把所有石头合并成一堆的最低成本。如果无法合并成一堆，返回 `-1` 。

#### 题解

先把无解情况筛掉：每次合并把堆数减少 `k - 1`，从 `n` 堆合成 1 堆要求 `(n - 1) % (k - 1) == 0`，否则直接返回 `-1`。

石头总数使用前缀和进行计算，参考[[前缀和与差分]]。

```cpp
class Solution {
public:
  int mergeStones(vector<int> &stones, int k) {
    int n = stones.size();
    if ((n - 1) % (k - 1) != 0) {
      return -1;
    }

    vector<int> pre(n + 1);
    for (int i = 0; i < n; i++) {
      pre[i + 1] = pre[i] + stones[i];
    }
    vector<vector<int>> dp(n, vector<int>(n, 0));
    for (int len = k; len <= n; len++) {
      for (int i = 0; i + len - 1 < n; i++) {
        int j = i + len - 1;
        dp[i][j] = INT_MAX;
        for (int m = i; m < j; m += k - 1) {
          dp[i][j] = min(dp[i][j], dp[i][m] + dp[m + 1][j]);
        }
        if ((len - 1) % (k - 1) == 0) {
          dp[i][j] += pre[j + 1] - pre[i];
        }
      }
    }

    return dp[0][n - 1];
  }
};
```

与例 1 的顺序相反：这里**先枚举分割点、再加整段的 $cost$**。

- 分割点按 `k - 1` 步长枚举，保证左侧区间是能并成 0 或多个 `k` 长区间的形态，右侧区间不作要求。
- 只有当整段能真正并成一堆（`(len - 1) % (k - 1) == 0`）时，才加上这一整段的石头总数作为合并代价；不能并成一堆的长度只负责把区间规约到更少的堆数，不产生这次代价。
- 外层从 `len = k` 起，因为比 `k` 短的区间无法执行一次合并。

### 例 3：环形 —— 断环成链

#### 题面

[NOIP 石子合并（P1880）](https://www.luogu.com.cn/problem/P1880)
在一个圆形操场的四周摆放 $N$ 堆石子，现要将石子有次序地合并成一堆，规定每次只能选相邻的 $2$ 堆合并成新的一堆，并将新的一堆的石子数，记为该次合并的得分。

试设计出一个算法，计算出将 $N$ 堆石子合并成 $1$ 堆的最小得分和最大得分。

#### 题解

由于这是一个环，但我们要在一维数组上计算，所以要进行断链点的枚举。
比如，环是 `1->2->3->4->1->...`，可以断为 `1234`、`2341` 等。
直接枚举断链点，时间复杂度会多 `n` 倍，即从 $O(n^3)$ 退化到 $O(n^4)$。

所以可以考虑将数组变长一倍（`a[i + n] = a[i]`），然后用长度为 `n` 的滑动窗口覆盖所有断链方式：任一断法都对应倍长数组上某个长度为 `n` 的连续段。这样断链点被吸收进左端点的枚举里，时间复杂度保持 $O(n^3)$。

```cpp
#include <bits/stdc++.h>
using namespace std;

const int MAXN = 205;
const int INF = 0x3f3f3f3f;

int a[MAXN];
int sum[MAXN];
int dpMin[MAXN][MAXN];
int dpMax[MAXN][MAXN];

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int n;
    cin >> n;

    for (int i = 1; i <= n; i++) {
        cin >> a[i];
        a[i + n] = a[i]; // 变长一倍
    }

    for (int i = 1; i <= 2 * n; i++) {
        sum[i] = sum[i - 1] + a[i];  // 前缀和
    }

    memset(dpMin, 0x3f, sizeof(dpMin));
    memset(dpMax, 0, sizeof(dpMax));

    for (int i = 1; i <= 2 * n; i++) {
        dpMin[i][i] = 0;
        dpMax[i][i] = 0;
    }

    for (int len = 2; len <= n; len++) { // 长度最长为 n 的滑动窗口
        for (int l = 1; l + len - 1 <= 2 * n; l++) {
            int r = l + len - 1;

            for (int k = l; k < r; k++) {
                int mergeScore = sum[r] - sum[l - 1];

                dpMin[l][r] = min(dpMin[l][r],
                                  dpMin[l][k] + dpMin[k + 1][r] + mergeScore);

                dpMax[l][r] = max(dpMax[l][r],
                                  dpMax[l][k] + dpMax[k + 1][r] + mergeScore);
            }
        }
    }

    int ansMin = INF;
    int ansMax = -INF;

    for (int l = 1; l <= n; l++) { // 取每个长度为 n 的窗口
        int r = l + n - 1;         // 即 dp[l][l + n - 1]，代表一种断链结果
        ansMin = min(ansMin, dpMin[l][r]);
        ansMax = max(ansMax, dpMax[l][r]);
    }

    cout << ansMin << '\n';
    cout << ansMax << '\n';

    return 0;
}
```

三个容易写错的点：

- 区间长度的枚举上限是 `n` 而不是 `2 * n`：环上一次合并的连续段最长就是 `n`，窗口更长会把同一段石子重复数进来。
- 数组、前缀和都要开到 `2 * n`，分割点 `k` 从 `l` 开始（允许左侧只剩单堆）。
- 答案不是 `dp[1][n]`，而是所有 `dp[l][l + n - 1]`（`1 <= l <= n`）的最小/最大值。

## 四、三道例题的差异

| 例题 | $cost$ 出现的时机 | 状态区间 | 关键点 |
| --- | --- | --- | --- |
| LeetCode 312 戳气球 | 枚举的 `k` 就是最后处理的元素，代价挂在分割点上 | 开区间 `(l, r)` | 首尾补 1，绕开边界 |
| LeetCode 1000 合并石头 | 先枚举分割点，能并成一堆时再加整段区间和 | 闭区间 `[i, j]` | `(n-1)%(k-1)` 判无解，分割点步长 `k-1` |
| P1880 石子合并（环） | 每次合并都加当前区间和 | 闭区间，数组倍长 | 断环成链 + 长度为 `n` 的窗口 |

## 总结

区间 DP 的套路是固定的：**定状态（区间左右端点）→ 按长度递增枚举 → 枚举分割点合并左右最优值 → 按题目规则决定 $cost$ 何时加入**。三个例题分别覆盖了代价挂在分割点、代价挂整段区间、以及环形断链三种最常见的变形；环形和多堆合并的代价计算都依赖前缀和，见 [[前缀和与差分]]。
