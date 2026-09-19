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
- 启动型 typecheck 提速约 3 倍(3 个真实项目基准:10s/6.5s/10.5s → 3.2s/1.8s/3.6s),峰值内存相当(约 1.1~1.2 倍,含 re-exec 的父子进程)。
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

1. 启动时在不加载检查器的情况下,用 bridge TypeScript 解析 tsconfig(带 `.vue` 扩展感知的 readDirectory,根文件集与真实检查一致),对全部输入文件做 sha1 内容哈希,连同 tsconfig `extends` 链内容哈希、解析出的 compilerOptions、完整 CLI 参数、工具链版本(bridge 版本 + TNB 补丁层内容哈希、解析到的 vue-tsc 模块路径)一起算出缓存 key。
2. **命中**:回放缓存的 stdout/stderr/退出码。命中前还会对上次检查运行 dump 出的**完整 program 文件清单**(含 node_modules、monorepo workspace 包等被间接拉入检查的文件)逐个做 size+mtime 校验,任何变化都判定失效——即使改动不在 tsconfig 根文件集内也能正确失效。
3. **未命中**:在子进程完整跑一遍检查,捕获输出与 program 文件清单(经 `scripts/patch-tnb-directives.js` 的 TNB-DUMPPATCH 注入,标记 `VUE_TSC_GO_DUMP_FILES` 环境变量触发),原子写入(临时文件 + rename)缓存条目后回放。并行启动同一项目只写一份条目,不会互相破坏。
4. 缓存位置:优先 `<tsconfig 同级>/node_modules/.cache/vue-tsc-go`,无 node_modules 时 `<tsconfig 同级>/.vue-tsc-go-cache`;条目超过 24 个时按最旧淘汰。

### 失效条件(保守策略)

以下任一变化都会导致全量重跑:任何输入源文件内容变化;tsconfig / extends 链 / packageJson 变化;CLI 参数变化;vue-tsc-go、bridge(含 TNB 补丁层内容)、vue-tsc 版本变化;program 文件清单中任何文件的 size/mtime 变化(依赖更新、workspace 包改动等)。

以下场景**自动放弃缓存**(照常全量检查):`--watch`/`--build` 等非诊断模式;非 `--noEmit` 的运行(emit 是副作用,命中会跳过);tsconfig 解析报错;无法枚举的配置链;不认识的 vueCompilerOptions 扩展配置;任何输入文件不可读。

### 已知限制

- program 文件清单走 size+mtime 校验而非内容哈希:同内容但 mtime 变化的文件(如 `git checkout`、重装依赖)会造成一次多余的失效重跑(方向安全);**新增**文件如果未被任何已跟踪文件引用,不会被察觉(但不被引用的文件不影响诊断)。
- 诊断输出中的相对路径按运行时 cwd 解析,同一项目从不同 cwd 运行会得到不同 key(安全但缓存不共享)。

## 冷跑内存调优

缓存 miss(冷跑)时,checker 进程内同时驻留 Go 运行时(tsgo 引擎,峰值大头)与 V8 堆(vue-tsc + Volar 虚拟代码)。CLI 在拉起 checker 时自动施加两组**仅影响 GC 行为、不影响诊断输出**的参数(`bin/vue-tsc-go.js`):

- **`GOGC=30`**:Go 堆默认按活数据的 2 倍(=100%)扩到下次 GC;降到 30% 让 Go 侧更早回收。实测 element-plus 冷跑峰值降约 9-10%。
- **Node `--max-semi-space-size=4`**:缩小 V8 年轻代上限,促使对象更早晋升/整理。
- **`GODEBUG=asyncpreemptoff=1`** 在进程 spawn 时就位(与 bridge 自身行为一致,仅更可靠),避免 Go 运行时后台抢占。

参数作用范围:缓存 miss 的 checker 子进程与 `--no-cache` 运行(后者通过一次性自 re-exec 携带,stdio/退出码透传)。**缓存命中路径完全不受影响**(无 re-exec、无额外开销)。

覆盖方式(均可用环境变量调整/关闭):

| 变量 | 默认 | 说明 |
|---|---|---|
| `VUE_TSC_GO_GOGC` | `30` | checker 的 GOGC 值;`off` 关闭;进程环境已带 `GOGC` 时尊重用户值 |
| `VUE_TSC_GO_SEMI_SPACE` | `4` | V8 `--max-semi-space-size`(MB);`off` 关闭 |

实测(5 轮中位数,Windows 10,Node 22):element-plus 1562→1423MB、vueuse 1083→970MB、vben 2011→1843MB,耗时增幅 ≤7%。注意:checker 峰值的主体是 tsgo 引擎的 Go 活跃堆(~live×1.3)与 V8 堆(~400MB 级)的固有驻留,这两个 GC 旋钮只能压缩 GC 余量,无法把峰值压到与单 V8 堆实现的原版 vue-tsc 相同水平(vueuse 已接近,element-plus/vben 仍高 17-23%)。更激进手段(`GOMEMLIMIT` 软限、`GOGC≤20`)实测会引发 GC 风暴,耗时劣化 12-45%,不予采用。

### 增量缓存

默认缓存已升级为增量级:对项目做少量修改后再跑 `vue-tsc-go`,只重新检查被改文件及其反向依赖闭包(与 `tsc --incremental` 相同的受影响集语义),其余文件的诊断从上次结果重放,输出与全量检查逐字节一致(含新错误的行列与退出码)。失效规则保守:新增/删除文件、全局脚本与模块增强(`declare global`/`declare module`)相关改动、node_modules 变化、受影响面超过项目 40% 等情形自动回退全量;任何内部异常也回退全量,只影响速度不影响正确性。缓存条目(v2)额外保存模块解析图与逐文件诊断;`.vue-global-types` 等生成文件的 mtime 抖动不会再造成误失效。

实测(element-plus / vueuse / vben,与全量跑及原版输出逐字节一致):叶子文件改动后 1.7–2.6s(全量冷跑 3.9s、原版 10s);枢纽共享文件(反向依赖 100+)回退全量(约 3.3s);还原改动后回到命中路径 0.2–0.27s。

## 自测

```bash
npm test   # 三部分:
           # 1) selftest:对 test/fixture(tsconfig + .vue + .ts 含类型错误)运行,
           #    校验 .vue 被检查、错误行列指向 .vue 源文件、退出码为 2;
           # 2) cache.test:在临时副本上校验缓存命中/字节一致回放、编辑失效、
           #    mtime 重校验、--cache-dir / --clear-cache / --no-cache;
           # 3) mutation.test:随机变异(fixture,默认种子 25/25)每轮
           #    "缓存跑(增量/全量/命中) === --no-cache 跑"逐字节一致
```

`test/perf.ps1` 用于测量墙钟时间与峰值内存(含子进程树)。
