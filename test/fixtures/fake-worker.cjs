/**
 * 假的 dialog worker：沿用真实 worker 的 createPost / errorMessageOf（被测对象），但不碰 koffi / Win32。
 *
 *   FAKE_WORKER_MODE=yield             showing 之后先让出事件循环，再回报结果
 *                                      （真实 worker 的 Show() 是同步阻塞的，恰好掩盖了断开过早的问题）
 *   FAKE_WORKER_MODE=exit-early        showing 之后直接退出
 *   FAKE_WORKER_MODE=error             showing 之后回报一个带堆栈的错误
 *   FAKE_WORKER_MODE=echo-title        把收到的 DSH_DIALOG_TITLE 当作选中的路径回报
 *   FAKE_WORKER_MODE=owner-crash       showing 里报告父窗口 4242，然后直接退出（模拟对话框开着时崩溃）
 *   FAKE_WORKER_MODE=owner-done        showing 里报告父窗口 4242，然后正常回报结果
 *
 * 修复模式（DSH_DIALOG_REENABLE_OWNER）：把收到的窗口句柄写进 FAKE_WORKER_MARKER 指向的文件。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createPost, errorMessageOf } = require(path.join(__dirname, "..", "..", "lib", "dialog-worker.cjs"));

if (process.env.DSH_DIALOG_REENABLE_OWNER) {
	fs.writeFileSync(process.env.FAKE_WORKER_MARKER, process.env.DSH_DIALOG_REENABLE_OWNER);
	process.exit(0);
}

// 被 `node --test` 直接当成测试文件跑时没有 IPC，安静退出即可。
if (typeof process.send !== "function") process.exit(0);

const post = createPost({ send: process.send.bind(process) });
process.on("disconnect", () => process.exit(0));

const mode = process.env.FAKE_WORKER_MODE ?? "";
const requested = (process.env.DSH_DIALOG_INITIAL_DIR ?? "").trim() || null;
const owner = mode.startsWith("owner-") ? "4242" : null;
post({ kind: "showing", initialFolder: { requested, applied: requested !== null }, owner, koffi: "fake-koffi" });

if (mode === "exit-early" || mode === "owner-crash") process.exit(3);
else if (mode === "error") post(errorMessageOf(new Error("boom")));
else if (mode === "echo-title") post({ kind: "done", path: process.env.DSH_DIALOG_TITLE ?? "" });
else setTimeout(() => post({ kind: "done", path: "D:\\Picked" }), 100);
