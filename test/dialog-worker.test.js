import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import worker from "../lib/dialog-worker.cjs";

const { FOLDER_DIALOG_OPTIONS, HRESULT_CANCELLED, createPost, dshOwnerWindow, errorMessageOf, loadKoffi, loadWin32DialogBindings, reenableOwner, runFolderDialog } = worker;
const VENDORED_KOFFI = fileURLToPath(new URL("../vendor/node_modules/koffi/index.cjs", import.meta.url));
const WORKER = fileURLToPath(new URL("../lib/dialog-worker.cjs", import.meta.url));
const windowsOnly = { skip: process.platform !== "win32" && "要调真实的 Win32 API" };
const DSH_EXE = "D:\\DSH Next\\DSH NEXT.exe";

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
			proc
		});

		post({ kind: "showing" });
		assert.equal(proc.disconnects, 0);
		post({ kind: "done", path: "D:\\Picked" });
		assert.deepEqual(sent, ["showing", "done"]);
		assert.equal(proc.disconnects, 1);
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

/**
 * 不碰 Win32 的绑定替身。calls 记录对话框和窗口收到的调用；
 * windows 描述现有的窗口：hwnd → { exe, enabled }。
 */
function fakeBindings({ calls = [], options = 0, foreground = null, windows = {}, show = 0 } = {}) {
	const windowOf = (hwnd) => windows[String(hwnd)];
	return {
		setThreadDpiAwareness() {},
		coInitializeSta: () => 0,
		coUninitialize() {},
		foregroundRootWindow: () => foreground,
		processImageOfWindow: (hwnd) => windowOf(hwnd)?.exe ?? null,
		isWindow: (hwnd) => windowOf(hwnd) !== undefined,
		isWindowEnabled: (hwnd) => windowOf(hwnd)?.enabled !== false,
		enableWindow: (hwnd) => calls.push(["enableWindow", hwnd]),
		displayPathOf: (item) => ({ hr: 0, path: item.path }),
		shellItemFromPath: (directory) => ({ hr: 0, item: { path: directory } }),
		release() {},
		createFolderDialog: () => ({
			getOptions: () => (typeof options === "number" ? { hr: 0, options } : options),
			setOptions: (value) => (calls.push(["setOptions", value]), 0),
			setTitle: (title) => (calls.push(["setTitle", title]), 0),
			setFolder: () => 0,
			show: (owner) => (calls.push(["show", owner]), show),
			resultPath: () => (calls.push(["resultPath"]), { hr: 0, path: "D:\\Picked" }),
			release() {}
		})
	};
}

const callsNamed = (calls, name) => calls.filter(([called]) => called === name);
const run = (bindings, options = {}, onShowing = () => {}) => runFolderDialog(bindings, { title: "", ...options }, onShowing);

describe("runFolderDialog：标题", () => {
	test("给了标题就设置", () => {
		const calls = [];
		run(fakeBindings({ calls }), { title: "选择新工作区所在文件夹" });
		assert.deepEqual(callsNamed(calls, "setTitle"), [["setTitle", "选择新工作区所在文件夹"]]);
	});

	test("没给标题就不调 SetTitle，保留系统自带的（已本地化的）标题", () => {
		const calls = [];
		run(fakeBindings({ calls }));
		assert.deepEqual(callsNamed(calls, "setTitle"), []);
	});
});

describe("runFolderDialog：选项与返回值", () => {
	test("先 GetOptions，再在默认选项上加 FOS_PICKFOLDERS 等标志", () => {
		assert.equal(FOLDER_DIALOG_OPTIONS, 0x20 | 0x40 | 0x8 | 0x800);
		const calls = [];
		run(fakeBindings({ calls, options: 0x1808 }));
		assert.deepEqual(callsNamed(calls, "setOptions"), [["setOptions", 0x1808 | FOLDER_DIALOG_OPTIONS]]);
	});

	test("最高位有标志时按无符号数传给 SetOptions", () => {
		const calls = [];
		run(fakeBindings({ calls, options: 0x80000000 }));
		assert.deepEqual(callsNamed(calls, "setOptions"), [["setOptions", 0x80000000 + FOLDER_DIALOG_OPTIONS]]);
	});

	test("GetOptions 失败时报错，不弹框", () => {
		const calls = [];
		assert.throws(() => run(fakeBindings({ calls, options: { hr: -2147467259, options: 0 } })), /GetOptions failed: HRESULT 0x80004005/);
		assert.deepEqual(callsNamed(calls, "show"), []);
	});

	test("用户取消（HRESULT_FROM_WIN32(ERROR_CANCELLED)）时返回 null，不再读结果", () => {
		assert.equal(HRESULT_CANCELLED, -2147023673);
		const calls = [];
		assert.equal(run(fakeBindings({ calls, show: HRESULT_CANCELLED })), null);
		assert.deepEqual(callsNamed(calls, "resultPath"), []);
	});

	test("选中时返回路径", () => {
		assert.equal(run(fakeBindings()), "D:\\Picked");
	});
});

