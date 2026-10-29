import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { apply } from "../lib/index.js";
import { onPlatform } from "./helpers.js";

const CONFIG = "/dsh-directory-plugin/config";
const PICK = "/dsh-directory-plugin/pick";
const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SAME_ORIGIN_JSON = { "content-type": "application/json", "sec-fetch-site": "same-origin" };
const windowsOnly = { skip: process.platform !== "win32" && "对话框只在 Windows 上拉起" };

// 这里的用例都不该真的拉起对话框进程；万一校验失效，宁可报错也别弹出真窗口。
// 记下每次调用，方便检查交给 worker 的环境变量；个别用例把 spawnImpl 换成假的子进程。
const refuseSpawn = () => {
	throw new Error("测试中不应拉起对话框进程");
};
const spawnCalls = [];
let spawnImpl = refuseSpawn;
before(() => {
	mock.method(childProcess, "spawn", (command, args, options) => {
		spawnCalls.push({ command, args, options });
		return spawnImpl(command, args, options);
	});
	syncBuiltinESMExports();
});
after(() => {
	mock.restoreAll();
	syncBuiltinESMExports();
});

let home;
beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-directory-plugin-"));
	process.env.DSH_HOME = home;
	spawnCalls.length = 0;
	spawnImpl = refuseSpawn;
});

/** 一个什么都不做、等测试替它发消息的「worker 进程」。 */
function fakeChild() {
	const child = new EventEmitter();
	child.kill = () => {};
	child.disconnect = () => {};
	// 修复进程会 unref（不阻塞宿主退出），假子进程也得有。
	child.unref = () => {};
	return child;
}

