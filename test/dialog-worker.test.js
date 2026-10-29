import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import worker from "../lib/dialog-worker.cjs";

const { FOLDER_DIALOG_OPTIONS, HRESULT_CANCELLED, createPost, dshOwnerWindow, errorMessageOf, koffiCandidates, loadKoffi, loadWin32DialogBindings, reenableOwner, runFolderDialog } = worker;
const VENDORED_KOFFI = fileURLToPath(new URL("../vendor/node_modules/koffi/index.cjs", import.meta.url));
const WORKER = fileURLToPath(new URL("../lib/dialog-worker.cjs", import.meta.url));
const windowsOnly = { skip: process.platform !== "win32" && "要调真实的 Win32 API" };
const DSH_EXE = "D:\\DSH Next\\DSH NEXT.exe";
/** COM 的失败 HRESULT 都是负数：E_FAIL、HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)、RPC_E_CHANGED_MODE。 */
const HRESULT_E_FAIL = -2147467259;
const HRESULT_FILE_NOT_FOUND = -2147024894;
const HRESULT_RPC_E_CHANGED_MODE = -2147417850;

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

	test("宿主先断了通道：发不出去也不抛，也不会再去断开一个已经断开的通道", () => {
		const proc = {
			connected: false,
			disconnects: 0,
			disconnect() {
				this.disconnects++;
			}
		};
		const post = createPost({
			send() {
				throw Object.assign(new Error("IPC channel is closed"), { code: "ERR_IPC_CHANNEL_CLOSED" });
			},
			proc
		});
		assert.doesNotThrow(() => post({ kind: "done", path: null }));
		assert.equal(proc.disconnects, 0);
	});

	test("别的异常照常抛：通道的问题不能被当成万能兜底", () => {
		const post = createPost({
			send() {
				throw new TypeError("send is not a function");
			},
			proc: { connected: true, disconnect() {} }
		});
		assert.throws(() => post({ kind: "done", path: null }), TypeError);
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
 * windows 描述现有的窗口：hwnd → { exe, enabled }；
 * 其余参数用来造出某个阶段的失败（HRESULT 一律用负数，和 COM 一致）：
 * getOptionsHr / setOptionsHr / setTitleHr / setFolderHr / itemHr / displayPath / result。
 */
function fakeBindings({
	calls = [],
	options = 0,
	foreground = null,
	windows = {},
	show = 0,
	coInitHr = 0,
	getOptionsHr = 0,
	setOptionsHr = 0,
	setTitleHr = 0,
	setFolderHr = 0,
	itemHr = 0,
	resolvePath = (directory) => directory,
	displayPath = (item) => ({ hr: 0, path: item.path }),
	result = { hr: 0, path: "D:\\Picked" }
} = {}) {
	const windowOf = (hwnd) => windows[String(hwnd)];
	return {
		setThreadDpiAwareness() {
			calls.push(["setThreadDpiAwareness"]);
		},
		coInitializeSta: () => (calls.push(["coInitialize"]), coInitHr),
		coUninitialize() {
			calls.push(["coUninitialize"]);
		},
		foregroundRootWindow: () => foreground,
		processImageOfWindow: (hwnd) => windowOf(hwnd)?.exe ?? null,
		isWindow: (hwnd) => windowOf(hwnd) !== undefined,
		isWindowEnabled: (hwnd) => windowOf(hwnd)?.enabled !== false,
		enableWindow: (hwnd) => calls.push(["enableWindow", hwnd]),
		displayPathOf: (item) => displayPath(item),
		shellItemFromPath: (directory) => {
			calls.push(["shellItemFromPath", directory]);
			return itemHr < 0 ? { hr: itemHr } : { hr: itemHr, item: { path: resolvePath(directory) } };
		},
		release() {},
		createFolderDialog: () => ({
			getOptions: () => (calls.push(["getOptions"]), { hr: getOptionsHr, options }),
			setOptions: (value) => (calls.push(["setOptions", value]), setOptionsHr),
			setTitle: (title) => (calls.push(["setTitle", title]), setTitleHr),
			setFolder: (item) => (calls.push(["setFolder", item.path]), setFolderHr),
			show: (owner) => (calls.push(["show", owner]), show),
			resultPath: () => (calls.push(["resultPath"]), typeof result === "function" ? result() : result),
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

	test("GetOptions 失败不再致命：用内置的 FOS_* 兜底，照常弹框", () => {
		const calls = [];
		let reported;
		const picked = run(fakeBindings({ calls, getOptionsHr: HRESULT_E_FAIL }), {}, (folder) => (reported = folder));
		assert.equal(picked, "D:\\Picked");
		assert.deepEqual(callsNamed(calls, "setOptions"), [["setOptions", FOLDER_DIALOG_OPTIONS]]);
		assert.equal(reported.getOptionsHr, HRESULT_E_FAIL);
		assert.equal(callsNamed(calls, "show").length, 1);
	});

	test("只有 SetOptions 失败还是致命的：不弹框", () => {
		const calls = [];
		assert.throws(() => run(fakeBindings({ calls, setOptionsHr: HRESULT_E_FAIL })), /SetOptions failed: HRESULT 0x80004005/);
		assert.deepEqual(callsNamed(calls, "show"), []);
	});

	test("SetTitle 失败只记诊断，对话框照常弹", () => {
		const calls = [];
		let reported;
		const picked = run(fakeBindings({ calls, setTitleHr: HRESULT_E_FAIL }), { title: "选择文件夹" }, (folder) => (reported = folder));
		assert.equal(picked, "D:\\Picked");
		assert.equal(reported.setTitleHr, HRESULT_E_FAIL);
		assert.equal(callsNamed(calls, "show").length, 1);
	});

	test("用户取消（HRESULT_FROM_WIN32(ERROR_CANCELLED)）时返回 null，不再读结果", () => {
		assert.equal(HRESULT_CANCELLED, -2147023673);
		const calls = [];
		assert.equal(run(fakeBindings({ calls, show: HRESULT_CANCELLED })), null);
		assert.deepEqual(callsNamed(calls, "resultPath"), []);
	});

	test("Show 失败（不是取消）：按 Show 报错，也不再读结果", () => {
		const calls = [];
		assert.throws(() => run(fakeBindings({ calls, show: HRESULT_E_FAIL })), /Show failed: HRESULT 0x80004005/);
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

describe("runFolderDialog：起始目录诊断（宿主 stat 的结论，worker 不再自己碰磁盘）", () => {
	const GONE = path.join(os.tmpdir(), "dsh-directory-plugin-gone-" + process.pid);

	test("没配置起始目录：requested 为 null、state 为 none", () => {
		let reported;
		const picked = run(fakeBindings(), {}, (folder) => (reported = folder));
		assert.equal(picked, "D:\\Picked");
		assert.deepEqual(reported, { requested: null, applied: false, state: "none" });
	});

	test("state=missing 且 Shell 解析失败：reason=missing，但仍然交过一次 SHCreateItemFromParsingName", () => {
		const calls = [];
		let reported;
		run(fakeBindings({ calls, itemHr: HRESULT_FILE_NOT_FOUND }), { initialFolder: GONE, initialState: "missing" }, (folder) => (reported = folder));
		assert.deepEqual(reported, { requested: GONE, applied: false, state: "missing", itemHr: HRESULT_FILE_NOT_FOUND, reason: "missing" });
		assert.deepEqual(callsNamed(calls, "shellItemFromPath"), [["shellItemFromPath", GONE]], "不再用 existsSync 预检，照旧交给 Shell 试一次");
	});

	test("state=not-dir / unknown：reason 跟着宿主的结论走", () => {
		for (const state of ["not-dir", "unknown"]) {
			let reported;
			run(fakeBindings({ itemHr: HRESULT_FILE_NOT_FOUND }), { initialFolder: GONE, initialState: state }, (folder) => (reported = folder));
			assert.equal(reported.state, state);
			assert.equal(reported.reason, state);
		}
	});

	test("state=dir 但 Shell 解析不出来：reason=SHCreateItemFromParsingName", () => {
		let reported;
		run(fakeBindings({ itemHr: HRESULT_FILE_NOT_FOUND }), { initialFolder: GONE, initialState: "dir" }, (folder) => (reported = folder));
		assert.equal(reported.state, "dir");
		assert.equal(reported.reason, "SHCreateItemFromParsingName");
	});

	test("宿主没给 state（老宿主）或给了不认识的值：按 unknown 报", () => {
		for (const initialState of [undefined, "", "bogus"]) {
			let reported;
			run(fakeBindings({ itemHr: HRESULT_FILE_NOT_FOUND }), { initialFolder: GONE, initialState }, (folder) => (reported = folder));
			assert.equal(reported.state, "unknown");
			assert.equal(reported.reason, "unknown");
		}
	});

	test("解析出来没有文件系统路径（虚拟文件夹）：reason=not-filesystem", () => {
		let reported;
		run(fakeBindings({ displayPath: () => ({ hr: 0, path: null }) }), { initialFolder: "D:\\Projects", initialState: "dir" }, (folder) => (reported = folder));
		assert.deepEqual(reported, {
			requested: "D:\\Projects",
			applied: false,
			state: "dir",
			itemHr: 0,
			resolvedHr: 0,
			resolvedPath: null,
			setFolderHr: 0,
			reason: "not-filesystem"
		});
	});

	test("宿主的 stat 过期了（state=missing 但目录又在了）：照样设上，不算失败", () => {
		let reported;
		run(fakeBindings(), { initialFolder: "D:\\Projects", initialState: "missing" }, (folder) => (reported = folder));
		assert.equal(reported.applied, true);
		assert.equal(reported.reason, undefined);
	});

	test("不再用 fs.existsSync 预检：不存在的目录只要 Shell 能解析就照设", () => {
		const calls = [];
		let reported;
		const absent = path.join(os.tmpdir(), "dsh-directory-plugin-absent-" + process.pid);
		run(fakeBindings({ calls }), { initialFolder: absent, initialState: "dir" }, (folder) => (reported = folder));
		assert.deepEqual(callsNamed(calls, "setFolder"), [["setFolder", absent]]);
		assert.equal(reported.applied, true);
	});

	test("SetFolder 失败：applied 为 false，setFolderHr 留给日志", () => {
		let reported;
		run(fakeBindings({ setFolderHr: HRESULT_E_FAIL }), { initialFolder: "D:\\Projects", initialState: "dir" }, (folder) => (reported = folder));
		assert.equal(reported.applied, false);
		assert.equal(reported.setFolderHr, HRESULT_E_FAIL);
		assert.equal(reported.reason, "SetFolder");
	});

	test("SetFolder 成功、但 Shell 解析成别的目录：不算设上", () => {
		let reported;
		run(fakeBindings({ resolvePath: () => "D:\\Other" }), { initialFolder: "D:\\Projects", initialState: "dir" }, (folder) => (reported = folder));
		assert.equal(reported.resolvedPath, "D:\\Other");
		assert.equal(reported.applied, false);
		assert.equal(reported.reason, "resolved-elsewhere");
	});

	test("尾部分隔符和大小写不同仍算同一个目录", () => {
		let reported;
		run(fakeBindings({ resolvePath: () => "D:\\Projects" }), { initialFolder: "d:\\projects\\", initialState: "dir" }, (folder) => (reported = folder));
		assert.equal(reported.applied, true);
	});

	test("盘符根的尾部分隔符不会被削掉", () => {
		let reported;
		run(fakeBindings({ resolvePath: () => "D:\\" }), { initialFolder: "D:\\", initialState: "dir" }, (folder) => (reported = folder));
		assert.equal(reported.applied, true);
	});
});

describe("runFolderDialog：resultPath 的失败阶段", () => {
	test("GetResult 失败：报 GetResult", () => {
		assert.throws(() => run(fakeBindings({ result: { hr: HRESULT_E_FAIL, stage: "GetResult" } })), /GetResult failed: HRESULT 0x80004005/);
	});

	test("GetDisplayName 失败：报 GetDisplayName，不冒充 GetResult", () => {
		assert.throws(() => run(fakeBindings({ result: { hr: HRESULT_FILE_NOT_FOUND, stage: "GetDisplayName" } })), /GetDisplayName failed: HRESULT 0x80070002/);
	});

	test("拿到的路径是空串：报错，不当成取消", () => {
		assert.throws(() => run(fakeBindings({ result: { hr: 0, path: "" } })), /selected item has no filesystem path/);
	});

	test("拿到的路径不是字符串：同一条错", () => {
		assert.throws(() => run(fakeBindings({ result: { hr: 0, path: null } })), /selected item has no filesystem path/);
	});

	test("绑定没带 stage 时按 GetResult 报（不静默吞掉 HRESULT）", () => {
		assert.throws(() => run(fakeBindings({ result: { hr: HRESULT_E_FAIL } })), /GetResult failed: HRESULT 0x80004005/);
	});
});

describe("runFolderDialog：必须先 CoInitialize", () => {
	test("CoInitializeEx 失败：直接报错，不建对话框", () => {
		const calls = [];
		assert.throws(() => run(fakeBindings({ calls, coInitHr: HRESULT_RPC_E_CHANGED_MODE })), /CoInitializeEx failed: HRESULT 0x80010106/);
		assert.deepEqual(callsNamed(calls, "setOptions"), []);
		assert.deepEqual(callsNamed(calls, "show"), []);
	});

	test("正常收尾时 CoInitialize / CoUninitialize 配对", () => {
		const calls = [];
		run(fakeBindings({ calls }));
		assert.equal(callsNamed(calls, "coInitialize").length, 1);
		assert.equal(callsNamed(calls, "coUninitialize").length, 1);
	});

	test("中途失败也要 CoUninitialize", () => {
		const calls = [];
		assert.throws(() => run(fakeBindings({ calls, setOptionsHr: HRESULT_E_FAIL })));
		assert.equal(callsNamed(calls, "coUninitialize").length, 1);
	});
});

describe("koffiCandidates：env → 随包副本 → DSH 安装 → 裸模块", () => {
	const withEnv = (value, body) => {
		const previous = process.env.DSH_KOFFI_PATH;
		if (value === undefined) delete process.env.DSH_KOFFI_PATH;
		else process.env.DSH_KOFFI_PATH = value;
		try {
			return body();
		} finally {
			if (previous === undefined) delete process.env.DSH_KOFFI_PATH;
			else process.env.DSH_KOFFI_PATH = previous;
		}
	};

	test("没设 DSH_KOFFI_PATH：随包副本排第一，最后才轮到裸模块名", () => {
		const candidates = withEnv(undefined, koffiCandidates);
		assert.equal(candidates[0], VENDORED_KOFFI);
		assert.equal(candidates[candidates.length - 1], "koffi");
	});

	test("设了 DSH_KOFFI_PATH：显式覆盖排在最前，随包副本退一位", () => {
		const custom = "D:\\custom\\koffi\\index.cjs";
		const candidates = withEnv(custom, koffiCandidates);
		assert.equal(candidates[0], custom);
		assert.equal(candidates[1], VENDORED_KOFFI);
	});

	test("不再把 app.asar 里的原生模块当候选（dlopen 不了）", () => {
		for (const candidate of withEnv(undefined, koffiCandidates)) {
			assert.doesNotMatch(candidate, /app\.asar[\\/]node_modules/, candidate);
		}
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

	test("null COM 指针（含 bigint 0）不会被当成地址去 decode", () => {
		withBindings((bindings) => {
			assert.throws(() => bindings.release(null), /null COM pointer/);
			assert.throws(() => bindings.release(0n), /null COM pointer/);
			assert.throws(() => bindings.displayPathOf(null), /null pointer/);
		});
	});

	test("DPI：已经是感知上下文就不重复设置，重复调用也不抛", () => {
		withBindings((bindings) => {
			assert.doesNotThrow(() => bindings.setThreadDpiAwareness());
			assert.doesNotThrow(() => bindings.setThreadDpiAwareness());
		});
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
