/** 测试共用的小工具（不是测试文件：npm test 只跑 *.test.js）。 */

/**
 * 在这个用例里把 process.platform 换成 platform，用例结束后还原。
 * @param {import("node:test").TestContext} t - 当前用例。
 * @param {string} platform - 例如 "linux"。
 */
export function onPlatform(t, platform) {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { ...original, value: platform });
	t.after(() => Object.defineProperty(process, "platform", original));
}
