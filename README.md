# vue-tsc-go

基于 tsgo(TypeScript 官方 Go 移植)引擎的 [vue-tsc](https://github.com/vuejs/language-tools/tree/main/packages/tsc) 替代品。命令行用法与 vue-tsc 3.x 完全一致,参数原样透传,但语义检查由进程内 Go 引擎执行——启动型 typecheck 显著更快、内存更低。

## 用法

全局替换 `vue-tsc` 即可,把命令名换掉、其余不动:

```bash
# 原来这样
vue-tsc --noEmit
vue-tsc -p tsconfig.web.json --composite false --noEmit

# 现在这样
vue-tsc-go --noEmit
vue-tsc-go -p tsconfig.web.json --composite false --noEmit
```

安装:

```bash
npm i -D vue-tsc-go
npx vue-tsc-go --noEmit
```

或在 CI 中直接 `node node_modules/vue-tsc-go/bin/vue-tsc-go.js --noEmit`。

## 原理

```
bin/vue-tsc-go.js
 ├─ 1. Module._resolveFilename hook:
 │      把所有 `typescript` / `typescript/...` 的模块解析重定向到
 │      typescript-native-bridge(一个 drop-in 的 TypeScript 6.0.3 fork,
 │      其 createProgram 检测到 configFilePath 时把 Program/TypeChecker
 │      切换到进程内 Go 引擎,平台二进制 @typescript-native-bridge/<platform> 的
 │      bridge.node,NAPI + 内嵌 Go 运行时)。
 │      该重定向同时覆盖 vue-tsc 的 resolveTscPath() 默认解析、其 package.json
 │      name 探测,以及 @volar/typescript / @vue/language-core 内部的
 │      require('typescript'),保证整条管线一致跑在 bridge TypeScript 上。
 └─ 2. 调用 vue-tsc 包导出的 run()(vue-tsc 3.x 发布产物原生导出,零 fork):
        run 内部用 fs.readFileSync hook 改写 tsc 入口源码,注入 Volar 的
        program proxy 与 .vue 语言插件(和原版 vue-tsc bin 完全同一份逻辑)。
```

即:Volar 负责 `.vue` 单文件组件的语言能力(虚拟代码生成、诊断位置映射),tsgo 负责语义检查。没有任何对 vue-tsc / typescript 源码的私有拷贝。

## 与原版 vue-tsc 的差异

- 引擎:`typescript`(JS)→ `typescript-native-bridge`(tsgo,Go)。
- 启动型 typecheck 提速约 3 倍(3 个真实项目基准:10s/6.5s/10.5s → 3.2s/1.8s/3.6s),峰值内存相当(约 1.1~1.2 倍;结果缓存命中时 0.1s/40MB 级)。
- 依赖里多带一份 bridge 版 TypeScript(不冲突,js 内部重定向)。

## 已知限制 / 与基线的诊断差异

三个基准项目(element-plus / vueuse / vue-vben-admin)的诊断输出已与原版 vue-tsc 基线逐条一致(错误码、文件、行列、退出码)。为消除 tsgo 引擎与 JS 版的两类行为差异,本仓库做了两处适配(也见 `scripts/patch-tnb-directives.js` 头注释):

1. **vue-tsc 版本跟随被测项目**(bin/vue-tsc-go.js):优先用 `require.resolve("vue-tsc", { paths: [cwd] })` 解析被测项目自己安装的 vue-tsc(与直接运行项目内 vue-tsc 二进制行为一致),解析不到才回退到本包内置的 3.1.5。原因:Volar 虚拟代码生成随 vue-tsc 版本变化(3.1.5 与 3.3.11 对 `<template v-for>` 的 `v-for` 变量引用、`@ts-expect-error` 消费行为均不同),要与原版输出一致就必须用同版本。

2. **注释指令对齐层**(patch 脚本打进 bridge 的 lib/typescript.js 与 lib/_tsc.js,标记 TNB-PATCH):tsgo 引擎对多行调用的 TS2769 报在实参行内,其自带的 @ts-ignore 按行抑制因此失效;对齐层在 JS 侧按 stock 语义重新执行 @ts-ignore/@ts-expect-error 抑制(自诊断起始行向上回溯,容忍空行、注释行与实参续行),并剔除被该层证明"实际已使用"的 Go 端 TS2578。按错误码 + 指令上下文判定,无任何文件白名单。
   - 已知限制:若某个被 `@ts-ignore` 护住的多行调用在原版 vue-tsc 下仍会报错(即原版的抑制范围不覆盖该实参行),本层会将其抑制而原版会打印——方向上偏向作者的"忽略这个调用"意图。

其余已知限制:

- **customTransformers 不支持**(tsgo 引擎限制,与原版 vue-tsc 的 emit 流程不兼容;`--noEmit` 检查场景不受影响)。

## 诊断结果缓存

针对"同一项目反复启动 typecheck"(本地循环、CI 重复跑)的场景,vue-tsc-go 内置诊断结果缓存:输入未变时跳过整个检查,直接回放上次运行的 stdout/stderr/退出码,**逐字节一致**。

- 默认开启。跳过缓存:`--no-cache` 或环境变量 `VUE_TSC_GO_NO_CACHE=1`;自定义位置:`--cache-dir <dir>` 或 `VUE_TSC_GO_CACHE_DIR`;清空:`--clear-cache`。CI 只读文件系统时写入失败会静默降级(照常全量检查)。

### 工作原理

1. 启动时在不加载检查器的情况下,用 bridge TypeScript 解析 tsconfig(带 `.vue` 扩展感知的 readDirectory,根文件集与真实检查一致),对全部输入文件算内容哈希,连同 tsconfig `extends` 链内容哈希、解析出的 compilerOptions、完整 CLI 参数、工具链版本(bridge 版本 + TNB 补丁层内容哈希、解析到的 vue-tsc 模块路径)一起算出缓存 key。内容哈希阶段带 **mtime+size 快筛**:与上次运行(`rootmeta.json` 边车)比对 stat,仅 stat 变化的文件重新读取哈希,最终 key 仍是纯内容哈希(stat 变了必重读,内容变化必然被发现)。指纹阶段实测 ~0.19s @ element-plus(其中 bridge bundle 的 require 即 ~0.11s,为加载 TypeScript 解析器的固有成本)。
2. **命中**:回放缓存的 stdout/stderr/退出码。命中前还会对上次检查运行 dump 出的**完整 program 文件清单**(含 node_modules、monorepo workspace 包等被间接拉入检查的文件)逐个做 size+mtime 校验(stat 变化时以存储的内容哈希复核),任何内容变化都判定失效——即使改动不在 tsconfig 根文件集内也能正确失效。
3. **未命中**:**在当前进程内**完整跑一遍检查(tsc 驱动的收尾 `process.exit()` 被拦截转换为退出码,stdout/stderr 经流写入拦截捕获,无子进程),捕获输出与 program 文件清单(经 `scripts/patch-tnb-directives.js` 的 TNB-DUMPPATCH 注入,标记 `VUE_TSC_GO_DUMP_FILES` 环境变量触发),原子写入(临时文件 + rename)缓存条目后回放。并行启动同一项目只写一份条目,不会互相破坏。
4. 缓存位置:优先 `<tsconfig 同级>/node_modules/.cache/vue-tsc-go`,无 node_modules 时 `<tsconfig 同级>/.vue-tsc-go-cache`;条目超过 24 个时按最旧淘汰。

### 失效条件(保守策略)

以下任一变化都会导致全量重跑:任何输入源文件内容变化;tsconfig / extends 链 / packageJson 变化;CLI 参数变化;vue-tsc-go、bridge(含 TNB 补丁层内容)、vue-tsc 版本变化;program 文件清单中任何文件的 size/mtime 变化(依赖更新、workspace 包改动等)。

以下场景**自动放弃缓存**(照常全量检查):`--watch`/`--build` 等非诊断模式;非 `--noEmit` 的运行(emit 是副作用,命中会跳过);tsconfig 解析报错;无法枚举的配置链;不认识的 vueCompilerOptions 扩展配置;任何输入文件不可读。

### 已知限制

- program 文件清单走 size+mtime 校验而非内容哈希:同内容但 mtime 变化的文件(如 `git checkout`、重装依赖)会造成一次多余的失效重跑(方向安全);**新增**文件如果未被任何已跟踪文件引用,不会被察觉(但不被引用的文件不影响诊断)。
- 诊断输出中的相对路径按运行时 cwd 解析,同一项目从不同 cwd 运行会得到不同 key(安全但缓存不共享)。

### 会话级按需 worker(实验特性,严格 opt-in)

> **注意**:worker 是**实验特性,默认完全关闭**。多个 git worktree 并行交叉 typecheck 的场景**不建议启用**——每个会话 worker 常驻持有约 1~1.5GB 内存,并行多个 worktree 会各自长出一个常驻进程,容易撑爆内存。默认路径(不设置任何 worker 开关)任何运行都不会留下常驻进程。

在"编辑几个文件 → 再跑一次 typecheck"的本地循环里,连缓存命中路径的冷启动地板(进程启动 + 指纹 ≈ 0.2s)与增量路径的冷启动都可以省掉。为此 vue-tsc-go 提供**按需拉起、空闲自退的常驻会话 worker**(`bin/worker.js`),仅在显式要求时启动:

```
CLI 进程（每次运行都是新进程）                 会话 worker（bin/worker.js，按需常驻）
─────────────────────────────                ─────────────────────────────────────
1. 指纹: tsconfig 链 + argv + env + 全部      常驻持有:
   根文件内容哈希（mtime+size 快筛,~0.19s @ element-plus）      - Module hook + vue-tsc + tsc bundle（Volar 管线）
2. 解析 worker 命名管道,连接（不在则             - 进程内 Go 引擎会话（project/overlay 缓存跨运行复用）
   后台拉起一个,与指纹计算并行）                - 上次运行的会话状态（program 文件清单/解析图/逐文件诊断）
3. 发送 {argv, plan} 请求,按序取回
   {stdout, stderr, exitCode} 原样输出
```

worker 内的三种路径,输出与全量跑逐字节一致（与磁盘缓存同一套保守失效规则,任何疑问回退全量）:

- **replay**:plan key 与会话上次运行相同（内容零变化,且 program 文件清单 stat 校验通过）→ 直接回放内存中的结果（毫秒级）。
- **incremental**:内容有变化 → 对变更文件调用 bridge 的外部变更通知（与 `tsc --watch` 同一机制,Go 引擎从磁盘重读快照）→ 只重新检查变更文件的反向依赖闭包（沿用 `prepareIncremental` 的保守规则:新增/删除文件、全局脚本/模块增强改动、受影响面超 40% 等回退全量）,其余文件诊断从会话内存重放;语义与语法诊断均逐文件混合。
- **full**:以上任一前提不成立 → 会话内全量重跑（仍省掉子进程启动,Go 会话增量复用）。

每次 worker 运行（含 replay 之外的增量/全量）都会回写 v2 磁盘缓存条目,worker 死后磁盘命中/磁盘增量路径照常可用,只是变慢、不会出错。

**开关与默认行为**:

| 开关 | 说明 |
|---|---|
| （默认） | **不启用 worker**——不拉起、不连接任何常驻进程,行为与单进程流程完全一致 |
| `VUE_TSC_GO_WORKER=1` 或 `--worker` | 显式启用(实验特性) |
| `--no-worker` / `VUE_TSC_GO_NO_WORKER=1` | 即使 opt-in 也禁用 |
| `VUE_TSC_GO_WORKER_IDLE_MS` | 空闲自退时间,默认 600000（10 分钟） |
| `--clear-cache` | 同时结束该项目注册的所有 worker |

worker 是**按需 worker,不是 watch 常驻**:不做文件系统监听、不做任何主动工作,只在 CLI 运行到来时处理一次检查;空闲超时自退,kill 掉后下一次运行自动拉起并回退到常规路径（只损失速度）。单 worker 单会话,会话按 (工具链 + tsconfig + argv + cwd) 维度绑定,任一变化即重启会话——常驻内存上界 = 一份 Go program（约 1~1.5GB,element-plus 实测约 2.0GB 工作集含 V8）。多个 tsconfig（如 vben 的 app/worker 配置)会各自有独立 worker,请注意内存余量。

