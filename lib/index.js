/**
 * 宿主侧（host plane）：提供「默认工作区目录」的读写与原生目录选择，
 * 以及客户端设置页 / 新建工作区流程要调用的两个 HTTP 路由。
 *
 * 路由（同源相对路径，客户端硬编码同样的常量）：
 *   GET  /dsh-directory-plugin/config  → { directory, configFile, supported }
 *   POST /dsh-directory-plugin/config  { directory } → { directory, configFile }
 *   POST /dsh-directory-plugin/pick    { purpose?, title?, initialDirectory? }
 *                                      → { path, directory, initialFolder }
 *
 * 出错时返回非 2xx 和 { code, error, detail? }：客户端按 code 翻译文案、接上 detail，
 * error 是英文说明（写日志、兜底显示）。/pick 另有 409 busy（另一个用途的对话框正开着）
 * 和 501 unsupported（不是 Windows）。
 *
 * 两个路由只服务 DSH 自己的页面：浏览器标为跨站的请求一律拒绝；POST 必须是
 * application/json（跨域发这种请求得先过 CORS 预检，而这里从不回 CORS 头）；
 * /pick 不接受 GET，否则任何网页放一个 <img> 就能弹出对话框。
 *
 * @module dsh-directory-plugin
 */
import {
	PICK_PURPOSES,
	PluginError,
	configFile,
	isSupported,
	logEvent,
	messageOf,
	normalizeDialogTitle,
	normalizeDirectory,
	parseDirectory,
	pickConfiguredDirectory,
	pickDirectory,
	readSettings,
	writeSettings
} from "./core.js";

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
		if (size > MAX_BODY_BYTES) throw new PluginError("body-too-large", "Request body exceeds " + MAX_BODY_BYTES + " bytes");
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") return {};
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new PluginError("invalid-json", "Request body is not valid JSON");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new PluginError("invalid-body", "Request body must be a JSON object");
	return parsed;
}

/**
 * 输出 JSON 响应。
 * @param {import("node:http").ServerResponse} response - 响应。
 * @param {number} status - 状态码。
 * @param {unknown} body - 响应体。
 */
function respondJson(response, status, body) {
	if (response.headersSent || response.writableEnded) return;
	const text = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(text)
	});
	response.end(text);
}

/**
 * 输出错误响应 { code, error, detail? }。
 * @param {import("node:http").ServerResponse} response - 响应。
 * @param {number} status - 状态码。
 * @param {PluginError} error - 带错误码的错误。
 */
function respondError(response, status, error) {
	const body = { code: error.code, error: error.message };
	if (error.detail !== undefined) body.detail = error.detail;
	respondJson(response, status, body);
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
		respondError(response, 403, new PluginError("cross-site", "Cross-site request refused"));
		return true;
	}
	const type = String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
	if (method !== "GET" && type !== "application/json") {
		respondError(response, 415, new PluginError("unsupported-media-type", "Request must be application/json"));
		return true;
	}
	return false;
}

/**
 * 读 JSON 请求体；失败时回 400/413 并返回 null。
 * @param {import("node:http").IncomingMessage} request - 请求。
 * @param {import("node:http").ServerResponse} response - 响应。
 * @returns {Promise<Record<string, unknown> | null>} 请求体。
 */
async function readBodyOrRespond(request, response) {
	try {
		return await readJsonBody(request);
	} catch (error) {
		if (!(error instanceof PluginError)) throw error;
		respondError(response, error.code === "body-too-large" ? 413 : 400, error);
		return null;
	}
}

/**
 * /config 处理器。
 * @param {import("node:http").IncomingMessage} request - 请求。
 * @param {import("node:http").ServerResponse} response - 响应。
 */
