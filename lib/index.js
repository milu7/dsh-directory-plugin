/**
 * 宿主侧（host plane）：提供「默认工作区目录」的读写与原生目录选择，
 * 以及客户端设置页 / 新建工作区流程要调用的两个 HTTP 路由。
 *
 * 路由（同源相对路径，客户端硬编码同样的常量）：
 *   GET  /dsh-directory-plugin/config  → { directory, configFile }
 *   POST /dsh-directory-plugin/config  { directory } → { directory }
 *   POST /dsh-directory-plugin/pick    → { path, directory } | { error }
 *
 * 两个路由只服务 DSH 自己的页面：浏览器标为跨站的请求一律拒绝；POST 必须是
 * application/json（跨域发这种请求得先过 CORS 预检，而这里从不回 CORS 头）；
 * /pick 不接受 GET，否则任何网页放一个 <img> 就能弹出对话框。
 *
 * @module dsh-directory-plugin
 */
import { configFile, lastPickInfo, logEvent, messageOf, normalizeDirectory, pickConfiguredDirectory, pickDirectory, readSettings, writeSettings } from "./core.js";

/** 插件名（cordis 行 id 同名）。 */
export const name = "dsh-directory-plugin";

/** 不阻塞启动：只在宿主组合里挂了 webServer 时才注册路由。 */
export const inject = [];

/** 客户端与宿主共用的路由前缀。 */
const BASE = "/dsh-directory-plugin";

/** 请求体上限。 */
const MAX_BODY_BYTES = 65536;

/**
 * 读 JSON 请求体。
 * @param {import("node:http").IncomingMessage} request - 请求。
 * @returns {Promise<Record<string, unknown>>} 解析结果（空体 → {}）。
 */
async function readJsonBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new Error("请求体过大");
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") return {};
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("请求体不是合法 JSON");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求体必须是 JSON 对象");
	return parsed;
}

/**
 * 输出 JSON 响应。
 * @param {import("node:http").ServerResponse} response - 响应。
 * @param {number} status - 状态码。
 * @param {unknown} body - 响应体。
 */
function respondJson(response, status, body) {
	if (response.writableEnded) return;
	const text = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(text)
	});
	response.end(text);
}

/**
 * 拒绝不是 DSH 页面自己发出的请求（防 CSRF）。已经回了 403/415 时返回 true。
 * @param {import("node:http").IncomingMessage} request - 请求。
 * @param {import("node:http").ServerResponse} response - 响应。
 * @param {string} method - 大写的请求方法。
 * @returns {boolean} 是否已拒绝。
 */
function refuseForeign(request, response, method) {
	// 现代浏览器都带 Sec-Fetch-Site：同源 fetch 是 same-origin，地址栏直接打开是 none。
	const site = request.headers["sec-fetch-site"];
	if (site !== undefined && site !== "same-origin" && site !== "none") {
		respondJson(response, 403, { error: "拒绝跨站请求" });
		return true;
	}
	const type = String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
	if (method !== "GET" && type !== "application/json") {
		respondJson(response, 415, { error: "请求必须是 application/json" });
		return true;
	}
	return false;
}

/**
 * /config 处理器。
 * @param {import("node:http").IncomingMessage} request - 请求。
 * @param {import("node:http").ServerResponse} response - 响应。
 */
async function handleConfig(request, response) {
	const method = (request.method ?? "GET").toUpperCase();
	if (method !== "GET" && method !== "POST" && method !== "PUT") {
		respondJson(response, 405, { error: "只支持 GET/POST" });
		return;
	}
	if (refuseForeign(request, response, method)) return;
	if (method === "GET") {
		const { directory } = await readSettings();
		respondJson(response, 200, { directory, configFile: configFile() });
		return;
	}
	let body;
	try {
		body = await readJsonBody(request);
	} catch (error) {
		respondJson(response, 400, { error: messageOf(error) });
		return;
	}
	const requested = body.directory;
	const clearing = requested === null || requested === undefined || (typeof requested === "string" && requested.trim() === "");
	let directory = null;
	if (!clearing) {
		try {
			directory = normalizeDirectory(requested);
		} catch (error) {
			respondJson(response, 400, { error: messageOf(error) });
			return;
		}
	}
	try {
		await writeSettings(directory);
	} catch (error) {
		// 典型原因：文件一直被杀毒、索引或编辑器占着，重试几次后仍然失败。
		logEvent("config-write-failed", messageOf(error));
		respondJson(response, 500, { error: "保存配置失败：" + messageOf(error) });
		return;
	}
	respondJson(response, 200, { directory, configFile: configFile() });
}

/**
 * /pick 处理器：打开原生目录对话框（起始目录 = 已保存的默认目录）。
 * @param {import("node:http").IncomingMessage} request - 请求。
 * @param {import("node:http").ServerResponse} response - 响应。
 */
async function handlePick(request, response) {
	const method = (request.method ?? "GET").toUpperCase();
	if (method !== "POST") {
		respondJson(response, 405, { error: "只支持 POST" });
		return;
	}
	if (refuseForeign(request, response, method)) return;
	const { directory } = await readSettings();
	try {
		const path = await pickDirectory(directory);
		logEvent("pick", (path ?? "(cancelled)") + " initial=" + JSON.stringify(lastPickInfo()));
		respondJson(response, 200, { path: path ?? null, directory, initialFolder: lastPickInfo() });
	} catch (error) {
		logEvent("pick-failed", messageOf(error));
		respondJson(response, 200, { error: messageOf(error), directory, initialFolder: lastPickInfo() });
	}
}

/**
 * 宿主插件入口。
 * @param {import("@deepseek-ai/cordis").Context} ctx - cordis 上下文。
 */
export function apply(ctx) {
	ctx.inject(["webServer"], (sub) => {
		const server = sub.webServer;
		sub.effect(() => {
			const disposers = [
				server.register({ kind: "exact", path: BASE + "/config", handler: handleConfig }),
				server.register({ kind: "exact", path: BASE + "/pick", handler: handlePick })
			];
			logEvent("host-routes-registered", BASE);
			return () => {
				for (const dispose of disposers) {
					try {
						dispose?.();
					} catch {
						// 卸载期异常不影响其他路由。
					}
				}
			};
		}, "dsh-directory-plugin routes");
	});
}

export { pickConfiguredDirectory };
