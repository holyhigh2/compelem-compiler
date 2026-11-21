# Changelog

### 文档

- `docs/TEMPLATE-CODEGEN.md` §2 占位符契约更新：三明治形、粘连机理、前缀禁令、格式锁步警示。

## 0.30.0-beta.13

### 修复

- 结构指令点（`execEach`/`execCond`）改为无条件 exec，主模板与子模板两条发射路径共用 `dirExecStmt`：`args[0]`（条件/集合）不变 ≠ 点内无变化——等值集合/恒真条件仍需经 REFRESH/UPDATE 换当轮回调刷新分支内数据。TAG 位 `execDir` 保留值守卫（args[0] 即数据本身）。需配套同版本 compelem 运行期（`up.value` 回写 + `__fx` 门控重跑）。

### 新增

- 字面占位符编译错误：模板源码直接书写 `⟬Ċ⟭` 时 `buildTemplateHTML` 逐 quasi 阻断（与实体解码守卫对称），防止字面标记被运行期 walk 误判为插值。
- `E-EVENT-DUP`（阻断）：同一元素上同一事件名只允许一条绑定，修饰符不区分（`@click.stop` + `@click.prevent`、`@mutate.attr` + `@mutate.tree` 均判重复）——多路逻辑在回调内分支，多类型观测写组合修饰符。动态 `@event` 路径编译期不可见，运行期保持原生多监听语义。
- `E-DIRECTIVE-DUP` 扩展到自定义指令：TAG 位整插值按调用名（`directiveName` / `moduleBindingName`）查重，同种指令同一元素只允许一次。
- 移除 `W-MUTATE-MERGE`（被 `E-EVENT-DUP` 吞并：重复 `@mutate.*` 不再合并提示，直接阻断）。

### 文档

- 新增 `docs/TEMPLATE-CODEGEN.md`：两条解析路径、占位符契约、源码级解析与 codegen 硬约束全集（别名识别禁令、双通道类表、注释剥离、destroy no-op 语义、`_$__` 方法装饰器语义表、继承 own-only 等）。
- 修正 watch-extract / field-extract 的失实「运行时装饰器兜底」注释：运行期装饰器是 no-op 存根，提取失败的安全网是 E 码阻断构建（all-or-nothing），不存在运行期兜底路径。

### 其它

- `.gitignore` 补 `.workbuddy/`。
- 诊断文案口径：编译器 E/W 码说明统一中文（面向开发者的构建指引）；运行期 console 归 compelem 侧，统一英文。