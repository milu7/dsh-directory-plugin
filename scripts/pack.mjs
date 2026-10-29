#!/usr/bin/env node
/**
 * 按 package.json 的 "files" 白名单把插件打成可分发 zip。
 *
 * 与旧的手工流程相比，这个脚本：
 *  - 只认 manifest 里的白名单，vendor/ 裁剪与否由仓库状态决定，不会再打出「带 koffi 全套 C++ 源码」的旧包；
 *  - 写完立刻回读中央目录校验条目数与名称，坏包直接失败；
 *  - 输出 sha256，方便在 release 里附校验值。
 *
 * 用法：node scripts/pack.mjs --out dist/dsh-directory-plugin-1.1.0.zip
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

/** 脚本所在目录：默认把它的上一级（插件包根目录）当作要打包的目录。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

const SKIP_DIRS = new Set([".git", ".idea", ".vscode", "__pycache__", ".cache", "node_modules.bak"]);
const SKIP_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const SKIP_SUFFIXES = new Set([".log", ".tmp"]);

/* ---------------- zip writer ---------------- */

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c;
	}
	return table;
})();

/** CRC-32（zip 用）。 */
function crc32(buffer) {
	let crc = -1;
	for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ -1) >>> 0;
}

/** DOS 日期时间（1900 基准，2 秒精度）。 */
function dosDateTime(date) {
	const year = Math.max(date.getFullYear(), 1980);
	return {
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
		date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
	};
}

/**
 * 写一个 deflate 压缩的 zip。
 * @param {Array<{name: string, data: Buffer, mtime: Date}>} entries - 条目（按名称排序后写入）。
 * @returns {Buffer} 完整 zip 字节。
 */
function buildZip(entries) {
	const chunks = [];
	const central = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const raw = entry.data;
		const packed = zlib.deflateRawSync(raw, { level: 9 });
		const crc = crc32(raw);
		const { time, date } = dosDateTime(entry.mtime);

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0x0800, 6); // UTF-8 名称
		local.writeUInt16LE(8, 8); // deflate
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(date, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(packed.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		chunks.push(local, name, packed);

		const centralEntry = Buffer.alloc(46);
		centralEntry.writeUInt32LE(0x02014b50, 0);
		centralEntry.writeUInt16LE(20, 4); // version made by
		centralEntry.writeUInt16LE(20, 6); // version needed
		centralEntry.writeUInt16LE(0x0800, 8);
		centralEntry.writeUInt16LE(8, 10);
		centralEntry.writeUInt16LE(time, 12);
		centralEntry.writeUInt16LE(date, 14);
		centralEntry.writeUInt32LE(crc, 16);
		centralEntry.writeUInt32LE(packed.length, 20);
		centralEntry.writeUInt32LE(raw.length, 24);
		centralEntry.writeUInt16LE(name.length, 28);
		centralEntry.writeUInt16LE(0, 30); // extra
		centralEntry.writeUInt16LE(0, 32); // comment
		centralEntry.writeUInt16LE(0, 34); // disk start
		centralEntry.writeUInt16LE(0, 36); // internal attrs
		centralEntry.writeUInt32LE(0, 38); // external attrs
		centralEntry.writeUInt32LE(offset, 42);
		central.push(centralEntry, name);

		offset += local.length + name.length + packed.length;
	}

	const centralBuffer = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralBuffer.length, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20);
	return Buffer.concat([Buffer.concat(chunks), centralBuffer, eocd]);
}

/**
 * 回读中央目录，确认条目数与名称都写对了。
 * @param {Buffer} buffer - zip 字节。
 * @returns {string[]} 条目名。
 */