/** 等到 predicate 成立（请求要先读请求体、读配置，几轮事件循环之后才会走到 spawn）。 */
async function waitFor(predicate, what) {
	for (let i = 0; i < 200; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail("等不到：" + what);
}
afterEach(() => {
	delete process.env.DSH_DIRECTORY_LOG_PATHS;
	delete process.env.DSH_DIRECTORY_PLUGIN_SECRET;
	fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

const readLog = () => {
	const file = path.join(home, "workspace-directory.log");
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
};

/** 通过 apply() 挂载一次，拿到路由处理器和卸载函数（effect 返回的 disposer）。 */
function mount() {
	const handlers = {};
	let teardown = null;
	apply({
		inject(_dependencies, callback) {
			callback({
				webServer: { register: (route) => ((handlers[route.path] = route.handler), () => {}) },
				effect: (setup) => ((teardown = setup()), () => teardown?.())
			});
		}
	});
	return { handlers, dispose: () => teardown?.() };
}

/** 通过 apply() 拿到真正注册的路由处理器。 */
function routes() {
	return mount().handlers;
}

/**
 * 模拟一次请求，返回 { status, headers, body }。
 * @param {Record<string, Function>} handlers - 路由表。
 * @param {string} route - 路由路径。
 * @param {{method?: string, headers?: Record<string, string> | null, body?: unknown, address?: string}} [options] - 请求参数；
 *   address 填 request.socket.remoteAddress（不填就是「拿不到来源地址」）。
 */
async function callOn(handlers, route, { method = "GET", headers = {}, body, address } = {}) {
	const payload = body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
	const request = Readable.from(payload);
	request.method = method;
	request.headers = headers;
	if (address !== undefined) request.socket = { remoteAddress: address };
	const result = { status: null, headers: null, body: null };
	const response = {
		writableEnded: false,
		writeHead(status, responseHeaders) {
			result.status = status;
			result.headers = responseHeaders;
		},
		end(text) {
			this.writableEnded = true;
			result.body = JSON.parse(text);
		}
	};
	await handlers[route](request, response);
	return result;
}

/** 模拟一次请求（每次重新挂载）。 */
async function call(route, options) {
	return callOn(routes(), route, options);
}

describe("CSRF 防护", () => {
	test("/pick 不再接受 GET", async () => {
		const result = await call(PICK, { method: "GET", headers: { "sec-fetch-site": "same-origin" } });
		assert.equal(result.status, 405);
		assert.equal(result.body.code, "method-not-allowed");
	});

	test("非 JSON 的 POST 被拒绝（跨站表单、no-cors 请求只能发这种）", async () => {
		const textPlain = { "content-type": "text/plain" };
		assert.equal((await call(PICK, { method: "POST", headers: textPlain, body: "{}" })).status, 415);
		assert.equal((await call(CONFIG, { method: "POST", headers: textPlain, body: { directory: home } })).status, 415);
		assert.ok(!fs.existsSync(path.join(home, "workspace-directory.json")), "被拒绝的请求不应改动配置");
	});

	test("浏览器标为跨站的请求被拒绝", async () => {
		const crossSite = { ...SAME_ORIGIN_JSON, "sec-fetch-site": "cross-site" };
		const picked = await call(PICK, { method: "POST", headers: crossSite, body: {} });
		assert.equal(picked.status, 403);
		assert.equal(picked.body.code, "cross-site");
		assert.equal((await call(CONFIG, { method: "GET", headers: crossSite })).status, 403);
		assert.equal(spawnCalls.length, 0);
	});

	test("同源 JSON 请求照常工作，地址栏直接打开 GET /config 也可以", async () => {
		const saved = await call(CONFIG, { method: "POST", headers: SAME_ORIGIN_JSON, body: { directory: home } });
		assert.equal(saved.status, 200);
		assert.equal(saved.body.directory, home);

		const read = await call(CONFIG, { method: "GET", headers: { "sec-fetch-site": "none" } });
		assert.equal(read.status, 200);
		assert.equal(read.body.directory, home);
	});
});

describe("POST /config", () => {
	test("相对路径返回 400 和错误码 not-absolute，detail 是原始输入", async () => {
		const result = await call(CONFIG, { method: "POST", headers: SAME_ORIGIN_JSON, body: { directory: "Projects" } });
		assert.equal(result.status, 400);
		assert.equal(result.body.code, "not-absolute");
		assert.equal(result.body.detail, "Projects");
		assert.equal(typeof result.body.error, "string");
	});

	test("配置文件一直被占用时返回 500 save-failed，而不是让请求悬空", async (t) => {
		t.mock.method(fs.promises, "rename", async () => {
			throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
		});

		const result = await call(CONFIG, { method: "POST", headers: SAME_ORIGIN_JSON, body: { directory: home } });
		assert.equal(result.status, 500);
		assert.equal(result.body.code, "save-failed");
		assert.match(result.body.detail, /EPERM/);
		assert.deepEqual(fs.readdirSync(home).filter((name) => name.endsWith(".tmp")), []);
	});

	test("请求体不是 JSON 对象时返回 400", async () => {
		const notJson = await call(CONFIG, { method: "POST", headers: SAME_ORIGIN_JSON, body: "{oops" });
		assert.equal(notJson.status, 400);
		assert.equal(notJson.body.code, "invalid-json");
		const array = await call(CONFIG, { method: "POST", headers: SAME_ORIGIN_JSON, body: "[]" });
		assert.equal(array.body.code, "invalid-body");
	});

	test("PUT 不再被当成 POST（以前的报错文案写着只支持 GET/POST）", async () => {
		const result = await call(CONFIG, { method: "PUT", headers: SAME_ORIGIN_JSON, body: { directory: home } });
		assert.equal(result.status, 405);
		assert.equal(result.body.code, "method-not-allowed");
		assert.ok(!fs.existsSync(path.join(home, "workspace-directory.json")));
	});
});

describe("GET /config", () => {
	test("告诉客户端当前平台是否支持", async () => {
		const read = await call(CONFIG, { method: "GET", headers: { "sec-fetch-site": "same-origin" } });
		assert.equal(read.body.supported, process.platform === "win32");
	});

	test("不是 Windows 时 supported 为 false", async (t) => {
		onPlatform(t, "linux");
		const read = await call(CONFIG, { method: "GET", headers: { "sec-fetch-site": "same-origin" } });
		assert.equal(read.status, 200);
		assert.equal(read.body.supported, false);
	});
});

describe("POST /pick", () => {
	test("不是 Windows：501 unsupported，不起进程", async (t) => {
		onPlatform(t, "linux");
		const result = await call(PICK, { method: "POST", headers: SAME_ORIGIN_JSON, body: { purpose: "workspace" } });
		assert.equal(result.status, 501);
		assert.equal(result.body.code, "unsupported");
		assert.equal(spawnCalls.length, 0);
	});

	test("另一个用途的对话框开着时回 409 busy；同用途的请求等着拿同一个结果", windowsOnly, async () => {
		const child = fakeChild();
		spawnImpl = () => child;
		const workspace = call(PICK, { method: "POST", headers: SAME_ORIGIN_JSON, body: { purpose: "workspace" } });
		await waitFor(() => spawnCalls.length === 1, "第一个对话框进程");

		const settings = await call(PICK, { method: "POST", headers: SAME_ORIGIN_JSON, body: { purpose: "settings" } });
		assert.equal(settings.status, 409);
		assert.equal(settings.body.code, "busy");
		// 给同用途的第二个请求一点时间走到 pickDirectory：它应该共用第一个对话框，不再起进程。
		const again = call(PICK, { method: "POST", headers: SAME_ORIGIN_JSON, body: { purpose: "workspace" } });
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(spawnCalls.length, 1, "同用途不应再起一个进程");

		child.emit("message", { kind: "showing", initialFolder: { requested: null, applied: false }, owner: "4242", koffi: "C:\\vendor\\koffi\\index.cjs" });
		child.emit("message", { kind: "done", path: "D:\\Picked" });
		for (const result of [await workspace, await again]) {
			assert.equal(result.status, 200);
			assert.equal(result.body.path, "D:\\Picked");
			assert.deepEqual(result.body.initialFolder, { requested: null, applied: false });
		}
		// 实测时靠这一行确认：对话框以 DSH 窗口为父窗口，用的是哪一份 koffi（只记来源枚举）。
		assert.ok(readLog().includes("pick D:\\…\\Picked purpose=workspace owner=4242 koffi=override initial="), readLog());
	});

	test("输入框里的目录写法不对：400，不起进程", async () => {
		const result = await call(PICK, { method: "POST", headers: SAME_ORIGIN_JSON, body: { purpose: "settings", initialDirectory: "Projects" } });
		assert.equal(result.status, 400);
		assert.equal(result.body.code, "not-absolute");
		assert.equal(spawnCalls.length, 0);
	});

	test("从输入框里还没保存的目录打开；目录不存在也照样交给 worker（由它回退并报告）", windowsOnly, async () => {
		const missing = path.join(home, "missing");
		await call(PICK, { method: "POST", headers: SAME_ORIGIN_JSON, body: { purpose: "settings", initialDirectory: `"${missing}"` } });
		assert.equal(spawnCalls[0].options.env.DSH_DIALOG_INITIAL_DIR, missing);
	});

	test("输入框空着时从已保存的目录打开", windowsOnly, async () => {
		await call(CONFIG, { method: "POST", headers: SAME_ORIGIN_JSON, body: { directory: home } });
		await call(PICK, { method: "POST", headers: SAME_ORIGIN_JSON, body: { purpose: "settings", initialDirectory: "  " } });
		assert.equal(spawnCalls[0].options.env.DSH_DIALOG_INITIAL_DIR, home);
	});

	test("客户端给的标题（去掉控制字符后）交给 worker；失败时只回错误码和说明，不带堆栈", windowsOnly, async () => {
		const result = await call(PICK, { method: "POST", headers: SAME_ORIGIN_JSON, body: { title: "选择\n文件夹" } });
		assert.equal(spawnCalls.length, 1);
		assert.equal(spawnCalls[0].options.env.DSH_DIALOG_TITLE, "选择 文件夹");

		assert.equal(result.status, 500);
		assert.equal(result.body.code, "pick-failed");
		assert.equal(result.body.detail, "测试中不应拉起对话框进程");
		assert.doesNotMatch(JSON.stringify(result.body), /\\n\s+at /);
		assert.match(readLog(), /pick-failed pick-failed /);
	});

	test("没给标题时 worker 收到空串（对话框用系统自带的标题）", windowsOnly, async () => {
		await call(PICK, { method: "POST", headers: SAME_ORIGIN_JSON, body: {} });
		assert.equal(spawnCalls[0].options.env.DSH_DIALOG_TITLE, "");
	});
});

describe("兜底", () => {
	test("处理器里没料到的异常回 500 internal-error，而不是让请求悬空", async () => {
		const result = await call(CONFIG, { method: "GET", headers: null });
		assert.equal(result.status, 500);
		assert.equal(result.body.code, "internal-error");
		assert.match(readLog(), /route-failed/);
	});
});

describe("同一进程里被挂两次（profile 装了一份，市场又热挂了一份）", () => {
	test("第二份注册同名路由失败时不抛，只记一条 duplicate-mount", () => {
		const mounted = [];
		const context = {
			inject(_dependencies, callback) {
				callback({
					webServer: {
						register(route) {
							if (mounted.includes(route.path)) throw new Error('webserver: duplicate exact route "' + route.path + '"');
							mounted.push(route.path);
							return () => {};
						}
					},
					effect: (setup) => setup()
				});
			}
		};
		apply(context);
		apply(context);
		assert.deepEqual(mounted, [CONFIG, PICK], "路由只该注册一遍");
		const log = readLog();
		assert.match(log, /duplicate-mount \/dsh-directory-plugin\/config /);
		assert.match(log, /host-routes-registered \/dsh-directory-plugin routes=0/);
	});
});

describe("耗时日志", () => {
	test("/pick 的日志带上请求等待、启动、总时长（响应体不变）", windowsOnly, async () => {
		spawnImpl = () => {
			const child = fakeChild();
			setImmediate(() => {
				child.emit("message", { kind: "showing", initialFolder: { requested: null, applied: false } });
				child.emit("message", { kind: "done", path: "D:\\Picked" });
			});
			return child;
		};
		const headers = { ...SAME_ORIGIN_JSON, "x-dsh-directory-plugin-started-at": String(Date.now() - 7) };
		const result = await call(PICK, { method: "POST", headers, body: {} });
		assert.equal(result.status, 200);
		assert.deepEqual(Object.keys(result.body).sort(), ["directory", "initialFolder", "path"], "响应体形状不变");
		assert.match(readLog(), /timing=wait=\d+ms show=\d+ms total=\d+ms/);
	});

	test("请求在宿主里排久了，单独记一条 pick-delayed", windowsOnly, async () => {
		spawnImpl = () => {
			const child = fakeChild();
			setImmediate(() => child.emit("message", { kind: "done", path: null }));
			return child;
		};
		const headers = { ...SAME_ORIGIN_JSON, "x-dsh-directory-plugin-started-at": String(Date.now() - 4000) };
		await call(PICK, { method: "POST", headers, body: {} });
		assert.match(readLog(), /pick-delayed wait=\d+ms purpose=workspace/);
	});
});

describe("GET /config：local 与 exists", () => {
	test("响应形状是 directory / configFile / supported / local / exists，并且带 nosniff", async () => {
		const read = await call(CONFIG, { method: "GET", headers: { "sec-fetch-site": "same-origin" } });
		assert.equal(read.status, 200);
		assert.deepEqual(Object.keys(read.body).sort(), ["configFile", "directory", "exists", "local", "supported"]);
		assert.equal(read.body.local, true);
		assert.equal(read.body.exists, null, "还没配置时是 null");
		assert.equal(read.headers["x-content-type-options"], "nosniff");
	});

	test("已保存的目录存在是 true，被删掉之后是 false", async () => {
		const saved = path.join(home, "workspace");
		fs.mkdirSync(saved);
		await call(CONFIG, { method: "POST", headers: SAME_ORIGIN_JSON, body: { directory: saved } });
		assert.equal((await call(CONFIG, { method: "GET", headers: SAME_ORIGIN_JSON })).body.exists, true);
		fs.rmdirSync(saved);
		assert.equal((await call(CONFIG, { method: "GET", headers: SAME_ORIGIN_JSON })).body.exists, false);
	});

	test("非本机请求：/config 照常返回，local 为 false（客户端据此不接管选择框）", async () => {
		const read = await call(CONFIG, { method: "GET", headers: SAME_ORIGIN_JSON, address: "10.1.2.3" });
		assert.equal(read.status, 200);
		assert.equal(read.body.local, false);
		assert.equal((await call(CONFIG, { method: "GET", headers: SAME_ORIGIN_JSON })).body.local, true);
	});

	test("回环地址的三种写法都算本机", async () => {
		for (const address of ["127.0.0.1", "::1", "::FFFF:127.0.0.1"]) {
			assert.equal((await call(CONFIG, { method: "GET", headers: SAME_ORIGIN_JSON, address })).body.local, true, address);
		}
	});

	test("配置文件读不出来：directory 和 exists 都是 null，不抛", async (t) => {
		fs.writeFileSync(path.join(home, "workspace-directory.json"), "{}");
		t.mock.method(fs.promises, "readFile", async () => {
			throw Object.assign(new Error("EBUSY: resource busy or locked, open"), { code: "EBUSY" });
		});
		const read = await call(CONFIG, { method: "GET", headers: SAME_ORIGIN_JSON });
		assert.equal(read.status, 200);
		assert.equal(read.body.directory, null);
		assert.equal(read.body.exists, null);
		assert.match(readLog(), /config-unreadable/);
	});
});

describe("POST /config：清除配置与请求体上限", () => {
	test("空串 / null / 不传 directory 都是清除：回 200，文件里是 null", async () => {
		await call(CONFIG, { method: "POST", headers: SAME_ORIGIN_JSON, body: { directory: home } });
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "workspace-directory.json"), "utf8")), { directory: home });

		for (const body of [{ directory: "" }, { directory: null }, {}]) {
			const cleared = await call(CONFIG, { method: "POST", headers: SAME_ORIGIN_JSON, body });
			assert.equal(cleared.status, 200);
			assert.equal(cleared.body.directory, null);
			assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "workspace-directory.json"), "utf8")), { directory: null });
			assert.equal((await call(CONFIG, { method: "GET", headers: SAME_ORIGIN_JSON })).body.directory, null);
		}
	});

	test("请求体超过 64KB：413 body-too-large，不写配置", async () => {
		const result = await call(CONFIG, { method: "POST", headers: SAME_ORIGIN_JSON, body: "x".repeat(70000) });
		assert.equal(result.status, 413);
		assert.equal(result.body.code, "body-too-large");
		assert.ok(!fs.existsSync(path.join(home, "workspace-directory.json")));
	});

	test("/pick 的请求体同样有上限", async () => {
		const result = await call(PICK, { method: "POST", headers: SAME_ORIGIN_JSON, body: "x".repeat(70000) });
		assert.equal(result.status, 413);
		assert.equal(result.body.code, "body-too-large");
		assert.equal(spawnCalls.length, 0);
	});
});