与磁盘缓存一样,`--no-cache`、`--watch` 等非诊断模式不经过 worker;两个 CLI 并发运行同一项目时,worker 内部按序串行处理,输出互不串扰。



缓存 miss(冷跑)时,检查器与 CLI 同进程,同时驻留 Go 运行时(tsgo 引擎,峰值大头)与 V8 堆(vue-tsc + Volar 虚拟代码)。CLI 在加载 bridge 的 Go 插件前自动施加两组**仅影响 GC 行为、不影响诊断输出**的参数(`bin/vue-tsc-go.js`):

- **`GOGC=30`**:Go 堆默认按活数据的 2 倍(=100%)扩到下次 GC;降到 30% 让 Go 侧更早回收。实测 element-plus 冷跑峰值降约 9-10%。
- **Node `--max-semi-space-size=4`**:缩小 V8 年轻代上限,促使对象更早晋升/整理(仅在 `--no-cache` 路径通过一次性 re-exec 携带;缓存路径为保持单进程不 re-exec)。
- **`GODEBUG=asyncpreemptoff=1`** 在 Go 运行时初始化前就位,避免后台抢占。

参数作用范围:缓存路径在进程内直接生效;`--no-cache` 运行通过一次性自 re-exec 携带(stdio/退出码透传)。**缓存命中路径完全不受影响**(无 re-exec、无额外开销)。

