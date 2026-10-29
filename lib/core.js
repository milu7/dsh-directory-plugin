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

/**
 * 起始目录的状态：宿主在 spawn 前异步探测（最多 1.5 秒），通过 DSH_DIALOG_INITIAL_STATE
 * 交给 worker。worker 只用它填 initialFolder.state / reason 做诊断，仍然无条件尝试 SetFolder。
 * none 表示调用方没给起始目录；unknown 表示探测超时或出错了（照样把目录交给 worker 试）。
 * @typedef {"dir" | "missing" | "not-dir" | "unknown" | "none"} InitialState
 */

/**
 * 选择框对起始目录的实际处理结果（worker 在 showing 里回报，诊断用）。
 * state 是宿主探测到的状态；applied 是「SetFolder 成功且回报的 resolvedPath 与请求一致」；
 * reason 是没生效的原因（missing / not-dir / unknown / SHCreateItemFromParsingName / not-filesystem / SetFolder / resolved-elsewhere）。
 * @typedef {{
 *   requested?: string | null,
 *   state?: InitialState,
 *   applied?: boolean,
 *   reason?: string,
 *   setFolderHr?: number,
 *   itemHr?: number,
 *   resolvedHr?: number,
 *   resolvedPath?: string | null
 * }} InitialFolderInfo
 */

/**
 * 一次选择的结果。owner 是对话框的父窗口（DSH 窗口的 HWND，十进制字符串）；
 * 前台窗口不是 DSH 的时候对话框没有父窗口，owner 为 null。koffi 是 worker 实际加载的
 * koffi 入口（随包的那份，或者回退到的 DSH 自带的那份），只用来判断来源（见 koffiSource）：
 * 日志里不写绝对路径。
 */

/**
 * 一次选择的耗时（毫秒，只写日志、不回给界面）：toShowingMs 从拉起 worker 到它回报「框要出来了」，
 * worker 没来得及回报（超时、提前退出）时是 null；toDoneMs 到用户关掉框为止。
 * @typedef {{toShowingMs: number | null, toDoneMs: number}} PickTiming
 */

/** 选择框的用途：同一用途的并发请求共用一个对话框，不同用途的返回 busy。 */
export const PICK_PURPOSES = ["workspace", "settings"];

/**
 * 当前平台能不能用：对话框依赖 Win32 COM，只支持 Windows。
 * @returns {boolean} 是否支持。
 */
