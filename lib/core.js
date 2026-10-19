/**
 * 插件「记得新建工作区的目录」的纯 Node 逻辑层。
 *
 * 这里刻意不 import 任何 @deepseek-ai/* 或 electron 模块，所以可以直接用
 * node 跑单测：配置读写 + 拉起原生目录对话框（子进程）。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(HERE, "dialog-worker.cjs");
const VENDORED_KOFFI = path.join(HERE, "..", "vendor", "node_modules", "koffi", "index.cjs");

/** 上一次选择框对「起始目录」的实际处理结果（诊断用）。 */
let lastInitialFolder = null;

/**
 * 上一次选择框对起始目录的处理结果。
 * @returns {{requested?: string | null, applied?: boolean, reason?: string, setFolderHr?: number} | null} 诊断信息。
 */
export function lastPickInfo() {
	return lastInitialFolder;
}

/** 对话框标题的长度上限（标题由客户端按界面语言传入）。 */
const MAX_TITLE_LENGTH = 200;

/** 子进程在 Show() 之前回报 showing 的最长等待时间。 */
const SHOWING_TIMEOUT_MS = 30000;

/**
 * 带错误码的错误。客户端按 code 选文案再接上 detail；message 是英文说明，写日志、兜底显示。
 */
export class PluginError extends Error {
	/**
	 * @param {string} code - 错误码，例如 "not-found"。
	 * @param {string} message - 英文说明。
	 * @param {string} [detail] - 接在文案后面的细节（路径、底层错误）。
	 */
	constructor(code, message, detail) {
		super(message);
		this.name = "PluginError";
		this.code = code;
		if (detail !== undefined) this.detail = detail;
	}
}

/**
 * DSH 主目录：优先 DSH_HOME，其次 ~/.dsh。
 * @returns {string} 绝对路径。
 */
export function dshHome() {
	const raw = process.env.DSH_HOME;
	if (typeof raw === "string" && raw.trim() !== "") return path.resolve(raw.trim());
	return path.join(os.homedir(), ".dsh");
}

/**
 * 配置文件位置。
 * @returns {string} 绝对路径。
 */
export function configFile() {
	return path.join(dshHome(), "workspace-directory.json");
}

/**
 * 追加一行诊断日志（插件出问题时给用户看）。
 * @param {string} event - 事件名。
 * @param {string} [detail] - 细节。
 */
export function logEvent(event, detail) {
	try {
		const file = path.join(dshHome(), "workspace-directory.log");
		const stamp = new Date().toISOString();
		fs.appendFileSync(file, stamp + " " + event + (detail ? " " + detail : "") + "\n", "utf8");
	} catch {
		// 日志失败不影响功能。
	}
}

/**
 * 把错误转成可读文案。
 * @param {unknown} error - 任意错误。
 * @returns {string} 文案。
 */
export function messageOf(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** 旧版插件用过的配置文件名（按新→旧排列），读取时做一次性迁移。 */
const LEGACY_CONFIG_NAMES = ["workspace-anchor.json", "default-workspace-directory.json"];

/**
 * 旧版配置文件位置。
 * @param {string} [name] - 旧文件名，默认最新一个。
 * @returns {string} 绝对路径。
 */
export function legacyConfigFile(name = LEGACY_CONFIG_NAMES[0]) {
	return path.join(dshHome(), name);
}

/** readSettingsFile 的结果：文件不存在，可以去找旧版配置。 */
const MISSING = Symbol("missing");

/** readSettingsFile 的结果：文件在，但读不出来或不是合法 JSON——只能报告，绝不能覆盖。 */
const UNREADABLE = Symbol("unreadable");

/**
 * 读取一个配置文件。
 * @param {string} file - 文件路径。
 * @returns {Promise<string | null | typeof MISSING | typeof UNREADABLE>} 目录；null 表示明确清空。
 */
async function readSettingsFile(file) {
	let text;
	try {
		text = await fs.promises.readFile(file, "utf8");
	} catch (error) {
		if (error?.code === "ENOENT") return MISSING;
		logEvent("config-unreadable", file + " " + messageOf(error));
		return UNREADABLE;
	}
	let parsed;
	try {
		// 记事本、PowerShell 5 存的 UTF-8 常带 BOM，JSON.parse 不认。
		parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
	} catch (error) {
		logEvent("config-corrupt", file + " " + messageOf(error));
		return UNREADABLE;
	}
	const directory = typeof parsed?.directory === "string" ? parsed.directory.trim() : "";
	return directory === "" ? null : directory;
}

/**
 * 读取已保存的默认目录。
 *
 * 只有主配置「不存在」时才去找旧版配置并迁移。主配置在但损坏（比如手改时反斜杠没写成
 * `\\`）时按未配置处理并记日志，文件原样保留，等用户改好或在设置页重新保存。
 * @returns {Promise<{directory: string | null}>} 未配置或文件损坏时 directory 为 null。
 */
export async function readSettings() {
	const primary = await readSettingsFile(configFile());
	if (primary === UNREADABLE) return { directory: null };
	if (primary !== MISSING) return { directory: primary };
	for (const name of LEGACY_CONFIG_NAMES) {
		const legacy = await readSettingsFile(legacyConfigFile(name));
		if (legacy === MISSING || legacy === UNREADABLE) continue;
		await migrateLegacySettings(legacy);
		return { directory: legacy };
	}
	return { directory: null };
}

/** 迁移完成后旧文件追加的后缀：内容保留，但不再参与读取。 */
const MIGRATED_SUFFIX = ".migrated";

/**
 * 把旧版配置写成主配置；成功后让所有旧文件退役，免得以后删掉主配置时旧值又「复活」。
 * @param {string | null} directory - 旧版配置里的目录。
 */
async function migrateLegacySettings(directory) {
	try {
		await writeSettings(directory);
	} catch (error) {
		// 迁移失败不影响本次读取，下次读取时再试。
		logEvent("config-migrate-failed", messageOf(error));
		return;
	}
	for (const name of LEGACY_CONFIG_NAMES) {
		const file = legacyConfigFile(name);
		try {
			await fs.promises.rename(file, file + MIGRATED_SUFFIX);
		} catch {
			// 不存在或改名失败都无妨：主配置已经就位，旧文件不会再被读取。
		}
	}
	logEvent("config-migrated", directory ?? "(cleared)");
}

/** Windows 上目标文件被杀毒、索引、编辑器短暂占用时，rename 会报这几种错，稍等即可。 */
const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

/** rename 的重试间隔（合计最多多等 750ms）。 */
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400];