覆盖方式(均可用环境变量调整/关闭):

| 变量 | 默认 | 说明 |
|---|---|---|
| `VUE_TSC_GO_GOGC` | `30` | checker 的 GOGC 值;`off` 关闭;进程环境已带 `GOGC` 时尊重用户值 |
| `VUE_TSC_GO_SEMI_SPACE` | `4` | V8 `--max-semi-space-size`(MB);`off` 关闭 |

实测(5 轮中位数,Windows 10,Node 22):element-plus 1562→1423MB、vueuse 1083→970MB、vben 2011→1843MB,耗时增幅 ≤7%。注意:checker 峰值的主体是 tsgo 引擎的 Go 活跃堆(~live×1.3)与 V8 堆(~400MB 级)的固有驻留,这两个 GC 旋钮只能压缩 GC 余量,无法把峰值压到与单 V8 堆实现的原版 vue-tsc 相同水平(vueuse 已接近,element-plus/vben 仍高 17-23%)。更激进手段(`GOMEMLIMIT` 软限、`GOGC≤20`)实测会引发 GC 风暴,耗时劣化 12-45%,不予采用。

### 增量缓存(两级,子程序优先)

默认缓存已升级为增量级:对项目做少量修改后再跑 `vue-tsc-go`,按两级策略处理,任何一级有任何疑虑都保守回退到下一级,输出与全量检查逐字节一致(含新错误的行列与退出码):

