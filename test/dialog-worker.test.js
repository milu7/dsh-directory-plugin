import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import worker from "../lib/dialog-worker.cjs";

const { createPost, errorMessageOf, runFolderDialog } = worker;

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

describe("errorMessageOf：报错只带 message，堆栈另放", () => {
	test("Error：message 不含堆栈，stack 单独给宿主写日志", () => {
		const message = errorMessageOf(new Error("CoInitializeEx failed: HRESULT 0x80010106"));
		assert.equal(message.kind, "error");
		assert.equal(message.message, "CoInitializeEx failed: HRESULT 0x80010106");
		assert.match(message.stack, /^Error: CoInitializeEx failed[^\n]*\n\s+at /);
	});

	test("抛出的不是 Error 时转成字符串", () => {
		assert.deepEqual(errorMessageOf("boom"), { kind: "error", message: "boom" });
	});
});

/** 不碰 Win32 的绑定替身；calls 记录对话框收到的调用。 */
function fakeBindings(calls = []) {
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
			setOptions: (options) => (calls.push(["setOptions", options]), 0),
			setTitle: (title) => (calls.push(["setTitle", title]), 0),
			setFolder: () => 0,
			show: () => 0,
			resultPath: () => ({ hr: 0, path: "D:\\Picked" }),
			release() {}
		})
	};
}

describe("runFolderDialog：标题", () => {
	test("给了标题就设置", () => {
		const calls = [];
		runFolderDialog(fakeBindings(calls), "选择新工作区所在文件夹", undefined, () => {});
		assert.deepEqual(
			calls.filter(([name]) => name === "setTitle"),
			[["setTitle", "选择新工作区所在文件夹"]]
		);
	});

	test("没给标题就不调 SetTitle，保留系统自带的（已本地化的）标题", () => {
		const calls = [];
		runFolderDialog(fakeBindings(calls), "", undefined, () => {});
		assert.deepEqual(
			calls.filter(([name]) => name === "setTitle"),
			[]
		);
	});
});

describe("runFolderDialog：showing 里的起始目录诊断（设置页据此判断是否回退）", () => {
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