describe("runFolderDialog：父窗口（第 14 条：代替模拟按 Alt）", () => {
	test("前台是 DSH 自己的窗口：以它为父窗口（模态），并在 showing 里报告", () => {
		const calls = [];
		let reported;
		const bindings = fakeBindings({ calls, foreground: 7n, windows: { 7: { exe: DSH_EXE } } });
		run(bindings, { dshExe: "d:\\dsh next\\DSH NEXT.EXE" }, (_folder, owner) => (reported = owner));
		assert.deepEqual(callsNamed(calls, "show"), [["show", 7n]]);
		assert.equal(reported, "7");
	});

	test("前台是别的程序（用户切走了）：不设父窗口，也不抢前台", () => {
		const calls = [];
		let reported;
		const bindings = fakeBindings({ calls, foreground: 9n, windows: { 9: { exe: "C:\\Windows\\explorer.exe" } } });
		run(bindings, { dshExe: DSH_EXE }, (_folder, owner) => (reported = owner));
		assert.deepEqual(callsNamed(calls, "show"), [["show", null]]);
		assert.equal(reported, null);
	});

	test("没有前台窗口、读不到进程路径、没给 DSH 路径：都不设父窗口", () => {
		assert.equal(dshOwnerWindow(fakeBindings({ foreground: null }), DSH_EXE), null);
		assert.equal(dshOwnerWindow(fakeBindings({ foreground: 7n, windows: { 7: {} } }), DSH_EXE), null);
		assert.equal(dshOwnerWindow(fakeBindings({ foreground: 7n, windows: { 7: { exe: DSH_EXE } } }), ""), null);
	});
});

describe("reenableOwner：worker 崩溃后恢复被禁用的 DSH 窗口", () => {
	test("还是被禁用的 DSH 窗口：重新启用", () => {
		const calls = [];
		const bindings = fakeBindings({ calls, windows: { 1234: { exe: DSH_EXE, enabled: false } } });
		assert.equal(reenableOwner(bindings, "1234", DSH_EXE), true);
		assert.deepEqual(calls, [["enableWindow", 1234n]]);
	});

	test("已经是启用的、窗口没了、句柄被别的程序复用了、句柄不是数字：什么都不做", () => {
		const calls = [];
		const bindings = fakeBindings({
			calls,
			windows: { 1: { exe: DSH_EXE, enabled: true }, 2: { exe: "C:\\Other\\app.exe", enabled: false } }
		});
		assert.equal(reenableOwner(bindings, "1", DSH_EXE), false);
		assert.equal(reenableOwner(bindings, "3", DSH_EXE), false);
		assert.equal(reenableOwner(bindings, "2", DSH_EXE), false);
		assert.equal(reenableOwner(bindings, "-1", DSH_EXE), false);
		assert.equal(reenableOwner(bindings, "0x10", DSH_EXE), false);
		assert.deepEqual(calls, []);
	});
});

describe("runFolderDialog：showing 里的起始目录诊断（设置页据此判断是否回退）", () => {
	test("没配置起始目录：requested 为 null", () => {
		let reported;
		const picked = run(fakeBindings(), {}, (folder) => (reported = folder));
		assert.equal(picked, "D:\\Picked");
		assert.deepEqual(reported, { requested: null, applied: false });
	});

	test("配置的目录已不存在：requested 有值、applied 为 false", () => {
		const missing = path.join(os.tmpdir(), "dsh-directory-plugin-missing-" + process.pid);
		let reported;
		run(fakeBindings(), { initialFolder: missing }, (folder) => (reported = folder));
		assert.deepEqual(reported, { requested: missing, applied: false, reason: "missing" });
	});
});

