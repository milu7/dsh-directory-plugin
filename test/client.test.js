import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, test } from "node:test";
import vm from "node:vm";

const SOURCE = fs.readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
const CONFIG = "/dsh-directory-plugin/config";
const PICK = "/dsh-directory-plugin/pick";
const HOLES = ["conversation.hero.workspace.directoryFlow", "sidebar.workspaces.directoryFlow"];

function findAll(node, predicate, found = []) {
	if (node === null || typeof node !== "object") return found;
	if (predicate(node)) found.push(node);
	for (const child of node.children) findAll(child, predicate, found);
	return found;
}

const textOf = (node) => node.children.filter((child) => typeof child === "string").join("");
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** 非 200 的响应：replies 里写 reply(409, {...})。 */
class Reply {
	constructor(status, body) {
		this.status = status;
		this.body = body;
	}
}
const reply = (status, body) => new Reply(status, body);

/**
 * 刚好够这个插件用的 React 替身：每个挂载的组件有自己的 hooks，effect 在 render 之后同步执行。
 * 状态更新不会自动重渲染，测试里手动 render()。
 */
function createReact() {
	let fiber = null;
	const slot = () => {
		if (fiber === null) throw new Error("hook called outside render");
		return [fiber, fiber.cursor++];
	};
	const react = {
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
		useState(initial) {
			const [owner, index] = slot();
			if (!(index in owner.hooks)) owner.hooks[index] = initial;
			const setState = (next) => {
				owner.hooks[index] = typeof next === "function" ? next(owner.hooks[index]) : next;
			};
			return [owner.hooks[index], setState];
		},
		useRef(initial) {
			const [owner, index] = slot();
			if (!(index in owner.hooks)) owner.hooks[index] = { current: initial };
			return owner.hooks[index];
		},
		useEffect(effect, deps) {
			const [owner, index] = slot();
			const previous = owner.hooks[index];
			const changed = deps === undefined || previous === undefined || deps.some((dep, i) => dep !== previous.deps[i]);
			if (!changed) return;
			owner.pending.push(() => {
				previous?.cleanup?.();
				const cleanup = effect();
				owner.hooks[index] = { deps, cleanup: typeof cleanup === "function" ? cleanup : null };
			});
		}
	};
	function mount(Component) {
		const owner = { hooks: [], cursor: 0, pending: [], tree: null };
		return {
			render(props) {
				fiber = owner;
				owner.cursor = 0;
				owner.pending = [];
				try {
					owner.tree = Component(props);
				} finally {
					fiber = null;
				}
				for (const run of owner.pending) run();
			},
			findAll: (predicate) => findAll(owner.tree, predicate)
		};
	}
	return { react, mount };
}

/**
 * 在 vm 里加载浏览器 bundle 并 apply。t() 直接返回文案 key，方便断言。
 * @param {object} [options]
 * @param {Record<string, unknown>} [options.replies] - "METHOD /path" → 响应 JSON、reply(status, body)，或 (body) => 前两者（可以是 Promise）。
 * @param {string[]} [options.holes] - DSH 里实际存在的槽位，默认两个都在。
 * @param {Record<string, unknown>} [options.globals] - 额外的全局变量（比如内置 bridge）。
 * @param {(key: string) => string} [options.translate] - 替换 t()，默认原样返回 key。
 */
function loadPlugin({ replies = {}, holes = HOLES, globals = {}, translate = (key) => key } = {}) {
	const requests = [];
	const fetch = async (url, init = {}) => {
		const key = (init.method ?? "GET") + " " + url;
		const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
		requests.push({ key, body });
		if (!(key in replies)) throw new Error("unexpected request " + key);
		const answer = await (typeof replies[key] === "function" ? replies[key](body) : replies[key]);
		const { status, body: payload } = answer instanceof Reply ? answer : { status: 200, body: answer };
		return { ok: status >= 200 && status < 300, status, text: async () => (payload === undefined ? "" : JSON.stringify(payload)) };
	};

	const { react, mount } = createReact();
	let definition = null;
	const loader = { load: (loaded) => (definition = loaded) };
	vm.runInNewContext(SOURCE, { window: { __ModuleLoader__: loader }, console, fetch, ...globals }, { filename: "client.js" });
	const plugin = definition.factory((name) => {
		if (name !== "react") throw new Error("unexpected require " + name);
		return react;
	});

	const components = new Map();
	const registered = [];
	let dictionaries = null;
	plugin.apply({
		locale: { bind: () => translate, register: (_ns, dicts) => ((dictionaries = dicts), () => {}) },
		effect: (setup) => setup(),
		slots: {
			inject(name, callback) {
				if (!holes.includes(name) && name !== "settings.section") return () => {};
				const result = callback();
				if (result && typeof result.next === "function") Array.from(result); // 回调也可以是生成器
				return () => {};
			},
			register(options, component) {
				registered.push(options.name);
				components.set(options.id ?? options.name, component);
				return () => {};
			}
		}
	});
	return { components, registered, dictionaries, requests, mount };
}

