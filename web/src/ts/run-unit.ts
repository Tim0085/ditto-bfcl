/**
 * 运行单元约定（指挥官，2026-11-05）。只有类型和常量，没有实现。
 *
 * 一个"运行单元"跑一个"配置 × 轮次 × 块（× 第几次尝试）"：起一个 config-main.ts --block <block.json>，
 * 跑完退出。调度程序（T8a）只通过这里的接口起、等、停一个运行单元：
 * - T8a 实现本机子进程版（kind = "local-process"），用来离线测调度逻辑；
 * - T8b 实现容器版（kind = "docker"），主实验用它。
 * 两边都只读这个文件，不改；要改，停下来报告指挥官。
 */

/** 调度程序交给启动器的东西。路径都是宿主上的绝对路径。 */
export interface RunUnitSpec {
  /** 全局唯一；只含字母、数字、下划线、短横线。容器名、标签由它派生。 */
  unitId: string;
  /** 这次运行的编号（plan.json 里的 runId），用于给容器贴标签、找残留。 */
  runId: string;
  /** 调度程序按宿主视角写好的 block.json 内容（T7 交付说明第 2 节的格式）。 */
  block: Record<string, unknown>;
  /** config-main 的 outputRoot，宿主绝对路径；结果写到 <outputRoot>/configs/<configId>/。 */
  outputRoot: string;
  /** 这个单元自己的日志目录（标准输出、标准错误、生命周期记录），宿主绝对路径。 */
  logDir: string;
  /** 离线保护器报告目录，宿主绝对路径。 */
  guardReportDir: string;
  /** 宿主上模型出口的地址，例如 http://127.0.0.1:43210。启动器负责换成单元里看到的地址。 */
  egressUrl: string;
}

/** 单元结束时的情况。拿不到的字段填 null，不猜。 */
export interface RunUnitExit {
  exitCode: number | null;
  /** 被信号结束时的信号名。 */
  signal: string | null;
  /** 是否被 kill() 强杀。 */
  killed: boolean;
  /** 是否先收到过 stop()（计划停止）。 */
  stoppedByPlan: boolean;
  /** 容器版：是否因内存超限被系统杀掉；本机子进程版填 null。 */
  oomKilled: boolean | null;
  startedAt: string;
  endedAt: string;
  /** <outputRoot>/configs/<configId>/block-summary.json 的内容；没有就是 null。 */
  summary: unknown | null;
}

export interface RunUnit {
  readonly unitId: string;
  /** 等它结束。可以多次调用，结果相同。 */
  wait(): Promise<RunUnitExit>;
  /** 计划停止：发 SIGTERM，让 config-main 自己收尾。不自动升级成强杀。 */
  stop(reason: string): Promise<void>;
  /** 强杀。调用方自己负责先确认它在出口上没有在途请求。 */
  kill(reason: string): Promise<void>;
  isAlive(): Promise<boolean>;
}

export interface RunUnitLauncher {
  readonly kind: "local-process" | "docker";
  /**
   * 把调度程序按宿主视角写的 block.json 换成单元里看到的样子
   * （python 路径、outputRoot、modelEndpoint、资源采样目录等）。本机子进程版原样返回。
   */
  toUnitView(spec: RunUnitSpec): Record<string, unknown>;
  start(spec: RunUnitSpec): Promise<RunUnit>;
  /** 调度程序重启后认领还在跑（或已结束但还没收）的同名单元；找不到返回 undefined。 */
  adopt(runId: string, unitId: string): Promise<RunUnit | undefined>;
  /** 列出属于这次运行的单元编号。只按自己的标记找，不碰别的实验的进程和容器。 */
  list(runId: string): Promise<string[]>;
}

/** 容器和镜像上贴的标记名。只按这些标记找和清理，别的一概不碰。 */
export const SEC1_LABELS = {
  owner: "sec1.owner",
  run: "sec1.run",
  unit: "sec1.unit",
  context: "sec1.context",
} as const;
export const SEC1_OWNER = "ditto-sec1-bfcl-web";
/** 唯一的镜像名。 */
export const SEC1_IMAGE_REPOSITORY = "ditto-sec1-bfcl-web";
