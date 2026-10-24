import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import { apply } from "../lib/index.js";
import { onPlatform } from "./helpers.js";

const CONFIG = "/dsh-directory-plugin/config";
const PICK = "/dsh-directory-plugin/pick";
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
	fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

const readLog = () => {
	const file = path.join(home, "workspace-directory.log");
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
};

/** 通过 apply() 拿到真正注册的路由处理器。 */
function routes() {
	const handlers = {};
	apply({
		inject(_dependencies, callback) {
			callback({
				webServer: { register: (route) => ((handlers[route.path] = route.handler), () => {}) },
				effect: (setup) => setup()
			});
		}
	});
	return handlers;
}

/** 模拟一次请求，返回 { status, body }。 */
async function call(route, { method = "GET", headers = {}, body } = {}) {
	const payload = body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
	const request = Readable.from(payload);
	request.method = method;
	request.headers = headers;
	const result = { status: null, body: null };
	const response = {
		writableEnded: false,
		writeHead(status) {
			result.status = status;
		},
		end(text) {
			this.writableEnded = true;
			result.body = JSON.parse(text);
		}
	};
	await routes()[route](request, response);
	return result;
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
		// 实测时靠这一行确认：对话框以 DSH 窗口为父窗口，用的是哪一份 koffi。
		assert.ok(readLog().includes("pick D:\\Picked purpose=workspace owner=4242 koffi=C:\\vendor\\koffi\\index.cjs initial="), readLog());
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
