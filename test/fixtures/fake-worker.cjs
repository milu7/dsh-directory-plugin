/**
 * 假的 dialog worker：沿用真实 worker 的 createPost（被测对象），但不碰 koffi / Win32。
 *
 *   FAKE_WORKER_MODE=yield       showing 之后先让出事件循环，再回报结果
 *                                （真实 worker 的 Show() 是同步阻塞的，恰好掩盖了断开过早的问题）
 *   FAKE_WORKER_MODE=exit-early  showing 之后直接退出
 */
"use strict";

const path = require("node:path");
const { createPost } = require(path.join(__dirname, "..", "..", "lib", "dialog-worker.cjs"));

// 被 `node --test` 直接当成测试文件跑时没有 IPC，安静退出即可。
if (typeof process.send !== "function") process.exit(0);

const post = createPost({ send: process.send.bind(process), logFile: "" });
process.on("disconnect", () => process.exit(0));

const requested = (process.env.DSH_DIALOG_INITIAL_DIR ?? "").trim() || null;
post({ kind: "showing", threadId: 0, initialFolder: { requested, applied: requested !== null } });

if (process.env.FAKE_WORKER_MODE === "exit-early") process.exit(3);
else setTimeout(() => post({ kind: "done", path: "D:\\Picked" }), 100);