describe("POST /pick：只接受本机请求", () => {
	test("非回环地址：403 not-local，不起进程，日志留痕", windowsOnly, async () => {
		const result = await call(PICK, { method: "POST", headers: SAME_ORIGIN_JSON, body: {}, address: "192.168.1.20" });
		assert.equal(result.status, 403);
		assert.equal(result.body.code, "not-local");
		assert.equal(spawnCalls.length, 0);
		assert.match(readLog(), /not-local pick refused from 192\.168\.1\.20/);
	});

	test("回环地址的三种写法都放行", windowsOnly, async () => {
		for (const address of ["127.0.0.1", "::1", "::FFFF:127.0.0.1"]) {
			await call(PICK, { method: "POST", headers: SAME_ORIGIN_JSON, body: {}, address });
		}
		assert.equal(spawnCalls.length, 3);
		assert.doesNotMatch(readLog(), /not-local/);
	});
});

describe("POST /pick：交给 worker 的东西", () => {
	test("worker 只拿到白名单环境变量，外加 DSH_* 自定义项", windowsOnly, async () => {
		process.env.DSH_DIRECTORY_PLUGIN_SECRET = "不该传给 worker";
		await call(PICK, { method: "POST", headers: SAME_ORIGIN_JSON, body: {} });
		const env = spawnCalls[0].options.env;
		assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
		assert.equal(env.PATH, process.env.PATH);
		assert.equal("DSH_DIRECTORY_PLUGIN_SECRET" in env, false, "白名单之外的变量不传");
		assert.equal("DSH_HOME" in env, false, "宿主自己的环境变量不外传");
		assert.ok(env.DSH_KOFFI_PATH.endsWith(path.join("vendor", "node_modules", "koffi", "index.cjs")), env.DSH_KOFFI_PATH);
		assert.equal(env.DSH_DIALOG_INITIAL_STATE, "none");
		assert.equal(env.DSH_DIALOG_INITIAL_DIR, "");
	});

	test("DSH_DIALOG_INITIAL_STATE 跟着已保存的目录走：dir / missing", windowsOnly, async () => {
		const saved = path.join(home, "workspace");
		fs.mkdirSync(saved);
		await call(CONFIG, { method: "POST", headers: SAME_ORIGIN_JSON, body: { directory: saved } });
		await call(PICK, { method: "POST", headers: SAME_ORIGIN_JSON, body: {} });
		assert.equal(spawnCalls[0].options.env.DSH_DIALOG_INITIAL_STATE, "dir");

		spawnCalls.length = 0;
		fs.rmdirSync(saved);
		await call(PICK, { method: "POST", headers: SAME_ORIGIN_JSON, body: {} });
		assert.equal(spawnCalls[0].options.env.DSH_DIALOG_INITIAL_STATE, "missing");
	});

	test("输入框里填的是个文件：state 是 not-dir（worker 据此回退并报告）", windowsOnly, async () => {
		const file = path.join(home, "file.txt");
		fs.writeFileSync(file, "");
		await call(PICK, { method: "POST", headers: SAME_ORIGIN_JSON, body: { purpose: "settings", initialDirectory: file } });
		assert.equal(spawnCalls[0].options.env.DSH_DIALOG_INITIAL_STATE, "not-dir");
		assert.equal(spawnCalls[0].options.env.DSH_DIALOG_INITIAL_DIR, file);
	});
});