- **一级·子程序增量**:不为改动重建全量 program,而是以受影响文件为根取**前向传递导入闭包**,加上全局声明/ambient 风险文件(全局脚本、`declare global`/`declare module`、UMD global,来自上次条目的元数据),生成一个临时兄弟 tsconfig(`extends` 原配置、显式绝对 `files`、清空 include/exclude),只对这个小子程序跑受影响文件的诊断,其余文件的诊断从上次条目重放。运行后做守卫校验(受影响文件必须都在子程序内、未改动文件的模块解析必须与全量一致、program 不得引入未知文件等),任一不满足即丢弃结果回退。
- **二级·全量程序增量**:重建完整 program,但只对受影响闭包逐文件重查,其余文件诊断重放(上一版默认路径)。
- **兜底·全量**:新增/删除文件、全局脚本与模块增强(`declare global`/`declare module`)相关改动、node_modules 变化、受影响面超过项目 40% 等情形自动全量;任何内部异常也回退全量,只影响速度不影响正确性。

缓存条目(v2)额外保存模块解析图、逐文件语义/语法诊断与 ambient 风险分类;`.vue-global-types` 等生成文件的 mtime 抖动不会再造成误失效。子程序方案下,小改动路径不重建全量检查器状态,峰值内存约为全量冷跑的一半(见下)。