/** 打开设置页 → 等配置读完，返回页面。 */
async function openSettings(replies, options = {}) {
	const plugin = loadPlugin({ ...options, replies });
	const page = plugin.mount(plugin.components.get("directory-plugin"));
	page.render();
	await settle();
	page.render();
	return Object.assign(page, { requests: plugin.requests });
}

const button = (page, key) => page.findAll((node) => node.type === "button" && textOf(node) === key)[0];

/** 打开设置页 → 点「浏览…」→ 等选择结果，返回页面。 */
async function browseOnce(replies, options = {}) {
	const page = await openSettings(replies, options);
	button(page, (options.translate ?? String)("browse")).props.onClick();
	await settle();
	page.render();
	return page;
}

/** 打开设置页 → 在输入框里填 value → 点「保存」→ 等结果，返回页面。 */
async function saveOnce(replies, value) {
	const page = await openSettings(replies);
	page.findAll((node) => node.type === "input")[0].props.onChange({ target: { value } });
	page.render();
	button(page, "save").props.onClick();
	await settle();
	page.render();
	return page;
}

const statusOf = (page) => textOf(page.findAll((node) => node.props.role === "status")[0]);

/** 挂上 directoryFlow，打开一次，收集回调。 */
async function openFlowOnce(options) {
	const plugin = loadPlugin(options);
	const flow = plugin.mount(plugin.components.get(HOLES[0]));
	const calls = [];
	flow.render({
		open: true,
		onPicked: (path) => calls.push(["picked", path]),
		onCancel: () => calls.push(["cancel"]),
		onError: (message) => calls.push(["error", message])
	});
	await settle();
	await settle();
	return { calls, requests: plugin.requests };
}

describe("设置页", () => {
	test("没配置目录时点「浏览…」，不会误报「配置的目录已不存在」", async () => {
		const page = await browseOnce({
			["GET " + CONFIG]: { directory: null },
			["POST " + PICK]: { path: "D:\\Picked", directory: null, initialFolder: { requested: null, applied: false } }
		});
		const [input] = page.findAll((node) => node.type === "input");
		assert.equal(input.props.value, "D:\\Picked");
		assert.equal(page.findAll((node) => textOf(node) === "fallbackHint").length, 0);
	});

	test("配置的目录确实打不开时，仍然提示已回退到系统默认位置", async () => {
		const page = await browseOnce({
			["GET " + CONFIG]: { directory: "D:\\Gone" },
			["POST " + PICK]: { path: null, directory: "D:\\Gone", initialFolder: { requested: "D:\\Gone", applied: false, reason: "missing" } }
		});
		assert.equal(page.findAll((node) => textOf(node) === "fallbackHint").length, 1);
	});

	test("占位符里的反斜杠只有一个（源码里写两个就够了）", () => {
		const { dictionaries } = loadPlugin();
		assert.equal(dictionaries.zh.placeholder, "例如 D:\\Projects");
		assert.equal(dictionaries.en.placeholder, "e.g. D:\\Projects");
	});

	test("输入框有无障碍名称，状态行是一直存在的 live region", async () => {
		const page = await browseOnce({
			["GET " + CONFIG]: { directory: "D:\\Gone" },
			["POST " + PICK]: { path: null, directory: "D:\\Gone", initialFolder: { requested: "D:\\Gone", applied: false } }
		});
		const [input] = page.findAll((node) => node.type === "input");
		assert.equal(input.props["aria-label"], "inputLabel");
		const [status] = page.findAll((node) => node.props.role === "status");
		assert.equal(status.props["aria-live"], "polite");
		assert.equal(textOf(status), "fallbackHint");
	});
});

