import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** 目录下的所有文件：相对路径、正斜杠、排好序。 */
function filesUnder(directory) {
	return fs
		.readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, "/"))
		.sort();
}

test("vendor 只带运行时会加载的文件（koffi 的 C++ 源码、头文件、构建脚本都不带）", () => {
	// 加载链：koffi/index.cjs → src/koffi/index.cjs → src/static.cjs → @koromix/koffi-win32-x64 → koffi.node。
	// 升级 koffi 时按同样的链路重新挑文件，再更新这张清单；真正能不能用由 dialog-worker.test.js 里的冒烟测试把关。
	assert.deepEqual(filesUnder(path.join(ROOT, "vendor")), [
		"node_modules/@koromix/koffi-win32-x64/index.js",
		"node_modules/@koromix/koffi-win32-x64/package.json",
		"node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node",
		"node_modules/koffi/LICENSE.txt",
		"node_modules/koffi/index.cjs",
		"node_modules/koffi/package.json",
		"node_modules/koffi/src/koffi/index.cjs",
		"node_modules/koffi/src/koffi/src/static.cjs"
	]);
});

test("README 的示意图不超过 1760 宽（页面按 880 宽显示，两倍图就够清晰）", () => {
	const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
	const images = filesUnder(path.join(ROOT, "docs", "images"));
	assert.ok(images.length > 0);
	for (const name of images) {
		const png = fs.readFileSync(path.join(ROOT, "docs", "images", name));
		assert.equal(png.toString("latin1", 1, 4), "PNG", name);
		assert.ok(png.readUInt32BE(16) <= 1760, name + " 宽 " + png.readUInt32BE(16));
		assert.ok(readme.includes("docs/images/" + name), "README 没有用到 " + name);
	}
});

test("manifest 的入口、白名单与引擎范围齐全（打包与 CI 都依赖这些字段）", () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
	assert.match(manifest.version, /^\d+\.\d+\.\d+$/, "version 不是语义化版本");
	assert.equal(manifest.main, "lib/index.js");
	assert.equal(manifest.exports["."], "./lib/index.js");
	assert.equal(manifest.exports["./client"], "./client/client.js");
	for (const entry of ["lib", "client", "vendor", "cordis.patch.yml", "README.md", "LICENSE"]) {
		assert.ok(manifest.files.includes(entry), "files 里缺少 " + entry);
	}
	for (const entry of manifest.files.filter((name) => name !== "README.md" && name !== "LICENSE" && !name.endsWith(".yml"))) {
		assert.ok(fs.existsSync(path.join(ROOT, entry)), "files 里的 " + entry + " 不存在");
	}
	assert.ok(manifest.engines?.node, "缺少 engines.node");
	assert.ok(manifest.scripts?.pack, "缺少 npm run pack");
	assert.ok(fs.existsSync(path.join(ROOT, "scripts", "pack.mjs")), "打包脚本不存在");
	// README 用相对路径引用 docs/images：发布包不带它们就是死链。
	assert.ok(manifest.files.includes("docs/images"), "发布包需要带上 README 引用的图片");
	for (const image of filesUnder(path.join(ROOT, "docs", "images"))) {
		assert.ok(manifest.files.some((entry) => entry === "docs/images" || entry === "docs" || entry.startsWith("docs/")), "图片 " + image + " 不在发布白名单里");
	}
});

test("CHANGELOG 的第一条就是当前版本", () => {
	const changelog = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
	const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
	const first = /^##\s*\[?(\d+\.\d+\.\d+)\]?/m.exec(changelog);
	assert.ok(first, "CHANGELOG 里没有版本条目");
	assert.equal(first[1], version);
});

test("CI 在 Windows 上跑测试，并在打 tag 时打包发布", () => {
	const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
	assert.match(workflow, /windows-latest/);
	assert.match(workflow, /npm test/);
	assert.match(workflow, /scripts\/pack\.mjs/);
});
