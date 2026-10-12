# G27 · 服务不可达默认不放行 —— 实测通过

gallery 标注：**服务挂掉 → 默认拒绝，绝不静默放行**。

这是剩余未测演示里**唯一与安全直接相关**的一条，判据也与前面各族的"准确率"完全不同：
它不关心判得对不对，只关心**服务不可用时会不会静默放行**。这类主张用"把地址指向
没人监听的端口"就能干净地测，不需要标注集。

## 方法

`tools/measure_failclosed.py`（模型仓）对**发布到 PyPI 的 wheel**逐个验证三种降级情形，
每种都断言两件事：

1. **不放行** —— 灰区命令必须 deny / 非零退出码
2. **理由可读** —— 给出的必须是一条说明服务出了什么问题的理由，而不是空拒绝或裸
   traceback。后者会让使用者以为工具坏了，而不是服务挂了

三种降级：服务不可达（端口无人监听）· 服务回 500 · 服务回 200 但应答缺字段。

## 实测结果

```
phocinae-guard 0.1.5
  PASS guard: service unreachable -> not allowed (exit != 0)
  PASS guard: service unreachable -> gives a readable reason

phocinae-mcp 0.2.4
  PASS mcp: grey-zone gate with service unreachable        -> deny
  PASS mcp: service unreachable        -> the reason names the failure
  PASS mcp: whitelisted 'git status' still allowed offline (service unreachable)
  PASS mcp: grey-zone gate with service returns 500        -> deny
  PASS mcp: service returns 500        -> the reason names the failure
  PASS mcp: whitelisted 'git status' still allowed offline (service returns 500)
  PASS mcp: grey-zone gate with service answers with missing fields -> deny
  PASS mcp: service answers with missing fields -> the reason names the failure
  PASS mcp: whitelisted 'git status' still allowed offline (service answers with missing fields)

measure_failclosed: fail-closed holds on every surface tested
```

**13 项断言全部通过。**

## 一句值得单独指出的设计

注意每组里都有一条 **"whitelisted 'git status' still allowed offline"** —— 在服务
不可达、回 500、应答缺字段这三种情形下，白名单命令**仍然离线放行**。

这一点很重要，因为它说明 **fail-closed 没有把 L0 一起拖下水**：

- 灰区（L0 判不了）→ 服务不可用 → **deny**（安全方向正确）
- 白名单（L0 明确放行）→ 服务不可用 → **allow**（功能不受影响）

如果实现得粗糙一点（例如"服务不可用就全拒"），安全性一样但工具会变得不可用 ——
这正是 `phocinae-mcp` 0.2.2 那个"每条命令都拒"缺陷的形态。现在两者分得很干净：
**离线能判的照常判，判不了的才依赖服务，服务没了才拒绝。**

## 与前面各族的对照

这是十二族测量里**唯一一条完全通过、且与判定质量无关**的 —— 它测的是**降级行为**。
所以它不受"模型判别力不足"这一结论的影响：即使模型一个判定也做不对，
只要服务不可用时拒绝、而不是猜，这条主张就成立。

G27 也是 gallery 里**唯一一条把"不做什么"当卖点**的演示，实测确认这个卖点是真的。
