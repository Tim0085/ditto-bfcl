# Ditto 0.1.5 独立副本：来源

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/CodeSoul-co/Ditto |
| tag | `v0.1.5` |
| 提交 | `d95ded5000236c4da11a7f038e69906a6641519e`（2026-11-02 13:53:45 +0800） |
| 构建日期 | 2026-11-04 |
| 构建环境 | Node v24.14.0、npm 11.21.1、Windows 11 |
| 构建命令 | 在包外临时目录 `git clone --depth 1 --branch v0.1.5`，然后 `npm ci --ignore-scripts`（安装了 12 个构建依赖），再 `npm run build:core` |
| 本目录内容 | `dist/` 是构建输出原样拷贝（581 个文件，与构建目录逐文件比对一致）；`package.json` 只保留运行需要的字段，另加 `private`、`files`、`dittoSourceTag`、`dittoSourceCommit`；`SHA256SUMS.txt` 是 `dist/` 全部文件和 `package.json` 的 SHA-256 |

没有构建 `packages/retrieval`（BFCL 不用检索）。

替换下来的 0.1.2 副本原样保留在 `../ditto-0.1.2/`（T1 交付的那一份，内容未改，只改了目录名）。

替换后在本包内的核对（2026-11-04）：

- `npm run typecheck` 通过；
- T2 的 35 项测试全部通过；
- `scripts/verify-context-roundtrip.ts`（真实旧轨迹 31 条消息往返）全部 PASS；
- `package-lock.json` 只有 `vendor/ditto` 的版本号一行从 0.1.2 变成 0.1.5。

这一步由指挥官完成，T3 验收时要独立复核：重新从 tag 构建一次，和本目录的 `SHA256SUMS.txt` 比对。