实测(5 轮中位,Windows 10,Node 22;与全量跑及原版输出逐字节一致):

| 项目 | 场景 | 小改动(子程序) | 全量冷跑 | 无改动命中 |
|---|---|---|---|---|
| element-plus | 叶子 .ts(反向依赖 14) | 2.4-2.5s / 742MB(全量的 0.51 倍) | 3.9s / 1440MB | 0.25s |
| element-plus | 共享 .vue(button,反向依赖 104) | 3.2s(子程序仍命中) | 3.9s | 0.25s |
| vueuse | 叶子 .ts(闭包 5) | 1.3s / 542MB(0.51 倍) | 2.4s / 1070MB | 0.24s |
| vben web-antd | 页面 .vue | 2.2s / 919MB(0.50 倍) | 4.6s / 1870MB | 0.22s |
| vueuse | 大桶文件(闭包 630) | 回退全量(约 2.4s) | 2.4s | 0.24s |

子程序的时间大头是 Go 引擎构建受影响闭包的 program(element-plus 叶子改动的闭包仍有 ~1577 个文件,约占全量 87%,这是项目 import 图的固有密度),因此 element-plus 的小改动约 2.4-2.5s,未达 2.2s 的期望目标;内存 0.50-0.53 倍基本达成理想线(进一步压低需要更小的闭包,GOGC/GOMEMLIMIT 调优实测无效——峰值由活跃堆决定)。

## 自测

```bash
npm test          # 默认套件(零常驻,不启动任何 worker):
                  # 1) selftest:对 test/fixture(tsconfig + .vue + .ts 含类型错误)运行,
                  #    校验 .vue 被检查、错误行列指向 .vue 源文件、退出码为 2;
                  # 2) cache.test:在临时副本上校验缓存命中/字节一致回放、编辑失效、
                  #    mtime 重校验、--cache-dir / --clear-cache / --no-cache;
                  # 3) mutation.test:随机变异(fixture,覆盖 .ts/.vue/桶文件/类型文件/
                  #    深共享模块/declare global/生成文件,默认 30 轮)每轮
                  #    "缓存跑(子程序增量/全量增量/全量/命中) === --no-cache 跑"逐字节一致

npm run test:worker  # worker 实验特性测试(显式 opt-in VUE_TSC_GO_WORKER=1,结束后清理 worker):
                     # mutation-worker.test(worker 路径 25 轮逐字节一致)+ robustness.test
                     # (kill -9 恢复 / 并发不串扰 / 空闲自退)
```

`test/perf.ps1` 测量单次运行的墙钟时间与峰值内存(含子进程树);`test/perf-scenarios.ps1` 输出 nocache-full / cache-miss-full / cache-hit / small-change 四场景各 5 轮的中位数;`test/incremental.bench.js` 在三个基准项目上做场景化字节一致性与计时;`test/bench-consistency.js` 比对 worker 路径/磁盘命中/--no-cache 的逐字节一致性。
