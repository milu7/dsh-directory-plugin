import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { logEvent, normalizeDialogTitle, normalizeDirectory, parseDirectory, pickDirectory, readSettings, runPick, writeSettings } from "../lib/core.js";
import { onPlatform } from "./helpers.js";

const FAKE_WORKER = fileURLToPath(new URL("./fixtures/fake-worker.cjs", import.meta.url));
const windowsOnly = { skip: process.platform !== "win32" && "Windows 专属的路径写法" };

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
	const fake = { workerPath: FAKE_WORKER };

	test("showing 之后 worker 让出了事件循环，选择结果依然送达，并带上起始目录诊断", async () => {
		process.env.FAKE_WORKER_MODE = "yield";
		assert.deepEqual(await runPick("D:\\Configured", fake), {
			path: "D:\\Picked",
			initialFolder: { requested: "D:\\Configured", applied: true },
			owner: null
		});
	});

	test("worker 中途退出时报错（pick-exited，detail 是退出码），错误上带着已回报的诊断", async () => {
		process.env.FAKE_WORKER_MODE = "exit-early";
		await assert.rejects(runPick(null, fake), {
			code: "pick-exited",
			detail: "3",
			initialFolder: { requested: null, applied: false }
		});
	});

	test("worker 报错时只带 message，堆栈单独放在 workerStack 上", async () => {
		process.env.FAKE_WORKER_MODE = "error";
		const error = await runPick(null, fake).then(
			() => assert.fail("应该失败"),
			(failure) => failure
		);
		assert.equal(error.code, "pick-failed");
		assert.equal(error.detail, "boom");
		assert.doesNotMatch(error.message, /\n\s+at /);
		assert.match(error.workerStack, /^Error: boom\n\s+at /);
	});

	test("标题原样交给 worker；不给标题时 worker 收到空串", async () => {
		process.env.FAKE_WORKER_MODE = "echo-title";
		assert.equal((await runPick(null, { ...fake, title: "选择新工作区所在文件夹" })).path, "选择新工作区所在文件夹");
		assert.equal((await runPick(null, fake)).path, null);
	});
});

describe("runPick：模态对话框开着时 worker 死掉（第 14 条的后手）", () => {
	const fake = { workerPath: FAKE_WORKER };
	const marker = () => path.join(home, "reenabled-owner");
	beforeEach(() => {
		process.env.FAKE_WORKER_MARKER = marker();
	});
	afterEach(() => {
		delete process.env.FAKE_WORKER_MARKER;
	});

	async function markerAfter(ms) {
		for (let waited = 0; waited < ms; waited += 20) {
			if (fs.existsSync(marker())) return fs.readFileSync(marker(), "utf8");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		return null;
	}

	test("报告过父窗口后异常退出：起修复模式的 worker 把那个窗口重新启用", async () => {
		process.env.FAKE_WORKER_MODE = "owner-crash";
		await assert.rejects(runPick(null, fake), { code: "pick-exited" });
		assert.equal(await markerAfter(3000), "4242");
		assert.match(readLog(), /owner-reenable 4242/);
	});

	test("有父窗口但正常结束：不修复；结果里带着父窗口（写进日志用）", async () => {
		process.env.FAKE_WORKER_MODE = "owner-done";
		assert.equal((await runPick(null, fake)).owner, "4242");
		assert.equal(await markerAfter(300), null);
	});

	test("没有父窗口时异常退出：没有要恢复的窗口", async () => {
		process.env.FAKE_WORKER_MODE = "exit-early";
		await assert.rejects(runPick(null, fake), { code: "pick-exited" });
		assert.equal(await markerAfter(300), null);
	});
});

describe("pickDirectory：同一时刻只有一个对话框", () => {
	const fake = { workerPath: FAKE_WORKER };

	test("用途相同的并发请求共用一个对话框的结果", async () => {
		process.env.FAKE_WORKER_MODE = "yield";
		const first = pickDirectory(null, { ...fake, purpose: "workspace" });
		const second = pickDirectory(null, { ...fake, purpose: "workspace" });
		assert.equal(second, first);
		assert.equal((await first).path, "D:\\Picked");
	});

	test("用途不同时以 busy 拒绝，对话框关掉之后又能正常打开", async () => {
		process.env.FAKE_WORKER_MODE = "yield";
		const workspace = pickDirectory(null, { ...fake, purpose: "workspace" });
		await assert.rejects(pickDirectory(null, { ...fake, purpose: "settings" }), { code: "busy" });
		await workspace;
		assert.equal((await pickDirectory(null, { ...fake, purpose: "settings" })).path, "D:\\Picked");
	});

	test("不是 Windows 时直接报 unsupported，不起进程", async (t) => {
		onPlatform(t, "linux");
		await assert.rejects(pickDirectory(null, { workerPath: path.join(home, "no-such-worker.cjs") }), { code: "unsupported" });
	});
});
