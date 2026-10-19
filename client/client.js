/**
 * 浏览器侧（client plane）：
 *  1) 接管「新建工作区」的两个 directoryFlow 槽位（priority -2，低于桌面端内置的 -1），
 *     把原生选择框换成「从默认目录开始」的那一个；失败时回退到内置 bridge。
 *  2) 在设置页注册自己的入口（输入框 / 浏览 / 保存 / 恢复默认）。
 */
window.__ModuleLoader__.load({
	id: "dsh-directory-plugin",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;

		var react = require("react");
		var h = react.createElement;

		var NS = "dshDirectoryPlugin";
		var BASE = "/dsh-directory-plugin";
		var HOLES = ["conversation.hero.workspace.directoryFlow", "sidebar.workspaces.directoryFlow"];
		var BRIDGE_GLOBAL = "__DSH_DIRECTORY_PICKER__";

		var zh = {
			nav: "新建工作区目录",
			title: "新建工作区：默认打开目录",
			hint: "设置后，每次「新建工作区」弹出的文件夹选择框都会从这个目录开始；具体子目录仍然由你自己选。留空则保持系统默认位置。",
			placeholder: "例如 D:\\\\Projects",
			browse: "浏览…",
			browsing: "已打开选择框…",
			save: "保存",
			saving: "保存中…",
			saved: "已保存",
			clear: "恢复系统默认",
			cleared: "已恢复系统默认位置",
			current: "当前生效：",
			none: "（未设置，使用系统默认位置）",
			loadFailed: "读取配置失败",
			saveFailed: "保存失败",
			pickFailed: "打开选择框失败",
			fallbackHint: "配置的目录已不存在或无法打开，选择框已回退到系统默认位置",
			invalid: "目录无效"
		};
		var en = {
			nav: "Workspace folder",
			title: "New workspace: starting folder",
			hint: "The folder chooser of \"new workspace\" will start in this directory. You still pick the exact subfolder yourself. Leave empty for the system default.",
			placeholder: "e.g. D:\\\\Projects",
			browse: "Browse…",
			browsing: "Chooser opened…",
			save: "Save",
			saving: "Saving…",
			saved: "Saved",
			clear: "Use system default",
			cleared: "System default restored",
			current: "Active: ",
			none: "(not set — system default)",
			loadFailed: "Failed to read settings",
			saveFailed: "Failed to save",
			pickFailed: "Failed to open the chooser",
			fallbackHint: "The configured folder is gone, so the chooser opened at the system default",
			invalid: "Invalid directory"
		};

		function messageOf(error) {
			if (error && typeof error.message === "string") return error.message;
			return String(error);
		}

		function requestJson(path, init) {
			var options = Object.assign(
				{
					credentials: "same-origin",
					cache: "no-store",
					headers: { "content-type": "application/json" }
				},
				init || {}
			);
			return fetch(BASE + path, options).then(function (response) {
				return response.text().then(function (text) {
					var data = null;
					try {
						data = text === "" ? null : JSON.parse(text);
					} catch {
						data = null;
					}
					if (!response.ok) {
						throw new Error((data && data.error) || "HTTP " + response.status);
					}
					return data || {};
				});
			});
		}

		/** 用宿主路由打开原生选择框。 */
		function pickViaHost() {
			return requestJson("/pick", { method: "POST", body: "{}" });
		}

		/** 回退：桌面端预加载的 __DSH_DIRECTORY_PICKER__（系统默认位置）。 */
		function pickViaBridge() {
			var bridge = globalThis[BRIDGE_GLOBAL];
			if (!bridge || typeof bridge.pick !== "function") {
				return Promise.reject(new Error("directory picker bridge is unavailable"));
			}
			return Promise.resolve(bridge.pick());
		}

		function applyInner(ctx) {
			var t = ctx.locale.bind(NS);

			try {
				ctx.effect(function () {
					return ctx.locale.register(NS, { zh: zh, en: en });
				}, "dsh-directory-plugin dictionaries");
			} catch (error) {
				console.warn("[dsh-directory-plugin] locale registration failed", error);
			}

			/**
			 * 接管 directoryFlow：open 时先走宿主对话框，失败再回退内置 bridge。
			 * 组件本身不渲染任何东西（与桌面端内置实现一致）。
			 */
			function DirectoryFlow(props) {
				var open = props && props.open;
				react.useEffect(
					function () {
						if (!open) return undefined;
						var alive = true;
						function picked(path) {
							if (!alive) return;
							if (typeof path === "string" && path !== "") {
								if (typeof props.onPicked === "function") props.onPicked(path);
							} else if (typeof props.onCancel === "function") props.onCancel();
						}
						function report(message) {
							if (!alive) return;
							if (typeof props.onError === "function") props.onError(message);
							else console.warn("[dsh-directory-plugin] " + message);
						}
						function fallback(reason) {
							pickViaBridge().then(picked, function () {
								report(messageOf(reason));
							});
						}
						pickViaHost().then(
							function (data) {
								if (!alive) return;
								if (data && typeof data.path === "string" && data.path !== "") picked(data.path);
								else if (data && data.error) fallback(data.error);
								else picked(null);
							},
							function (error) {
								if (!alive) return;
								fallback(error);
							}
						);
						return function () {
							alive = false;
						};
					},
					[open]
				);
				return null;
			}

			/** 设置页入口。 */
			function SettingsPage() {
				var pair = react.useState({ value: "", saved: null, status: "", tone: "muted", busy: false });
				var state = pair[0];
				var setState = pair[1];

				react.useEffect(function () {
					var alive = true;
					requestJson("/config", { method: "GET" }).then(
						function (data) {
							if (!alive) return;
							var directory = typeof data.directory === "string" ? data.directory : "";
							setState({ value: directory, saved: directory === "" ? null : directory, status: "", tone: "muted", busy: false });
						},
						function (error) {
							if (!alive) return;
							setState({ value: "", saved: null, status: t("loadFailed") + "：" + messageOf(error), tone: "error", busy: false });
						}
					);
					return function () {
						alive = false;
					};
				}, []);

				function update(patch) {
					setState(function (prev) {
						return Object.assign({}, prev, patch);
					});
				}

				function browse() {
					update({ busy: true, status: t("browsing"), tone: "muted" });
					pickViaHost().then(
						function (data) {
							if (data && data.error) {
								update({ busy: false, status: t("pickFailed") + "：" + data.error, tone: "error" });
								return;
							}
							var info = data && data.initialFolder;
							// 只有确实配置了起始目录、却没能用上时才算回退；没配置时 worker 报的是 requested: null。
							var fellBack = !!(info && info.requested && info.applied === false);
							var hint = fellBack ? t("fallbackHint") : "";
							if (data && typeof data.path === "string" && data.path !== "") update({ value: data.path, busy: false, status: hint, tone: fellBack ? "error" : "muted" });
							else update({ busy: false, status: hint, tone: fellBack ? "error" : "muted" });
						},
						function (error) {
							update({ busy: false, status: t("pickFailed") + "：" + messageOf(error), tone: "error" });
						}
					);
				}

				function save() {
					update({ busy: true, status: t("saving"), tone: "muted" });
					requestJson("/config", { method: "POST", body: JSON.stringify({ directory: state.value }) }).then(
						function (data) {
							var directory = data && typeof data.directory === "string" ? data.directory : "";
							setState({ value: directory, saved: directory === "" ? null : directory, status: t("saved"), tone: "ok", busy: false });
						},
						function (error) {
							update({ busy: false, status: t("saveFailed") + "：" + messageOf(error), tone: "error" });
						}
					);
				}

				function reset() {
					update({ busy: true, status: t("saving"), tone: "muted" });
					requestJson("/config", { method: "POST", body: JSON.stringify({ directory: "" }) }).then(
						function () {
							setState({ value: "", saved: null, status: t("cleared"), tone: "ok", busy: false });
						},
						function (error) {
							update({ busy: false, status: t("saveFailed") + "：" + messageOf(error), tone: "error" });
						}
					);
				}

				var buttonStyle = {
					cursor: state.busy ? "default" : "pointer",
					borderRadius: 8,
					border: "1px solid rgba(127,127,127,0.4)",
					background: "transparent",
					color: "inherit",
					fontFamily: "inherit",
					fontSize: 13,
					lineHeight: "20px",
					padding: "6px 14px",
					opacity: state.busy ? 0.5 : 1
				};
				var inputStyle = {
					flex: 1,
					minWidth: 240,
					borderRadius: 8,
					border: "1px solid rgba(127,127,127,0.4)",
					background: "transparent",
					color: "inherit",
					fontFamily: "inherit",
					fontSize: 13,
					lineHeight: "20px",
					padding: "6px 10px"
				};

				return h(
					"div",
					{ style: { display: "flex", flexDirection: "column", gap: 12, padding: "20px 8px", maxWidth: 720 } },
					h("h3", { style: { margin: 0, fontSize: 16, fontWeight: 600 } }, t("title")),
					h("p", { style: { margin: 0, opacity: 0.7, fontSize: 13, lineHeight: 1.6 } }, t("hint")),
					h(
						"div",
						{ style: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } },
						h("input", {
							type: "text",
							value: state.value,
							placeholder: t("placeholder"),
							spellCheck: false,
							style: inputStyle,
							onChange: function (event) {
								update({ value: event.target.value, status: "", tone: "muted" });
							}
						}),
						h("button", { type: "button", style: buttonStyle, disabled: state.busy, onClick: browse }, t("browse")),
						h("button", { type: "button", style: buttonStyle, disabled: state.busy, onClick: save }, t("save")),
						h("button", { type: "button", style: buttonStyle, disabled: state.busy, onClick: reset }, t("clear"))
					),
					h(
						"p",
						{ style: { margin: 0, fontSize: 12, lineHeight: 1.6, opacity: 0.7 } },
						t("current"),
						state.saved === null ? t("none") : state.saved
					),
					state.status === ""
						? null
						: h(
								"p",
								{
									style: {
										margin: 0,
										fontSize: 12,
										lineHeight: 1.6,
										color: state.tone === "error" ? "#e5484d" : state.tone === "ok" ? "#30a46c" : "inherit",
										opacity: state.tone === "muted" ? 0.7 : 1
									}
								},
								state.status
							)
				);
			}

			try {
				ctx.slots.inject(HOLES[0], function () {
					return ctx.slots.inject(HOLES[1], function* () {
						yield ctx.slots.register({ name: HOLES[0], priority: -2 }, DirectoryFlow);
						yield ctx.slots.register({ name: HOLES[1], priority: -2 }, DirectoryFlow);
					});
				});
			} catch (error) {
				console.warn("[dsh-directory-plugin] directory flow takeover failed", error);
			}

			try {
				ctx.slots.inject("settings.section", function () {
					return ctx.slots.register(
						{ name: "settings.section", id: "directory-plugin", order: 16, label: function () { return t("nav"); }, locale: NS },
						SettingsPage
					);
				});
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

		exports.name = "dsh-directory-plugin";
		exports.inject = ["slots", "locale"];
		exports.apply = apply;
		return module.exports;
	}
});
