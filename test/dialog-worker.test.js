import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import worker from "../lib/dialog-worker.cjs";

const { createPost, runFolderDialog } = worker;

describe("createPost：只有终止消息才结束会话", () => {
	test("IPC：showing 之后不断开，done 之后才断开", () => {
		const proc = {
			connected: true,
			disconnects: 0,
			disconnect() {
				this.disconnects++;
				this.connected = false;
			}
		};
		const sent = [];
		const post = createPost({
			send: (message, delivered) => {
				sent.push(message.kind);
				delivered();
			},
			logFile: "",
			proc
		});

		post({ kind: "showing" });
		assert.equal(proc.disconnects, 0);
		post({ kind: "done", path: "D:\\Picked" });
		assert.deepEqual(sent, ["showing", "done"]);
		assert.equal(proc.disconnects, 1);
	});

	test("文件传输：showing 不会让进程退出，error 以退出码 1 退出", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const exits = [];
		const post = createPost({ send: null, logFile: "", proc: { exit: (code) => exits.push(code) } });

		post({ kind: "showing" });
		t.mock.timers.tick(1000);
		assert.deepEqual(exits, []);
		post({ kind: "error", message: "boom" });
		t.mock.timers.tick(50);
		assert.deepEqual(exits, [1]);
	});
});

describe("runFolderDialog：showing 里的起始目录诊断（设置页据此判断是否回退）", () => {
	function fakeBindings() {
		return {
			setThreadDpiAwareness() {},
			coInitializeSta: () => 0,
			coUninitialize() {},
			currentThreadId: () => 1,
			pressAltForForeground() {},
			displayPathOf: (item) => ({ hr: 0, path: item.path }),
			shellItemFromPath: (directory) => ({ hr: 0, item: { path: directory } }),
			release() {},
			createFolderDialog: () => ({
				setOptions: () => 0,
				setTitle: () => 0,
				setFolder: () => 0,
				show: () => 0,
				resultPath: () => ({ hr: 0, path: "D:\\Picked" }),
				release() {}
			})
		};
	}

	test("没配置起始目录：requested 为 null", () => {
		let reported;
		const picked = runFolderDialog(fakeBindings(), "title", undefined, (_threadId, folder) => {
			reported = folder;
		});
		assert.equal(picked, "D:\\Picked");
		assert.deepEqual(reported, { requested: null, applied: false });
	});

	test("配置的目录已不存在：requested 有值、applied 为 false", () => {
		const missing = path.join(os.tmpdir(), "dsh-directory-plugin-missing-" + process.pid);
		let reported;
		runFolderDialog(fakeBindings(), "title", missing, (_threadId, folder) => {
			reported = folder;
		});
		assert.deepEqual(reported, { requested: missing, applied: false, reason: "missing" });
	});
});
