# T8b 容器恢复与运行要求

**主实验连续运行约 20 小时，必须开着盖子跑。** 本机接电与电池模式的“合上盖子操作”都设为睡眠。防睡眠帮手不应被当作合盖保护；若要合盖运行，须由用户自行修改电源设置。本实现不改电源方案、合盖设置或申请管理员权限。

## 运行前与接口

主入口为 `src/ts/docker/launcher.ts` 的 `DockerLauncher(imageId, {clockTicks, pageBytes}, tag="dev")`，实现只读接口 `src/ts/run-unit.ts`。镜像构建由 `node --experimental-transform-types scripts/docker-build.ts` 执行，只用本地 create/cp/commit；没有 docker build 或联网安装路径。可加 `--verify-reuse` 核验同份内容复用，`--manifest <路径>` 保存文件指纹。

阶段配置的 `launcher` 选择 `local-process` 或 `docker`。Docker 填 `tag`（正式阶段用 `exp1-v1`）及 `runtime: {clockTicks:100,pageBytes:4096}`；冻结命令 inspect 实际标签，把完整镜像 ID 写入计划，已有 ID 必须一致。每单元传唯一的 runId/unitId、block、输出/日志/保护器报告目录和宿主出口 URL。启动器按计划 ID 启动，再核对 tag；不一致就拒绝，不暗换代码。getconf 的值来自实测，入口每次复核。

`toUnitView` 映射为容器内 Python、/output、/sys/fs/cgroup、/proc 及本机转发端点。模型出口仍由宿主独立进程提供，只监听 127.0.0.1。容器内转发只通往固定 host.docker.internal 端口；Node 主进程和 Worker 始终加载原保护器。

容器固定 2 CPU、4 GiB、无 swap、pids-limit=1024、非 root 1000:1000、cap-drop=ALL、no-new-privileges、--init、restart=no。32 Worker/实际8题并行已测最终峰值318，1024留有706余量。正常 wait 完成后先记录退出码、OOM、起止时间、日志和摘要，再删除容器。

转发连接宿主的超时固定为3秒，仅约束本机网络这一跳。连接未建成时，不向宿主出口发送任何请求字节；读完当前HTTP请求体后返回固定502应答（`X-Ditto-Relay: upstream-not-connected-v1`、`Content-Type: text/plain`、`Content-Length: 38`、`Connection: close`，正文为`DITTO_RELAY_UPSTREAM_NOT_CONNECTED_V1`加LF）。先读完Content-Length或chunked请求，避免大请求尚未发送完就关闭导致RST/EPIPE。客户端只把完全一致的应答当作未连接，沿用1、2、4秒、最多3次重连及原步骤记录；正常上游连接后的错误仍立即整轮停。`/unit/relay.jsonl`每次记时间和原始连接错误，仅供诊断；出口源码没有该标记。不同机器的底层错误原文可能不同，BFCL_RUN_STOP结构、尝试次数和类别一致。

`pids.jsonl`仍每50毫秒读取current与累计peak，只在任一数值变化或30秒心跳时写盘，并在子进程退出时补最终样本。累计peak保留短尖峰；不把稀疏日志的行数当成采样次数。

## 调度进程退出后的认领

T8a 修复 4 的宿主调度全机锁固定为 `F:\Academic\Ditto\experiments\sec1\_machine\scheduler-lock\scheduler.lock`，包和任意隔离副本使用同一位置，不随 TEMP/TMP 或副本位置变化。目录按需创建；活 PID 拒绝、死 PID 锁在同目录归档、token 释放规则不变。这与下文每单元的 collector.lock 是两把不同用途的锁。

