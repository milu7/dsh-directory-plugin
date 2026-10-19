import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { lastPickInfo, normalizeDialogTitle, normalizeDirectory, readSettings, runPick, writeSettings } from "../lib/core.js";

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
	test("拒绝相对路径，错误码 not-absolute，detail 是原始输入", () => {
		assert.throws(() => normalizeDirectory("Projects"), { code: "not-absolute", detail: "Projects" });
		assert.throws(() => normalizeDirectory("..\\Projects"), { code: "not-absolute" });
	});

	test("拒绝盘符相对、当前盘根相对的写法", windowsOnly, () => {
		assert.throws(() => normalizeDirectory("C:"), { code: "not-absolute" });
		assert.throws(() => normalizeDirectory("C:Projects"), { code: "not-absolute" });
		assert.throws(() => normalizeDirectory("\\Projects"), { code: "not-absolute" });
	});

	test("不存在、不是文件夹、不是字符串、引号里是空的：各有错误码", () => {
		const missing = path.join(home, "missing");
		assert.throws(() => normalizeDirectory(missing), { code: "not-found", detail: missing });
		const file = path.join(home, "file.txt");
		fs.writeFileSync(file, "");
		assert.throws(() => normalizeDirectory(file), { code: "not-a-directory", detail: file });
		assert.throws(() => normalizeDirectory(42), { code: "not-a-string" });
		assert.throws(() => normalizeDirectory('""'), { code: "empty" });
	});

	test("接受带引号的绝对路径", () => {
		assert.equal(normalizeDirectory(`"${home}"`), home);
	});

	test("接受正斜杠写法并规范化", windowsOnly, () => {
		assert.equal(normalizeDirectory(home.replaceAll("\\", "/") + "/"), home);
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

	test("showing 之后 worker 让出了事件循环，选择结果依然送达", async () => {
		process.env.FAKE_WORKER_MODE = "yield";
		assert.equal(await runPick("D:\\Configured", fake), "D:\\Picked");
		assert.deepEqual(lastPickInfo(), { requested: "D:\\Configured", applied: true });
	});

	test("worker 中途退出时报错（pick-exited，detail 是退出码），而不是一直挂着", async () => {
		process.env.FAKE_WORKER_MODE = "exit-early";
		await assert.rejects(runPick(null, fake), { code: "pick-exited", detail: "3" });
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
		assert.equal(await runPick(null, { ...fake, title: "选择新工作区所在文件夹" }), "选择新工作区所在文件夹");
		assert.equal(await runPick(null, fake), null);
	});
});
