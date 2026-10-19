/**
 * Standalone Win32 folder-dialog worker with INITIAL-FOLDER support.
 *
 * Derived from @deepseek-ai/dsh-host-directory-picker-native/lib/worker.cjs
 * (koffi COM: CoCreateInstance(FileOpenDialog) + IFileDialog vtable slots).
 * Additions:
 *   - env DSH_DIALOG_INITIAL_DIR: open the dialog AT this folder
 *     (shell32!SHCreateItemFromParsingName -> IFileDialog::SetFolder slot 12),
 *     released right after the call. Missing/unparsable folder is reported but
 *     does NOT fail the dialog (it opens at the OS default instead).
 *   - env DSH_DIALOG_TITLE optional; without it the dialog keeps the system's
 *     own (localized) title.
 *   - env DSH_KOFFI_PATH optional absolute path to koffi's index.cjs; otherwise
 *     koffi is resolved from the Electron installation next to process.execPath.
 *     Only koffi 3.x is accepted: the bindings rely on BigInt pointers.
 *
 * Protocol (IPC): {kind:'showing',initialFolder} then exactly one
 * {kind:'done',path} or {kind:'error',message,stack?}. The host shows only
 * `message`; `stack` goes to its log.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** The bindings below rely on koffi 3 (pointers are BigInt values). */
const REQUIRED_KOFFI_MAJOR = 3;

/** Where to look for koffi: explicit override, then the Electron install beside process.execPath, then bare. */
function koffiCandidates() {
	const candidates = [];
	if (process.env.DSH_KOFFI_PATH) candidates.push(process.env.DSH_KOFFI_PATH);
	const exeDir = path.dirname(process.execPath);
	candidates.push(path.join(exeDir, "resources", "app.asar.unpacked", "node_modules", "koffi", "index.cjs"));
	candidates.push(path.join(exeDir, "resources", "app.asar", "node_modules", "koffi", "index.cjs"));
	candidates.push("koffi");
	return candidates;
}

/**
 * Load the first candidate that is koffi 3.x. Another major version is skipped
 * like a missing one; when nothing fits, the error names every candidate's
 * problem (the host then falls back to DSH's own picker).
 */
function loadKoffi(candidates = koffiCandidates(), load = require) {
	const failures = [];
	for (const candidate of candidates) {
		let koffi;
		try {
			const loaded = load(candidate);
			koffi = loaded && (loaded.default ?? loaded);
		} catch (error) {
			failures.push(candidate + ": " + (error && error.code ? error.code : String(error).slice(0, 120)));
			continue;
		}
		const version = koffi && typeof koffi.version === "string" ? koffi.version : "unknown";
		if (Number.parseInt(version, 10) !== REQUIRED_KOFFI_MAJOR) {
			failures.push(candidate + ": koffi " + version + ", need " + REQUIRED_KOFFI_MAJOR + ".x");
			continue;
		}
		return koffi;
	}
	throw new Error("dialog-worker: no usable koffi " + REQUIRED_KOFFI_MAJOR + ".x; tried " + failures.join(" | "));
}

const COINIT_APARTMENTTHREADED = 2;
const CLSCTX_INPROC_SERVER = 1;
const SIGDN_FILESYSPATH = -2147123200;
const DPI_AWARENESS_CONTEXTS = [-4, -3, -2];
const VK_MENU = 18;
const KEYEVENTF_KEYUP = 2;
/* FILEOPENDIALOGOPTIONS (shobjidl_core.h). */
const FOS_NOCHANGEDIR = 0x8;
const FOS_PICKFOLDERS = 0x20;
const FOS_FORCEFILESYSTEM = 0x40;
const FOS_PATHMUSTEXIST = 0x800;
/** Added on top of the dialog's defaults (GetOptions first, as Microsoft recommends). */
const FOLDER_DIALOG_OPTIONS = FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR | FOS_PATHMUSTEXIST;
/** HRESULT_FROM_WIN32(ERROR_CANCELLED): the user closed the dialog without choosing. */
const HRESULT_CANCELLED = 0x800704c7 | 0;
/* IFileDialog vtable slots (IUnknown 0-2, IModalWindow::Show 3, IFileDialog 4+). */
const SLOT_RELEASE = 2;
const SLOT_SHOW = 3;
const SLOT_SET_OPTIONS = 9;
const SLOT_GET_OPTIONS = 10;
const SLOT_SET_FOLDER = 12;
const SLOT_SET_TITLE = 17;
const SLOT_GET_RESULT = 20;
/* IShellItem vtable slot for GetDisplayName. */
const SLOT_GET_DISPLAY_NAME = 5;

function guidBytes(text) {
	const match = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(text);
	const bytes = Buffer.alloc(16);
	bytes.writeUInt32LE(parseInt(match[1], 16), 0);
	bytes.writeUInt16LE(parseInt(match[2], 16), 4);
	bytes.writeUInt16LE(parseInt(match[3], 16), 6);
	Buffer.from(match[4] + match[5], "hex").copy(bytes, 8);
	return bytes;
}