describe("loadKoffi：只接受 koffi 3（第 11 条）", () => {
	const fakeLoad = (modules) => (candidate) => {
		if (!(candidate in modules)) throw Object.assign(new Error("Cannot find module " + candidate), { code: "MODULE_NOT_FOUND" });
		return modules[candidate];
	};

	test("跳过找不到的和主版本不对的，用第一个 3.x", () => {
		const koffi3 = { version: "3.1.1" };
		const loaded = loadKoffi(["missing", "old", "new"], fakeLoad({ old: { version: "2.9.0" }, new: { default: koffi3 } }));
		assert.equal(loaded.koffi, koffi3);
		assert.equal(loaded.source, "new", "报告实际用的是哪一份，写进日志");
	});

	test("一个能用的都没有：报错里写明每个候选的问题", () => {
		assert.throws(
			() => loadKoffi(["missing", "old", "odd"], fakeLoad({ old: { version: "2.9.0" }, odd: {} })),
			(error) => {
				assert.match(error.message, /no usable koffi 3\.x/);
				assert.match(error.message, /missing: MODULE_NOT_FOUND/);
				assert.match(error.message, /old: koffi 2\.9\.0, need 3\.x/);
				assert.match(error.message, /odd: koffi unknown, need 3\.x/);
				return true;
			}
		);
	});

	test("随包带的 koffi 通过版本检查", windowsOnly, () => {
		assert.match(loadKoffi([VENDORED_KOFFI]).koffi.version, /^3\./);
	});
});

describe("Win32 绑定冒烟测试（真实 API，但不调用 Show，不会弹框）", windowsOnly, () => {
	function withBindings(body) {
		const previous = process.env.DSH_KOFFI_PATH;
		process.env.DSH_KOFFI_PATH = VENDORED_KOFFI;
		try {
			return body(loadWin32DialogBindings());
		} finally {
			if (previous === undefined) delete process.env.DSH_KOFFI_PATH;
			else process.env.DSH_KOFFI_PATH = previous;
		}
	}

	test("对话框对象：GetOptions（vtable 第 10 槽）读得到默认选项，SetOptions/SetTitle 成功", () => {
		withBindings((bindings) => {
			assert.equal(bindings.koffiSource, VENDORED_KOFFI);
			assert.ok(bindings.coInitializeSta() >= 0);
			try {
				const dialog = bindings.createFolderDialog();
				try {
					const current = dialog.getOptions();
					assert.equal(current.hr, 0);
					assert.equal(typeof current.options, "number");
					assert.equal(dialog.setOptions((current.options | FOLDER_DIALOG_OPTIONS) >>> 0), 0);
					assert.equal(dialog.getOptions().options & FOLDER_DIALOG_OPTIONS, FOLDER_DIALOG_OPTIONS);
					assert.equal(dialog.setTitle("冒烟测试"), 0);
				} finally {
					dialog.release();
				}
			} finally {
				bindings.coUninitialize();
			}
		});
	});

	test("IShellItem 的显示路径用 koffi 3 直接解码，中文目录名也正确", () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "目录插件-测试-"));
		try {
			withBindings((bindings) => {
				assert.ok(bindings.coInitializeSta() >= 0);
				try {
					const resolved = bindings.shellItemFromPath(directory);
					assert.ok(resolved.hr >= 0);
					try {
						const display = bindings.displayPathOf(resolved.item);
						assert.equal(display.hr, 0);
						assert.equal(display.path.toLowerCase(), fs.realpathSync.native(directory).toLowerCase());
					} finally {
						bindings.release(resolved.item);
					}
				} finally {
					bindings.coUninitialize();
				}
			});
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	test("真实 worker 进程：修复模式能加载 koffi 并正常退出（句柄 0 不是窗口，什么都不改）", () => {
		const result = spawnSync(process.execPath, [WORKER], {
			env: { ...process.env, DSH_DIALOG_REENABLE_OWNER: "0", DSH_KOFFI_PATH: VENDORED_KOFFI },
			encoding: "utf8",
			windowsHide: true
		});
		assert.equal(result.stderr, "");
		assert.equal(result.status, 0);
	});

	test("真实 worker 进程：没有 IPC 通道时直接报错退出，不会弹框", () => {
		const result = spawnSync(process.execPath, [WORKER], { env: { ...process.env, DSH_KOFFI_PATH: VENDORED_KOFFI }, encoding: "utf8", windowsHide: true });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /must be spawned with an IPC channel/);
	});

	test("前台窗口和它所属进程的 exe 路径读得出来（只读，不改窗口状态）", () => {
		withBindings((bindings) => {
			const window = bindings.foregroundRootWindow();
			if (window === null) return; // 锁屏等情况下没有前台窗口
			assert.equal(typeof window, "bigint");
			assert.equal(bindings.isWindow(window), true);
			const image = bindings.processImageOfWindow(window);
			if (image !== null) assert.match(image, /^[a-z]:\\.+\.exe$/i);
			assert.equal(bindings.isWindow(0n), false);
		});
	});
});