describe("日志脱敏", () => {
	const PICKED = "D:\\DSH Project\\双人求生\\子目录";
	const REQUESTED = "D:\\DSH Project\\双人求生";

	/** 让假 worker 回报一次带完整路径的 showing 和 done。 */
	function replyWithPaths() {
		spawnImpl = () => {
			const child = fakeChild();
			setImmediate(() => {
				child.emit("message", {
					kind: "showing",
					initialFolder: { requested: REQUESTED, state: "dir", applied: true, resolvedPath: REQUESTED },
					owner: "4242",
					koffi: path.join(PLUGIN_ROOT, "vendor", "node_modules", "koffi", "index.cjs")
				});
				child.emit("message", { kind: "done", path: PICKED });
			});
			return child;
		};
	}

	test("默认只留最后一段目录名：完整路径不落盘，响应体照旧给完整路径", windowsOnly, async () => {
		replyWithPaths();
		const result = await call(PICK, { method: "POST", headers: SAME_ORIGIN_JSON, body: {} });
		assert.equal(result.status, 200);
		assert.equal(result.body.path, PICKED, "界面要的是完整路径");

		const log = readLog();
		assert.doesNotMatch(log, /DSH Project/, log);
		assert.ok(log.includes("pick D:\\…\\子目录 purpose=workspace owner=4242 koffi=vendor initial="), log);
		assert.ok(log.includes("koffi=vendor"), "koffi 只记来源枚举");
		// initial= 是 JSON.stringify 出来的：反斜杠成对出现，字段本身也必须先脱敏。
		assert.ok(log.includes('"requested":"D:\\\\…\\\\双人求生"'), log);
		assert.ok(log.includes('"resolvedPath":"D:\\\\…\\\\双人求生"'), log);
	});

	test("DSH_DIRECTORY_LOG_PATHS=1 时写完整路径（排错用）", windowsOnly, async () => {
		process.env.DSH_DIRECTORY_LOG_PATHS = "1";
		replyWithPaths();
		await call(PICK, { method: "POST", headers: SAME_ORIGIN_JSON, body: {} });
		const log = readLog();
		assert.ok(log.includes("pick " + PICKED + " purpose=workspace"), log);
	});
});

describe("卸载（effect disposer）", () => {
	test("dispose 时中止还开着的对话框：kill + pick-aborted，请求以 pick-exited 收尾", windowsOnly, async () => {
		const child = fakeChild();
		let kills = 0;
		child.kill = () => {
			kills++;
			child.emit("close", null, "SIGTERM");
		};
		spawnImpl = () => child;
		const mounted = mount();
		const pending = callOn(mounted.handlers, PICK, { method: "POST", headers: SAME_ORIGIN_JSON, body: {} });
		await waitFor(() => spawnCalls.length === 1, "对话框进程");
		child.emit("message", { kind: "showing", initialFolder: null, owner: "4242", koffi: "C:\\koffi\\index.cjs" });

		mounted.dispose();

		assert.equal(kills, 1);
		assert.match(readLog(), /pick-aborted purpose=workspace/);
		const result = await pending;
		assert.equal(result.status, 500);
		assert.equal(result.body.code, "pick-exited");
	});

	test("没有对话框时 dispose 什么也不做", () => {
		const mounted = mount();
		mounted.dispose();
		assert.doesNotMatch(readLog(), /pick-aborted/);
	});
});