describe("directoryFlow 槽位", () => {
	test("两个槽位各自注册：其中一个不存在时，另一个照样接管", () => {
		assert.deepEqual(loadPlugin().registered.filter((name) => HOLES.includes(name)), HOLES);
		assert.deepEqual(loadPlugin({ holes: [HOLES[1]] }).registered.filter((name) => HOLES.includes(name)), [HOLES[1]]);
		assert.deepEqual(loadPlugin({ holes: [HOLES[0]] }).registered.filter((name) => HOLES.includes(name)), [HOLES[0]]);
	});

	test("对话框开着时父组件换了回调，结果交给最新的回调", async () => {
		let release;
		const plugin = loadPlugin({
			replies: { ["POST " + PICK]: () => new Promise((resolve) => (release = resolve)) }
		});
		const flow = plugin.mount(plugin.components.get(HOLES[0]));
		const calls = [];
		flow.render({ open: true, onPicked: (path) => calls.push("stale " + path) });
		await settle();
		flow.render({ open: true, onPicked: (path) => calls.push("latest " + path) });

		release({ path: "D:\\Picked", directory: null, initialFolder: null });
		await settle();
		assert.deepEqual(calls, ["latest D:\\Picked"]);
		assert.equal(plugin.requests.length, 1, "换回调不应该重新弹框");
	});
});

describe("错误码与多语言", () => {
	test("保存失败时按错误码显示当前语言的文案，后面接上 detail", async () => {
		const page = await saveOnce(
			{
				["GET " + CONFIG]: { directory: null },
				["POST " + CONFIG]: reply(400, { code: "not-absolute", error: "Directory must be a fully qualified path", detail: "Projects" })
			},
			"Projects"
		);
		assert.equal(statusOf(page), "saveFailed" + "errNotAbsolute" + "Projects");
	});

	test("不认识的错误码，显示宿主给的说明", async () => {
		const page = await browseOnce({
			["GET " + CONFIG]: { directory: null },
			["POST " + PICK]: reply(403, { code: "cross-site", error: "Cross-site request refused" })
		});
		assert.equal(statusOf(page), "pickFailed" + "Cross-site request refused");
	});

	test("词典里的前缀自带分隔符：英文用半角冒号，不再硬编码全角「：」", () => {
		const { dictionaries } = loadPlugin();
		assert.equal(dictionaries.zh.saveFailed, "保存失败：");
		assert.equal(dictionaries.en.saveFailed, "Failed to save: ");
		assert.equal(dictionaries.en.errNotFound, "Folder not found: ");
		assert.doesNotMatch(SOURCE, /\+ "："/);
	});

	test("对话框标题按当前语言随 /pick 一起传给宿主", async () => {
		const translate = (key) => "<" + key + ">";
		const page = await browseOnce(
			{
				["GET " + CONFIG]: { directory: null },
				["POST " + PICK]: { path: null, directory: null, initialFolder: null }
			},
			{ translate }
		);
		assert.deepEqual(page.requests.at(-1), { key: "POST " + PICK, body: { purpose: "settings", title: "<dialogTitleSettings>" } });

		const flow = await openFlowOnce({ translate, replies: { ["POST " + PICK]: { path: null } } });
		assert.deepEqual(flow.requests[0].body, { purpose: "workspace", title: "<dialogTitleWorkspace>" });
	});

	test("词典没注册上（t 原样返回 key）时不传标题，让系统用自带的", async () => {
		const flow = await openFlowOnce({ replies: { ["POST " + PICK]: { path: null } } });
		assert.deepEqual(flow.requests[0].body, { purpose: "workspace" });
	});
});

