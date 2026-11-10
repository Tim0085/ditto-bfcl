import { readFile } from "node:fs/promises";
import { runBlock } from "../src/ts/config-main.ts";
const block = JSON.parse(await readFile(process.argv[2], "utf8"));
const pending = runBlock(block);
process.once("message", message => {
  if (message !== "planned-stop") throw new Error("unexpected test message");
  // Windows test: exercise this newly started child's registered SIGTERM handler.
  process.emit("SIGTERM");
  process.send?.("planned-stop-applied");
});
try {
  const summary = await pending;
  console.log(JSON.stringify(summary)); process.exitCode = summary.exitCode;
} finally { if (process.connected) process.disconnect(); }
