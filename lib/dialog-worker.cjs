/**
 * Standalone Win32 folder-dialog worker with INITIAL-FOLDER support.
 *
 * Derived from @deepseek-ai/dsh-host-directory-picker-native/lib/worker.cjs
 * (koffi COM: CoCreateInstance(FileOpenDialog) + IFileDialog vtable slots).
 * Additions:
 *   - env DSH_DIALOG_INITIAL_DIR: open the dialog AT this folder
 *     (shell32!SHCreateItemFromParsingName -> IFileDialog::SetFolder slot 12),
 *     released right after the call. A folder that cannot be applied is reported
 *     but does NOT fail the dialog (it opens at the OS default instead).
 *   - env DSH_DIALOG_INITIAL_STATE (dir|missing|not-dir|unknown|none): the result
 *     of the host's own async stat of that folder. Diagnostics only: the worker
 *     never touches the disk itself, so a stale or absent value only changes the
 *     `reason` it reports, never whether SetFolder is attempted.
 *   - env DSH_DIALOG_TITLE optional; without it the dialog keeps the system's
 *     own (localized) title. A SetTitle failure is a diagnostic, not fatal.
 *   - env DSH_KOFFI_PATH optional absolute path to koffi's index.cjs; otherwise
 *     koffi is resolved from the copy vendored with the plugin, then from the
 *     Electron installation next to process.execPath, then bare. A native module
 *     cannot be dlopen'ed from app.asar, so asar paths are not candidates.
 *     Only koffi 3.x is accepted: the bindings rely on BigInt pointers.
 *   - Owner window: when the foreground window belongs to DSH itself (the same
 *     exe as this worker), the dialog is shown modal to it, so it opens in front
 *     of DSH, centered on it, and DSH cannot start a second dialog meanwhile.
 *     Any other foreground window means the user switched away: the dialog is
 *     then unowned and does not steal the foreground.
 *   - env DSH_DIALOG_REENABLE_OWNER=<hwnd>: repair mode. A worker that dies
 *     while its modal dialog is up leaves the owner disabled; the host then runs
 *     this to enable it again (only if it is still a disabled DSH window).
 *
 * Protocol (IPC): {kind:'showing',initialFolder,owner,koffi} then exactly one
 * {kind:'done',path} or {kind:'error',message,stack?}. `owner` is the owner
 * HWND as a decimal string, or null; `koffi` is the koffi entry that was
 * loaded. The host shows only `message`; `stack` goes to its log.
 * `initialFolder` carries the requested folder, the host's `state`, and what
 * happened when it was applied. A picked item without a filesystem path is an
 * error, never path:'' -- the host reads '' as "cancelled".
 */
"use strict";

const path = require("node:path");

/** The bindings below rely on koffi 3 (pointers are BigInt values). */
const REQUIRED_KOFFI_MAJOR = 3;

/**
 * Where to look for koffi: explicit override, the copy vendored with the plugin,
 * the Electron install beside process.execPath, then bare.
 * @returns {string[]} absolute paths (plus the bare module name), in try order.
 */
function koffiCandidates() {
	const candidates = [];
	if (process.env.DSH_KOFFI_PATH) candidates.push(process.env.DSH_KOFFI_PATH);
	// A native module cannot be dlopen'ed out of app.asar, so the vendored copy is
	// the DSH-side candidate and only unpacked paths are listed.
	candidates.push(path.join(__dirname, "..", "vendor", "node_modules", "koffi", "index.cjs"));
	const exeDir = path.dirname(process.execPath);
	candidates.push(path.join(exeDir, "resources", "app.asar.unpacked", "node_modules", "koffi", "index.cjs"));
	candidates.push("koffi");
	return candidates;
}

/**
 * Load the first candidate that is koffi 3.x. Another major version is skipped
 * like a missing one; when nothing fits, the error names every candidate's
 * problem (the host then falls back to DSH's own picker).
 * @returns {{koffi: object, source: string}} the module and the candidate it came from.
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
		return { koffi, source: candidate };
	}
	throw new Error("dialog-worker: no usable koffi " + REQUIRED_KOFFI_MAJOR + ".x; tried " + failures.join(" | "));
}

const COINIT_APARTMENTTHREADED = 2;
const CLSCTX_INPROC_SERVER = 1;
const SIGDN_FILESYSPATH = -2147123200;
const DPI_AWARENESS_CONTEXTS = [-4, -3, -2];
const GA_ROOTOWNER = 3;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
/** Longest Win32 path, in UTF-16 code units. */
const MAX_PATH_CHARS = 32768;
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

