import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	cancelActivePick,
	directoryExists,
	koffiSource,
	logEvent,
	normalizeDialogTitle,
	normalizeDirectory,
	parseDirectory,
	pickConfiguredDirectory,
	pickDirectory,
	probeInitialState,
	readSettings,
	redactPath,
	runPick,
	writeSettings
} from "../lib/core.js";
import { onPlatform } from "./helpers.js";

const FAKE_WORKER = fileURLToPath(new URL("./fixtures/fake-worker.cjs", import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const windowsOnly = { skip: process.platform !== "win32" && "Windows 专属的路径写法" };

/**
 * 把 child_process.spawn 换成假子进程（沙箱里真 spawn 会 EPERM），返回每次调用的记录。
 *
 * 用完由 t.mock 自动还原；同时要 syncBuiltinESMExports()，否则 core.js 里那句
 * import { spawn } from "node:child_process" 的绑定还指向老函数。
 * @param {import("node:test").TestContext} t - 当前用例。
 * @returns {Array<{command: string, args: string[], options: Record<string, unknown>, child: EventEmitter}>} 调用记录。
 */
function stubSpawn(t) {
	const calls = [];
	t.mock.method(childProcess, "spawn", (command, args, options) => {
		const child = new EventEmitter();
		child.kill = () => {
			child.killed = true;
		};
		child.disconnect = () => {};
		child.unref = () => {};
		calls.push({ command, args, options, child });
		return child;
	});
	syncBuiltinESMExports();
	t.after(() => {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	});
	return calls;
}

/**
 * 等到 predicate 成立（runPick 会先异步探测起始目录，几轮事件循环之后才 spawn）。
 * @param {() => boolean} predicate - 条件。
 * @param {number} [rounds] - 最多等多少轮。
 */
async function waitFor(predicate, rounds = 200) {
	for (let i = 0; i < rounds; i++) {
		if (predicate()) return;
		// 用 setImmediate：有的用例会 mock setTimeout（pick-timeout），不能被它挡住。
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail("等不到条件成立");
}

/**
 * 写一个「设好环境变量再 require 真身」的假 worker 启动脚本。
 *
 * runPick 现在只把白名单里的环境变量交给子进程（不再透传 process.env），所以
 * FAKE_WORKER_MODE / FAKE_WORKER_MARKER 这类测试开关不能靠 process.env 传，得写进启动脚本。
 * @param {string} mode - FAKE_WORKER_MODE 的值（yield / exit-early / error / echo-title / owner-*）。
 * @param {string} [marker] - 修复模式要写入的 marker 文件路径。
 * @returns {string} 可以直接当 workerPath 用的脚本路径。
 */
function fakeWorker(mode, marker) {
	const file = path.join(home, "fake-worker-" + mode + "-" + randomUUID() + ".cjs");
	const lines = ['"use strict";', "process.env.FAKE_WORKER_MODE = " + JSON.stringify(mode) + ";"];
	if (marker !== undefined) lines.push("process.env.FAKE_WORKER_MARKER = " + JSON.stringify(marker) + ";");
	lines.push("require(" + JSON.stringify(FAKE_WORKER) + ");");
	fs.writeFileSync(file, lines.join("\n") + "\n");
	return file;
}

let home;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-directory-plugin-"));
	process.env.DSH_HOME = home;
});
afterEach(() => {
	delete process.env.FAKE_WORKER_MODE;
	fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

const primaryFile = () => path.join(home, "workspace-directory.json");
const legacyFile = () => path.join(home, "workspace-anchor.json");
const logFile = () => path.join(home, "workspace-directory.log");
const readLog = () => (fs.existsSync(logFile()) ? fs.readFileSync(logFile(), "utf8") : "");
const tempFiles = () => fs.readdirSync(home).filter((name) => name.endsWith(".tmp"));
const lockError = (code) => Object.assign(new Error(code + ": simulated lock, rename"), { code });

describe("readSettings：损坏的配置与旧版迁移", () => {
	test("手改写错的 JSON 不会被旧版配置覆盖，并记录日志", async () => {
		const handEdited = '{ "directory": "D:\\Projects" }\n'; // 文件里是单个反斜杠：非法 JSON
		fs.writeFileSync(primaryFile(), handEdited);
		fs.writeFileSync(legacyFile(), JSON.stringify({ directory: "C:\\Old" }));

		assert.deepEqual(await readSettings(), { directory: null });
		assert.equal(fs.readFileSync(primaryFile(), "utf8"), handEdited);
		assert.ok(fs.existsSync(legacyFile()), "主配置损坏时不应该动旧版文件");
		assert.match(readLog(), /config-corrupt/);
	});

	test("带 BOM 的配置文件（记事本、PowerShell 5 常见）可以正常读取", async () => {
		fs.writeFileSync(primaryFile(), "\uFEFF" + JSON.stringify({ directory: "D:\\Projects" }));
		assert.deepEqual(await readSettings(), { directory: "D:\\Projects" });
	});

	test("主配置不存在时迁移旧版配置，并让旧文件退役", async () => {
		fs.writeFileSync(legacyFile(), JSON.stringify({ directory: "C:\\Old" }));

		assert.deepEqual(await readSettings(), { directory: "C:\\Old" });
		assert.deepEqual(JSON.parse(fs.readFileSync(primaryFile(), "utf8")), { directory: "C:\\Old" });
		assert.ok(!fs.existsSync(legacyFile()));
		assert.ok(fs.existsSync(legacyFile() + ".migrated"));

		// 之后删掉主配置，旧值也不会再「复活」。
		fs.rmSync(primaryFile());
		assert.deepEqual(await readSettings(), { directory: null });
	});
});

describe("writeSettings：配置文件被占用", () => {
	test("短暂占用（EPERM）时重试成功，不留临时文件", async (t) => {
		const rename = fs.promises.rename;
		let failures = 2;
		t.mock.method(fs.promises, "rename", async (from, to) => {
			if (failures-- > 0) throw lockError("EPERM");
			return rename(from, to);
		});

		await writeSettings("D:\\Projects");
		assert.deepEqual(JSON.parse(fs.readFileSync(primaryFile(), "utf8")), { directory: "D:\\Projects" });
		assert.deepEqual(tempFiles(), []);
	});

	test("一直被占用时抛出原始错误，并清理临时文件", async (t) => {
		t.mock.method(fs.promises, "rename", async () => {
			throw lockError("EBUSY");
		});

		await assert.rejects(writeSettings("D:\\Projects"), { code: "EBUSY" });
		assert.deepEqual(tempFiles(), []);
	});
});

describe("normalizeDirectory：只接受完整的绝对路径", () => {
	test("拒绝相对路径，错误码 not-absolute，detail 是原始输入", async () => {
		await assert.rejects(normalizeDirectory("Projects"), { code: "not-absolute", detail: "Projects" });
		await assert.rejects(normalizeDirectory("..\\Projects"), { code: "not-absolute" });
	});

	test("拒绝盘符相对、当前盘根相对的写法", windowsOnly, async () => {
		await assert.rejects(normalizeDirectory("C:"), { code: "not-absolute" });
		await assert.rejects(normalizeDirectory("C:Projects"), { code: "not-absolute" });
		await assert.rejects(normalizeDirectory("\\Projects"), { code: "not-absolute" });
	});

	test("不存在、不是文件夹、不是字符串、引号里是空的：各有错误码", async () => {
		const missing = path.join(home, "missing");
		await assert.rejects(normalizeDirectory(missing), { code: "not-found", detail: missing });
		const file = path.join(home, "file.txt");
		fs.writeFileSync(file, "");
		await assert.rejects(normalizeDirectory(file), { code: "not-a-directory", detail: file });
		await assert.rejects(normalizeDirectory(42), { code: "not-a-string" });
		await assert.rejects(normalizeDirectory('""'), { code: "empty" });
	});

	test("接受带引号的绝对路径", async () => {
		assert.equal(await normalizeDirectory(`"${home}"`), home);
	});

	test("接受正斜杠写法并规范化", windowsOnly, async () => {
		assert.equal(await normalizeDirectory(home.replaceAll("\\", "/") + "/"), home);
	});

	test("用异步 stat：断开的网络盘不会卡住整个宿主", async (t) => {
		t.mock.method(fs, "statSync", () => {
			throw new Error("不应该调用同步的 statSync");
		});
		let release;
		const stat = fs.promises.stat;
		t.mock.method(fs.promises, "stat", (target) => new Promise((resolve) => (release = () => resolve(stat(target)))));

		let done = false;
		const pending = normalizeDirectory(home).then((directory) => ((done = true), directory));
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(done, false, "stat 还没返回，宿主的事件循环照常在转");
		release();
		assert.equal(await pending, home);
	});

	test("parseDirectory 只检查写法，不要求目录存在", () => {
		const missing = path.join(home, "missing");
		assert.equal(parseDirectory(`"${missing}"`), missing);
		assert.throws(() => parseDirectory("Projects"), { code: "not-absolute" });
	});
});

describe("logEvent：诊断日志", () => {
	test("换行被转义：堆栈这样的多行文本也只占一行", () => {
		logEvent("pick-failed", "Error: boom\n    at a\r\n    at b");
		const lines = readLog().split("\n").filter(Boolean);
		assert.equal(lines.length, 1);
		assert.match(lines[0], / pick-failed Error: boom\\n {4}at a\\n {4}at b$/);
	});

	test("超过 1MB 时轮转成 .log.1，新日志从空文件开始", () => {
		const old = "x".repeat(1024 * 1024) + "\n";
		fs.writeFileSync(logFile(), old);
		logEvent("after-rotation");
		assert.equal(fs.readFileSync(logFile() + ".1", "utf8"), old);
		assert.match(readLog(), /^\S+ after-rotation\n$/);

		// 再轮转一次：旧的 .1 被替换，始终只留一份旧日志。
		fs.writeFileSync(logFile(), old.replaceAll("x", "y"));
		logEvent("second-rotation");
		assert.ok(fs.readFileSync(logFile() + ".1", "utf8").startsWith("y"));
		assert.deepEqual(fs.readdirSync(home).filter((name) => name.startsWith("workspace-directory.log")).sort(), ["workspace-directory.log", "workspace-directory.log.1"]);
	});

	test("没到 1MB 时只追加", () => {
		logEvent("first");
		logEvent("second");
		assert.equal(readLog().split("\n").filter(Boolean).length, 2);
		assert.ok(!fs.existsSync(logFile() + ".1"));
	});
});

describe("normalizeDialogTitle：客户端传来的对话框标题", () => {
	test("控制字符换成空格并去掉首尾空白", () => {
		assert.equal(normalizeDialogTitle("  选择\n文件夹\u0007 "), "选择 文件夹");
	});

	test("不是字符串或只剩空白时不设标题（用系统自带的）", () => {
		assert.equal(normalizeDialogTitle(undefined), undefined);
		assert.equal(normalizeDialogTitle(42), undefined);
		assert.equal(normalizeDialogTitle(" \t\r\n "), undefined);
	});

	test("最多 200 个字符，按码点截断", () => {
		const title = normalizeDialogTitle("😀".repeat(300));
		assert.equal(Array.from(title).length, 200);
		assert.ok(title.endsWith("😀"), "不应留下半个代理对");
	});
});

describe("runPick：和 worker 之间的 IPC", () => {
	test("showing 之后 worker 让出了事件循环，选择结果依然送达，并带上起始目录诊断", async () => {
		const { timing, ...result } = await runPick("D:\\Configured", { workerPath: fakeWorker("yield") });
		assert.deepEqual(result, {
			path: "D:\\Picked",
			initialFolder: { requested: "D:\\Configured", applied: true },
			owner: null,
			koffi: "fake-koffi"
		});
		// 耗时只写日志（宿主拼成 timing= 一行），不进响应体。
		assert.equal(typeof timing.toShowingMs, "number");
		assert.equal(typeof timing.toDoneMs, "number");
		assert.ok(timing.toDoneMs >= timing.toShowingMs, "关掉框的时间不该早于框出现");
	});

	test("worker 中途退出时报错（pick-exited，detail 是退出码），错误上带着已回报的诊断", async () => {
		await assert.rejects(runPick(null, { workerPath: fakeWorker("exit-early") }), {
			code: "pick-exited",
			detail: "3",
			initialFolder: { requested: null, applied: false }
		});
	});

	test("worker 报错时只带 message，堆栈单独放在 workerStack 上", async () => {
		const error = await runPick(null, { workerPath: fakeWorker("error") }).then(
			() => assert.fail("应该失败"),
			(failure) => failure
		);
		assert.equal(error.code, "pick-failed");
		assert.equal(error.detail, "boom");
		assert.doesNotMatch(error.message, /\n\s+at /);
		assert.match(error.workerStack, /^Error: boom\n\s+at /);
	});

	test("标题原样交给 worker；不给标题时 worker 收到空串", async () => {
		const workerPath = fakeWorker("echo-title");
		assert.equal((await runPick(null, { workerPath, title: "选择新工作区所在文件夹" })).path, "选择新工作区所在文件夹");
		assert.equal((await runPick(null, { workerPath })).path, null);
	});
});

describe("runPick：模态对话框开着时 worker 死掉（第 14 条的后手）", () => {
	const marker = () => path.join(home, "reenabled-owner");

	async function markerAfter(ms) {
		for (let waited = 0; waited < ms; waited += 20) {
			if (fs.existsSync(marker())) return fs.readFileSync(marker(), "utf8");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		return null;
	}

	test("报告过父窗口后异常退出：起修复模式的 worker 把那个窗口重新启用", async () => {
		await assert.rejects(runPick(null, { workerPath: fakeWorker("owner-crash", marker()) }), { code: "pick-exited" });
		assert.equal(await markerAfter(3000), "4242");
		assert.match(readLog(), /owner-reenable 4242/);
	});

	test("有父窗口但正常结束：不修复；结果里带着父窗口（写进日志用）", async () => {
		assert.equal((await runPick(null, { workerPath: fakeWorker("owner-done", marker()) })).owner, "4242");
		assert.equal(await markerAfter(300), null);
	});

	test("没有父窗口时异常退出：没有要恢复的窗口", async () => {
		await assert.rejects(runPick(null, { workerPath: fakeWorker("exit-early", marker()) }), { code: "pick-exited" });
		assert.equal(await markerAfter(300), null);
	});
});

describe("pickDirectory：同一时刻只有一个对话框", () => {
	test("用途相同的并发请求共用一个对话框的结果", async () => {
		const options = { workerPath: fakeWorker("yield"), purpose: "workspace" };
		const first = pickDirectory(null, options);
		const second = pickDirectory(null, options);
		assert.equal(second, first);
		assert.equal((await first).path, "D:\\Picked");
	});

	test("用途不同时以 busy 拒绝，对话框关掉之后又能正常打开", async () => {
		const workerPath = fakeWorker("yield");
		const workspace = pickDirectory(null, { workerPath, purpose: "workspace" });
		await assert.rejects(pickDirectory(null, { workerPath, purpose: "settings" }), { code: "busy" });
		await workspace;
		assert.equal((await pickDirectory(null, { workerPath, purpose: "settings" })).path, "D:\\Picked");
	});

	test("不是 Windows 时直接报 unsupported，不起进程", async (t) => {
		onPlatform(t, "linux");
		await assert.rejects(pickDirectory(null, { workerPath: path.join(home, "no-such-worker.cjs") }), { code: "unsupported" });
	});
});

describe("probeInitialState：起始目录探测", () => {
	test("没给目录是 none，存在是 dir，不存在是 missing，文件是 not-dir", async () => {
		assert.equal(await probeInitialState(null), "none");
		assert.equal(await probeInitialState(""), "none");
		assert.equal(await probeInitialState(home), "dir");
		assert.equal(await probeInitialState(path.join(home, "missing")), "missing");
		const file = path.join(home, "file.txt");
		fs.writeFileSync(file, "");
		assert.equal(await probeInitialState(file), "not-dir");
	});

	test("stat 卡住（断开的网络盘）时最多等 1.5 秒，超时给 unknown", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		t.mock.method(fs.promises, "stat", () => new Promise(() => {}));
		const pending = probeInitialState("\\\\192.0.2.1\\share\\sub");
		t.mock.timers.tick(1500);
		assert.equal(await pending, "unknown");
	});
});

describe("directoryExists：给 /config 的 exists 字段", () => {
	test("未配置是 null，存在是 true，不存在或不是文件夹是 false", async () => {
		assert.equal(await directoryExists(null), null);
		assert.equal(await directoryExists(""), null);
		assert.equal(await directoryExists(home), true);
		assert.equal(await directoryExists(path.join(home, "missing")), false);
		const file = path.join(home, "file.txt");
		fs.writeFileSync(file, "");
		assert.equal(await directoryExists(file), false);
	});
});

describe("redactPath：日志里的路径脱敏", () => {
	test("只留最后一段，中间的目录折成 …", windowsOnly, () => {
		assert.equal(redactPath("D:\\DSH Project\\双人求生"), "D:\\…\\双人求生");
		assert.equal(redactPath("D:\\DSH Project\\双人求生\\"), "D:\\…\\双人求生");
	});

	test("家目录前缀优先折成 ~", windowsOnly, () => {
		assert.equal(redactPath(path.join(os.homedir(), "双人求生")), "~" + path.sep + "双人求生");
		assert.equal(redactPath(path.join(os.homedir(), "Projects", "双人求生")), "~" + path.sep + "…" + path.sep + "双人求生");
	});

	test("不是绝对路径、空值原样返回；重复脱敏结果不变", windowsOnly, () => {
		assert.equal(redactPath(""), "");
		assert.equal(redactPath("(cancelled)"), "(cancelled)");
		assert.equal(redactPath("D:\\"), "D:\\");
		assert.equal(redactPath("C:\\Projects"), "C:\\…\\Projects", "只有一段也照折，行为一致");
		const once = redactPath("D:\\DSH Project\\双人求生");
		assert.equal(redactPath(once), once);
	});

	test("logEvent 把自由文本（错误文案、堆栈）里的路径一起脱敏", windowsOnly, () => {
		logEvent("config-unreadable", "EPERM: rename 'D:\\DSH Project\\双人求生\\workspace-directory.json'");
		const line = readLog();
		assert.doesNotMatch(line, /DSH Project/, line);
		assert.match(line, /D:\\…\\workspace-directory\.json/);
	});

	test("正斜杠写的绝对路径同样脱敏（旧配置迁移日志里可能出现）", windowsOnly, () => {
		logEvent("config-migrated", "D:/Private Source/alice/secret.txt");
		const line = readLog();
		assert.doesNotMatch(line, /Private Source\/alice/, line);
		assert.match(line, /D:\/…\\secret\.txt/);
	});

	test("DSH_DIRECTORY_LOG_PATHS=1 时写完整路径（排错用）", windowsOnly, (t) => {
		t.after(() => delete process.env.DSH_DIRECTORY_LOG_PATHS);
		process.env.DSH_DIRECTORY_LOG_PATHS = "1";
		assert.equal(redactPath("D:\\DSH Project\\双人求生"), "D:\\DSH Project\\双人求生");
		logEvent("config-unreadable", "rename 'D:\\DSH Project\\双人求生\\x.json'");
		assert.match(readLog(), /D:\\DSH Project\\双人求生\\x\.json/);
	});
});

describe("koffiSource：日志只记来源枚举", () => {
	test("vendor / dsh / override / unknown", windowsOnly, () => {
		assert.equal(koffiSource(path.join(PLUGIN_ROOT, "vendor", "node_modules", "koffi", "index.cjs")), "vendor");
		assert.equal(koffiSource(path.join(PLUGIN_ROOT, "vendor", "node_modules", "koffi", "src", "koffi", "index.cjs")), "override");
		assert.equal(koffiSource("koffi"), "dsh");
		assert.equal(koffiSource(path.join(path.dirname(process.execPath), "resources", "app.asar.unpacked", "node_modules", "koffi", "index.cjs")), "dsh");
		assert.equal(koffiSource("D:\\tools\\koffi\\index.cjs"), "override");
		assert.equal(koffiSource(null), "unknown");
		assert.equal(koffiSource(""), "unknown");
	});
});

describe("readSettings：配置文件读不出来（被占用、权限不足）", () => {
	test("记 config-unreadable，按未配置处理，绝不覆盖原文件", async (t) => {
		const original = JSON.stringify({ directory: "D:\\Projects" });
		fs.writeFileSync(primaryFile(), original);
		t.mock.method(fs.promises, "readFile", async () => {
			throw Object.assign(new Error("EBUSY: resource busy or locked, open"), { code: "EBUSY" });
		});

		assert.deepEqual(await readSettings(), { directory: null });
		assert.equal(fs.readFileSync(primaryFile(), "utf8"), original);
		assert.match(readLog(), /config-unreadable/);
	});
});

describe("writeSettings：并发保存", () => {
	test("两个保存同时进行：都不失败、不留临时文件、最终是其中一个值", async () => {
		const first = path.join(home, "first");
		const second = path.join(home, "second");
		await Promise.all([writeSettings(first), writeSettings(second)]);
		const saved = JSON.parse(fs.readFileSync(primaryFile(), "utf8")).directory;
		assert.ok(saved === first || saved === second, "最终值应是其中一个：" + saved);
		assert.deepEqual(tempFiles(), []);
	});
});

describe("logEvent：轮转失败后的硬上限", () => {
	test("日志一直被占用（rename 失败）时到 8MB 直接截断，不会无限增长", async (t) => {
		fs.writeFileSync(logFile(), "x".repeat(8 * 1024 * 1024));
		t.mock.method(fs, "renameSync", () => {
			throw Object.assign(new Error("EBUSY: resource busy or locked, rename"), { code: "EBUSY" });
		});

		logEvent("still-working");

		const text = readLog();
		assert.ok(text.length < 1024, "截断后只剩新写的一行，实际 " + text.length + " 字节");
		assert.match(text, / still-working\n$/);
		assert.ok(!fs.existsSync(logFile() + ".1"), "rename 失败就不会有轮转文件");
	});
});

describe("runPick：起始目录状态交给 worker（假子进程）", () => {
	const fake = { workerPath: FAKE_WORKER };

	test("dir / missing / not-dir / none 分别交给 DSH_DIALOG_INITIAL_STATE", async (t) => {
		const calls = stubSpawn(t);
		const file = path.join(home, "file.txt");
		fs.writeFileSync(file, "");
		const states = [];
		for (const directory of [home, path.join(home, "missing"), file, null]) {
			const before = calls.length;
			const pending = runPick(directory, fake);
			await waitFor(() => calls.length > before);
			const call = calls[before];
			assert.equal(call.options.env.DSH_DIALOG_INITIAL_DIR, directory ?? "");
			states.push(call.options.env.DSH_DIALOG_INITIAL_STATE);
			call.child.emit("message", { kind: "done", path: null });
			assert.equal((await pending).path, null);
		}
		assert.deepEqual(states, ["dir", "missing", "not-dir", "none"]);
	});

	test("pickConfiguredDirectory 从已保存的目录开始", async (t) => {
		const calls = stubSpawn(t);
		await writeSettings(home);
		const pending = pickConfiguredDirectory();
		await waitFor(() => calls.length === 1);
		assert.equal(calls[0].options.env.DSH_DIALOG_INITIAL_DIR, home);
		assert.equal(calls[0].options.env.DSH_DIALOG_INITIAL_STATE, "dir");
		calls[0].child.emit("message", { kind: "done", path: "D:\\Picked" });
		assert.equal(await pending, "D:\\Picked");
	});
});

describe("runPick：非正常收尾都要救回 owner（假子进程）", () => {
	const fake = { workerPath: FAKE_WORKER };

	/**
	 * 起一次 runPick，等到它 spawn，返回记录和那个假子进程。
	 * @param {import("node:test").TestContext} t - 当前用例。
	 */
	async function started(t) {
		const calls = stubSpawn(t);
		// 走 pickDirectory：cancelActivePick 管的是它登记的 activePick，直接调 runPick 不会登记。
		const pending = pickDirectory(null, { purpose: "workspace", ...fake });
		await waitFor(() => calls.length === 1);
		return { calls, pending, child: calls[0].child };
	}

	test("回报 error：先把父窗口救回来，再报 pick-failed", async (t) => {
		const { calls, pending, child } = await started(t);
		child.emit("message", { kind: "showing", initialFolder: null, owner: "4242", koffi: "fake-koffi" });
		child.emit("message", { kind: "error", message: "boom" });
		await assert.rejects(pending, { code: "pick-failed" });
		assert.equal(calls.length, 2, "error 之后应该起一个修复进程");
		assert.equal(calls[1].options.env.DSH_DIALOG_REENABLE_OWNER, "4242");
		assert.match(readLog(), /owner-reenable 4242/);
	});

	test("中途退出（close）：照样救一次", async (t) => {
		const { calls, pending, child } = await started(t);
		child.emit("message", { kind: "showing", initialFolder: null, owner: "4242", koffi: "fake-koffi" });
		child.emit("close", 3, null);
		await assert.rejects(pending, { code: "pick-exited", detail: "3" });
		assert.equal(calls.length, 2);
		assert.equal(calls[1].options.env.DSH_DIALOG_REENABLE_OWNER, "4242");
	});

	test("正常回报 done：不救（worker 自己已经恢复），也不再多起进程", async (t) => {
		const { calls, pending, child } = await started(t);
		child.emit("message", { kind: "showing", initialFolder: null, owner: "4242", koffi: "fake-koffi" });
		child.emit("message", { kind: "done", path: "D:\\Picked" });
		assert.equal((await pending).path, "D:\\Picked");
		assert.equal(calls.length, 1);
		assert.doesNotMatch(readLog(), /owner-reenable/);
	});

	test("还没回报 showing 就退出：没有父窗口要救", async (t) => {
		const { calls, pending, child } = await started(t);
		child.emit("close", 1, null);
		await assert.rejects(pending, { code: "pick-exited" });
		assert.equal(calls.length, 1);
		assert.doesNotMatch(readLog(), /owner-reenable/);
	});

	test("30 秒没回报 showing：pick-timeout 并杀掉进程", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const { calls, pending, child } = await started(t);
		t.mock.timers.tick(30000);
		await assert.rejects(pending, { code: "pick-timeout" });
		assert.equal(child.killed, true);
		assert.equal(calls.length, 1, "还没有 owner，不用起修复进程");
	});

	test("cancelActivePick：中止开着的对话框，日志里留一条 pick-aborted", async (t) => {
		const { calls, pending, child } = await started(t);
		child.emit("message", { kind: "showing", initialFolder: null, owner: "4242", koffi: "fake-koffi" });
		assert.equal(cancelActivePick(), true);
		assert.equal(child.killed, true);
		assert.match(readLog(), /pick-aborted/);
		// 真进程被 kill 之后会发 close，这里手动补一条让 promise 收尾。
		child.emit("close", null, "SIGTERM");
		await assert.rejects(pending, { code: "pick-exited", detail: "SIGTERM" });
		assert.equal(calls.length, 2, "close 时照样兜一次 owner 修复");
		assert.equal(cancelActivePick(), false, "收尾之后没有要取消的东西");
	});

	test("探测起始目录期间取消：不再拉起 worker，请求以 pick-aborted 收尾", async (t) => {
		const calls = stubSpawn(t);
		let releaseStat;
		const gate = new Promise((resolve) => (releaseStat = resolve));
		const realStat = fs.promises.stat;
		t.mock.method(fs.promises, "stat", async (target) => {
			if (String(target).includes("HANG")) return gate.then(() => ({ isDirectory: () => true }));
			return realStat(target);
		});
		const pending = pickDirectory("D:\\HANG\\dir", { purpose: "workspace" });
		await waitFor(() => calls.length > 0 || true);
		// 探测还挂着：activeWorker 还没赋值，取消必须仍然生效。
		assert.equal(cancelActivePick(), true, "探测窗口内也要能取消");
		assert.match(readLog(), /pick-aborted/);
		releaseStat();
		await assert.rejects(pending, { code: "pick-aborted" });
		assert.equal(calls.length, 0, "取消之后不能再 spawn worker");
		assert.equal(cancelActivePick(), false, "收尾后没有要取消的东西");
	});
});
