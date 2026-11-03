/**
 * 生成打赏二维码的内置数据模块（lib/reward-qr.js）
 * ---------------------------------------------------------------------------
 * 用法：node scripts/gen-reward-qr.js [图片路径]
 *   默认读项目根目录下的「打赏码.jpg」（兼容「打赏.jpg」）。
 *
 * 为什么要生成成代码而不是直接读图片：见 lib/reward-qr.js 顶部的说明——
 * 打赏收款码是「钱的去向」，做成磁盘文件就存在被替换成他人收款码的风险。
 * 换成新收款码时跑一次本脚本，然后 git diff 就能看到二维码确实变了（改动留痕）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CANDIDATES = ['打赏码.jpg', '打赏.jpg', '打赏码.png', '打赏.png'];

function pickFile(arg) {
  if (arg) {
    const p = path.isAbsolute(arg) ? arg : path.join(ROOT, arg);
    if (!fs.existsSync(p)) throw new Error('找不到图片：' + p);
    return p;
  }
  for (const name of CANDIDATES) {
    const p = path.join(ROOT, name);
    if (fs.existsSync(p)) return p;
  }
  throw new Error('项目根目录下没找到打赏二维码图片，可选文件名：' + CANDIDATES.join(' / '));
}

// 只读 JPEG/PNG 的宽高，用于在注释里标注尺寸（顺带校验图片没坏）
function imageSize(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) {           // PNG：IHDR 固定在第 16 字节起
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), type: 'image/png' };
  }
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5), type: 'image/jpeg' };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return { w: 0, h: 0, type: 'image/jpeg' };
}

const file = pickFile(process.argv[2]);
const buf = fs.readFileSync(file);
const sha = crypto.createHash('sha256').update(buf).digest('hex');
const { w, h, type } = imageSize(buf);
const b64 = buf.toString('base64');

// 每行 100 字符折行：单行十几万字符会让编辑器卡顿、git diff 变成一整行
const lines = [];
for (let i = 0; i < b64.length; i += 100) lines.push(b64.slice(i, i + 100));

const body = lines.map((l) => "  '" + l + "'").join(',\n');

const out = `/**
 * 打赏二维码 · 内置图片数据（自动生成，勿手改）
 * 生成命令：node scripts/gen-reward-qr.js
 * ---------------------------------------------------------------------------
 * 为什么把图片字节写死在代码里，而不是运行时读磁盘上的 jpg：
 *   打赏收款码是「钱的去向」。如果做成读取磁盘文件（public/ 里的静态图片或根目录的 jpg），
 *   任何能碰到这台机器文件的人——装机、远程协助、顺手拷文件的人——只要把那张 jpg
 *   换成自己的收款码，顾客扫码打赏的钱就进了他的口袋，而且界面上看不出任何异常。
 *   写死在源码里之后，磁盘上的图片被替换不影响展示的收款码；要改就必须改代码，
 *   而代码在 git 里，一改 git status 立刻现形。
 *
 * 校验方式：服务启动时用 EXPECTED_SHA256 核对 DATA 解码后的字节，不一致就拒绝提供
 *   二维码并打日志报警——防止有人连这里的 base64 一起改掉。
 *   换新收款码 = 换图片 + 重跑生成脚本 + 提交，二维码的任何变化都会留在版本记录里。
 */
const crypto = require('crypto');

// 源文件名（仅作溯源记录，运行时不再读取该文件）
const SOURCE_FILE = ${JSON.stringify(path.basename(file))};

// 源图片字节的 SHA-256：DATA 解码后必须与之完全一致
const EXPECTED_SHA256 = '${sha}';

// 原始图片字节（base64），共 ${buf.length} 字节，${w}×${h}
const DATA = Buffer.from([
${body}
].join(''), 'base64');

// 运行时摘要：与 EXPECTED_SHA256 一致才对外提供
const DIGEST = crypto.createHash('sha256').update(DATA).digest('hex');

module.exports = { SOURCE_FILE, EXPECTED_SHA256, DIGEST, DATA, SIZE: DATA.length, MIME: '${type}', WIDTH: ${w}, HEIGHT: ${h} };
`;

fs.writeFileSync(path.join(ROOT, 'lib', 'reward-qr.js'), out);
console.log('[reward-qr] 源文件 ' + path.basename(file) + '（' + buf.length + ' 字节，' + w + '×' + h + '）');
console.log('[reward-qr] sha256 ' + sha);
console.log('[reward-qr] 已写入 lib/reward-qr.js（' + out.length + ' 字符）');
