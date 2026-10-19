import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { lastPickInfo, normalizeDirectory, readSettings, runPick, writeSettings } from "../lib/core.js";

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
	test("拒绝相对路径", () => {
		assert.throws(() => normalizeDirectory("Projects"), /绝对路径/);
		assert.throws(() => normalizeDirectory("..\\Projects"), /绝对路径/);
	});

	test("拒绝盘符相对、当前盘根相对的写法", windowsOnly, () => {
		assert.throws(() => normalizeDirectory("C:"), /绝对路径/);
		assert.throws(() => normalizeDirectory("C:Projects"), /绝对路径/);
		assert.throws(() => normalizeDirectory("\\Projects"), /绝对路径/);
	});

	test("接受带引号的绝对路径", () => {
		assert.equal(normalizeDirectory(`"${home}"`), home);
	});

	test("接受正斜杠写法并规范化", windowsOnly, () => {
		assert.equal(normalizeDirectory(home.replaceAll("\\", "/") + "/"), home);
	});
});

describe("runPick：和 worker 之间的 IPC", () => {
	test("showing 之后 worker 让出了事件循环，选择结果依然送达", async () => {
		process.env.FAKE_WORKER_MODE = "yield";
		assert.equal(await runPick("D:\\Configured", FAKE_WORKER), "D:\\Picked");
		assert.deepEqual(lastPickInfo(), { requested: "D:\\Configured", applied: true });
	});

	test("worker 中途退出时报错，而不是一直挂着", async () => {
		process.env.FAKE_WORKER_MODE = "exit-early";
		await assert.rejects(runPick(null, FAKE_WORKER), /提前退出（exit 3）/);
	});
});