const CLSID_FILE_OPEN_DIALOG = guidBytes("dc1c5a9c-e88a-4dde-a5a1-60f82a20aef7");
const IID_IFILE_OPEN_DIALOG = guidBytes("d57c7288-d4ad-4768-be02-9d969532d960");
const IID_ISHELL_ITEM = guidBytes("43826d1e-e718-42ee-bc55-a1e261c37bfe");

/* koffi registers named prototypes process-wide, so the bindings are built once. */
let bindingsCache = null;

function loadWin32DialogBindings() {
	if (bindingsCache === null) bindingsCache = createWin32DialogBindings();
	return bindingsCache;
}

function createWin32DialogBindings() {
	const koffi = loadKoffi();
	const ole32 = koffi.load("ole32.dll");
	const user32 = koffi.load("user32.dll");
	const shell32 = koffi.load("shell32.dll");
	const pointerSize = koffi.sizeof("void *");
	const coInitializeEx = ole32.func("__stdcall", "CoInitializeEx", "int32", ["void *", "uint32"]);
	const coUninitialize = ole32.func("__stdcall", "CoUninitialize", "void", []);
	const coCreateInstance = ole32.func("__stdcall", "CoCreateInstance", "int32", ["void *", "void *", "uint32", "void *", "void *"]);
	const coTaskMemFree = ole32.func("__stdcall", "CoTaskMemFree", "void", ["void *"]);
	const shCreateItemFromParsingName = shell32.func("__stdcall", "SHCreateItemFromParsingName", "int32", ["str16", "void *", "void *", "void *"]);
	const keybdEvent = user32.func("__stdcall", "keybd_event", "void", ["uint8", "uint8", "uint32", "uintptr"]);

	const protoShow = koffi.proto("int32 __stdcall DshDialogShow(void *self, void *owner)");
	const protoSetOptions = koffi.proto("int32 __stdcall DshDialogSetOptions(void *self, uint32 options)");
	const protoGetOptions = koffi.proto("int32 __stdcall DshDialogGetOptions(void *self, _Out_ uint32 *options)");
	const protoSetTitle = koffi.proto("int32 __stdcall DshDialogSetTitle(void *self, str16 title)");
	const protoSetFolder = koffi.proto("int32 __stdcall DshDialogSetFolder(void *self, void *item)");
	const protoGetResult = koffi.proto("int32 __stdcall DshDialogGetResult(void *self, _Out_ void **item)");
	const protoGetDisplayName = koffi.proto("int32 __stdcall DshItemGetDisplayName(void *self, int32 form, _Out_ void **name)");
	const protoRelease = koffi.proto("uint32 __stdcall DshComRelease(void *self)");

	const method = (self, slot, proto) => {
		const vtable = koffi.decode(self, "void *");
		const fn = koffi.decode(vtable, slot * pointerSize, "void *");
		return (...args) => koffi.call(fn, proto, self, ...args);
	};

	const displayPathOf = (item) => {
		const nameOut = [null];
		const gotName = method(item, SLOT_GET_DISPLAY_NAME, protoGetDisplayName)(SIGDN_FILESYSPATH, nameOut);
		if (gotName < 0) return { hr: gotName };
		try {
			// koffi 3: a NUL-terminated UTF-16 string straight from the pointer.
			return { hr: gotName, path: koffi.decode(nameOut[0], "char16_t", -1) };
		} finally {
			coTaskMemFree(nameOut[0]);
		}
	};

	return {
		setThreadDpiAwareness: () => {
			let setContext;
			try {
				setContext = user32.func("__stdcall", "SetThreadDpiAwarenessContext", "void *", ["intptr"]);
			} catch {
				return;
			}
			for (const context of DPI_AWARENESS_CONTEXTS) if (setContext(context) !== null) return;
		},
		coInitializeSta: () => coInitializeEx(null, COINIT_APARTMENTTHREADED),
		coUninitialize: () => {
			coUninitialize();
		},
		pressAltForForeground: () => {
			keybdEvent(VK_MENU, 0, 0, 0);
			keybdEvent(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
		},
		displayPathOf,
		/** IShellItem for a filesystem path; caller must release it. */
		shellItemFromPath: (directory) => {
			const out = Buffer.alloc(pointerSize);
			const hr = shCreateItemFromParsingName(directory, null, IID_ISHELL_ITEM, out);
			if (hr < 0) return { hr };
			return { hr, item: koffi.decode(out, "void *") };
		},
		release: (self) => method(self, SLOT_RELEASE, protoRelease)(),
		createFolderDialog: () => {
			const out = Buffer.alloc(pointerSize);
			const created = coCreateInstance(CLSID_FILE_OPEN_DIALOG, null, CLSCTX_INPROC_SERVER, IID_IFILE_OPEN_DIALOG, out);
			if (created < 0) throw new Error("CoCreateInstance(FileOpenDialog) failed: HRESULT 0x" + (created >>> 0).toString(16));
			const dialog = koffi.decode(out, "void *");
			return {
				getOptions: () => {
					const options = [0];
					const hr = method(dialog, SLOT_GET_OPTIONS, protoGetOptions)(options);
					return { hr, options: options[0] };
				},
				setOptions: (options) => method(dialog, SLOT_SET_OPTIONS, protoSetOptions)(options),
				setTitle: (title) => method(dialog, SLOT_SET_TITLE, protoSetTitle)(title),
				setFolder: (item) => method(dialog, SLOT_SET_FOLDER, protoSetFolder)(item),
				show: (owner) => method(dialog, SLOT_SHOW, protoShow)(owner),
				resultPath: () => {
					const itemOut = [null];
					const gotItem = method(dialog, SLOT_GET_RESULT, protoGetResult)(itemOut);
					if (gotItem < 0) return { hr: gotItem };
					const item = itemOut[0];
					try {
						return displayPathOf(item);
					} finally {
						method(item, SLOT_RELEASE, protoRelease)();
					}
				},
				release: () => {
					method(dialog, SLOT_RELEASE, protoRelease)();
				}
			};
		}
	};
}

function check(hr, what) {
	if (hr < 0) throw new Error(what + " failed: HRESULT 0x" + (hr >>> 0).toString(16));
	return hr;
}

/**
 * Show the folder dialog. `onShowing(initialFolder)` runs right before the
 * blocking Show().
 * @returns {string | null} the chosen folder; null when cancelled.
 */
function runFolderDialog(bindings, { title, initialFolder }, onShowing) {
	bindings.setThreadDpiAwareness();
	check(bindings.coInitializeSta(), "CoInitializeEx");
	try {
		const dialog = bindings.createFolderDialog();
		try {
			const current = dialog.getOptions();
			check(current.hr, "GetOptions");
			check(dialog.setOptions((current.options | FOLDER_DIALOG_OPTIONS) >>> 0), "SetOptions");
			if (title) check(dialog.setTitle(title), "SetTitle");
			const folder = { requested: initialFolder ?? null, applied: false };
			if (initialFolder) {
				if (!fs.existsSync(initialFolder)) {
					folder.reason = "missing";
				} else {
					const resolved = bindings.shellItemFromPath(initialFolder);
					folder.itemHr = resolved.hr;
					if (resolved.hr < 0) {
						folder.reason = "SHCreateItemFromParsingName";
					} else {
						try {
							const display = bindings.displayPathOf(resolved.item);
							folder.resolvedHr = display.hr;
							folder.resolvedPath = display.path ?? null;
							const setHr = dialog.setFolder(resolved.item);
							folder.setFolderHr = setHr;
							folder.applied = setHr >= 0;
						} finally {
							bindings.release(resolved.item);
						}
					}
				}
			}
			onShowing(folder);
			bindings.pressAltForForeground();
			const shown = dialog.show(null);
			if (shown === HRESULT_CANCELLED) return null;
			check(shown, "Show");
			const result = dialog.resultPath();
			check(result.hr, "GetResult");
			return result.path;
		} finally {
			dialog.release();
		}
	} finally {
		bindings.coUninitialize();
	}
}

/* Messages after which the conversation is over (the worker then exits). */
const TERMINAL_KINDS = new Set(["done", "error"]);

/**
 * Build the message poster.
 *
 * Only terminal messages end the conversation. "showing" is posted while the
 * dialog is still up: disconnecting after it would make the worker exit
 * mid-dialog (losing "done") as soon as anything yields to the event loop
 * before Show() returns.
 */
function createPost({ send, proc = process }) {
	return (message) => {
		send(message, () => {
			if (TERMINAL_KINDS.has(message.kind) && proc.connected) proc.disconnect();
		});
	};
}

/**
 * The terminal error message: the host shows `message` and only logs `stack`.
 */
function errorMessageOf(error) {
	if (!(error instanceof Error)) return { kind: "error", message: String(error) };
	const message = { kind: "error", message: error.message || String(error) };
	if (typeof error.stack === "string") message.stack = error.stack;
	return message;
}

function main() {
	if (typeof process.send !== "function") throw new Error("dialog-worker must be spawned with an IPC channel");
	const post = createPost({ send: process.send.bind(process) });
	process.on("disconnect", () => process.exit(0));
	const options = {
		title: (process.env.DSH_DIALOG_TITLE ?? "").trim(),
		initialFolder: (process.env.DSH_DIALOG_INITIAL_DIR ?? "").trim() || undefined
	};
	try {
		const chosen = runFolderDialog(loadWin32DialogBindings(), options, (initialFolder) => post({ kind: "showing", initialFolder }));
		post({ kind: "done", path: chosen });
	} catch (error) {
		post(errorMessageOf(error));
	}
}

/* Exported for tests; requiring this file does not open a dialog, spawning it does. */
module.exports = { HRESULT_CANCELLED, FOLDER_DIALOG_OPTIONS, createPost, errorMessageOf, loadKoffi, loadWin32DialogBindings, runFolderDialog };

if (require.main === module) main();
