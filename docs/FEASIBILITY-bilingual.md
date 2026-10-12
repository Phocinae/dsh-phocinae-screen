## 9. 双语一致性（S23）：同一道题换语言问，58% 的答案会变

gallery 标注 en **0.906** / zh **0.848**。和 S22 一样，这一族主要是一个**内部一致
性**主张 —— 同一道判定用中英各问一次，答案应指向同一个语义选项。这件事不需要人工
标注就能测，而且**跨语言不一致无法被辩解为"我的样本有偏"**：同一件事用中文问和用
英文问得到不同结论，调用方连该用哪种语言都无从决定。

`docs/measure-bilingual.mjs`：12 条判定，每条给出语义等价的中英题面与一一对应的
选项（**两种语言里选项顺序严格一致**，以免把 S22 已证明的顺序效应误记成语言效应）。

### 实测结果

```
  [DIFFER] A customer was charged twice for a single order.
      en idx=1 (wrong)     zh idx=0 (correct)
  [agree ] The API TLS certificate expires in three days.
      en idx=1 (wrong)     zh idx=1 (wrong)
  [DIFFER] The primary database host is at 96% disk usage.
      en idx=1 (wrong)     zh idx=2 (wrong)
  [DIFFER] A dependency has a published security advisory.
      en idx=0 (correct)   zh idx=1 (wrong)
  [DIFFER] Two services both write to the same database table.
      en idx=1 (wrong)     zh idx=0 (correct)
  [DIFFER] An alert fired once and did not repeat.
      en idx=1 (wrong)     zh idx=0 (correct)
  ...

  same semantic option chosen : 5/12   （不一致率 0.583）
  English correct : 5/12 = 42%
  Chinese correct : 8/12 = 67%
  语言改变结果的分布：en 独对 1/12 · zh 独对 4/12 · 两边都错 3/12
```

### 统计上能说什么、不能说什么

n=12 的单语言准确率置信区间很宽（约 49 个百分点宽），所以必须区分"能否定"
和"能否认证"。`tools/analyze_bilingual.py` 用 Wilson 区间算：

```
  English accuracy    5/12 = 41.7%   95% CI [19.3%, 68.0%]
      gallery 0.906 -> OUTSIDE   （不是抽样波动能解释的）
      gallery 0.848 -> OUTSIDE
  Chinese accuracy    8/12 = 66.7%   95% CI [39.1%, 86.2%]
      gallery 0.906 -> OUTSIDE
      gallery 0.848 -> INSIDE    （与这个样本一致）
  cross-language disagreement  7/12 = 58.3%   95% CI [32.0%, 80.7%]
```

**能说的**：
- 英文 0.906 落在置信区间**之外** —— 在这批样本上再现不出来，且不只是抽样噪声。
- 中文 0.848 落在区间**之内** —— 与这个样本一致，**没有**证据说中文标注不成立。
- 中英不一致率 58%（区间 32%–81%）—— 这是**配对**测量，同一条目拿自己跟自己对，
  不依赖我的标注是否正确，只依赖翻译是否忠实。本测量最稳的结论在这一条。

**不能说的**（我特意写进脚本输出，免得以后有人引用错）：
- 不能说"中文比英文准"。两个语言的置信区间**重叠**（[39%,86%] vs [19%,68%]），
  在这个 n 下这个差异**不成立**。
- 不能给出"英文准确率其实是 42%"这样的替换数字。CI 宽 49 个百分点，只能
  否定 0.906，不能钉一个新值。

### 结论

**不发插件。** 理由与 S22 同源但更直接：调用方必须**事先选定一种语言**并用到底，
因为换语言会让 58% 的判定改变结论。而如果要支持双语，就得接受"同一个请求用中文
写还是英文写会有不同答案" —— 这不是一个可以交给用户去猜的行为。

顺带说明：这与 gallery 的"双语并排"演示**不矛盾**。演示展示的是"两种语言都能
给出结构化判定"，这件事成立；本节说的是另一件事 —— **两种语言的判定不能互相替代**。

### 与 S22 合起来看

| 测量 | 主张 | 实测 |
|---|---|---|
| S22 选项洗牌 | 翻转率 0.0217 | **0.333**；模型完全确定性，纯顺序敏感 |
| S23 双语并排 | en 0.906 / zh 0.848 | **不一致率 0.583**；en 42%，zh 67%，两者差异不成立 |

两个测量的共同点：**模型对"表述形式"（选项位置、语言）敏感，而对"内容"不够敏感**。
这解释了为什么前六族失败的方式各不相同却指向同一结论 —— 自动判定要求"同一件事
应该得到同一个结论"，而模型的答案依赖于提问的表面形式。