/**
 * 写入默认目录（null 表示清除）：先写临时文件，再原子替换。
 * @param {string | null} directory - 已规范化的绝对目录，或 null。
 * @returns {Promise<void>} 失败时清理临时文件并抛出原始错误。
 */
export async function writeSettings(directory) {
	const file = configFile();
	// 每次写入用独立的临时文件名，并发保存不会互相踩。
	const temp = file + "." + randomUUID() + ".tmp";
	await fs.promises.mkdir(path.dirname(file), { recursive: true });
	try {
		await fs.promises.writeFile(temp, JSON.stringify({ directory: directory ?? null }, null, 2) + "\n", "utf8");
		await renameWithRetry(temp, file);
	} catch (error) {
		await fs.promises.rm(temp, { force: true }).catch(() => {});
		throw error;
	}
}

/**
 * rename；目标被短暂占用时按退避间隔重试。
 * @param {string} from - 源路径。
 * @param {string} to - 目标路径。
 */
async function renameWithRetry(from, to) {
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.promises.rename(from, to);
			return;
		} catch (error) {
			if (attempt >= RENAME_RETRY_DELAYS_MS.length || !TRANSIENT_RENAME_ERRORS.has(error?.code)) throw error;
			await sleep(RENAME_RETRY_DELAYS_MS[attempt]);
		}
	}
}

/**
 * 是否是完整的绝对路径。Windows 上的 "C:foo"（盘符相对）和 "\foo"（当前盘根相对）
 * 都会按宿主进程的当前目录解析，结果不可预期，和相对路径一样拒绝。
 * @param {string} directory - 去掉引号后的输入。
 * @returns {boolean} 是否可以接受。
 */
function isFullyQualified(directory) {
	if (process.platform !== "win32") return path.isAbsolute(directory);
	return /^[a-zA-Z]:[\\/]/.test(directory) || /^[\\/]{2}[^\\/]/.test(directory);
}

/**
 * 规范化并校验用户输入的目录。
 * @param {unknown} value - 原始输入（可能带引号、正反斜杠混用）。
 * @returns {string} 规范化后的绝对目录。
 */
export function normalizeDirectory(value) {
	if (typeof value !== "string") throw new PluginError("not-a-string", "Directory must be a string");
	let directory = value.trim();
	const quoted = /^"(.*)"$/s.exec(directory);
	if (quoted !== null) directory = quoted[1].trim();
	if (directory === "") throw new PluginError("empty", "Directory is empty");
	if (!isFullyQualified(directory)) throw new PluginError("not-absolute", "Directory must be a fully qualified path", directory);
	directory = path.resolve(directory);
	let stat;
	try {
		stat = fs.statSync(directory);
	} catch {
		throw new PluginError("not-found", "Directory does not exist", directory);
	}
	if (!stat.isDirectory()) throw new PluginError("not-a-directory", "Not a directory", directory);
	return directory;
}

/**
 * 规范化客户端传来的对话框标题：去掉控制字符、限制长度。
 * @param {unknown} value - 原始值。
 * @returns {string | undefined} 标题；不可用时 undefined（对话框会用系统自带的标题）。
 */
export function normalizeDialogTitle(value) {
	if (typeof value !== "string") return undefined;
	const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
	// 按码点截断，不会把表情之类的代理对劈成两半。
	const title = Array.from(cleaned).slice(0, MAX_TITLE_LENGTH).join("").trim();
	return title === "" ? undefined : title;
}