/** A COM pointer is null both as null/undefined and as the BigInt zero koffi hands back. */
function isNullPointer(pointer) {
	return pointer === null || pointer === undefined || pointer === 0 || pointer === 0n;
}

/**
 * Bind `name` only when the DLL exports it: the DPI entry points below need
 * Windows 10 1607+, and older systems have to keep working without them.
 * @returns {Function | null} the bound function, or null when it is unavailable.
 */
function optionalFunc(dll, name, result, args) {
	try {
		return dll.func("__stdcall", name, result, args);
	} catch {
		return null;
	}
}

/* koffi registers named prototypes process-wide, so the bindings are built once. */
let bindingsCache = null;

function loadWin32DialogBindings() {
	if (bindingsCache === null) bindingsCache = createWin32DialogBindings();
	return bindingsCache;
}

function createWin32DialogBindings() {
	const { koffi, source: koffiSource } = loadKoffi();
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
	const getForegroundWindow = user32.func("__stdcall", "GetForegroundWindow", "void *", []);
	const getAncestor = user32.func("__stdcall", "GetAncestor", "void *", ["void *", "uint32"]);
	const getWindowThreadProcessId = user32.func("__stdcall", "GetWindowThreadProcessId", "uint32", ["void *", "_Out_ uint32 *"]);
	const isWindow = user32.func("__stdcall", "IsWindow", "int", ["void *"]);
	const isWindowEnabled = user32.func("__stdcall", "IsWindowEnabled", "int", ["void *"]);
	const enableWindow = user32.func("__stdcall", "EnableWindow", "int", ["void *", "int"]);
	const openProcess = kernel32.func("__stdcall", "OpenProcess", "void *", ["uint32", "int", "uint32"]);
	const closeHandle = kernel32.func("__stdcall", "CloseHandle", "int", ["void *"]);
	const queryFullProcessImageName = kernel32.func("__stdcall", "QueryFullProcessImageNameW", "int", ["void *", "uint32", "_Out_ char16_t *", "_Inout_ uint32 *"]);
	/* DPI awareness (Windows 10 1607+): the bindings stay null where the system is older. */
	const getThreadDpiAwarenessContext = optionalFunc(user32, "GetThreadDpiAwarenessContext", "void *", []);
	const setThreadDpiAwarenessContext = optionalFunc(user32, "SetThreadDpiAwarenessContext", "void *", ["intptr"]);
	const areDpiAwarenessContextsEqual = optionalFunc(user32, "AreDpiAwarenessContextsEqual", "int", ["void *", "intptr"]);

	const protoShow = koffi.proto("int32 __stdcall DshDialogShow(void *self, void *owner)");
	const protoSetOptions = koffi.proto("int32 __stdcall DshDialogSetOptions(void *self, uint32 options)");
	const protoGetOptions = koffi.proto("int32 __stdcall DshDialogGetOptions(void *self, _Out_ uint32 *options)");
	const protoSetTitle = koffi.proto("int32 __stdcall DshDialogSetTitle(void *self, str16 title)");
	const protoSetFolder = koffi.proto("int32 __stdcall DshDialogSetFolder(void *self, void *item)");
	const protoGetResult = koffi.proto("int32 __stdcall DshDialogGetResult(void *self, _Out_ void **item)");
	const protoGetDisplayName = koffi.proto("int32 __stdcall DshItemGetDisplayName(void *self, int32 form, _Out_ void **name)");
	const protoRelease = koffi.proto("uint32 __stdcall DshComRelease(void *self)");

	/* Never decode address 0: a null COM pointer or vtable would crash the process. */
	const method = (self, slot, proto) => {
		if (isNullPointer(self)) throw new Error("dialog-worker: COM call on a null pointer (vtable slot " + slot + ")");
		const vtable = koffi.decode(self, "void *");
		if (isNullPointer(vtable)) throw new Error("dialog-worker: COM object has no vtable (slot " + slot + ")");
		const fn = koffi.decode(vtable, slot * pointerSize, "void *");
		if (isNullPointer(fn)) throw new Error("dialog-worker: COM vtable slot " + slot + " is empty");
		return (...args) => koffi.call(fn, proto, self, ...args);
	};

	const displayPathOf = (item) => {
		const nameOut = [null];
		const gotName = method(item, SLOT_GET_DISPLAY_NAME, protoGetDisplayName)(SIGDN_FILESYSPATH, nameOut);
		if (gotName < 0) return { hr: gotName };
		// A non-filesystem item (a virtual folder) may report success without a path.
		if (isNullPointer(nameOut[0])) return { hr: gotName, path: null };
		try {
			// koffi 3: a NUL-terminated UTF-16 string straight from the pointer.
			return { hr: gotName, path: koffi.decode(nameOut[0], "char16_t", -1) };
		} finally {
			coTaskMemFree(nameOut[0]);
		}
	};

	return {
		/** Which koffi candidate was loaded (the vendored copy, or DSH's own as a fallback). */
		koffiSource,
		/**
		 * Physical-pixel layout for the dialog. A thread that already is DPI-aware keeps
		 * its context: setting it again fails or reconfigures the host's own dialogs.
		 * DPI_AWARENESS_CONTEXT(-2/-3/-4) are pseudo-handles while the running context is
		 * a real handle, so they only compare through AreDpiAwarenessContextsEqual.
		 */
		setThreadDpiAwareness: () => {
			if (setThreadDpiAwarenessContext === null) return;
			if (getThreadDpiAwarenessContext !== null && areDpiAwarenessContextsEqual !== null) {
				const current = getThreadDpiAwarenessContext();
				if (!isNullPointer(current)) {
					for (const context of DPI_AWARENESS_CONTEXTS) {
						if (areDpiAwarenessContextsEqual(current, context) !== 0) return;
					}
				}
			}
			for (const context of DPI_AWARENESS_CONTEXTS) if (setThreadDpiAwarenessContext(context) !== null) return;
		},
		coInitializeSta: () => coInitializeEx(null, COINIT_APARTMENTTHREADED),
		coUninitialize: () => {
			coUninitialize();
		},
		/** The top-level window the user is working in (root owner of the foreground window), or null. */
		foregroundRootWindow: () => {
			const foreground = getForegroundWindow();
			if (!foreground) return null;
			return getAncestor(foreground, GA_ROOTOWNER) || foreground;
		},
		/** Full path of the exe that owns `window`, or null when it cannot be read. */
		processImageOfWindow: (window) => {
			const pid = [0];
			if (getWindowThreadProcessId(window, pid) === 0 || !pid[0]) return null;
			const handle = openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid[0]);
			if (!handle) return null;
			try {
				const buffer = Buffer.alloc(MAX_PATH_CHARS * 2);
				const length = [MAX_PATH_CHARS];
				if (!queryFullProcessImageName(handle, 0, buffer, length)) return null;
				return buffer.toString("utf16le", 0, length[0] * 2);
			} finally {
				closeHandle(handle);
			}
		},
		isWindow: (window) => isWindow(window) !== 0,
		isWindowEnabled: (window) => isWindowEnabled(window) !== 0,
		enableWindow: (window) => {
			enableWindow(window, 1);
		},
		displayPathOf,
		/** IShellItem for a filesystem path; caller must release it. */
		shellItemFromPath: (directory) => {
			const out = Buffer.alloc(pointerSize);
			const hr = shCreateItemFromParsingName(directory, null, IID_ISHELL_ITEM, out);
			if (hr < 0) return { hr };
			return { hr, item: koffi.decode(out, "void *") };
		},
		release: (self) => {
			if (isNullPointer(self)) throw new Error("dialog-worker: Release() on a null COM pointer");
			return method(self, SLOT_RELEASE, protoRelease)();
		},
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
				/**
				 * The chosen item's filesystem path. A failure names the stage that failed:
				 * GetResult (no IShellItem) or GetDisplayName (no filesystem path), so the
				 * host can tell "the dialog lost the result" from "it is not a folder".
				 */
				resultPath: () => {
					const itemOut = [null];
					const gotItem = method(dialog, SLOT_GET_RESULT, protoGetResult)(itemOut);
					if (gotItem < 0) return { hr: gotItem, stage: "GetResult" };
					if (isNullPointer(itemOut[0])) throw new Error("dialog-worker: GetResult returned a null IShellItem");
					try {
						const display = displayPathOf(itemOut[0]);
						if (display.hr < 0) return { hr: display.hr, stage: "GetDisplayName" };
						return { hr: display.hr, path: display.path };
					} finally {
						method(itemOut[0], SLOT_RELEASE, protoRelease)();
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

/** "D:\Projects\" and "D:\Projects" are one folder; a drive or UNC root keeps its own separator. */
function trimTrailingSeparators(value) {
	let text = value;
	for (;;) {
		if (text.length <= 1 || (!text.endsWith("\\") && !text.endsWith("/"))) return text;
		if (text === path.win32.parse(text).root) return text;
		text = text.slice(0, -1);
	}
}

/** Same folder? Windows paths compare case-insensitively and ignore trailing separators. */
function samePath(a, b) {
	return trimTrailingSeparators(path.win32.normalize(a)).toLowerCase() === trimTrailingSeparators(path.win32.normalize(b)).toLowerCase();
}

/**
 * The owner for the dialog: DSH's own foreground window, or null.
 *
 * Only a window of the DSH exe qualifies. Any other foreground window means the
 * user switched away after clicking; the dialog then stays unowned (it may open
 * behind, with a flashing taskbar button) instead of disabling someone else's
 * window or stealing the foreground.
 */
function dshOwnerWindow(bindings, dshExe) {
	if (!dshExe) return null;
	const window = bindings.foregroundRootWindow();
	if (!window) return null;
	const image = bindings.processImageOfWindow(window);
	return image !== null && samePath(image, dshExe) ? window : null;
}

/**
 * Repair mode: enable `ownerText` again if it is still a disabled DSH window
 * (a window handle can be reused, so check the exe once more).
 * @returns {boolean} whether EnableWindow was called.
 */
function reenableOwner(bindings, ownerText, dshExe) {
	if (!/^\d+$/.test(ownerText)) return false;
	const window = BigInt(ownerText);
	if (!bindings.isWindow(window) || bindings.isWindowEnabled(window)) return false;
	const image = bindings.processImageOfWindow(window);
	if (image === null || !samePath(image, dshExe)) return false;
	bindings.enableWindow(window);
	return true;
}

/** The DSH_DIALOG_INITIAL_STATE values that mean the host found a problem with the folder. */
const PROBLEM_INITIAL_STATES = new Set(["missing", "not-dir", "unknown"]);

/**
 * `initialFolder.state`: what the host's own stat said about the requested folder.
 * Diagnostics only. No folder requested is "none"; anything the host did not
 * send (an older host, a stale env) is reported as "unknown".
 * @returns {"none" | "dir" | "missing" | "not-dir" | "unknown"} the normalized state.
 */
function initialFolderState(requested, reported) {
	if (!requested) return "none";
	const state = String(reported ?? "").trim();
	return state === "dir" || PROBLEM_INITIAL_STATES.has(state) ? state : "unknown";
}

/** Why the requested folder could not be applied: the host's stat wins, else the Win32 stage. */
function unusableReason(state, fallback) {
	return PROBLEM_INITIAL_STATES.has(state) ? state : fallback;
}

/**
 * Apply the requested start folder to `dialog`, recording what happened on `folder`
 * for the host's log. Never throws: a folder that cannot be applied only costs the
 * dialog its start location. The attempt is unconditional -- the host's stat may be
 * stale, and a folder recreated in the meantime still works.
 */
function applyInitialFolder(bindings, dialog, folder, initialFolder) {
	const resolved = bindings.shellItemFromPath(initialFolder);
	folder.itemHr = resolved.hr;
	if (resolved.hr < 0) {
		folder.reason = unusableReason(folder.state, "SHCreateItemFromParsingName");
		return;
	}
	try {
		const display = bindings.displayPathOf(resolved.item);
		folder.resolvedHr = display.hr;
		folder.resolvedPath = display.path ?? null;
		const setHr = dialog.setFolder(resolved.item);
		folder.setFolderHr = setHr;
		if (display.hr < 0 || typeof display.path !== "string" || display.path === "") {
			folder.reason = unusableReason(folder.state, "not-filesystem");
			return;
		}
		if (setHr < 0) {
			folder.reason = unusableReason(folder.state, "SetFolder");
			return;
		}
		// SetFolder succeeding is not enough: the Shell may resolve the request to a
		// different folder (mapped drive, redirected legacy path), and the dialog would
		// then open somewhere the user did not configure.
		folder.applied = samePath(display.path, initialFolder);
		if (!folder.applied) folder.reason = unusableReason(folder.state, "resolved-elsewhere");
	} finally {
		bindings.release(resolved.item);
	}
}

/**
 * The picked folder, or an error that names the stage which failed: GetResult (no
 * IShellItem) or GetDisplayName (no filesystem path). An empty path is a failure,
 * never a cancel: the host reads path:'' as "the user cancelled".
 */
function checkedResultPath(result) {
	check(result.hr, result.stage ?? "GetResult");
	if (typeof result.path !== "string" || result.path === "") throw new Error("selected item has no filesystem path");
	return result.path;
}

/**
 * Show the folder dialog. `onShowing(initialFolder, owner)` runs right before
 * the blocking Show(); `owner` is the owner HWND as a decimal string or null.
 * @param {object} bindings - Win32 bindings, see createWin32DialogBindings.
 * @param {{title?: string, initialFolder?: string, initialState?: string, dshExe?: string}} options -
 *   title: the dialog title; initialFolder: the configured start folder;
 *   initialState: the host's DSH_DIALOG_INITIAL_STATE; dshExe: this app's exe.
 * @returns {string | null} the chosen folder; null when cancelled.
 */
function runFolderDialog(bindings, { title, initialFolder, initialState, dshExe }, onShowing) {
	bindings.setThreadDpiAwareness();
	check(bindings.coInitializeSta(), "CoInitializeEx");
	try {
		const dialog = bindings.createFolderDialog();
		try {
			const folder = { requested: initialFolder ?? null, applied: false, state: initialFolderState(initialFolder, initialState) };
			// Only SetOptions is fatal: the dialog has to open as the right kind of picker,
			// while an unreadable option set or a title the system rejects are cosmetics.
			const current = dialog.getOptions();
			if (current.hr < 0) folder.getOptionsHr = current.hr;
			const baseOptions = current.hr < 0 ? 0 : current.options;
			check(dialog.setOptions((baseOptions | FOLDER_DIALOG_OPTIONS) >>> 0), "SetOptions");
			if (title) {
				const titleHr = dialog.setTitle(title);
				if (titleHr < 0) folder.setTitleHr = titleHr;
			}
			if (initialFolder) applyInitialFolder(bindings, dialog, folder, initialFolder);
			const owner = dshOwnerWindow(bindings, dshExe);
			onShowing(folder, owner === null ? null : String(owner));
			const shown = dialog.show(owner);
			if (shown === HRESULT_CANCELLED) return null;
			check(shown, "Show");
			return checkedResultPath(dialog.resultPath());
		} finally {
			dialog.release();
		}
	} finally {
		bindings.coUninitialize();
	}
}

/* Messages after which the conversation is over (the worker then exits). */
const TERMINAL_KINDS = new Set(["done", "error"]);

/** The IPC channel closing under a send is the host leaving first; other failures are bugs. */
function isChannelClosed(error) {
	return error !== null && typeof error === "object" && (error.code === "ERR_IPC_CHANNEL_CLOSED" || error.code === "ERR_IPC_DISCONNECTED");
}

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
		try {
			send(message, () => {
				if (TERMINAL_KINDS.has(message.kind) && proc.connected) proc.disconnect();
			});
		} catch (error) {
			// The host may be gone already (timeout, cancelled pick): a closed channel just
			// means nobody is listening, and crashing here would only add stderr noise.
			if (proc.connected !== false && !isChannelClosed(error)) throw error;
		}
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
	const reenable = (process.env.DSH_DIALOG_REENABLE_OWNER ?? "").trim();
	if (reenable !== "") {
		reenableOwner(loadWin32DialogBindings(), reenable, process.execPath);
		return;
	}
	if (typeof process.send !== "function") throw new Error("dialog-worker must be spawned with an IPC channel");
	const post = createPost({ send: process.send.bind(process) });
	process.on("disconnect", () => process.exit(0));
	const options = {
		title: (process.env.DSH_DIALOG_TITLE ?? "").trim(),
		initialFolder: (process.env.DSH_DIALOG_INITIAL_DIR ?? "").trim() || undefined,
		// The host already stat'ed the folder before spawning us; this is log detail only.
		initialState: (process.env.DSH_DIALOG_INITIAL_STATE ?? "").trim(),
		// This worker runs on DSH's own exe, so a window of that exe is a DSH window.
		dshExe: process.execPath
	};
	try {
		const bindings = loadWin32DialogBindings();
		const chosen = runFolderDialog(bindings, options, (initialFolder, owner) => post({ kind: "showing", initialFolder, owner, koffi: bindings.koffiSource }));
		post({ kind: "done", path: chosen });
	} catch (error) {
		post(errorMessageOf(error));
	}
}

/* Exported for tests; requiring this file does not open a dialog, spawning it does. */
module.exports = { HRESULT_CANCELLED, FOLDER_DIALOG_OPTIONS, createPost, dshOwnerWindow, errorMessageOf, koffiCandidates, loadKoffi, loadWin32DialogBindings, reenableOwner, runFolderDialog };

if (require.main === module) main();