旧 `%LOCALAPPDATA%\ditto-bfcl-scheduler\` 留给用户自行处理，新代码不访问它。修复前的调度副本仍拿旧锁，与新锁互相看不见，**不得同时运行新旧调度代码**。如果修复 4 尚未换入主包，以代码实际版本为准，不能按本段假定主包已迁移。

1. 按标签列出，不能按名字前缀猜：`docker ps -a --filter label=sec1.owner=ditto-sec1-bfcl --filter label=sec1.run=<runId> --no-trunc`。
2. 从计划恢复镜像 ID 和 runtime，构造启动器，调用 `list(runId)`，再对每个单元调用 `adopt(runId, unitId)`。
3. 认领核对标签、镜像 ID、单元日志中的 unit.json。先经 inspect 取得完整容器 Id，再用于 handle 缓存、身份检查和 collector.lock；docker ps 的短 ID 不直接保存或比较。运行中和已结束未收的容器都可收集，随后调用 `wait()`；不存在则返回 undefined。锁中完整 ID 确实不同仍拒绝认领。
4. collector.lock 使用随机 token 标识每次持有者；创建、旧锁接管和释放都先用原子 mkdir 取得 collector.lock.guard 目录，持有期间重新读取锁并核对。两个进程即使读到同一旧锁，也只有一方能接管；另一方报“另一方正在收集这个单元”，不执行收集或删除容器。释放只删自己的 token，不匹配则保留锁并写 collector-lock-events.jsonl。
5. guard 只覆盖很短的文件操作，不覆盖 docker wait。释放端遇竞争最多等待5秒，超时保留锁和 guard、写 release-deferred 事件，已收齐结果不因释放竞争改成失败。若进程恰在这段崩溃，会留下 guard：自动恢复保守拒绝，不按年龄、旧 PID 或 rename 猜测回收。人工先暂停该单元所有收集入口并确认没有收集进程，再保全 collector.lock、guard 及相关日志，移走 guard 后重新认领；无法排除仍有持有者时不要操作。guard 自身不自动抢占，避免再次引入互删。
6. exit.json 已落盘但容器没删时可以续收；未知身份锁不自动删除。Windows PID 可能复用，活 PID 一律保守拒绝。最小后续扩展是同时核对操作系统进程创建时间；本次不扩大范围。

7. 容器状态为created或StartedAt是Docker零值，表示从没启动过。`wait()`不运行docker wait，保存`exitCode/startedAt/endedAt=null`、`collection.neverStarted=true`和“没启动过”，随后删除该容器。T8c 将它记为“配置没开始”，保留原尝试，下一次 run 补未开始的题。CLI 退出2、无摘要、无T7 block.json且无完整题目结果的启动失败同样处理。只读接口原文不改，运行时保留null。
8. `wait()`失败会释放锁且不缓存失败；排除障碍后同一个handle可重试。仅成功的结果缓存。成功收完后，对该handle再调`stop()`、`kill()`或`isAlive()`不再访问Docker；前两者不新增请求，后者返回false。

## 判断卡住、停止和强杀

查看单元 stdout/stderr、步骤/资源记录、`docker inspect <精确ID>` 的 State，以及宿主出口账本。单次模型请求可等600秒，排队/重试可更长，不能因短时没有新日志就强杀。

`stop(reason)` 用 `docker kill --signal=SIGTERM <完整ID>` 发 SIGTERM，只等送达命令返回，不等容器退出，也不自动升级强杀。入口将信号转发给 config-main，并写 signals.jsonl；当前题记 interrupted，在途模拟请求没有提前取消。调度器同时向所有单元发停止，继续监视在途数、5秒宽限和卡死上限。收集 wait 在观察到退出后调用，避免挂住的 docker wait 子进程阻止调度器写暂停报告并退出。

只有先确认出口上该单元没有在途请求，调用方才可 `kill(reason)`。kill.json 和 stop.json 是最近一次方法请求的查看入口；权威记录是 kill-requests/、stop-requests/ 中按 requestId 分开的 JSON，更新经同目录临时文件原子替换，避免跨 handle/进程覆盖别人的结果。kill 状态依次为 requested（已记下、未发出）、dispatched（在调用 Docker 前原子写入的发出边界，结果未知）、succeeded / failed（命令明确成功返回/失败）。发出标记与 OS 启动命令之间仍可能崩溃，dispatched 因此不能当作已送达。记录含 reason、at、完整 containerId，后两种附 completedAt，失败附 error 并抛错；stop 请求语义不变。

`killed=true` 必须同时满足至少一个当前容器请求明确 succeeded、实际退出137、OOMKilled=false；对应 signal=SIGKILL，其余 signal=null。收集先写 kill-outcome.json 再写 exit.json：仅 requested 的记录标 not-dispatched（未发出）；dispatched/旧格式未知记录结合137且非OOM、又无成功回执时标 unconfirmed（已发出、未确认），killed=false；明确成功且137非OOM标 confirmed。无请求标 not-requested，其余标 not-confirmed。记录保留所有相关请求及实际退出码/OOM依据。

调度程序与导出现已同时读 exit.json、kill-outcome.json 和 kill-requests/ 权威记录；unconfirmed 是原因不明，不能因 killed=false 就报“确定未强杀”。无请求目录时兼容旧 kill.json/stop.json；没有成功回执不能判 true。不重写历史 exit.json；历史证据缺失明确留空。同 handle 的 wait 等本 handle 在途请求落盘；跨进程回执较晚时先保留未知，后续导出结合权威请求目录重算，并单独保留原收集快照。

`stoppedByPlan` 按只读接口“是否先收到过 stop()”表示启动器接受并记录过计划停止请求，不表示 SIGTERM 已送达，也不表示它是最终退出原因。因此停止命令失败时此字段仍可为true，送达失败以 stop.json.status/error 为准；对已经退出的单元调用 stop 不生成请求。OOM 单独读取 State.OOMKilled。

Docker stats 是 wait 期间采集的 Docker CLI 原始容器总量；调度器退出后才 wait，因此该项不覆盖答题活动窗，缺失保持空值。活动窗CPU/内存以容器内严格 cgroup 样本为准，宿主负载另读 host 记录；不把进程RSS相加当容器总量。T7 `/proc` 中确认已退出的行保留空值、原因和 exitedDuringSample；available 只评估仍在集合内的进程。活进程读取失败与 cgroup 错误仍按 strict 处理。

`docker kill`在检查Running之后撞上容器自己退出/被移除时，保存`status=not-running`或`not-found`、`killed=false`及完整错误，不再抛给调用方；其他失败仍保存failed并抛错。容器内PID 1 docker-init会被采样器归为main，Python转发监督进程归为python；导出资源明细须用command区分它们与答题主进程/bridge.py。导出汇总只用cgroup样本，不受这些角色名影响；采样器未改。

## Docker Desktop 或电脑重启后

不自动重启 Docker，也不恢复真实模型调用。由于 restart=no，先按标签看实际状态，保留挂载目录，核对退出状态、出口在途记录及任务/失败文件，再交给 T8a 决定按题续跑。不能假定已经计费的题可以直接重做，不能覆盖已有结果。

本任务没有实际重启 Docker Desktop 或电脑；此节是按已固定参数和状态核对步骤给出的恢复操作，不宣称重启实验已经验证。

## 评分与清理

评分入口：`node --experimental-transform-types scripts/docker-score.ts <imageId> <input> <output> <logDir> [tag]`。同一个镜像、network none、Python -B。宿主/容器原文件均保留；验收只允许行尾/末尾换行不同，逐处记录字节偏移和十六进制差异，不改变评分器。

T8c补查发现一个具体目录的Docker共享边界：对`scenarios-release/tasks-fail/.../attempt-2/output/configs/direct-c1/tasks/`及高一级目录做只读bind，容器open同一JSON可复现Errno 5；根因未定位，不能据此推断所有深目录或单纯长度限制，原目录读取尚未修复。正式主矩阵使用既定宿主HostScorer，全部评分通过。辅助容器复评分可先把原JSON复制到 `F:\Academic\Ditto\experiments\sec1\_tmp\scratch\t8c\score-check\` 下的短输入目录，逐字节SHA256相同后，用原评分入口读取副本；此路径已实际通过，评分只差允许的CRLF/LF。原文件保留，副本与输出记录原SHA，不改变评分器、正式镜像或台账。证据：`runs/offline/t8c-20261106/scoring-short-copy.json`、`logs/t8b-score-existing-short.log`、`scoring-bind-probe/`。

清理先预览：`node --experimental-transform-types scripts/docker-gc.ts --run=<runId>`；确认候选与证据已保存后才加 `--apply`。只处理 owner 标签的已退出容器及无用无标签镜像，保护 runs 下计划引用、docker/images.json台账中的每个镜像ID及仍被容器使用的镜像。即使正式镜像已无标签，台账仍保护它；预览单列“受台账保护”。台账损坏/缺失时拒绝清理。可用`--ledger=<测试专用路径>`验收，`--image=sha256:<完整ID>`只处理指定镜像并跳过容器。按完整 ID 删除，不用全局 prune，不触碰其他实验。

## 显式发布与镜像台账

在包根目录执行`node --experimental-transform-types scripts/docker-publish.ts <x.y.z或expN-vN>`，本次正式版本为 `exp1-v1`。构建命令只打dev或test-*；正式版本只能经发布命令产生。发布拒绝dev、已有台账版本或已存在标签，核对dev的owner/complete、同构建规则重算的内容指纹，以及两个本地基础镜像ID/摘要和构建时间。运行docker/publish-tests.json列出的每项测试，逐项保存命令、完整日志、退出码，并检查测试前后内容与测试输入指纹；任何测试失败、没有测试或期间内容变化都不打标签、不写台账。日志默认保存在runs/offline/docker-publish-*，不会进镜像。

台账每行含version、tag、imageId、fingerprint、baseImages（node/python的ID与摘要）、builtAt、publishedAt、testFingerprint和tests（name/command/log/exitCode）。与其他Docker JSON一样，先写同目录pending文件再原子改名。发布持有台账旁的.lock目录；崩溃时可留下锁和已打的标签，但台账不会露出半截JSON。先核对日志、镜像与台账，确认没有发布进程后再由指挥官处置，不按pending文件补造记录。

T8b历史轮次没有发布；T8c通过正式发布命令写入 `exp1-v1` 的真实台账。发布清单已纳入全部10个T8a调度测试、T8c契约和真实容器小题冒烟，逐项串行运行；期间独占全机调度锁，不含egress-guard.test.ts。测试用`--source-tag=test-* --ledger=<测试路径> --tests=<测试清单> --logs=<日志目录>`，禁止test-*源写真实台账。

Windows上每条Node/Python命令都先在该命令进程中设置TEMP、TMP为F盘任务目录；构建大上下文可用SEC1_DOCKER_SCRATCH指定F盘scratch目录，不修改系统环境。Python一律-B。旧docker-legacy-probe已移出scripts且不进镜像；不要从历史证据执行旧构建器。

Docker调度开跑时自动启动隐藏的 `scripts/docker-awake.ps1 -StopFile <本次临时停止文件> -ParentPid <调度PID>`，正常结束或暂停时释放。帮手同时核对父进程PID和创建时间，父进程消失或复用即有限退出。只申请进程级临时状态；不调用需要管理员的 `powercfg /requests`。合盖仍会睡眠，主实验须开盖。

T8b历史证据在 `runs/offline/t8b-20261105/`；T8c完整调度联调、发布及恢复证据在 `runs/offline/t8c-20261106/`，交付见上级 `docs/15_T8c_交付.md`。本手册没有声明真实模型性能或付费实验通过。

## T8 修复 3：完整写盘与退出记录损坏

启动器的 JSON 记录先完整写入同目录 `.pending-<随机标识>` 文件，再发布到正式名称。覆盖写使用改名；仅首次写入使用硬链接，目标已经存在就拒绝。unit.json、block.json 和 collector.lock 保留原序列化内容；退出、inspect、kill-outcome、停止/强杀请求及其历史记录保留原字段。异常退出可能留下 pending 文件，它不是有效记录，不能把它改名当作完成结果。

### 退出记录损坏

`wait()` 在收集锁内读取 exit.json。若 JSON 无法解析或缺少必需字段（包括合法JSON的{}），先原样改名为 `exit.json.damaged-<时间>-<随机标识>`，并在旁边保存 `.recovery.json`，记明原路径、保全路径、完整容器 ID、时间和错误。

- 容器仍在：沿用同一容器身份重新等待、收集日志与退出状态，完整发布新的 exit.json 后才删除容器。运行中容器也会正常等到退出，不会因此强杀。
- 容器已经不在：不能恢复退出状态，明确报错并指向本节；不得从残缺 JSON、pending 文件或其他容器推造记录。若 `adopt()` 已返回 undefined，应直接核对保留的日志目录及退出记录，按“没有完整退出记录”处理，暂停该单元的结果确认。先保全目录和原始账本，交由指挥官确认如何处理；不要把它计为已完成或自动补跑。
- 保全或恢复记录写入失败：原样报错，不继续删容器。collector.lock.guard 的人工恢复规则仍按前节执行。

块汇总block-summary.json无法解析时，原文件保留，另复制一份`.damaged-*`并写旁边的恢复说明；summary=null、collection.summaryError写清原因。照常保存真实退出状态、日志并删容器；结果仍在宿主挂载目录，不因删容器而丢失。保全写入失败仍明确报错，排除障碍可用同一handle重收。

本机启动器在停止/强杀握手失败后最多等5秒，每50毫秒检查完整 exit.json 或进程已消失。该宽限用于正常退出最后的落盘及系统调度；它不延长模型调用等待，不取消在途请求。5秒后进程仍在、控制失败仍未解决，就保留原错误。单元端先完成应答写出，再执行停止回调。Docker stop 直接经 Docker 管理接口，已退出容器的 stop 返回成功，不涉及本机控制 socket 的 EOF 竞态。

## T8a 修复 5：宿主恢复与导出

以下是宿主调度恢复和导出规则；T8c 已用容器单元验证存活核对、在途归属和退出记录接入，实测目录见 `runs/offline/t8c-20261106/scenarios-final*`。

- 每次启动命令先设置本次任务的 F 盘 TEMP/TMP，再从包内 `scripts/egress-offline-guard.mjs` 加载保护器。修复 5 验证使用 `F:\Academic\Ditto\experiments\sec1\_tmp\os\t8a-fix5`，不修改系统或用户环境变量。
- 出口停止时，先保留运行根、停止报告、单元退出和原账本，确认单元与出口均已退出、没有在途请求，再按授权执行 recover。恢复先核对 `rate.jsonl` 与账本预留的顺序；仅补最后一笔未结算预留的缺行，或其被截断的尾行。原始限流文件和账本进入本次 recovery 目录；完整前缀不动，补行标 recovered，时间按下一条的保守规则处理，未知金额继续占额。中间缺行、错 ID/顺序、多行或无法证明归属的半行均拒绝，报告行号与 ID，停止标记保留。出口启动检查保持严格，恢复成功后用同一 root 执行一次 run 即可续跑。
- 半行的时间另外按保守规则处理：尾行 JSON 完整、只缺换行时，严格检查原 ID/config/at，并保留原 at（即使系统时钟回拨也不减小）。数字或字段本身被截断时，无法还原原时间，使用非负安全整数上界 `9007199254740991`，标 `timestampUpperBound`；原出口会把未来历史转成整整60秒的启动冷却。调度等待出口启动留120秒，包含该60秒冷却和原启动余量。该上界还在近期历史里时，后续启动可能继续保守冷却。完整缺最后一行的通常情况不额外固定等60秒。已闭合的非法数字、不能成为原始序列化前缀的半行都拒绝。
- 出口心跳停止但进程还活着时，不把未知在途记成零。先等待调度暂停报告；若报告仍有存活的 stuck 单元、相应配置最后明确记录了在途请求，按下文“永久冻结”步骤显式切断出口。recover 只在出口与单元退出后对账，未知费用继续占额，不伪造 stopped 标记或余额。第一次 run 可能只收集旧单元的非零退出、报告 unit-failure，再一次 run 才补题；两次报告都保留。
- 配置有在途请求（含无法确认配置归属的请求）时刷新它的活动时间，覆盖模型等待、排队、重试及冷却；归零后再给完整 idleMs。心跳过期仍报 stale，不把未知状态记成零。无在途且无步骤/结果活动的单元仍按 idleMs 检出并暂停；强杀仍须无在途并经过收尾宽限。
- 不手工删除失败暂停记录。新停止报告保存 pauseIds，续跑前逐个核对原暂停文件存在；少一份就拒绝，旧授权不能掩盖它。历史连续失败报告也会迁移成需单独授权的暂停。
- 强杀后的原尝试单独保留，费用按原账本累计。做题窗不完整时，仅在有完整强杀退出记录且时间有效的情况下，从已记录 tasksStarted.wall 算到退出；没有题开始记录时保守计整个单元寿命。补齐且评分齐全后累计这些尝试的活动时间计算 goodput、完成率，仍标非同时运行；补齐前两项留空。不能证明时间的情况标 missing，不补零。

## T8c：一条命令与人工恢复

在包根目录通过独立PowerShell进程运行一个阶段：

```powershell
powershell.exe -NoProfile -File scripts/t8a-stage.ps1 -Stage config/stages/t8c-integration.json -Root runs/offline/<本次新目录>
```

入口只设置本命令进程的F盘TEMP/TMP；未冻结则先plan，再run。已有计划先核对Stage与计划内容一致，再run，不覆盖计划；JSON对象属性顺序不影响核对，数组顺序和字段类型仍必须一致。连续失败续跑可传 `-Authorization "pause:<pauseId> 具体说明"`。修复1阶段配置为 `config/stages/t8c-slice-exp1-v2.json`，阶段3只冻结、不运行。Targeted分配是离线工程验证产物，付费前必须用获批真实剖析重新冻结。

以下Node命令均先在独立命令进程中把TEMP/TMP设为 `F:\Academic\Ditto\experiments\sec1\_tmp\os\t8c`，并统一使用 `node --import ./scripts/egress-offline-guard.mjs --experimental-transform-types scripts/t8a.ts` 作为前缀，`<root>`保持同一运行根：

- 计划停止：`stop --root <root>`；正常收尾后 `run --root <root>`，只补interrupted和未开始的题，已完成和skipped保持原尝试。
- 连续两道同类失败：保留pause文件；使用 `run --root <root> --authorization "pause:<pauseId> 具体确认说明"`。授权绑定本次暂停，旧授权不能用于新暂停。
- 出口停止或异常退出：先确认停止报告、单元已退出和原账本，再 `recover --root <root> --authorization "具体对账与恢复说明"`；之后一次 `run --root <root>`。恢复使用容器启动器查活，不读取不存在的本机control.json推断存活；未知费用继续占额。
- 心跳永久冻结但出口仍活着：保留现场，等调度程序退出并写好停止报告（报告里有 `egressLeftRunning:true`），再执行带授权的 `interrupt-egress`。控制口连接超时、而且同一pid的心跳超过5秒没更新时，入口判定为"冻结"：仍核对停止报告的runId和出口身份、出口启动不晚于报告、control.json的pid和进程创建时间，杀前再确认心跳仍过期，然后只结束自己的出口进程树。冻结时最后一次心跳是旧数据，说明不了哪个配置还在等，所以**不要求**停止报告里有stuckUnits、不要求单元还活着、不要求哪个配置在途大于0，这些只写进回执（T8c 修复1 审查后指挥官补丁，2026-11-07；原来按这三条拒绝，多配置时会走不通）。stuck单元在本运行根没有唯一归属、adopt/isAlive报错、attempt.json读不出来，同样只记进回执、不作条件。Docker下别的运行根的容器在回执里记 `alive:false`，意思是不归本运行根，不是确认它已退出。心跳仍新鲜或已恢复、身份不符、报告比出口旧，照旧拒绝。出口断开后等单元退出，再recover；之后run可能需要两次（先收旧失败，再补题）。这条路径不依赖出口自行解冻，也不授权强杀运行单元。冻结后如果先跑了一次run，`ensureEgress`会报 `Control timeout`，这次的停止报告照样写 `egressLeftRunning:true`：不论走正常收尾还是出错路径，只要这次run没接上出口、control.json记录的出口pid还活着、没有exit.json、这个进程的创建时间不晚于control.json的startedAt，就写这个标记（T9段B；段C2起只认control.json，pid.json不算，拿不准就不写，2026-11-08）。所以先run不是死路，照样走interrupt-egress → recover → run。这个标记只让操作员有资格走interrupt-egress，冻结、身份等核对照旧，出口健康时仍拒绝。
- 请求一直不结算、停止报告有 `stuckUnits` 且 `egressLeftRunning:true`：保留单元和出口。确认确实挂住后，执行 `interrupt-egress --root <root> --authorization "确认请求挂死，同意切断并保留未知费用"`。入口核对控制身份和进程创建时间，只结束本root已认证出口；不关闭别的进程。连接断开后原单元退出，再执行带说明的recover。第一次run可能只收集旧单元并报告unit-failure，第二次run才补题；两次的停止报告都保留。
- 调度进程崩溃：同root直接run，先认领原容器，绝不另起同一单元；随后stop仍可用。没有完整退出证据、身份不一致或收集锁仍活着时先保留现场。

T8c exp1-v1历史证据中“SIGTERM已送达但调用方应答丢失”到退出约493.6毫秒，低于默认5秒宽限；不据此缩短宽限或给题目增加取消信号。

## T8c 修复1：锁、身份、资源与目录

- run、recover、interrupt-egress 共用 `F:\Academic\Ditto\experiments\sec1\_machine\scheduler-lock\scheduler.lock`。已有调度程序或另一恢复持锁时明确拒绝；不删除活锁，不在另一个root绕开。死出口gateway.lock只在锁内同目录归档，恢复释放时核对自己的pid和随机token。
- interrupt-egress 要求停止报告的runId与计划、出口身份一致，出口启动不晚于报告。出口没冻结（控制口能连上）时，还要求报告里有stuck单元、这些单元仍活着、各自配置有明确的正在途数；进程清单查询之后、实际发信号之前同步复核报告、控制身份、心跳和每个目标配置的在途数；过时报告不能切断新一代出口。出口冻结（控制口超时且心跳过期5秒以上）时，单元存活和在途数只记进回执、不作条件，见上面"心跳永久冻结"一条。控制文件、停止报告或attempt.json缺失/损坏时先保全、报告，不手工拼造。出口没冻结时attempt.json损坏，interrupt-egress拒绝；出口冻结时只记进回执、不拒绝（T9段B）。recover不读这个文件；之后的run读不了它就停，要先把原文件恢复，才能run。
- 已保存的skipped失败即使没有block-summary，也会按streak>=2恢复失败暂停。无授权拒绝；授权必须包含本次全部pause:<完整ID>和具体说明。T7的streak只在一次尝试内累计，新尝试从0开始；调度程序另按尝试先后和题目结束时间，把同一配置、同一块各尝试的结果接起来（T9段A）：两道同类skipped分属不同尝试、中间没有隔着一道完成的题，就按连续失败暂停，收尾卡住、强杀、计划停止和摘要缺失都不会清掉这个判断。interrupted和别的类型的skipped不算隔开。这条判断在单元收集时和每次run开始时都做，暂停记在后一次尝试名下；按T7证据的暂停编号仍按单元，跨尝试证据的暂停编号带上配对（失败类型和后一道题号），同一配对在两处得到同一个编号。所以授权续跑以后，不论起的是新尝试，还是被认领的同一个单元，只要再出现新的连续失败证据（T7的streak到2，或另一组跨尝试配对），都要再授权一次；已授权过的同一配对不再重复要求：被认领的单元收集时如果只有已授权的配对、没有新证据，这次 `run` 仍会按连续失败停一次（`reason` 为 `consecutive-failure`，`complete` 可能为 true），下一次 `run` 不用再授权。跨尝试时X、Y、X这样中间隔着别的类型失败的两道X也配成一对，比T7（遇到别的类型就重置）严，只会多暂停，不会漏。
- Docker inspect/ps/kill/logs/stats/create等命令上限15秒；本地cp/commit上限120秒；docker wait不设命令超时。命令超时表示无法确认状态，按启动器错误暂停并保留现场，不能当作容器已死或在途为零。stop撞上正常退出记not-running/not-found，不冒充强杀成功。15秒的理由（指挥官补记）：这些命令正常一两秒内返回（修复1证据里每单元收集约1.7秒），15秒留了约十倍余量；超时最多多一次暂停、保留现场，不会被当成容器已死或在途为零，所以宁短勿长，免得Docker挂住时调度程序长时间不动。
- Docker认领同时检查日志路径的字面归属和realpath物理归属；同runId的其他root、指向其他root的junction均不认领、不停、不杀，事件记foreign-root-unit-ignored。注意：容器名由runId和unitId决定，同一runId在另一个root里还有容器时，本root起同名容器会因名字冲突失败，按启动器错误整轮暂停，不碰对方容器。新运行一律换新runId。
- 冻结及每次启动都比对镜像sec1.context与工作树；exp标签还对正式台账行。报错含两边指纹；不要为绕过错误改台账、标签或冻结计划。exp1-v1标签和台账行保留。
- 主资源总量以容器内cgroup为准，stop补最后一个样本。旧T8c采样器按冻结计划中的源码哈希识别，经用户确认允许最多1000ms尾部缺口；导出明确写实际缺口、只积分样本覆盖部分、不外推。其他数据仍只容许一个配置采样间隔，新矩阵要求末次样本覆盖tasksEnded。Docker stats在观察到退出后才收集，无法覆盖容器寿命，四个container*资源列可能为空，containerMissing写明原因；不补零。
- 收集仍串行，避免改变失败暂停、结果落盘及暂停进程退出的现有顺序；每次wait新增collection-start/collection-end及durationMs，可逐块求和。历史18配置每块收集约33–45秒；修复1的实际数以本轮矩阵和交付说明为准，不能把它当作答题时间。

### 挂载深度和辅助评分

Docker Desktop的独立探针在源目录第17层开始出现EIO；启动器和辅助评分会在create前拒绝超过16层的宿主绑定源路径。深度按盘符之后的目录组件计，字符总数不是该缺陷的判断依据。冻结计划时逐个预检所有job/unit的/unit、/output和/guard；目录尚未创建时，沿最近存在祖先的realpath投影未来路径，同时检查字面路径和junction目标路径，错误包含挂载、层数和源路径。

主实验建议root为 `F:\Academic\Ditto\experiments\sec1\01_bfcl_multiturn\runs\main`：root是7层，output/logs/guards绑定源是13层，直接用题目tasks目录辅助评分的输入源是16层，评分输出源不超过12层。再加一层目录会使辅助评分输入超限；改用更浅root，或只读复制输入到F盘短目录、逐文件验SHA后评分，原结果不覆盖。

### 中途退出的构建

先从原构建日志取得sec1.builder的完整值（不是显示名称），预览 `scripts/docker-gc.ts --run=<builder值>`；该入口同时搜索同owner的sec1.run或sec1.builder。镜像会继承builder标签，因此只有run/unit两个标签键均不存在的对象才按“构建容器”处理；有别的run/unit的对象即使builder相同也跳过，空字符串标签同样不能冒充无标签。显式sec1.run等于目标的正常运行清理仍保留。入口显示完整容器ID且只列已退出容器；确认属于本次构建后加 `--apply`，内部按完整ID删除，运行中的容器仍保留。镜像另用 `--image=<完整sha256>` 预览/删除，台账和冻结计划引用继续受保护。UTF-8 BOM只在解析计划JSON时去掉，其他损坏仍拒绝清理。

### exp1-v2 导出格式

`metadata.json` 的 `tableSchemaVersion` 为2，`tables`逐表记录文件名、格式、行数、UTF-8字节数及UTF-16字符单元数。`summary.json`、`tasks.json`、`blocks.json`仍是JSON数组，字段和缩进不变，但逐行写出；steps、steps-各部署、workers、resources、requests、host、scheduleEvents改为`.jsonl`，一行一个完整JSON对象。字段、null/missing含义和原记录顺序不变。

分析脚本先读metadata再按格式迭代。JSONL用Python的`for line in file: row=json.loads(line)`，或Node逐行读取；不要用`read_text()`/`readFileSync(...,'utf8')`加载整张steps表，也不要把所有行再拼成一个大字符串。Python命令仍加`-B`，宿主TEMP/TMP仍按任务设置在F盘。

写出只缓存约1Mi字符和一条记录；读取逐行处理，steps/graphs最多缓存一个attempt。小表、数值索引和未结算预留仍在内存，不能宣称任意题量都恒定内存。43,200题、每题137步的容量探针有5,918,400步，steps主表5,187,469,440字节；512MiB堆限制下两次导出成功，最大RSS为476,868,608字节，两份完整输出逐字节一致。该合成输入只验证容量；SAMPLE专用语义由真实144题回放的逐字段对照验证，不把合成容量输入当作模型实验。

### 宿主容量观测

矩阵额外以宿主Win32只读接口约200ms记录可用物理内存、实际页面文件使用量、CPU和进程/线程数；独立32MiB测量容器约1秒读取VM的`/proc/meminfo`。原始样本、最小可用值和页面文件使用峰值均保留。低于500MiB只写记录，照常完成；监控不调用暂停入口、不调整配额或系统设置。有限采样的最低值不代表捕获了每一个瞬时尖峰。矩阵、场景和发布验证必须串行。

测量容器使用`--init`，先确认宿主观察器已落下首样本，再起矩阵；结束时正常SIGTERM经init转发，核对观察器未OOM并收集删除。宿主观察器只读，主进程身份不符或停止文件出现后自退；正常join有10秒界限，必要时仅结束本会话自己的观察器并保留错误。观察器错误不能跳过VM容器清理，也不能覆盖矩阵本身的失败。

Windows调度子进程白名单包含PATH、PATHEXT及原有平台/临时目录项。PATHEXT缺失会使`powershell.exe -NoProfile`找不到裸命令`node`；只补这一命名项，不枚举或透传额外凭据变量。

## T9 段 A：两条线

阶段配置的 batch 可写 `lanes`：线的数组，每条线是组的序列，每组是配置编号。不写时和原来一样，所有配置一起起；冻结计划里也没有这个字段。冻结时校验：编号恰好等于这个 batch 的 `configs`、每个只出现一次、同一并发档全在同一组。不满足就拒绝，错误里写出配置编号。

块开始时每条线的第一组同时起；一条线的一组全部收集完，这条线的下一组才起；所有线都跑完，这块才评分、写 `block-end`。同时在跑的单元数等于各线当前组的配置数之和，主实验最多 5+7=12。`attempt.json` 和 `group-start` 事件记 `lane`、`laneGroup`（从 1 数），导出的 blocks、tasks 也带这两个字段。按计划分组先后跑不算补跑。有 `lanes` 时 `nonConcurrent` 按组判断：组里缺配置，或者组里有第 2 次以后的尝试，这个组才算补跑；`attempt.json`、块表的 `nonConcurrent` 和 `group-start` 的 `supplement` 都按这条算；被认领的旧单元不重写 `attempt.json`，保留它原来写下的值。组里缺配置时，块表的 `nonConcurrent` 是 `true`，任务表仍按每道题自己的尝试号算（第 2 次以后的尝试才是 `true`），和改前一样。`block-start` 的 `supplement` 仍描述整块（有没有第 2 次以后的尝试）。不写 `lanes` 时只有一组，就是整块，和原来一样。`block-start` 列出整块的配置和题序，包括后来因为停止没有起的组；判断某组实际开跑，看 `group-start`，不看 `block-start`。尝试目录在组起的时候才写，所以没起的组没有尝试记录。

停下来时分两种：

- **停止**（`stopping` 为真：出口停止或出口异常退出、计划停止、启动器错误）：不再起任何新组，已在跑的单元按原规则收尾。这块剩下的组留到续跑。
- **只暂停**（连续 2 道同类失败、单元失败、配置没开始、单个配置卡住）：这块还没起的组照常起，整块跑完再暂停，不开下一块（已定事项第 15 条）。单个配置卡住时，放弃等待的单元还活着（它有在途请求，不强杀），下一组照常起，所以这一段实际在跑的单元数可能超过各组配置数之和，主实验可能超过 12 个，以 `docker ps` 为准。这种情况只在这一轮已经定为暂停之后出现：这块跑完就停，不开下一块；卡住的单元和出口留给人工，按上文“请求一直不结算”处理。主实验同时在跑的最多是 5+k+6 个（k 个放弃等待的并发 4 单元，k≤7），最坏 18 个，也就是已经验证过的“18 个一起跑”的量。

续跑时只起还有剩余题的配置，仍按线和组的先后，没有剩余的组跳过。认领到的旧单元算在它的组里，而且先于这条线上还没起的组：调度程序重启时并发 8 组的单元还活着，这条线就先等它收完，再起并发 4 组要补的配置，两组不会同时跑。认领到的组之间一起看，不再分先后。

恢复命令不变。出口停止后 `recover` 一次、`run` 一次，按顺序补完。`interrupt-egress` → `recover` 之后的第一次 `run` 只收集旧单元的非零退出、按单元失败处理，所以并发 8 组照常起，并发 4 组的补跑排到下一次 `run`，也就是并发 8 可能先于并发 4 补跑；同一并发档的配置仍在同一组一起跑，同档公平不受影响。计划停止后直接 `run`；连续失败要带 `pause:<完整ID>` 授权。

验收证据在 `runs/offline/t9-20261107/a/`。

## T9 段 B：真实模式

不带 `--live` 的命令都和原来一样，默认离线。真实模式只在下面的条件全部成立时才会起来；第一次真实调用在阶段 2，由用户另外授权。

### 怎么起

阶段配置 `config/stages/live-profile.json`（2a）、`live-pilot.json`（2b）、`live-slice.json`（阶段 3）、`live-main.json`（阶段 4）的预算、价格、`maxRequests` 留 null，不能直接冻结。用户批授权单后，由指挥官在副本里填数再冻结；2b、3、4 还要用 `--targeted-split` 给 2a 的真实分法。冻结时这些数必须都是有限正数，否则拒绝，错误里写出是哪一项：`referenceUsd`、`referenceCny`、`peakCnyPerMillion` 三项、`maxRequests`、`perTaskRequests`、`dispatchPolicy` 四项、`prices` 的谷价和峰价。还要求后端和模式都是 `live`、启动器是 `docker`。这些数随计划哈希固定，开跑后不能改。

每次真实 `run`（包括续跑）都要带三样，少一样、哈希不对、说明为空都拒绝，真实计划不带 `--live`、离线计划带 `--live` 也拒绝：

```powershell
node --import ./scripts/egress-offline-guard.mjs --experimental-transform-types scripts/t8a.ts run --root <root> --live --key-file <密钥文件> --live-authorization "live:<完整计划哈希> 具体说明"
powershell.exe -NoProfile -File scripts/t8a-stage.ps1 -Stage <阶段文件> -Root <root> -Live -EnvFile <密钥文件> -LiveAuthorization "live:<完整计划哈希> 具体说明"
```

**不要写 `--env-file`。**Node 会自己打开命令行里任何 `--env-file` 指的文件，脚本名之后的也算，而且发生在保护器加载之前，文件不存在时直接退出。所以 `t8a.ts` 的参数叫 `--key-file`，`--env-file` 是未知参数，会被拒绝。PowerShell 入口的 `-EnvFile` 转成 `--key-file`，不打开文件。

每次 `run` 在 `scheduler/live-authorizations/` 下记一份：时间、进程号、计划哈希、预算/请求/在途上限、授权原文、密钥文件的路径。不记文件内容，也不记它的哈希。真实模式的授权说明去掉空白、控制符、不可见格式符、韩文填充符（U+115F、U+1160、U+3164、U+FFA0）、盲文空白 U+2800、组合附加符和变体选择符后，至少要有 2 个字符；`confirm-fee` 的 `--user-text`、`--authorization` 用同一个判断，至少 1 个字符。私用区、未分配码位（含非字符）、U+FFFC、U+1D159 也不算可见，未分配按本机 Node 的 Unicode 版本算；单独的代理项字符目前仍算可见，阶段 4 出发布包前补（T9 段 C2、C3 修复、T10 和审查，2026-11-08）。

密钥文件是 `NAME=VALUE` 行，要有配置里 `baseUrlEnv`、`apiKeyEnv` 两个名字（模板是 `BFCL_BASE_URL`、`BFCL_API_KEY`），其余内容丢弃。地址必须是不带账号和查询参数的 HTTPS。`--key-file`、`-EnvFile` 填的是密钥文件的**路径**，不要把密钥本身粘进去（粘进去会被当成路径记进授权记录和保护器报告）。密钥文件单独放进一个新建的、只装它的文件夹，不放在网络共享上，不给它建硬链接。真实模式只用上面两条命令起；`src/ts/egress/server.ts` 自带的 `--live` 入口已改成拒绝，提示改用 `t8a.ts run --live`。`--key-file`、`-EnvFile` 为空、只有空格、不存在、是目录或带 `..` 时，在写授权记录、起出口之前就拒绝，报错不回显这个值。出口在回复解析之后再脱敏一次，逐个字符串值和键名都查，错误回复同样处理：认得出原文、`\u` 转义、encodeURIComponent、全字节百分号（不分大小写）、Base64 和 Base64url（任意字节对齐）；认不出大小写变化、截断和 hex。本身是 JSON 的字符串（比如工具参数）会再解析、再脱敏，最多 4 层，里面用 `\u` 转义的密钥也认得出；超过 4 层不再拆开，嵌套到约 5000 层以上的回复会被当成无效 JSON、保留预留费用。没有密钥的回复原样不动，请求体不变（T9 段 C2、C3 修复和审查，2026-11-08）。

### 密钥和网络怎么管

调度程序只把密钥文件的路径交给出口进程，自己不打开它。离线保护器给每个子进程强制挂自己；唯一的例外在 `scripts/egress-live-launch.mjs`：`scripts/t8a.ts run --live`，全机调度锁文件里记的 pid、运行根、runId 就是这个进程和这份计划，计划哈希自洽、后端和模式是 live、启动器是 docker，本进程写过匹配的授权记录，命令行逐项等于起 `egress-shell.ts` 的那一条，而且一个进程只放行一次。这时子进程只挂 `scripts/egress-live-guard.mjs`。别的子进程照旧挂离线保护器；`egress-shell.ts` 看到离线保护器就拒绝启动，所以只伪造命令行只会得到一个起不来的进程。这些核对看的是锁文件和授权记录的内容，挡的是我们自己的程序误用（拿错入口、走错路径），不挡本机上已经在跑的恶意代码：把锁文件、计划、授权记录一起伪造齐全就能放行，而能做到这一步的代码本来也能直接读密钥文件（指挥官按段 B 三份审查裁定补，2026-11-07）。

真实模式保护器的规则：只许连密钥文件里那个 HTTPS 地址的主机和端口，DNS 只许对这个主机名 `lookup`，只许在 127.0.0.1 上监听；照旧拒绝 `private`、`.env*`、额外禁区，密钥文件只在启动时读一次；不起任何子进程。密钥所在目录整个是禁区，读文件、列目录、glob 都拒；密钥文件和它的目录按启动时记下的卷号＋文件号认，所以经 `\\localhost\F$` 管理共享、硬链接、改上层目录名再读密钥文件都挡住；密钥目录下任何一层子目录里的文件，也按逐级比对上层目录的卷号＋文件号挡住，某一级目录 stat 不了时这次操作直接失败、不放行（T9 段 C3 修复，2026-11-08）。真实模式拒绝手工构造的 `ChildProcess`，装好后禁用 `module.register` 和 `registerHooks`；离线保护器也包了 `ChildProcess.prototype.spawn`、禁用 `module.register`，保留测试钩子要用的 `registerHooks`。`Socket.connect` 按规整后的一次性选项检查，dgram 套接字不能 bind、connect、send，`inspector.open` 拒绝。剩下的已知缺口，都要出口进程里已有任意代码才能利用：符号链接和 8.3 短名本机建不出来，没验证；离线下仍有手工拼出、不挂保护器的子进程路子（改前就如此，不改）（T9 段 C2 和审查，2026-11-08）。密钥从保护器直接交给 `liveBackend`，不进任何进程的环境变量。容器那一侧不变：转发只连宿主出口，容器里的 Node 仍挂离线保护器、连不了外网。容器网络本身是 bridge，容器里不挂保护器的 Python 在网络层能连到宿主别的端口、按路由表也能出外网（改前就如此）；容器里没有密钥，BFCL multi-turn 的工具都是本地模拟、不联网（指挥官按段 B 三份审查裁定补，2026-11-07）。段 C 评估过只通向宿主出口的内部网络：Docker Desktop 上 `internal` 网络解析不了 `host.docker.internal`，加 host-gateway 后报网络不可达，所以保持 bridge（T9 段 C2，2026-11-08）。

不用代理。真 API 不走代理连不上时，停下来报告，不在这里配代理。

### 开跑前查什么

1. 镜像：阶段配置的标签是 `exp1-v3`，`src/` 改过以后旧标签会被冻结和启动拒绝。
2. 计划：`plan.json` 的哈希、预算、`maxRequests`、`maxInFlight` 和授权单一致；授权单写明上限按峰价（账本按 `peakCnyPerMillion` 计）。
3. 额度：账本发请求前按这一笔可能的最大用量预留（输入至少 32768、输出 65536 个 token；按旧快照的峰价每笔约 0.59 元），结算后才退回。所以余额不够一笔预留时就停，能花到的钱比上限少不到一笔；上限小时，同时在途的请求也受“上限÷每笔预留”限制，多出来的请求排队等结算，排队时间算进实测耗时。所以上限要留出“最多同时在途数 × 每笔预留”的余量，否则测到的是预算排队。未知费用每笔按这个预留占额；429、5xx 每重试一次也留下一笔这样的占额，到账本结束都不退。
4. 价格：`prices` 是旧实验的快照，真跑前请用户确认当前价格。11-07 已按官网核对，deepseek-flash 和快照一致（`runs/offline/t9-20261107/prices/`）。冻结时 `prices.peak` 要和 `budget.peakCnyPerMillion` 逐项相等，`referenceUsd`、`referenceCny` 乘 1e6 后是不小于 1 的安全整数，峰价恰好三个键且 cachedInput 不大于 uncachedInput，`referencePrice` 是有限正数——冻结时检查这几条，不满足就拒绝冻结（T9 段 C2，2026-11-08；原来要到出口启动时账本才拒绝）。
5. 密钥文件：路径对，地址是 HTTPS。不要把密钥放进环境变量；不要设 `NODE_TLS_REJECT_UNAUTHORIZED`，设了真实模式保护器拒绝加载。
6. 运行根：新目录、新 runId，挂载深度不超过 16 层；阶段 2a、2b 是两个运行根、两个账本。
7. 机器：开盖、接电，关掉占内存大的软件；Docker 只给这一轮用。

### 停了怎么办

| 看到什么 | 怎么做 | 要授权吗 |
| --- | --- | --- |
| `reason` 为 `egress-stop`，到人民币或请求上限 | 账本和假设都对就到此为止；要加额度只能新开运行根，开跑后不能改上限 | `recover` 要；恢复后再 `run` 仍到不了模型 |
| `reason` 为 `egress-stop`，429 或 5xx 重试用完、请求超时、模型名不对、401 | 先看 `egress/calls.jsonl` 和 `retry-exhausted.json`，查清原因，再 `recover`，再 `run --live ...` | `recover` 要说明；`run` 要三样 |
| 用量超过预留 | 账本标为超限，`recover` 拒绝，不能续跑。保留现场报告 | 不能走恢复 |
| 单题 `request_limit` 终态 | 不停，别的题照常；结果表里按终态看 | 不用 |
| 出口异常死掉 | 确认单元已退出，等心跳过期 5 秒，`recover`，再 `run --live ...` | 同上 |
| 出口冻结、请求不结算 | 走上文“心跳永久冻结”：`interrupt-egress` → 等单元退出 → `recover` → `run --live ...`，可能要 run 两次 | `interrupt-egress` 和 `recover` 都要说明 |
| 连续失败暂停 | `run --live ... --authorization "pause:<完整ID> 具体说明"` | 两份授权都要 |

`recover`、`interrupt-egress` 在真实计划上要授权说明，不需要密钥文件，也不接受 `--live`、`--key-file`，因为它们不问模型。未知费用一律保留，不清零。


传输出错（断线、超时、5xx、408）要重试时，冷却只压出错的那个请求：它等 30 秒（再错翻倍，最长 120 秒）再重发，等的时候不占在途名额，失败那次的预留照样保留；别的请求照常发。只有 HTTP 429 让整个出口一起冷却，`Retry-After` 照旧遵守。`egress/rate.cooldowns.jsonl` 每行带 `scope`（`global` 或 `request`），出口重启只恢复 `global` 的冷却，旧记录没有 `scope` 的按 `global` 算。出口停止时，正在等重发的请求被叫醒并报错，不再发出。5xx 带 `Retry-After` 时也只压那一个请求；要它也全局冷却，是一行改动（T11，2026-11-08；原来任何传输错误都让整个出口停 30 秒，阶段 3 有一次 51 秒全场零发送）。

真实模式下单次物理请求一定在 `timeoutMs` 内结束（算上 `maxRetries` 次重试和冷却，一次逻辑请求最长约 3×(`timeoutMs`+冷却)；模板配置下“一直不回”最坏约 31.5 分钟、留下 3 笔未知预留后才整轮停（指挥官按段 B 三份审查裁定补，2026-11-07）），而调度程序判“请求挂死”的上限比它长，所以“单元活着、出口健康、请求就是不结算”这条路走不到；请求不结算只会出现在出口冻结的时候，走冻结路径。

验收证据在 `runs/offline/t9-20261107/b/`。

## T9 段 C1：导出、大表和费用确认（2026-11-08）

### 资源列

CPU、内存积分只要有采样就照常积分，不外推：只积真实采到的那几段。`resourceSamplingOk` 是原来的达标规则（含 1000 ms 旧采样器那条），现在只是一个标记；不达标时看 `resourceCoverage`（覆盖比例）、`resourceMaxGapMs`（最长没被覆盖的一段）、`resourceUnavailableSamples`（不可用样本数）。内存积分 `gibSeconds` 按 1024³ 字节，旧列 `gbSeconds` 是十进制 GB。中间夹着不可用样本时，CPU 用累计计数器跨过缺口（这是真实值），内存按线性插值，`resourceCoverage` 仍报 1：这时要看 `resourceUnavailableSamples` 和 `resourceSamplingOk`。

### 新增的两份采样

- 出口进程负载：出口每 5 秒往 `egress/status.jsonl` 追加一行，只有时间、各配置在途数、出口自己的 CPU 和内存，没有请求内容或密钥。
- Docker 虚拟机内存：启动器是 docker 时，调度程序每 5 秒用 `docker info`、`docker stats --no-stream` 采一次，写进 `scheduler/docker-vm.jsonl`；命令出错或 15 秒超时只记 `available:false`，不影响调度。

### 用户确认一笔未知费用

```powershell
node --import ./scripts/egress-offline-guard.mjs --experimental-transform-types scripts/confirm-fee.ts --root <运行根> --request <请求ID> --conclusion not-charged --user-text '<用户原话>' --authorization '<谁、何时授权>'
```

只往 `scheduler/fee-confirmations.jsonl` 追加一行，账本一个字节都不动；同一请求以最后一行为准。没授权、说明为空、请求已经结算或 ID 不存在都拒绝。之后重新导出：确认未扣费的记 0 元，不再算未知。

确认扣了钱的，用 `--conclusion charged --charged-cny <元>`。导出汇总的 `confirmedChargedCny` 是这一范围内确认实付金额之和，没有时留空、不填 0；这一范围的 `valleyCny`、`peakCny`、`inputTokens`、`reasoningTokens` 等完整用量列照旧留空，`knownValleyCny` 不含这笔钱。发布包的主结果和费用表有"已确认实付（元）"一列，不分谷价峰价。账本的预留行原样保留（T9 段 C3 修复，2026-11-08；原来记了 charged 后旧费用列会变成有值却不含这笔钱）。导出的 summary、blocks、tasks 三层同一规则：没有 charged 时 `confirmedChargedCny` 留空，有时是确认金额（确认 0 元就是 0）；tasks 另有 `confirmedChargedRequests`（确认已扣费的请求数，没有就是 0，这是实数不是缺测）。"正式逐题"表有"确认已扣费请求（次）"一列，本次请求 = 已结算 + 确认免单 + 未知 + 确认已扣费（T10，2026-11-08）。

`graphTimes` 能区分 null 和 undefined，结果和 T9 之前的算法逐值相同。`tests/t9c1-export.test.ts`、`t9c1-release.test.ts` 找不到阶段 2 运行根就失败，在隔离副本里跑要设 `T9C1_LIVE_ROOT`（T9 段 C3 修复）。

### 生成发布包

导出用 `scripts/t8a.ts export --root <运行根> --output <新目录>`。发布包用 `scripts/build-release.py` 从导出生成，`scripts/check-release.py <发布包> <清单>` 自查格式（表头第 1 行、顶部不冻结、网格线、字体只有宋体和 Times New Roman，包括空格子和工作簿默认字体）、路径和密钥。完整命令写在 `build-release.py` 开头。发布包放在 `releases/<名字>/`，清单放在包外的证据目录；目标目录已存在就拒绝写入。阶段 2 的生成记录在 `runs/offline/t9-20261107/release/`；它是在段 C3 修复之前生成的，所以主结果和费用表没有"已确认实付（元）"一列（阶段 2 没有任何确认，这一列本来就全空），以后重新生成会多出这一列。

## T10、T11：阶段 4 之前（2026-11-08）

### 账本有多大、出口能不能打开

- 调度程序在单元退出时逐行读 `egress/ledger.jsonl`、`rate.jsonl`，只留这个配置、这一轮的行，内存约 116 MiB，和账本大小无关（T10）。
- **出口开机和 `recover` 仍把整个账本读成一个字符串**（`ledger.ts`、`gateway.ts` 没改）。上限约 101 万次请求（每次约 530 字节）；超过以后不是跑着时出错，而是**下一次开机或恢复时**报 `Invalid string length`，跑到一半就续不上。阶段 3 实测每题 13.2 次：一轮 800 题 × 18 配置约 19 万次、约 101 MB，开机约 1 秒、内存约 0.6 GiB。所以阶段 4 按轮拆成三个运行根（`live-main-r1`、`r2`、`r3`，用户 11-08 定），一个账本只装一轮。
- 主实验规模导出（43200 题，带 graphs）约 11 分钟、内存峰值约 3.4 GB；一轮约三分之一。导出前看一眼空闲内存。

### 冷却的导出口径

- T11 起断线冷却只压出错的那个请求（见上文"T9 段 B"里"停了怎么办"之前那段）。导出的 `cooldowns`、`cooldownMs` 目前把全局冷却和单个请求的冷却加在一起，不分开（`export-detail.ts:125`）。原始记录 `rate.cooldowns.jsonl` 每行带 `scope`，阶段 4 出结果前改导出按 `scope` 拆开，不用重跑（T10 审查新发现 4）。

### 测试和发布包

- `tests/t9c1-scale.ts` 读包里的 `runs/offline/t8c-20261106/profile/targeted-split.json`，找不到就失败；`--phase` 参数可以按 40 分钟分段。
- 没给 `--profile-report` 时，发布包不出"剖析分配"表，写进"没出的表"；不单列"逐轮结果"的理由写实际阶段名。README 的"必读说明"仍写死阶段 2 的内容，阶段 4 出发布包前改。
- `tests/t11-routing.test.ts` 失败时会在关运行时那一步挂住，跑它一律带 `--test-timeout`。