function readCentralDirectory(buffer) {
	const eocdAt = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	if (eocdAt < 0) throw new Error("no end-of-central-directory record");
	const count = buffer.readUInt16LE(eocdAt + 10);
	const size = buffer.readUInt32LE(eocdAt + 12);
	const start = buffer.readUInt32LE(eocdAt + 16);
	if (start + size > buffer.length) throw new Error("central directory points past end of file");
	const names = [];
	let cursor = start;
	for (let i = 0; i < count; i++) {
		if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("bad central directory entry at " + cursor);
		const nameLength = buffer.readUInt16LE(cursor + 28);
		const extraLength = buffer.readUInt16LE(cursor + 30);
		const commentLength = buffer.readUInt16LE(cursor + 32);
		names.push(buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength));
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	return names;
}

/* ---------------- 文件收集 ---------------- */

/**
 * 收集白名单里的文件。
 * @param {string} root - 插件根目录。
 * @param {string} entry - "files" 里的一项。
 * @returns {Array<{file: string, relative: string}>} 文件与相对路径。
 */
function collect(root, entry) {
	const target = path.join(root, entry);
	if (!fs.existsSync(target)) throw new Error("allowlisted path is missing: " + entry);
	const out = [];
	const walk = (dir) => {
		for (const dirent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (dirent.isDirectory()) {
				if (!SKIP_DIRS.has(dirent.name)) walk(path.join(dir, dirent.name));
				continue;
			}
			if (SKIP_FILES.has(dirent.name)) continue;
			if (SKIP_SUFFIXES.has(path.extname(dirent.name).toLowerCase())) continue;
			const file = path.join(dir, dirent.name);
			out.push({ file, relative: path.relative(root, file).split(path.sep).join("/") });
		}
	};
	if (fs.statSync(target).isDirectory()) walk(target);
	else out.push({ file: target, relative: entry });
	return out;
}

/* ---------------- main ---------------- */

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const index = args.indexOf("--" + name);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const root = path.resolve(argOf("root", path.join(HERE, "..")));
const manifestPath = path.join(root, "package.json");
if (!fs.existsSync(manifestPath)) {
	console.error("error: no package.json in " + root);
	process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const allowlist = Array.isArray(manifest.files) && manifest.files.length > 0 ? manifest.files : ["."];
const prefix = argOf("prefix", manifest.name);
const outPath = path.resolve(argOf("out", path.join(root, "dist", manifest.name + "-" + manifest.version + ".zip")));

const wanted = allowlist.includes("package.json") ? allowlist : ["package.json", ...allowlist];
const seen = new Map();
for (const entry of wanted) {
	for (const item of collect(root, entry)) {
		const name = prefix + "/" + item.relative;
		if (seen.has(name)) throw new Error("duplicate archive entry: " + name);
		seen.set(name, item.file);
	}
}

const entries = [...seen.entries()]
	.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	.map(([name, file]) => ({ name, data: fs.readFileSync(file), mtime: fs.statSync(file).mtime }));

const zip = buildZip(entries);
const names = readCentralDirectory(zip);
if (names.length !== entries.length) throw new Error("wrote " + entries.length + " entries but central directory has " + names.length);
if (!names.includes(prefix + "/package.json")) throw new Error("package.json is not at the archive root folder");
const leaks = names.filter((name) => name.includes("/.git/") || name.endsWith("/.gitignore"));
if (leaks.length > 0) throw new Error("VCS metadata leaked: " + leaks.slice(0, 3).join(", "));

fs.mkdirSync(path.dirname(outPath), { recursive: true });
const temp = outPath + ".tmp";
fs.writeFileSync(temp, zip);
fs.renameSync(temp, outPath);

const rawBytes = entries.reduce((sum, entry) => sum + entry.data.length, 0);
console.log(
	JSON.stringify(
		{
			archive: outPath,
			prefix,
			files: names.length,
			raw_bytes: rawBytes,
			zip_bytes: zip.length,
			sha256: createHash("sha256").update(zip).digest("hex"),
			samples: names.filter((name) => name.split("/").length <= 2).slice(0, 12)
		},
		null,
		2
	)
);
