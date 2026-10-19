import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const SOURCE = fs.readFileSync(new URL("../client/client.js", import.meta.url), "utf8");
const CONFIG = "/dsh-directory-plugin/config";
const PICK = "/dsh-directory-plugin/pick";

function findAll(node, predicate, found = []) {
	if (node === null || typeof node !== "object") return found;
	if (predicate(node)) found.push(node);
	for (const child of node.children) findAll(child, predicate, found);
	return found;
}

const textOf = (node) => node.children.filter((child) => typeof child === "string").join("");
const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 在 vm 里加载浏览器 bundle，配一个刚好够设置页用的 React 替身。
 * t() 直接返回文案 key，方便断言。
 * @param {Record<string, unknown>} replies - "METHOD /path" → 响应 JSON。
 */
function mountSettingsPage(replies) {
	const hooks = [];
	let cursor = 0;
	let effects = [];
	const react = {
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
		useState(initial) {
			const index = cursor++;
			if (!(index in hooks)) hooks[index] = initial;
			const setState = (next) => {
				hooks[index] = typeof next === "function" ? next(hooks[index]) : next;
			};
			return [hooks[index], setState];
		},
		useEffect(effect, deps) {
			const index = cursor++;
			const previous = hooks[index];
			if (previous === undefined || deps.some((dep, i) => dep !== previous[i])) {
				hooks[index] = deps;
				effects.push(effect);
			}
		}
	};
	const fetch = async (url, init = {}) => {
		const key = (init.method ?? "GET") + " " + url;
		if (!(key in replies)) throw new Error("unexpected request " + key);
		return { ok: true, status: 200, text: async () => JSON.stringify(replies[key]) };
	};

	let definition = null;
	const loader = { load: (loaded) => (definition = loaded) };
	vm.runInNewContext(SOURCE, { window: { __ModuleLoader__: loader }, console, fetch }, { filename: "client.js" });
	const plugin = definition.factory((name) => {
		if (name !== "react") throw new Error("unexpected require " + name);
		return react;
	});

	const components = new Map();
	plugin.apply({
		locale: { bind: () => (key) => key, register: () => () => {} },
		effect: (setup) => setup(),
		slots: {
			inject(_name, callback) {
				const result = callback();
				if (result && typeof result.next === "function") Array.from(result);
				return () => {};
			},
			register(options, component) {
				components.set(options.id ?? options.name, component);
				return () => {};
			}
		}
	});
	const SettingsPage = components.get("directory-plugin");

	let tree = null;
	return {
		render() {
			cursor = 0;
			effects = [];
			tree = SettingsPage();
			for (const effect of effects) effect();
		},
		findAll: (predicate) => findAll(tree, predicate)
	};
}

/** 打开设置页 → 等配置读完 → 点「浏览…」→ 等选择结果，返回页面。 */
async function browseOnce(replies) {
	const page = mountSettingsPage(replies);
	page.render();
	await settle();
	page.render();
	const [browse] = page.findAll((node) => node.type === "button" && textOf(node) === "browse");
	browse.props.onClick();
	await settle();
	page.render();
	return page;
}

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