/** 同一个时刻只允许一个对话框。 */
let activePick = null;

/**
 * 弹出原生文件夹选择框（从 initialDirectory 开始）。
 * @param {string | null} initialDirectory - 起始目录，null 表示让系统决定。
 * @param {{title?: string}} [options] - title：对话框标题，不给就用系统自带的。
 * @returns {Promise<string | null>} 选中的路径；取消时 null。
 */
export function pickDirectory(initialDirectory = null, { title } = {}) {
	if (activePick !== null) return activePick;
	activePick = runPick(initialDirectory, { title }).finally(() => {
		activePick = null;
	});
	return activePick;
}

/**
 * 用当前配置的目录弹出选择框。
 * @returns {Promise<string | null>} 选中的路径；取消时 null。
 */
export async function pickConfiguredDirectory() {
	const { directory } = await readSettings();
	return pickDirectory(directory);
}

/**
 * 把任意错误归成 PluginError（spawn 失败之类的系统错误码不往客户端漏）。
 * @param {unknown} error - 原始错误。
 * @returns {PluginError} 错误码为 pick-failed 的错误（原本就是 PluginError 时原样返回）。
 */
function asPickError(error) {
	if (error instanceof PluginError) return error;
	return new PluginError("pick-failed", messageOf(error), messageOf(error));
}

/**
 * 拉起 dialog-worker.cjs 并等待结果。
 * @param {string | null} initialDirectory - 起始目录。
 * @param {{title?: string, workerPath?: string}} [options] - title：对话框标题；
 *   workerPath：worker 脚本，测试时换成不碰 Win32 的假 worker。
 * @returns {Promise<string | null>} 选中的路径；取消时 null。失败时抛 PluginError
 *   （pick-timeout / pick-exited / pick-failed；worker 的堆栈放在 workerStack 上，只写日志）。
 */
export function runPick(initialDirectory, { title, workerPath = WORKER_PATH } = {}) {
	return new Promise((resolve, reject) => {
		lastInitialFolder = null;
		const env = {
			...process.env,
			// DSH 宿主本身就跑在 Node 模式的 Electron 里；显式带上，保证孙子进程也是纯 Node。
			ELECTRON_RUN_AS_NODE: "1",
			DSH_DIALOG_TITLE: title ?? "",
			DSH_DIALOG_INITIAL_DIR: initialDirectory ?? ""
		};
		// 优先用插件自带的 koffi（不依赖 DSH 安装布局）；没有就让 worker 自己按 exe 目录找。
		if (fs.existsSync(VENDORED_KOFFI)) env.DSH_KOFFI_PATH = VENDORED_KOFFI;
		let worker;
		try {
			worker = spawn(process.execPath, [workerPath], {
				env,
				stdio: ["ignore", "inherit", "inherit", "ipc"],
				windowsHide: true
			});
		} catch (error) {
			reject(asPickError(error));
			return;
		}
		let settled = false;
		let showingTimer = null;

		const cleanup = () => {
			if (showingTimer !== null) {
				clearTimeout(showingTimer);
				showingTimer = null;
			}
			worker.removeAllListeners("message");
			worker.removeAllListeners("error");
			worker.removeAllListeners("close");
		};
		const settle = (finish) => {
			if (settled) return;
			settled = true;
			cleanup();
			finish();
		};

		showingTimer = setTimeout(() => {
			settle(() => {
				try {
					worker.kill();
				} catch {}
				reject(new PluginError("pick-timeout", "Folder dialog did not start within " + SHOWING_TIMEOUT_MS + "ms"));
			});
		}, SHOWING_TIMEOUT_MS);

		worker.on("message", (message) => {
			if (message === null || typeof message !== "object") return;
			switch (message.kind) {
				case "showing":
					if (showingTimer !== null) {
						clearTimeout(showingTimer);
						showingTimer = null;
					}
					lastInitialFolder = message.initialFolder ?? null;
					return;
				case "done":
					settle(() => {
						try {
							worker.disconnect();
						} catch {}
						resolve(typeof message.path === "string" && message.path !== "" ? message.path : null);
					});
					return;
				case "error": {
					const text = String(message.message ?? "unknown");
					const error = new PluginError("pick-failed", "Native folder dialog failed: " + text, text);
					if (typeof message.stack === "string") error.workerStack = message.stack;
					settle(() => reject(error));
					return;
				}
				default:
					return;
			}
		});
		worker.on("error", (error) => {
			settle(() => reject(asPickError(error)));
		});
		// 用 close 而不是 exit：exit 可能比最后一条 IPC 消息先到，close 要等 IPC 通道读完才触发。
		worker.on("close", (code, signal) => {
			const status = code ?? signal ?? "unknown";
			settle(() => reject(new PluginError("pick-exited", "Folder dialog process exited early (" + String(status) + ")", String(status))));
		});
	});
}