async function handleConfig(request, response) {
	const method = (request.method ?? "GET").toUpperCase();
	if (method !== "GET" && method !== "POST") {
		respondError(response, 405, new PluginError("method-not-allowed", "Only GET and POST are supported"));
		return;
	}
	if (refuseForeign(request, response, method)) return;
	if (method === "GET") {
		const { directory } = await readSettings();
		respondJson(response, 200, { directory, configFile: configFile(), supported: isSupported() });
		return;
	}
	const body = await readBodyOrRespond(request, response);
	if (body === null) return;
	const requested = body.directory;
	const clearing = requested === null || requested === undefined || (typeof requested === "string" && requested.trim() === "");
	let directory = null;
	if (!clearing) {
		try {
			directory = await normalizeDirectory(requested);
		} catch (error) {
			if (!(error instanceof PluginError)) throw error;
			respondError(response, 400, error);
			return;
		}
	}
	try {
		await writeSettings(directory);
	} catch (error) {
		// 典型原因：文件一直被杀毒、索引或编辑器占着，重试几次后仍然失败。
		logEvent("config-write-failed", messageOf(error));
		respondError(response, 500, new PluginError("save-failed", "Could not write the config file", messageOf(error)));
		return;
	}
	respondJson(response, 200, { directory, configFile: configFile() });
}

/** /pick 失败时各错误码对应的状态码；其余（对话框本身出错）都是 500。 */
const PICK_FAILURE_STATUS = { busy: 409, unsupported: 501 };

/**
 * /pick 处理器：打开原生目录对话框。
 *
 * 起始目录默认是已保存的目录；设置页会把输入框里还没保存的值作为 initialDirectory 传来。
 * 这个值只检查写法（必须是完整的绝对路径）：目录不存在时照样打开，由 worker 回退到系统默认
 * 位置并在 initialFolder 里报告，免得已保存的目录被删后连「浏览…」都打不开。
 * @param {import("node:http").IncomingMessage} request - 请求。
 * @param {import("node:http").ServerResponse} response - 响应。
 */
async function handlePick(request, response) {
	const method = (request.method ?? "GET").toUpperCase();
	if (method !== "POST") {
		respondError(response, 405, new PluginError("method-not-allowed", "Only POST is supported"));
		return;
	}
	if (refuseForeign(request, response, method)) return;
	const body = await readBodyOrRespond(request, response);
	if (body === null) return;
	const purpose = PICK_PURPOSES.includes(body.purpose) ? body.purpose : "workspace";
	const { directory } = await readSettings();
	let initialDirectory = directory;
	const typed = body.initialDirectory;
	if (typed !== undefined && typed !== null && !(typeof typed === "string" && typed.trim() === "")) {
		try {
			initialDirectory = parseDirectory(typed);
		} catch (error) {
			if (!(error instanceof PluginError)) throw error;
			respondError(response, 400, error);
			return;
		}
	}
	try {
		const result = await pickDirectory(initialDirectory, { title: normalizeDialogTitle(body.title), purpose });
		logEvent("pick", (result.path ?? "(cancelled)") + " purpose=" + purpose + " owner=" + (result.owner ?? "none") + " initial=" + JSON.stringify(result.initialFolder));
		respondJson(response, 200, { path: result.path, directory, initialFolder: result.initialFolder });
	} catch (error) {
		const failure = error instanceof PluginError ? error : new PluginError("pick-failed", messageOf(error), messageOf(error));
		// 堆栈只进日志，不回给界面。
		const stack = typeof failure.workerStack === "string" ? " stack=" + failure.workerStack : "";
		logEvent("pick-failed", failure.code + " " + failure.message + " purpose=" + purpose + " initial=" + JSON.stringify(failure.initialFolder ?? null) + stack);
		respondError(response, PICK_FAILURE_STATUS[failure.code] ?? 500, failure);
	}
}

/**
 * 兜底：处理器里没料到的异常回 500，而不是让请求悬空。
 * @param {(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => Promise<void>} handler - 处理器。
 * @returns {(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => Promise<void>} 包装后的处理器。
 */
function guarded(handler) {
	return async (request, response) => {
		try {
			await handler(request, response);
		} catch (error) {
			logEvent("route-failed", String(request.url ?? "") + " " + messageOf(error));
			respondError(response, 500, new PluginError("internal-error", messageOf(error)));
		}
	};
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
				server.register({ kind: "exact", path: BASE + "/config", handler: guarded(handleConfig) }),
				server.register({ kind: "exact", path: BASE + "/pick", handler: guarded(handlePick) })
			];
			logEvent("host-routes-registered", BASE + (isSupported() ? "" : " (unsupported platform " + process.platform + ")"));
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
