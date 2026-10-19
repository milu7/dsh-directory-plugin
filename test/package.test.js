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