describe("设置页的「浏览…」", () => {
	test("从输入框里还没保存的目录打开；选了别的目录后提示还没保存", async () => {
		const page = await openSettings({
			["GET " + CONFIG]: { directory: "D:\\Saved" },
			["POST " + PICK]: { path: "D:\\Typed\\Child", directory: "D:\\Saved", initialFolder: { requested: "D:\\Typed", applied: true } }
		});
		page.findAll((node) => node.type === "input")[0].props.onChange({ target: { value: "  D:\\Typed " } });
		page.render();
		button(page, "browse").props.onClick();
		await settle();
		page.render();

		assert.deepEqual(page.requests.at(-1).body, { purpose: "settings", initialDirectory: "D:\\Typed" });
		assert.equal(page.findAll((node) => node.type === "input")[0].props.value, "D:\\Typed\\Child");
		assert.equal(statusOf(page), "unsaved");
		assert.match(textOf(page.findAll((node) => textOf(node).startsWith("current"))[0]), /D:\\Saved$/);
	});

	test("选回已保存的目录：不提示「尚未保存」", async () => {
		const page = await browseOnce({
			["GET " + CONFIG]: { directory: "D:\\Saved" },
			["POST " + PICK]: { path: "D:\\Saved", directory: "D:\\Saved", initialFolder: { requested: "D:\\Saved", applied: true } }
		});
		assert.equal(statusOf(page), "");
	});

	test("新建工作区的对话框正开着：提示 busy", async () => {
		const page = await browseOnce({
			["GET " + CONFIG]: { directory: null },
			["POST " + PICK]: reply(409, { code: "busy", error: "Another folder dialog is already open (workspace)" })
		});
		assert.equal(statusOf(page), "pickFailed" + "errBusy");
	});
});

describe("不是 Windows 的宿主", () => {
	test("设置页只显示说明，不显示输入框和按钮", async () => {
		const page = await openSettings({ ["GET " + CONFIG]: { directory: null, supported: false } });
		assert.equal(page.findAll((node) => node.type === "input" || node.type === "button").length, 0);
		assert.equal(page.findAll((node) => textOf(node) === "unsupported").length, 1);
	});

	test("新建工作区直接用 DSH 自带的选择框，不报错", async () => {
		const { calls } = await openFlowOnce({
			replies: { ["POST " + PICK]: reply(501, { code: "unsupported", error: "Only Windows is supported" }) },
			globals: { __DSH_DIRECTORY_PICKER__: { pick: async () => "D:\\Bridge" } }
		});
		assert.deepEqual(calls, [["picked", "D:\\Bridge"]]);
	});
});

describe("directoryFlow 的结果与回退", () => {
	test("宿主选中了目录：交给 onPicked", async () => {
		const { calls } = await openFlowOnce({ replies: { ["POST " + PICK]: { path: "D:\Picked" } } });
		assert.deepEqual(calls, [["picked", "D:\Picked"]]);
	});

	test("宿主那边取消了：交给 onCancel，不再弹第二个框", async () => {
		let bridgeCalls = 0;
		const bridge = { pick: async () => (bridgeCalls++, "D:\Bridge") };
		const { calls } = await openFlowOnce({
			replies: { ["POST " + PICK]: { path: null } },
			globals: { __DSH_DIRECTORY_PICKER__: bridge }
		});
		assert.deepEqual(calls, [["cancel"]]);
		assert.equal(bridgeCalls, 0);
	});

	test("宿主对话框出错（500）：回退到 DSH 自带的选择框", async () => {
		const { calls } = await openFlowOnce({
			replies: { ["POST " + PICK]: reply(500, { code: "pick-failed", error: "Native folder dialog failed: boom", detail: "boom" }) },
			globals: { __DSH_DIRECTORY_PICKER__: { pick: async () => "D:\Bridge" } }
		});
		assert.deepEqual(calls, [["picked", "D:\Bridge"]]);
	});

	test("设置页的对话框正开着（409 busy）：报告给 onError，不再弹出 DSH 自带的框", async () => {
		let bridgeCalls = 0;
		const { calls } = await openFlowOnce({
			replies: { ["POST " + PICK]: reply(409, { code: "busy", error: "Another folder dialog is already open (settings)" }) },
			globals: { __DSH_DIRECTORY_PICKER__: { pick: async () => (bridgeCalls++, "D:\\Bridge") } }
		});
		assert.deepEqual(calls, [["error", "errBusy"]]);
		assert.equal(bridgeCalls, 0);
	});

	test("宿主和内置选择框都不可用：onError 收到翻译后的文案", async () => {
		const { calls } = await openFlowOnce({
			replies: { ["POST " + PICK]: reply(500, { code: "pick-failed", error: "Native folder dialog failed: boom", detail: "boom" }) }
		});
		assert.deepEqual(calls, [["error", "errPickFailed" + "boom"]]);
	});
});
