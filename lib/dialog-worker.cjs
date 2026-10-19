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
 *   - env DSH_DIALOG_TITLE optional (defaults to "Select Workspace Directory").
 *   - env DSH_KOFFI_PATH optional absolute path to koffi's index.cjs; otherwise
 *     koffi is resolved from the Electron installation next to process.execPath.
 *
 * Protocol (unchanged): {kind:'showing',threadId,initialFolder?} then exactly
 * one {kind:'done',path} or {kind:'error',message}.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** Load koffi: explicit override, then the Electron install beside process.execPath, then bare. */
function loadKoffi() {
	const candidates = [];
	if (process.env.DSH_KOFFI_PATH) candidates.push(process.env.DSH_KOFFI_PATH);
	const exeDir = path.dirname(process.execPath);
	candidates.push(path.join(exeDir, "resources", "app.asar.unpacked", "node_modules", "koffi", "index.cjs"));
	candidates.push(path.join(exeDir, "resources", "app.asar", "node_modules", "koffi", "index.cjs"));
	candidates.push("koffi");
	const failures = [];
	for (const candidate of candidates) {
		try {
			const loaded = require(candidate);
			return loaded.default ?? loaded;
		} catch (error) {
			failures.push(candidate + ": " + (error && error.code ? error.code : String(error).slice(0, 120)));
		}
	}
	throw new Error("dialog-worker: koffi could not be loaded; tried " + failures.join(" | "));
}

function readUtf16(koffi, address, pointerSize) {
	const pointer = Buffer.alloc(8);
	pointer.writeBigUInt64LE(BigInt(address));
	return koffi.decode(pointer.subarray(0, pointerSize), "str16");
}

const COINIT_APARTMENTTHREADED = 2;
const CLSCTX_INPROC_SERVER = 1;
const SIGDN_FILESYSPATH = -2147123200;
const DPI_AWARENESS_CONTEXTS = [-4, -3, -2];
const VK_MENU = 18;
const KEYEVENTF_KEYUP = 2;
/* IFileDialog vtable slots (IUnknown 0-2, IModalWindow::Show 3, IFileDialog 4+). */
const SLOT_RELEASE = 2;
const SLOT_SHOW = 3;
const SLOT_SET_OPTIONS = 9;
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

async function loadWin32DialogBindings() {
	const koffi = loadKoffi();
	const ole32 = koffi.load("ole32.dll");
	const user32 = koffi.load("user32.dll");
	const shell32 = koffi.load("shell32.dll");
	const kernel32 = koffi.load("kernel32.dll");
	const pointerSize = koffi.sizeof("void *");
	const coInitializeEx = ole32.func("__stdcall", "CoInitializeEx", "int32", ["void *", "uint32"]);
	const coUninitialize = ole32.func("__stdcall", "CoUninitialize", "void", []);
	const coCreateInstance = ole32.func("__stdcall", "CoCreateInstance", "int32", ["void *", "void *", "uint32", "void *", "void *"]);
	const coTaskMemFree = ole32.func("__stdcall", "CoTaskMemFree", "void", ["void *"]);
	const shCreateItemFromParsingName = shell32.func("__stdcall", "SHCreateItemFromParsingName", "int32", ["str16", "void *", "void *", "void *"]);
	const getCurrentThreadId = kernel32.func("__stdcall", "GetCurrentThreadId", "uint32", []);
	const keybdEvent = user32.func("__stdcall", "keybd_event", "void", ["uint8", "uint8", "uint32", "uintptr"]);

	const protoShow = koffi.proto("int32 __stdcall DshDialogShow(void *self, void *owner)");
	const protoSetOptions = koffi.proto("int32 __stdcall DshDialogSetOptions(void *self, uint32 options)");
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
			return { hr: gotName, path: readUtf16(koffi, nameOut[0], pointerSize) };
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
		currentThreadId: () => getCurrentThreadId(),
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
				setOptions: (options) => method(dialog, SLOT_SET_OPTIONS, protoSetOptions)(options),
				setTitle: (title) => method(dialog, SLOT_SET_TITLE, protoSetTitle)(title),
				setFolder: (item) => method(dialog, SLOT_SET_FOLDER, protoSetFolder)(item),
				show: () => method(dialog, SLOT_SHOW, protoShow)(null),
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

function runFolderDialog(bindings, title, initialFolder, onShowing) {
	bindings.setThreadDpiAwareness();
	check(bindings.coInitializeSta(), "CoInitializeEx");
	try {
		const dialog = bindings.createFolderDialog();
		try {
			check(dialog.setOptions(104), "SetOptions");
			check(dialog.setTitle(title), "SetTitle");
			let folder = { requested: initialFolder ?? null, applied: false };
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
			onShowing(bindings.currentThreadId(), folder);
			bindings.pressAltForForeground();
			const shown = dialog.show();
			if (shown === -2147023673) return null;
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
 * Transport: IPC when the parent gave us one, otherwise a JSON-lines file
 * (DSH_DIALOG_LOG). The file transport exists because some sandboxes forbid
 * creating the named pipe an "ipc" stdio channel needs ("spawn EPERM").
 *
 * Only terminal messages end the conversation. "showing" is posted while the
 * dialog is still up: disconnecting after it would make the worker exit
 * mid-dialog (losing "done") as soon as anything yields to the event loop
 * before Show() returns.
 */
function createPost({ send, logFile, proc = process }) {
	return (message) => {
		const terminal = TERMINAL_KINDS.has(message.kind);
		if (logFile !== "") {
			try {
				fs.appendFileSync(logFile, JSON.stringify(message) + "\n");
			} catch {
				/* logging is best effort; IPC/exit still carries the result */
			}
		}
		if (send === null) {
			if (terminal) setTimeout(() => proc.exit(message.kind === "error" ? 1 : 0), 50);
			return;
		}
		send(message, () => {
			if (terminal && proc.connected) proc.disconnect();
		});
	};
}

function main() {
	const title = (process.env.DSH_DIALOG_TITLE ?? "").trim() || "Select Workspace Directory";
	const initialFolder = (process.env.DSH_DIALOG_INITIAL_DIR ?? "").trim() || undefined;
	const logFile = (process.env.DSH_DIALOG_LOG ?? "").trim();
	const send = typeof process.send === "function" ? process.send.bind(process) : null;
	if (send === null && logFile === "") throw new Error("dialog-worker needs an IPC channel or DSH_DIALOG_LOG");
	const post = createPost({ send, logFile });
	if (send !== null) process.on("disconnect", () => process.exit(0));
	(async () => {
		try {
			post({
				kind: "done",
				path: runFolderDialog(
					await loadWin32DialogBindings(),
					title,
					initialFolder,
					(threadId, folder) => post({ kind: "showing", threadId, initialFolder: folder })
				)
			});
		} catch (error) {
			post({ kind: "error", message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
		}
	})();
}

/* Exported for tests; requiring this file does not open a dialog, spawning it does. */
module.exports = { createPost, runFolderDialog };

if (require.main === module) main();
