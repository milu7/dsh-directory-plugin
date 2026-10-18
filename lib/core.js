/**
 * 插件「记得新建工作区的目录」的纯 Node 逻辑层。
 *
 * 这里刻意不 import 任何 @deepseek-ai/* 或 electron 模块，所以可以直接用
 * node 跑单测：配置读写 + 拉起原生目录对话框（子进程）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

/** 对话框标题（中文界面优先）。 */
const DIALOG_TITLE = "选择新工作区所在文件夹";

/** 子进程在 Show() 之前回报 showing 的最长等待时间。 */
const SHOWING_TIMEOUT_MS = 30000;

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

/**
 * 读取一个配置文件。
 * @param {string} file - 文件路径。
 * @returns {string | null | undefined} 目录；null 表示明确清空；undefined 表示文件缺失或损坏。
 */
function readSettingsFile(file) {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		const directory = typeof parsed?.directory === "string" ? parsed.directory.trim() : "";
		return directory === "" ? null : directory;
	} catch {
		return undefined;
	}
}

/**
 * 读取已保存的默认目录。
 * @returns {{directory: string | null}} 目录不存在/文件损坏时 directory 为 null。
 */
export function readSettings() {
	const primary = readSettingsFile(configFile());
	if (primary !== undefined) return { directory: primary };
	for (const name of LEGACY_CONFIG_NAMES) {
		const legacy = readSettingsFile(legacyConfigFile(name));
		if (legacy === undefined) continue;
		if (legacy !== null) {
			try {
				writeSettings(legacy);
			} catch {
				// 迁移失败不影响读取（下次仍会尝试）。
			}
		}
		return { directory: legacy };
	}
	return { directory: null };
}

/**
 * 写入默认目录（null 表示清除）。
 * @param {string | null} directory - 已规范化的绝对目录，或 null。
 */
export function writeSettings(directory) {
	const file = configFile();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = file + ".tmp";
	fs.writeFileSync(temp, JSON.stringify({ directory: directory ?? null }, null, 2) + "\n", "utf8");
	fs.renameSync(temp, file);
}

/**
 * 规范化并校验用户输入的目录。
 * @param {unknown} value - 原始输入（可能带引号、正反斜杠混用）。
 * @returns {string} 规范化后的绝对目录。
 */
export function normalizeDirectory(value) {
	if (typeof value !== "string") throw new Error("目录必须是一个字符串");
	let directory = value.trim();
	const quoted = /^"(.*)"$/s.exec(directory);
	if (quoted !== null) directory = quoted[1].trim();
	if (directory === "") throw new Error("目录不能为空");
	directory = path.resolve(directory);
	let stat;
	try {
		stat = fs.statSync(directory);
	} catch {
		throw new Error("目录不存在：" + directory);
	}
	if (!stat.isDirectory()) throw new Error("不是文件夹：" + directory);
	return directory;
}

/** 同一个时刻只允许一个对话框。 */
let activePick = null;

/**
 * 弹出原生文件夹选择框（从 initialDirectory 开始）。
 * @param {string | null} initialDirectory - 起始目录，null 表示让系统决定。
 * @returns {Promise<string | null>} 选中的路径；取消时 null。
 */
export function pickDirectory(initialDirectory = null) {
	if (activePick !== null) return activePick;
	activePick = runPick(initialDirectory).finally(() => {
		activePick = null;
	});
	return activePick;
}

/**
 * 用当前配置的目录弹出选择框。
 * @returns {Promise<string | null>} 选中的路径；取消时 null。
 */
export async function pickConfiguredDirectory() {
	const { directory } = readSettings();
	return pickDirectory(directory);
}

/**
 * 拉起 dialog-worker.cjs 并等待结果。
 * @param {string | null} initialDirectory - 起始目录。
 * @returns {Promise<string | null>} 选中的路径；取消时 null。
 */
function runPick(initialDirectory) {
	return new Promise((resolve, reject) => {
		lastInitialFolder = null;
		const env = {
			...process.env,
			// DSH 宿主本身就跑在 Node 模式的 Electron 里；显式带上，保证孙子进程也是纯 Node。
			ELECTRON_RUN_AS_NODE: "1",
			DSH_DIALOG_TITLE: DIALOG_TITLE,
			DSH_DIALOG_INITIAL_DIR: initialDirectory ?? ""
		};
		// 优先用插件自带的 koffi（不依赖 DSH 安装布局）；没有就让 worker 自己按 exe 目录找。
		if (fs.existsSync(VENDORED_KOFFI)) env.DSH_KOFFI_PATH = VENDORED_KOFFI;
		let worker;
		try {
			worker = spawn(process.execPath, [WORKER_PATH], {
				env,
				stdio: ["ignore", "inherit", "inherit", "ipc"],
				windowsHide: true
			});
		} catch (error) {
			reject(error);
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
			worker.removeAllListeners("exit");
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
				reject(new Error("文件夹选择对话框启动超时"));
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
				case "error":
					settle(() => reject(new Error("原生文件夹对话框失败：" + String(message.message ?? "unknown"))));
					return;
				default:
					return;
			}
		});
		worker.on("error", (error) => {
			settle(() => reject(error));
		});
		worker.on("exit", (code) => {
			settle(() => reject(new Error("文件夹选择对话框进程提前退出（exit " + String(code) + "）")));
		});
	});
}
