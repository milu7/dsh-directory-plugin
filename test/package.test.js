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
