/**
 * 浏览器侧（client plane）：
 *  1) 接管「新建工作区」的两个 directoryFlow 槽位（priority -2，低于桌面端内置的 -1），
 *     把原生选择框换成「从默认目录开始」的那一个；失败时回退到内置 bridge。
 *     接管前先 GET /config 预检：宿主不支持原生选择框、这次请求不是本机的、或者根本答不上来时，
 *     一个槽位都不碰，让 DSH 自带的选择器继续工作。
 *  2) 在设置页注册自己的入口（输入框 / 浏览 / 保存 / 恢复默认）。
 */
window.__ModuleLoader__.load({
	id: "dsh-directory-plugin",
	factory(require) {
		const react = require("react");
		const h = react.createElement;

		const NS = "dshDirectoryPlugin";
		const BASE = "/dsh-directory-plugin";
		const HOLES = ["conversation.hero.workspace.directoryFlow", "sidebar.workspaces.directoryFlow"];
		const BRIDGE_GLOBAL = "__DSH_DIRECTORY_PICKER__";
		/** 请求头：客户端发出 /pick 的时刻（毫秒）。宿主用它算出这次请求排了多久。 */
		const STARTED_AT_HEADER = "x-dsh-directory-plugin-started-at";
		/** 预检 GET /config 失败后重试的间隔（毫秒）：宿主刚重启时可能还答不上来。 */
		const PROBE_RETRY_MS = 800;
		/** 设置页输入框的长度上限：够放任何路径，又不会撞上宿主 64 KB 的请求体上限。 */
		const MAX_DIRECTORY_CHARS = 2048;

		const zh = {
			nav: "新建工作区目录",
			title: "新建工作区：默认打开目录",
			hint: "设置后，每次「新建工作区」弹出的文件夹选择框都会从这个目录开始；具体子目录仍然由你自己选。留空则保持系统默认位置。",
			inputLabel: "默认打开目录",
			placeholder: "例如 D:\\Projects",
			browse: "浏览…",
			browsing: "已打开选择框…",
			save: "保存",
			saving: "保存中…",
			saved: "已保存",
			clear: "恢复系统默认",
			cleared: "已恢复系统默认位置",
			current: "当前生效：",
			none: "（未设置，使用系统默认位置）",
			loadFailed: "读取配置失败：",
			saveFailed: "保存失败：",
			pickFailed: "打开选择框失败：",
			fallbackHint: "起始目录已不存在或无法打开，选择框已回退到系统默认位置",
			unsaved: "已选好，点「保存」后生效",
			unsupported: "目录插件只支持 Windows。在当前系统上，「新建工作区」会继续使用 DSH 自带的选择框。",
			dialogTitleWorkspace: "选择新工作区所在文件夹",
			dialogTitleSettings: "选择默认打开的目录",
			// 宿主返回的错误码对应的文案；后面直接接上 detail（路径、底层错误）。
			errNotString: "目录必须是文本",
			errEmpty: "目录不能为空",
			errNotAbsolute: "请填写完整的绝对路径（例如 D:\\Projects）：",
			errNotFound: "目录不存在：",
			errNotDirectory: "不是文件夹：",
			errSaveFailed: "写入配置文件失败：",
			errPickTimeout: "选择框启动超时",
			errPickExited: "选择框进程意外退出：",
			errPickFailed: "原生选择框出错：",
			errBusy: "已经有一个文件夹选择框开着，请先关掉它",
			errUnsupported: "只支持 Windows",
			errBodyTooLarge: "提交的内容超过了宿主允许的大小",
			errInternal: "插件内部出错了，详情见日志",
			errNotLocal: "原生选择框只在本机可用（当前页面不是从本机打开的）",
			missingHint: "当前目录不存在，下次会回退到系统默认位置",
			remoteHint: "当前页面不是从本机打开的：插件不会接管「新建工作区」，本页的「浏览…」也无法弹出选择框。"
		};
		const en = {
			nav: "Workspace folder",
			title: "New workspace: starting folder",
			hint: "The folder chooser of \"new workspace\" will start in this directory. You still pick the exact subfolder yourself. Leave empty for the system default.",
			inputLabel: "Default starting folder",
			placeholder: "e.g. D:\\Projects",
			browse: "Browse…",
			browsing: "Chooser opened…",
			save: "Save",
			saving: "Saving…",
			saved: "Saved",
			clear: "Use system default",
			cleared: "System default restored",
			current: "Active: ",
			none: "(not set — system default)",
			loadFailed: "Failed to read settings: ",
			saveFailed: "Failed to save: ",
			pickFailed: "Failed to open the chooser: ",
			fallbackHint: "The starting folder is gone or can't be opened, so the chooser opened at the system default",
			unsaved: "Selected. Click Save to apply it",
			unsupported: "This plugin only works on Windows. On this system, New Workspace keeps using DSH's built-in folder chooser.",
			dialogTitleWorkspace: "Choose a folder for the new workspace",
			dialogTitleSettings: "Choose the default starting folder",
			errNotString: "The folder must be text",
			errEmpty: "The folder is empty",
			errNotAbsolute: "Enter a full absolute path (e.g. D:\\Projects): ",
			errNotFound: "Folder not found: ",
			errNotDirectory: "Not a folder: ",
			errSaveFailed: "Could not write the settings file: ",
			errPickTimeout: "The folder chooser did not start in time",
			errPickExited: "The folder chooser process exited unexpectedly: ",
			errPickFailed: "The native folder chooser failed: ",
			errBusy: "Another folder chooser is already open. Close it first",
			errUnsupported: "Only available on Windows",
			errBodyTooLarge: "The request is larger than the Host allows",
			errInternal: "The plugin hit an internal error — see the log",
			errNotLocal: "The native chooser is only available on this machine (this page is not local)",
			missingHint: "This folder no longer exists. The next chooser will open at the system default position.",
			remoteHint: "This page is not opened from this machine: the plugin does not take over New Workspace here, and Browse… cannot open the native chooser."
		};

		/**
		 * 宿主错误码 → 文案 key。没列出来的（跨站、请求格式不对等）只会出在调用方写错时，直接显示英文说明。
		 * body-too-large / internal-error / not-local 宿主不带 detail，词典里的文案本身就是完整的句子。
		 */
		const ERROR_KEYS = {
			"not-a-string": "errNotString",
			empty: "errEmpty",
			"not-absolute": "errNotAbsolute",
			"not-found": "errNotFound",
			"not-a-directory": "errNotDirectory",
			"save-failed": "errSaveFailed",
			"pick-timeout": "errPickTimeout",
			"pick-exited": "errPickExited",
			"pick-failed": "errPickFailed",
			busy: "errBusy",
			unsupported: "errUnsupported",
			"body-too-large": "errBodyTooLarge",
			"internal-error": "errInternal",
			"not-local": "errNotLocal"
		};

		/* 设置页样式：放在组件外面，每次渲染复用同一批对象。 */
		const CONTROL_STYLE = {
			borderRadius: 8,
			border: "1px solid rgba(127,127,127,0.4)",
			background: "transparent",
			color: "inherit",
			fontFamily: "inherit",
			fontSize: 13,
			lineHeight: "20px"
		};
		const BUTTON_STYLE = { ...CONTROL_STYLE, cursor: "pointer", padding: "6px 14px", opacity: 1 };
		const BUSY_BUTTON_STYLE = { ...BUTTON_STYLE, cursor: "default", opacity: 0.5 };
		const INPUT_STYLE = { ...CONTROL_STYLE, flex: 1, minWidth: 240, padding: "6px 10px" };
		const PAGE_STYLE = { display: "flex", flexDirection: "column", gap: 12, padding: "20px 8px", maxWidth: 720 };
		const TITLE_STYLE = { margin: 0, fontSize: 16, fontWeight: 600 };
		const HINT_STYLE = { margin: 0, opacity: 0.7, fontSize: 13, lineHeight: 1.6 };
		const ROW_STYLE = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" };
		const CURRENT_STYLE = { margin: 0, fontSize: 12, lineHeight: 1.6, opacity: 0.7 };
		const STATUS_STYLES = {
			muted: { margin: 0, fontSize: 12, lineHeight: 1.6, color: "inherit", opacity: 0.7 },
			error: { margin: 0, fontSize: 12, lineHeight: 1.6, color: "#e5484d", opacity: 1 },
			ok: { margin: 0, fontSize: 12, lineHeight: 1.6, color: "#30a46c", opacity: 1 }
		};

		function messageOf(error) {
			if (typeof error?.message === "string") return error.message;
			return String(error);
		}

		async function requestJson(path, init) {
			const response = await fetch(BASE + path, {
				credentials: "same-origin",
				cache: "no-store",
				headers: { "content-type": "application/json" },
				...init
			});
			const text = await response.text();
			let data = null;
			try {
				data = text === "" ? null : JSON.parse(text);
			} catch {
				data = null;
			}
			if (!response.ok) {
				// 宿主的错误体是 { code, error, detail? }：code 用来选文案，error 是英文说明。
				const error = new Error(data?.error || "HTTP " + response.status);
				error.status = response.status;
				error.code = typeof data?.code === "string" ? data.code : null;
				error.detail = typeof data?.detail === "string" ? data.detail : null;
				throw error;
			}
			return data || {};
		}

		/**
		 * 用宿主路由打开原生选择框。
		 * 请求头带上发出时刻：宿主据此算出这次请求在网络上 / 宿主事件循环里排了多久（写进 timing 日志）。
		 * @param {{purpose: string, title?: string, initialDirectory?: string}} request - purpose：
		 *   "workspace" 或 "settings"；title 不给就用系统自带的；initialDirectory 不给就从已保存的目录开始。
		 */
		function pickViaHost(request) {
			return requestJson("/pick", {
				method: "POST",
				headers: { "content-type": "application/json", [STARTED_AT_HEADER]: String(Date.now()) },
				body: JSON.stringify(request)
			});
		}

		/** 回退：桌面端预加载的 __DSH_DIRECTORY_PICKER__（系统默认位置）。 */
		async function pickViaBridge() {
			const bridge = globalThis[BRIDGE_GLOBAL];
			if (typeof bridge?.pick !== "function") throw new Error("directory picker bridge is unavailable");
			return bridge.pick();
		}

		function applyInner(ctx) {
			const t = ctx.locale.bind(NS);

			try {
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-directory-plugin dictionaries");
			} catch (error) {
				console.warn("[dsh-directory-plugin] locale registration failed", error);
			}

			/** 错误的界面文案：认识的错误码按当前语言翻译并接上 detail，否则显示原始说明。 */
			function describe(error) {
				const key = error?.code ? ERROR_KEYS[error.code] : undefined;
				if (key === undefined) return messageOf(error);
				return t(key) + (error.detail || "");
			}

			/** 当前语言的对话框标题；词典没注册上（t 原样返回 key）时交给系统默认标题。 */
			function dialogTitle(key) {
				const text = t(key);
				return typeof text === "string" && text !== "" && text !== key ? text : undefined;
			}

			/**
			 * 拿到一次选择结果：先走宿主对话框，失败再回退内置 bridge。
			 * busy（另一个用途的选择框正开着）和 not-local（不是本机请求）原样抛出：这时回退只会再弹出第二个框。
			 * 回退也失败时报宿主那个错误——它带着 code，界面能翻译成文案。
			 * @param {{purpose: string, title?: string}} request - 交给宿主 /pick 的请求。
			 * @returns {Promise<string | null>} 选中的路径；取消时 null。
			 */
			async function requestPick(request) {
				try {
					const data = await pickViaHost(request);
					return typeof data?.path === "string" && data.path !== "" ? data.path : null;
				} catch (error) {
					// busy：另一个用途的框正开着；not-local：这里不是本机，回退只会再弹一个（而且多半没有 bridge）。
					if (error?.code === "busy" || error?.code === "not-local") throw error;
					try {
						return await pickViaBridge();
					} catch {
						throw error;
					}
				}
			}

			/**
			 * 正在进行的选目录请求，按槽位名分桶。原生框是模态的，第二个框会让 DSH 主窗口一起禁用，
			 * 用户看到的就是「点了没反应」；所以同一个槽位同一时刻只允许一个，后到的直接搭它的结果。
			 * 两个槽位分开算：它们的占用者不同，搭车会把同一个路径交付两次（可能重复建工作区）。
			 * @type {Map<string, Promise<string | null>>}
			 */
			const inflight = new Map();

			/**
			 * 同一个槽位同一时刻只发起一次 pick：槽位重挂载会让同一个 open 请求再跑一遍。
			 * @param {string} hole - 槽位名（分桶键）。
			 * @param {() => Promise<string | null>} run - 真正的请求。
			 * @returns {Promise<string | null>} 选择结果。
			 */
			function pickOnce(hole, run) {
				const pending = inflight.get(hole);
				if (pending !== undefined) return pending;
				const promise = run().finally(() => {
					if (inflight.get(hole) === promise) inflight.delete(hole);
				});
				inflight.set(hole, promise);
				return promise;
			}

			/**
			 * 生成接管某个槽位的组件：open 时先走宿主对话框，失败再回退内置 bridge。
			 * 组件本身不渲染任何东西（与桌面端内置实现一致）；hole 只用来给 pickOnce 分桶。
			 * @param {string} hole - 槽位名。
			 * @returns {(props: {open?: boolean, onPicked?: Function, onCancel?: Function, onError?: Function}) => null} directoryFlow 组件。
			 */
			function createDirectoryFlow(hole) {
				return function DirectoryFlow(props) {
					const open = props?.open;
					// 下面的 effect 只随 open 重跑；对话框开着时父组件可能换了回调，结果要交给最新的那一份。
					const latest = react.useRef(props);
					react.useEffect(() => {
						latest.current = props;
					});
					// 一个 open 只处理一次：重渲染、回调整形、槽位被重新注入，都不该再弹第二个框。
					const armed = react.useRef(false);
					// 卸载之后不再交付结果：对话框没有中止手段，迟到的答案不该落到已经不存在的占用者上。
					const alive = react.useRef(true);
					react.useEffect(() => {
						alive.current = true;
						return () => {
							alive.current = false;
						};
					}, []);
					react.useEffect(() => {
						if (!open) {
							armed.current = false;
							return undefined;
						}
						if (armed.current) return undefined;
						armed.current = true;
						const settle = (path) => {
							if (!alive.current) return;
							const current = latest.current || {};
							if (typeof path === "string" && path !== "") {
								if (typeof current.onPicked === "function") current.onPicked(path);
							} else if (typeof current.onCancel === "function") current.onCancel();
						};
						const report = (message) => {
							if (!alive.current) return;
							const current = latest.current || {};
							if (typeof current.onError === "function") current.onError(message);
							else console.warn("[dsh-directory-plugin] " + message);
						};
						pickOnce(hole, () => requestPick({ purpose: "workspace", title: dialogTitle("dialogTitleWorkspace") }))
							.then(settle, (error) => report(describe(error)))
							.catch((error) => console.warn("[dsh-directory-plugin] directory flow failed", error));
						return undefined;
					}, [open]);
					return null;
				};
			}

			/** 等一会儿：预检失败后的重试间隔。 */
			function delay(ms) {
				return new Promise((resolve) => setTimeout(resolve, ms));
			}

			/**
			 * 接管前先问宿主：这个宿主能不能弹原生选择框（Windows）、这次请求是不是本机的。
			 * 失败重试一次——宿主刚重启时 /config 可能还答不上来。
			 * @returns {Promise<{supported: boolean, local: boolean} | null>} 取不到时 null。
			 */
			async function probeHost() {
				let failure = null;
				for (let attempt = 0; attempt < 2; attempt++) {
					if (attempt > 0) await delay(PROBE_RETRY_MS);
					try {
						const data = await requestJson("/config", { method: "GET" });
						return { supported: data?.supported !== false, local: data?.local !== false };
					} catch (error) {
						failure = error;
					}
				}
				console.warn("[dsh-directory-plugin] /config preflight failed, keeping DSH's built-in folder chooser", failure);
				return null;
			}

			/**
			 * 预检通过后再接管两个 directoryFlow 槽位（priority -2，压过桌面端内置的 -1）。
			 *
			 * 预检是异步的，注册只能延后：插件卸载（effect 的 disposer 先跑）之后才回来的结果直接丢弃，
			 * 不会在卸载后又往槽位里塞东西。返回的 disposer 同时回收已经装上的注册。
			 * @param {*} ctx - 客户端插件上下文。
			 * @returns {() => void} 卸载时回收布局的 disposer。
			 */
			function installDirectoryFlowTakeover(ctx) {
				let disposed = false;
				/** @type {Array<() => void>} */
				const disposers = [];
				(async () => {
					const host = await probeHost();
					// 卸载后才回来的结果：一个槽位都不注册，内置选择器继续工作。
					if (disposed) return;
					if (host === null || !host.supported || !host.local) {
						console.warn(
							"[dsh-directory-plugin] keeping DSH's built-in folder chooser: " +
								(host === null ? "the host did not answer GET /config" : host.supported ? "this request is not local" : "the host does not support the native chooser")
						);
						return;
					}
					// 两个槽位各自注册：DSH 哪天改名或删掉其中一个，另一个入口照样接管。
					for (const hole of HOLES) {
						try {
							const dispose = ctx.slots.inject(hole, () => ctx.slots.register({ name: hole, priority: -2 }, createDirectoryFlow(hole)));
							if (typeof dispose === "function") disposers.push(dispose);
						} catch (error) {
							console.warn("[dsh-directory-plugin] directory flow takeover failed: " + hole, error);
						}
					}
				})().catch((error) => {
					console.warn("[dsh-directory-plugin] directory flow takeover failed", error);
				});
				return () => {
					disposed = true;
					for (const dispose of disposers.splice(0)) {
						try {
							dispose?.();
						} catch (error) {
							console.warn("[dsh-directory-plugin] directory flow disposal failed", error);
						}
					}
				};
			}
			/** 设置页入口。 */
			function SettingsPage() {
				const [state, setState] = react.useState({ value: "", saved: null, status: "", tone: "muted", busy: false, supported: true, local: true, exists: null });
				const update = (patch) => setState((prev) => ({ ...prev, ...patch }));

				react.useEffect(() => {
					let alive = true;
					(async () => {
						let data;
						try {
							data = await requestJson("/config", { method: "GET" });
						} catch (error) {
							if (alive) update({ value: "", saved: null, status: t("loadFailed") + describe(error), tone: "error", busy: false });
							return;
						}
						if (!alive) return;
						const directory = typeof data.directory === "string" ? data.directory : "";
						update({
							value: directory,
							saved: directory === "" ? null : directory,
							status: "",
							tone: "muted",
							busy: false,
							supported: data.supported !== false,
							local: data.local !== false,
							exists: typeof data.exists === "boolean" ? data.exists : null
						});
					})();
					return () => {
						alive = false;
					};
				}, []);

				async function browse() {
					update({ busy: true, status: t("browsing"), tone: "muted" });
					// 从输入框里的当前值打开（可能还没保存）；输入框空着就从已保存的目录打开。
					const typed = state.value.trim();
					let data;
					try {
						data = await pickViaHost({ purpose: "settings", title: dialogTitle("dialogTitleSettings"), initialDirectory: typed === "" ? undefined : typed });
					} catch (error) {
						update({ busy: false, status: t("pickFailed") + describe(error), tone: "error" });
						return;
					}
					const info = data?.initialFolder;
					// 只有确实请求了起始目录、却没能用上时才算回退；没配置时 worker 报的是 requested: null。
					const fellBack = Boolean(info?.requested && info.applied === false);
					const path = typeof data?.path === "string" && data.path !== "" ? data.path : null;
					setState((prev) => {
						if (path !== null && path !== prev.saved) return { ...prev, value: path, busy: false, status: t("unsaved"), tone: "muted" };
						return { ...prev, value: path ?? prev.value, busy: false, status: fellBack ? t("fallbackHint") : "", tone: fellBack ? "error" : "muted" };
					});
				}

				async function save() {
					update({ busy: true, status: t("saving"), tone: "muted" });
					let data;
					try {
						data = await requestJson("/config", { method: "POST", body: JSON.stringify({ directory: state.value }) });
					} catch (error) {
						update({ busy: false, status: t("saveFailed") + describe(error), tone: "error" });
						return;
					}
					const directory = typeof data?.directory === "string" ? data.directory : "";
					update({ value: directory, saved: directory === "" ? null : directory, status: t("saved"), tone: "ok", busy: false, exists: directory === "" ? null : true });
				}

				async function reset() {
					update({ busy: true, status: t("saving"), tone: "muted" });
					try {
						await requestJson("/config", { method: "POST", body: JSON.stringify({ directory: "" }) });
					} catch (error) {
						update({ busy: false, status: t("saveFailed") + describe(error), tone: "error" });
						return;
					}
					update({ value: "", saved: null, status: t("cleared"), tone: "ok", busy: false, exists: null });
				}

				// 宿主不是 Windows：只说明情况，不显示用不了的输入框和按钮。
				if (!state.supported) {
					return h("div", { style: PAGE_STYLE }, h("h3", { style: TITLE_STYLE }, t("title")), h("p", { style: HINT_STYLE }, t("unsupported")));
				}

				const buttonStyle = state.busy ? BUSY_BUTTON_STYLE : BUTTON_STYLE;

				return h(
					"div",
					{ style: PAGE_STYLE },
					h("h3", { style: TITLE_STYLE }, t("title")),
					h("p", { style: HINT_STYLE }, t("hint")),
					// 宿主说已保存的目录不在了：提前说明下次会从系统默认位置开始，免得用户以为设置丢了。
					state.exists === false ? h("p", { style: STATUS_STYLES.error }, t("missingHint")) : null,
					// 不是本机打开的页面：说清楚插件在这里不接管，免得用户点了「浏览…」以为坏了。
					state.local === false ? h("p", { style: HINT_STYLE }, t("remoteHint")) : null,
					h(
						"div",
						{ style: ROW_STYLE },
						h("input", {
							type: "text",
							value: state.value,
							placeholder: t("placeholder"),
							"aria-label": t("inputLabel"),
							maxLength: MAX_DIRECTORY_CHARS,
							spellCheck: false,
							style: INPUT_STYLE,
							onChange: (event) => update({ value: event.target.value, status: "", tone: "muted" })
						}),
						h("button", { type: "button", style: buttonStyle, disabled: state.busy, onClick: browse }, t("browse")),
						h("button", { type: "button", style: buttonStyle, disabled: state.busy, onClick: save }, t("save")),
						h("button", { type: "button", style: buttonStyle, disabled: state.busy, onClick: reset }, t("clear"))
					),
					h("p", { style: CURRENT_STYLE }, t("current"), state.saved === null ? t("none") : state.saved),
					// 状态行一直挂在页面上（空着也在），读屏软件才会播报后来填进去的文字。
					h("p", { role: "status", "aria-live": "polite", style: STATUS_STYLES[state.tone] || STATUS_STYLES.muted }, state.status)
				);
			}

			// 接管放在 effect 里：预检是异步的，卸载后到达的结果必须作废（见 installDirectoryFlowTakeover）。
			try {
				ctx.effect(() => installDirectoryFlowTakeover(ctx), "dsh-directory-plugin directory flow takeover");
			} catch (error) {
				console.warn("[dsh-directory-plugin] directory flow takeover failed", error);
			}

			try {
				ctx.slots.inject("settings.section", () =>
					ctx.slots.register({ name: "settings.section", id: "directory-plugin", order: 16, label: () => t("nav"), locale: NS }, SettingsPage)
				);
			} catch (error) {
				console.warn("[dsh-directory-plugin] settings section registration failed", error);
			}
		}

		/** 任何异常都不允许冒泡到 GUI 引导流程（否则可能白屏）。 */
		function apply(ctx) {
			try {
				applyInner(ctx);
			} catch (error) {
				console.warn("[dsh-directory-plugin] client plugin failed to apply", error);
			}
		}

		return { name: "dsh-directory-plugin", inject: ["slots", "locale"], apply };
	}
});
