import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import { apply } from "../lib/index.js";

const CONFIG = "/dsh-directory-plugin/config";
const PICK = "/dsh-directory-plugin/pick";
const SAME_ORIGIN_JSON = { "content-type": "application/json", "sec-fetch-site": "same-origin" };

// 这里的用例都不该真的拉起对话框进程；万一校验失效，宁可报错也别弹出真窗口。
before(() => {
	mock.method(childProcess, "spawn", () => {
		throw new Error("测试中不应拉起对话框进程");
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
});
afterEach(() => {
	fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

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
	});

	test("非 JSON 的 POST 被拒绝（跨站表单、no-cors 请求只能发这种）", async () => {
		const textPlain = { "content-type": "text/plain" };
		assert.equal((await call(PICK, { method: "POST", headers: textPlain, body: "{}" })).status, 415);
		assert.equal((await call(CONFIG, { method: "POST", headers: textPlain, body: { directory: home } })).status, 415);
		assert.ok(!fs.existsSync(path.join(home, "workspace-directory.json")), "被拒绝的请求不应改动配置");
	});

	test("浏览器标为跨站的请求被拒绝", async () => {
		const crossSite = { ...SAME_ORIGIN_JSON, "sec-fetch-site": "cross-site" };
		assert.equal((await call(PICK, { method: "POST", headers: crossSite, body: {} })).status, 403);
		assert.equal((await call(CONFIG, { method: "GET", headers: crossSite })).status, 403);
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
	test("相对路径返回 400，并提示要写绝对路径", async () => {
		const result = await call(CONFIG, { method: "POST", headers: SAME_ORIGIN_JSON, body: { directory: "Projects" } });
		assert.equal(result.status, 400);
		assert.match(result.body.error, /绝对路径/);
	});

	test("配置文件一直被占用时返回 500，而不是让请求悬空", async (t) => {
		t.mock.method(fs.promises, "rename", async () => {
			throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
		});

		const result = await call(CONFIG, { method: "POST", headers: SAME_ORIGIN_JSON, body: { directory: home } });
		assert.equal(result.status, 500);
		assert.match(result.body.error, /EPERM/);
		assert.deepEqual(fs.readdirSync(home).filter((name) => name.endsWith(".tmp")), []);
	});
});
