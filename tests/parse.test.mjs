// 纯逻辑测试：PDF 行重建 + 文字层诊断（不依赖浏览器）
import { pdfItemsToLines, pdfTextQuality } from './_parse.mjs';

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, '\n     got :', JSON.stringify(got), '\n     want:', JSON.stringify(want)); }
}

/* item 构造器：WPS/OCR 文字层常见的「逐字一个 item」 */
const it = (str, x, y, size = 12, extra = {}) => ({
  str,
  transform: [size, 0, 0, size, x, y],
  width: str.length * size,
  height: size,
  ...extra
});

console.log('\n[1] 逐字 item + 基线抖动 1.5pt，应合成一整行');
{
  const chars = ['第', '一', '章', '　', '风', '起'];
  const items = chars.map((c, i) => it(c, 40 + i * 12, 700 + (i % 2 ? 1.5 : -1.5), 12));
  eq('同一行不被打散', pdfItemsToLines(items), ['第一章　风起']);
}

console.log('\n[2] 两行相距 14pt，应分成两行');
{
  const items = [
    it('第一行的正文内容', 40, 700, 12),
    it('第二行的正文内容', 40, 686, 12)
  ];
  eq('两行分离', pdfItemsToLines(items), ['第一行的正文内容', '第二行的正文内容']);
}

console.log('\n[3] 未映射字符（U+FFFD / 私用区）应被过滤');
{
  const items = [it('正常文字', 40, 700), it('\uFFFD\uE123乱码', 88, 700)];
  eq('过滤坏字符', pdfItemsToLines(items), ['正常文字乱码']);
}

console.log('\n[4] 页码行应被过滤，正文数字行保留');
{
  const items = [
    it('12', 300, 40),
    it('2024 年第三季度报告', 40, 700)
  ];
  eq('只过滤纯页码', pdfItemsToLines(items), ['2024 年第三季度报告']);
}

console.log('\n[5] width 缺失时不应算出负 gap（OCR 文字层常见）');
{
  const a = it('中文', 40, 700, 12); delete a.width;
  const b = it('继续', 64, 700, 12); delete b.width;
  eq('无 width 也能拼上', pdfItemsToLines([a, b]), ['中文继续']);
}

console.log('\n[6] 文字层诊断');
{
  const emptyPages = Array(10).fill('');
  const d1 = pdfTextQuality(emptyPages, 10, 0, 0);
  eq('全空页 → image', { scanned: d1.scanned, reason: d1.reason }, { scanned: true, reason: 'image' });

  const bad = Array(10).fill('书书书书书');
  const d2 = pdfTextQuality(bad, 10, 500, 200);
  eq('坏字符 40% → encoding', { scanned: d2.scanned, reason: d2.reason }, { scanned: true, reason: 'encoding' });

  const good = Array(10).fill('这是一段正常的中文正文，每页都有一百多个字，足够判断。'.repeat(5));
  const d3 = pdfTextQuality(good, 10, 1750, 0);
  eq('正常 PDF → 不拦', d3.scanned, false);

  const sparse = Array(10).fill('字');
  const d4 = pdfTextQuality(sparse, 10, 10, 0);
  // 每页仅 1 字时，实际更像「扫描件上只剩零星页眉字」，判 image 合理；
  // sparse 针对的是「有几百字但远低于正常密度」的情况。
  eq('每页 1 字 → image（视作无文字层）', { scanned: d4.scanned, reason: d4.reason }, { scanned: true, reason: 'image' });

  const thin = Array(10).fill('正文'.repeat(12));   // 每页 24 字，未低于 20 的空白线但密度极低
  const d5 = pdfTextQuality(thin, 10, 240, 0);
  eq('每页 24 字 → sparse', { scanned: d5.scanned, reason: d5.reason }, { scanned: true, reason: 'sparse' });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
