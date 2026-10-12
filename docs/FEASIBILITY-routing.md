## 6. 选择类决策点（S07 工具路由 / S16 技能路由）：最接近达标的一族，也不达标

前面测的都是**质量判断**（"这段上下文重要吗"、"这张发票自洽吗"）。路由是
**选择**：候选集合固定、其中恰好一个是对的。结构上更容易 —— 模型不需要有
"重要性"的内部标尺，只要把请求和候选做匹配。而 gallery 给 S07 的标注是
**「工具选择 12/12」**，所以这是唯一有可能直接达标的演示族，必须单独测。

`docs/measure-routing.mjs`：8 个候选工具、12 条请求，每条恰好一个正确答案。

### 实测结果

```
=== A) 完整候选集（8 选 1，同 S07 设定）===
  MISS want=read_file              got=run_shell              p=0.186  Show me what is in config/settings.py.
  MISS want=write_file             got=summarise_text         p=0.500  Save these three paragraphs to notes.md.
  ok   want=run_shell              got=run_shell              p=0.901  Run the test suite…
  MISS want=search_web             got=summarise_text         p=0.186  What is the current population of Reykjavik?
  MISS want=query_database         got=create_calendar_event  p=0.474  How many orders were placed last Tuesday?
  MISS want=send_email             got=summarise_text         p=0.913  Tell the vendor that we accept their quote.
  MISS want=create_calendar_event  got=run_shell              p=0.582  Book a 30 minute call…
  MISS want=summarise_text         got=write_file             p=0.360  Give me a two sentence version…
  MISS want=read_file              got=summarise_text         p=0.181  Open the changelog…
  MISS want=run_shell              got=search_web             p=0.568  Which processes are listening on port 8155?
  MISS want=search_web             got=create_calendar_event  p=0.568  Who won the 2026 world championship?
  ok   want=query_database         got=query_database         p=0.168  List the customers who have not ordered…
  -> 2/12 correct（随机基线 1.50/12）
```

**2/12，比随机（1.5/12）只高半个。** gallery 标注是 12/12。

### 位置偏置是主因

把正确答案轮换到 8 个位置各测一遍：

```
  slot 0: 1/12 =  8%      slot 4: 3/12 = 25%
  slot 1: 3/12 = 25%      slot 5: 5/12 = 42%
  slot 2: 2/12 = 17%      slot 6: 5/12 = 42%
  slot 3: 4/12 = 33%      slot 7: 3/12 = 25%
```

**跨度 33 个百分点**（8% ~ 42%），与"哪个选项是正确答案"基本无关，而与
"它排在第几个"有关。这解释了 2/12 的来源：不是匹配失败，是**位置在决定答案**。
这与 §3 里 `noul` 的纯位置偏置、以及 S22「选项洗牌稳健（翻转率 0.0217）」
的标注互相矛盾 —— 实测到的翻转敏感度远高于 0.0217。

### 二选一时勉强可用，但仍不够

给两个选项（正确工具 vs 一个强干扰项，顺序随机）：

```
  -> 8/12 correct（随机基线 6/12）
```

67% vs 50%。**每三次路由就有一次选错工具。** 一次错误的工具调用（写错文件、
发错邮件、查错库）的代价，远高于省下的那一次判定，所以这不能当唯一路由器用。

### 结论

三族决策点、五次独立测量，全部不达标：

| 族 | 测量 | 结果 |
|---|---|---|
| 质量判断-筛选（S09/S20） | `measure-screen.mjs` | 含真正修复答案的块判可删（0.323） |
| 质量判断-分类（S01/S13/S14/S19/S21） | `feasibility-matrix.mjs` | 全部低于门槛，对照组仅 55% |
| 规则形状（S18） | `measure-deterministic-first.mjs` | 模型 0/6，纯规则 6/6 |
| **选择-路由（S07/S16）** | `measure-routing.mjs` | **8 选 1 得 2/12；位置偏置跨 33 点** |

### 与 gallery 标注的差异，必须说清楚

gallery 里的数字（S07 12/12、S22 翻转率 0.0217、S23 en 0.906/zh 0.848）与本节
实测**不在同一口径下**：那些数字来自模型自身评测流程（BENCHMARKS.md），
而这里是经 `POST /v1/systemone` 的**真实协议调用**、用本仓构造的样本。
两者差异如此之大，说明**不能把 gallery 的标注直接当作"照这个演示做个插件就能用"
的依据** —— 这正是必须实测的原因。

这不是在质疑评测结果造假：模型卡如实披露了 JevBench 0.5455 未过门，
`phocinae-guard` 也把 L1 默认关掉，项目自己的立场本来就是"模型只做初筛"。
本节只是把那句话量化到了具体决策点上。