export function isSupported() {
	return process.platform === "win32";
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
 * 诊断日志位置。
 * @returns {string} 绝对路径。
 */
export function logFile() {
	return path.join(dshHome(), "workspace-directory.log");
}

/** 日志超过这个大小就把它改名成 .1（只留一份旧日志），再从空文件开始写。 */
const MAX_LOG_BYTES = 1024 * 1024;

/** 轮转也失败（日志一直被占用）时的硬上限：到这儿直接截断，不能让日志无限长。 */
const MAX_LOG_HARD_BYTES = 8 * 1024 * 1024;

/** 想让日志写完整路径（排错用）就把这个环境变量设成 1。 */
const KEEP_LOG_PATHS = "DSH_DIRECTORY_LOG_PATHS";

/**
 * 追加一行诊断日志（插件出问题时给用户看）。
 *
 * 用同步写：本地小文件，一次弹框才写一两行；换成异步还得自己排队保证行序。
 * 路径默认脱敏（见 redactPath）：README 让用户把日志贴到公开 issue。
 * @param {string} event - 事件名。
 * @param {string} [detail] - 细节；里面的换行会被转义，一个事件只占一行。
 */
export function logEvent(event, detail) {
	try {
		const file = logFile();
		rotateLog(file);
		const stamp = new Date().toISOString();
		const text = detail ? redactLogText(escapeLogText(detail)) : "";
		fs.appendFileSync(file, stamp + " " + event + (text === "" ? "" : " " + text) + "\n", "utf8");
	} catch {
		// 日志失败不影响功能。
	}
}

/**
 * 把换行转义成字面的 \n（堆栈之类的多行文本也只占一行）。U+2028/U+2029 在 Windows
 * 文件名里是合法字符，编辑器却当换行渲染，一并转义。
 * @param {string} text - 原文。
 * @returns {string} 单行文本。
 */
function escapeLogText(text) {
	return String(text).replace(/\r\n|[\r\n\u2028\u2029]/g, "\\n");
}

/**
 * 日志里是否要写完整路径（排错时设 DSH_DIRECTORY_LOG_PATHS=1）。
 * @returns {boolean} 是否不脱敏。
 */
function keepLogPaths() {
	const raw = process.env[KEEP_LOG_PATHS];
	return typeof raw === "string" && (raw === "1" || raw.toLowerCase() === "true");
}

/** 文本里的 Windows 绝对路径（含 UNC）：C:\a\b、\\server\share\dir。不认引号，所以 rename 'C:\a\b' 能被截断。 */
const LOG_PATH_PATTERN = /(?:[a-zA-Z]:|\\\\[^\\/:*?"<>|\r\n\s]+)[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\\/:*?"<>|\r\n]+/g;

/**
 * 把一段自由文本里出现的绝对路径脱敏（错误文案、堆栈里常带着路径）。
 * @param {string} text - 原文。
 * @returns {string} 脱敏后的文本。
 */
function redactLogText(text) {
	if (keepLogPaths()) return text;
	return text.replace(LOG_PATH_PATTERN, (match) => redactPath(match));
}

/**
 * 单个路径脱敏：家目录前缀优先折成 ~，其余只留最后一段。
 * 例：D:\DSH Project\双人求生 → D:\…\双人求生；C:\Users\me\a\b → ~\…\b。
 * DSH_DIRECTORY_LOG_PATHS=1 时原样返回；不是绝对路径也原样返回。
 * @param {string} value - 路径。
 * @returns {string} 脱敏后的路径。
 */
export function redactPath(value) {
	const text = typeof value === "string" ? value : String(value ?? "");
	if (text === "" || keepLogPaths()) return text;
	const home = os.homedir();
	if (home !== "" && isUnderPath(text, home)) {
		const rest = text.slice(home.length).replace(/^[\\/]+/, "");
		return rest === "" ? "~" : "~" + path.sep + collapseSegments(rest);
	}
	const parsed = path.parse(text);
	if (parsed.root === "" || parsed.base === "" || parsed.base === "." || parsed.base === "..") return text;
	return parsed.root + "…" + path.sep + parsed.base;
}

/**
 * 相对路径的中间段折成 …，只留最后一段。
 * @param {string} relative - 相对路径。
 * @returns {string} 例如 "…\双人求生"。
 */
function collapseSegments(relative) {
	const segments = relative.split(/[\\/]+/).filter((part) => part !== "");
	if (segments.length <= 1) return segments[0] ?? "";
	return "…" + path.sep + segments[segments.length - 1];
}

/**
 * text 是否以目录 prefix 开头（并且落在目录边界上，免得 C:\Users\me 命中 C:\Users\mercy）。
 * @param {string} text - 待检查的路径。
 * @param {string} prefix - 目录前缀。
 * @returns {boolean} 是否是 prefix 本身或它的子路径。
 */
function isUnderPath(text, prefix) {
	if (prefix === "" || text.length < prefix.length) return false;
	const head = text.slice(0, prefix.length);
	if (process.platform === "win32" ? head.toLowerCase() !== prefix.toLowerCase() : head !== prefix) return false;
	const next = text.charAt(prefix.length);
	return next === "" || next === "\\" || next === "/";
}

/**
 * 两个路径是不是同一个（Windows 大小写不敏感，先规范化 ".." 之类的写法）。
 * @param {string} a - 路径。
 * @param {string} b - 路径。
 * @returns {boolean} 是否相同。
 */
function samePath(a, b) {
	return path.resolve(a).replace(/[\\/]+$/, "").toLowerCase() === path.resolve(b).replace(/[\\/]+$/, "").toLowerCase();
}

/**
 * 日志太大时轮转；轮转也失败时按硬上限截断。
 * @param {string} file - 日志文件。
 */
function rotateLog(file) {
	let size;
	try {
		size = fs.statSync(file).size;
	} catch {
		return; // 还没有日志
	}
	if (size < MAX_LOG_BYTES) return;
	try {
		fs.renameSync(file, file + ".1");
		return;
	} catch {
		// 正被别的程序占着：这次先接着写，下次再轮转——但不能让它无限长。
	}
	if (size < MAX_LOG_HARD_BYTES) return;
	try {
		fs.truncateSync(file, 0);
	} catch {
		// 还是写不进去：留给下次。
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
 * 只检查写法：去掉引号，必须是完整的绝对路径；不碰文件系统。
 * @param {unknown} value - 原始输入（可能带引号、正反斜杠混用）。
 * @returns {string} 规范化后的绝对路径（不保证存在）。
 */
export function parseDirectory(value) {
	if (typeof value !== "string") throw new PluginError("not-a-string", "Directory must be a string");
	let directory = value.trim();
	const quoted = /^"(.*)"$/s.exec(directory);
	if (quoted !== null) directory = quoted[1].trim();
	if (directory === "") throw new PluginError("empty", "Directory is empty");
	if (!isFullyQualified(directory)) throw new PluginError("not-absolute", "Directory must be a fully qualified path", directory);
	return path.resolve(directory);
}

/**
 * 规范化并校验用户输入的目录：写法正确，并且确实是一个已存在的文件夹。
 *
 * 用异步 stat：路径可能指向断开的映射盘或网络位置，同步调用会卡住整个宿主几十秒。
 * @param {unknown} value - 原始输入（可能带引号、正反斜杠混用）。
 * @returns {Promise<string>} 规范化后的绝对目录。
 */
export async function normalizeDirectory(value) {
	const directory = parseDirectory(value);
	let stat;
	try {
		stat = await fs.promises.stat(directory);
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

/** 起始目录探测最多等这么久：断开的映射盘、网络位置上的 stat 会卡住十几秒。 */
const INITIAL_STATE_TIMEOUT_MS = 1500;

/**
 * 异步探测起始目录的状态（给 worker 做诊断用）。
 *
 * 只做诊断：超时、出错都返回 unknown，照样把目录交给 worker 去试——和以前
 * worker 里那句同步 existsSync 的区别只是「谁等」和「等多久」。
 * @param {string | null} directory - 起始目录。
 * @returns {Promise<InitialState>} 状态。
 */
export async function probeInitialState(directory) {
	if (typeof directory !== "string" || directory === "") return "none";
	let timer = null;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve("unknown"), INITIAL_STATE_TIMEOUT_MS);
	});
	try {
		return await Promise.race([statState(directory), timeout]);
	} finally {
		if (timer !== null) clearTimeout(timer);
	}
}

/**
 * stat 一个目录，把结果归成状态。
 * @param {string} directory - 目录。
 * @returns {Promise<InitialState>} dir / not-dir / missing / unknown。
 */
async function statState(directory) {
	try {
		const stat = await fs.promises.stat(directory);
		return stat.isDirectory() ? "dir" : "not-dir";
	} catch (error) {
		// ENOTDIR：中途有一段不是目录，和「存在但不是文件夹」是一回事。
		if (error?.code === "ENOENT") return "missing";
		return error?.code === "ENOTDIR" ? "not-dir" : "unknown";
	}
}

/**
 * 已保存的目录现在还在不在（GET /config 的 exists 字段，设置页据此提示）。
 * @param {string | null} directory - 已保存的目录。
 * @returns {Promise<boolean | null>} 存在是 true，确定不存在是 false；未配置、探测超时或出错是 null。
 */
export async function directoryExists(directory) {
	if (typeof directory !== "string" || directory === "") return null;
	const state = await probeInitialState(directory);
	if (state === "unknown" || state === "none") return null;
	return state === "dir";
}

/** 同一个时刻只允许一个对话框：{ purpose, promise }。 */
let activePick = null;

/** 当前正在跑的 worker（卸载时中止对话框用）。 */
let activeWorker = null;

/** 当前这次选择的取消标志：探测起始目录（最长 1.5 秒）期间还没有 worker 可杀，先记下来。 */
let pickCancelled = false;

/**
 * 弹出原生文件夹选择框（从 initialDirectory 开始）。
 *
 * 对话框开着时又来一个请求：用途相同（比如重复点击）就共用这一个对话框的结果；
 * 用途不同（设置页的「浏览…」和「新建工作区」撞在一起）就以 busy 拒绝，
 * 免得同一个路径被两边同时拿去用。
 * @param {string | null} initialDirectory - 起始目录，null 表示让系统决定。
 * @param {{title?: string, purpose?: string, workerPath?: string}} [options] - title：对话框标题，
 *   不给就用系统自带的；purpose：用途（PICK_PURPOSES），默认 workspace；workerPath：见 runPick。
 * @returns {Promise<PickResult>} 选择结果；取消时 path 为 null。
 */
export function pickDirectory(initialDirectory = null, { title, purpose = "workspace", workerPath } = {}) {
	if (!isSupported()) return Promise.reject(new PluginError("unsupported", "Only Windows is supported (this is " + process.platform + ")"));
	if (activePick !== null) {
		if (activePick.purpose === purpose) return activePick.promise;
		return Promise.reject(new PluginError("busy", "Another folder dialog is already open (" + activePick.purpose + ")"));
	}
	pickCancelled = false;
	const promise = runPick(initialDirectory, { title, workerPath }).finally(() => {
		activePick = null;
		pickCancelled = false;
	});
	activePick = { purpose, promise };
	return promise;
}

/**
 * 中止正在进行的对话框（插件卸载、宿主关停时调用）。
 *
 * 只 kill 不等待：worker 的 close 会让 runPick 走一次非正常收尾，顺手把可能被禁用的
 * DSH 窗口救回来。
 * @returns {boolean} 是否真的中止了一个对话框。
 */
export function cancelActivePick() {
	if (activePick === null) return false;
	pickCancelled = true;
	const worker = activeWorker;
	logEvent("pick-aborted", "purpose=" + (activePick?.purpose ?? "unknown"));
	if (worker === null) return true; // 还在探测起始目录：runPick 在 spawn 前会看到 pickCancelled
	activeWorker = null;
	try {
		worker.kill();
	} catch {
		// 进程已经没了：没有要中止的东西。
	}
	return true;
}

/**
 * 用当前配置的目录弹出选择框。
 * @returns {Promise<string | null>} 选中的路径；取消时 null。
 */
export async function pickConfiguredDirectory() {
	const { directory } = await readSettings();
	return (await pickDirectory(directory)).path;
}

/** 插件自带的 koffi：undefined 表示还没查过，null 表示没有。 */
let vendoredKoffiPath;

/**
 * 插件自带的 koffi 入口。装好之后不会变，所以只查一次，不在每次弹框时碰文件系统。
 * @returns {string | null} index.cjs 的路径；没带就是 null。
 */
function vendoredKoffi() {
	if (vendoredKoffiPath === undefined) vendoredKoffiPath = fs.existsSync(VENDORED_KOFFI) ? VENDORED_KOFFI : null;
	return vendoredKoffiPath;
}

/**
 * worker 实际加载的 koffi 来自哪里。
 *
 * 日志只写这个枚举：README 让用户把日志贴到公开 issue，绝对路径会带出插件的安装目录。
 * @param {string | null} koffi - worker 回报的 koffi 入口（候选路径，或裸模块名 "koffi"）。
 * @returns {string} vendor（插件随包的那份）/ dsh（DSH 安装目录自带的）/ override（其它）/ unknown。
 */
export function koffiSource(koffi) {
	if (typeof koffi !== "string" || koffi === "") return "unknown";
	if (koffi === "koffi") return "dsh"; // 裸模块名：从 DSH 自己的 node_modules 里 require 到的
	if (samePath(koffi, VENDORED_KOFFI)) return "vendor";
	// exe 目录下的候选（resources/app.asar.unpacked/node_modules/koffi）就是 DSH 自带的那份。
	if (isUnderPath(koffi, path.dirname(process.execPath))) return "dsh";
	return "override";
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
 * worker 需要的环境变量（白名单，不再整体透传 process.env）。
 *
 * 全量透传的问题不是提权（同用户、同完整性级别），而是行为会被外部环境污染：
 * 比如在 shell 里设了 DSH_DIALOG_REENABLE_OWNER，正常弹框就会走进修复分支、框根本不出现。
 * Windows 的环境变量名大小写不敏感，process.env 的读取也是。
 */
const WORKER_ENV_KEYS = [
	"PATH",
	"SystemRoot",
	"SystemDrive",
	"windir",
	"TEMP",
	"TMP",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"LOCALAPPDATA",
	"APPDATA",
	"COMSPEC",
	"PATHEXT",
	"PROCESSOR_ARCHITECTURE",
	"NUMBER_OF_PROCESSORS"
];

/**
 * 启动 worker 用的环境变量。
 * @param {Record<string, string>} extra - 额外的变量。
 * @returns {Record<string, string>} 环境变量。
 */
function workerEnv(extra) {
	/** @type {Record<string, string>} */
	const env = {};
	for (const key of WORKER_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	// DSH 宿主本身就跑在 Node 模式的 Electron 里；显式带上，保证孙子进程也是纯 Node。
	env.ELECTRON_RUN_AS_NODE = "1";
	// 优先用插件自带的 koffi（不依赖 DSH 安装布局）；没有就让 worker 自己按 exe 目录找。
	const koffi = vendoredKoffi();
	if (koffi !== null) env.DSH_KOFFI_PATH = koffi;
	return { ...env, ...extra };
}

/** 修复进程失败时只留 stderr 的尾部这么多字符（worker 会把每个 koffi 候选都列一遍）。 */
const REPAIR_STDERR_TAIL = 500;

/**
 * worker 在模态对话框开着的时候死掉了（崩溃、被结束进程）：它禁用掉的 DSH 窗口不会自己恢复，
 * 整个 DSH 都点不动。起一个修复模式的 worker 把窗口重新启用（它会先确认那还是个被禁用的 DSH 窗口）。
 * @param {string} owner - 父窗口的 HWND（十进制）。
 * @param {string} workerPath - worker 脚本。
 */
function reenableOwner(owner, workerPath) {
	logEvent("owner-reenable", owner);
	try {
		const repair = spawn(process.execPath, [workerPath], {
			env: workerEnv({ DSH_DIALOG_REENABLE_OWNER: owner }),
			// 修复进程自己跑起来之后失败（比如 koffi 加载不了）原来完全看不见：收 stderr 尾部补一条日志。
			stdio: ["ignore", "ignore", "pipe"],
			windowsHide: true
		});
		let stderr = "";
		repair.stderr?.on("data", (chunk) => {
			stderr = (stderr + chunk).slice(-REPAIR_STDERR_TAIL);
		});
		repair.stderr?.on("error", () => {
			// 管道出错只影响诊断，不影响修复本身。
		});
		repair.on("error", (error) => logEvent("owner-reenable-failed", messageOf(error)));
		repair.on("close", (code) => {
			if (code === 0) return;
			const tail = stderr.trim();
			logEvent("owner-reenable-failed", "exit " + String(code ?? "unknown") + (tail === "" ? "" : ": " + tail));
		});
		repair.unref();
	} catch (error) {
		logEvent("owner-reenable-failed", messageOf(error));
	}
}

/**
 * 拉起 dialog-worker.cjs 并等待结果。
 *
 * spawn 之前先异步探测起始目录（最多 1.5 秒），把结果放进 DSH_DIALOG_INITIAL_STATE：
 * worker 只用它做诊断，不再自己同步 stat（断开的网络盘会卡住 showing）。
 * @param {string | null} initialDirectory - 起始目录。
 * @param {{title?: string, workerPath?: string}} [options] - title：对话框标题；
 *   workerPath：worker 脚本，测试时换成不碰 Win32 的假 worker。
 * @returns {Promise<PickResult>} 选择结果；取消时 path 为 null。失败时抛 PluginError
 *   （pick-timeout / pick-exited / pick-failed）：worker 回报过的起始目录诊断放在 initialFolder 上，
 *   worker 的堆栈放在 workerStack 上（只写日志）。
 */
export async function runPick(initialDirectory, { title, workerPath = WORKER_PATH } = {}) {
	const initialState = await probeInitialState(initialDirectory);
	// 探测期间可能已经有人要求中止（插件卸载）：别再起 worker 了，免得卸载之后还弹框。
	if (pickCancelled) return Promise.reject(new PluginError("pick-aborted", "Folder dialog was cancelled before it started"));
	return new Promise((resolve, rejectWith) => {
		const startedAt = Date.now();
		let toShowingMs = null;
		let initialFolder = null;
		let owner = null;
		let koffi = null;
		const reject = (error) => {
			error.initialFolder = initialFolder;
			rejectWith(error);
		};
		const env = workerEnv({
			DSH_DIALOG_TITLE: title ?? "",
			DSH_DIALOG_INITIAL_DIR: initialDirectory ?? "",
			DSH_DIALOG_INITIAL_STATE: initialState
		});
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
		activeWorker = worker;
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
		/**
		 * 收尾。除了 done（对话框正常关闭，shell 已经恢复 owner），其他收尾都先把可能被禁用的
		 * 父窗口救回来：worker 被 kill / 崩溃时不会有 COM 清理，窗口会永远点不动。
		 * @param {() => void} finish - 收尾动作。
		 * @param {boolean} [repair] - 是否兜一次 owner 修复。
		 */
		const settle = (finish, repair = true) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (activeWorker === worker) activeWorker = null;
			if (repair && owner !== null) reenableOwner(owner, workerPath);
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
					toShowingMs = Date.now() - startedAt;
					initialFolder = message.initialFolder ?? null;
					owner = typeof message.owner === "string" && /^\d+$/.test(message.owner) ? message.owner : null;
					koffi = typeof message.koffi === "string" ? message.koffi : null;
					return;
				case "done":
					// 正常关闭：worker 那边的模态框已经把 owner 恢复好了，不用再兜。
					settle(() => {
						try {
							worker.disconnect();
						} catch {}
						resolve({
							path: typeof message.path === "string" && message.path !== "" ? message.path : null,
							initialFolder,
							owner,
							koffi,
							timing: { toShowingMs, toDoneMs: Date.now() - startedAt }
						});
					}, false);
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
		// 走到这里说明 worker 没有回报 done/error 就没了；要是它的对话框当时以 DSH 窗口为父窗口，先把窗口救回来。
		worker.on("close", (code, signal) => {
			const status = code ?? signal ?? "unknown";
			settle(() => reject(new PluginError("pick-exited", "Folder dialog process exited early (" + String(status) + ")", String(status))));
		});
	});
}
