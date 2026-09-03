'use strict';
// samples/ の実xlsxから、実機の読取結果と同じ形の固定データを生成する。
//
//   node tools/gen-sample-fixtures.js samples test/fixtures/samples
//
// samples/ はリポジトリ管理外（顧客の実明細そのもの）。生成物だけを管理下に置き、
// 判定のテストはそちらを正とする。新しいサンプルを受け取ったら再生成し、
// test/phase6-real-samples.test.js の EXPECTED に期待値を追記すること。
//
// 実機の読取は getRange(1,1,rowCount,sheet.getMaxColumns()).getValues() ── すなわち
//   (a) 全行が同じ長さの矩形になる（末尾の空白は切り詰められない）
//   (b) 日付書式のセルは Date オブジェクトで返る
//   (c) 空セルは '' で返る
// この3点を再現しないと、テストが通っても実機で落ちる。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SAMPLES = process.argv[2];
const OUT = process.argv[3];

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let n = 0; n < count; n += 1) {
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    entries[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function decodeEntities(s) {
  return s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let text = '';
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(m[1]))) text += decodeEntities(t[1]);
    out.push(text);
  }
  return out;
}

const BUILTIN_DATE_IDS = [14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47];

/** 書式IDから「日付として表示されるか」を決める。Google変換後にDateになるのはこれ。 */
function parseStyles(xml) {
  if (!xml) return [];
  const custom = {};
  const numFmtRe = /<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"[^>]*\/>/g;
  let nm;
  while ((nm = numFmtRe.exec(xml))) custom[Number(nm[1])] = decodeEntities(nm[2]);

  const cellXfsMatch = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  if (!cellXfsMatch) return [];
  const xfs = [];
  const xfRe = /<xf[^>]*numFmtId="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g;
  let xm;
  while ((xm = xfRe.exec(cellXfsMatch[1]))) {
    const id = Number(xm[1]);
    let isDate = BUILTIN_DATE_IDS.indexOf(id) >= 0;
    if (!isDate && custom[id]) {
      // 書式コードに y/m/d が現れ、かつ通貨・桁区切り専用でないものを日付とみなす。
      const code = custom[id].replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '');
      isDate = /[ymd]/i.test(code) && !/^[#0.,\\¥$\s%-]*$/.test(code);
    }
    xfs.push(isDate);
  }
  return xfs;
}

function colToIndex(ref) {
  const letters = ref.replace(/\d+/g, '');
  let n = 0;
  for (let i = 0; i < letters.length; i += 1) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

/** Excelシリアル → ISO。1900起点、1900年うるう年バグぶんの-1日込み。 */
function serialToIso(serial) {
  const ms = Math.round((serial - 25569) * 86400000);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseSheet(xml, shared, dateStyles) {
  const rows = [];
  const rowRe = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>|<row[^>]*r="(\d+)"[^>]*\/>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const rowNum = Number(rm[1] || rm[3]);
    const body = rm[2] || '';
    const cells = [];
    const cellRe = /<c[^>]*r="([A-Z]+\d+)"([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(body))) {
      const idx = colToIndex(cm[1]);
      const attrs = cm[2] || '';
      const inner = cm[3] || '';
      const typeMatch = /t="([^"]+)"/.exec(attrs);
      const styleMatch = /s="(\d+)"/.exec(attrs);
      const type = typeMatch ? typeMatch[1] : 'n';
      const styled = styleMatch ? dateStyles[Number(styleMatch[1])] : false;
      let value = '';
      if (type === 'inlineStr') {
        let text = '';
        const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
        let t;
        while ((t = tRe.exec(inner))) text += decodeEntities(t[1]);
        value = text;
      } else {
        const vMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (vMatch) {
          const raw = decodeEntities(vMatch[1]);
          if (type === 's') value = shared[Number(raw)];
          else if (type === 'str' || type === 'e') value = raw;
          else if (styled && raw !== '' && Number(raw) > 0) value = {__date__: serialToIso(Number(raw))};
          else value = Number(raw);
        }
      }
      cells[idx] = value === undefined ? '' : value;
    }
    rows[rowNum - 1] = cells;
  }
  const height = rows.length;
  for (let i = 0; i < height; i += 1) if (!rows[i]) rows[i] = [];
  return rows;
}

function readXlsx(file) {
  const entries = readZip(fs.readFileSync(file));
  const shared = parseSharedStrings(entries['xl/sharedStrings.xml'] &&
    entries['xl/sharedStrings.xml'].toString('utf8'));
  const dateStyles = parseStyles(entries['xl/styles.xml'] &&
    entries['xl/styles.xml'].toString('utf8'));
  const wb = entries['xl/workbook.xml'].toString('utf8');
  const names = [];
  const nameRe = /<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"[^>]*\/?>/g;
  let nm;
  while ((nm = nameRe.exec(wb))) names.push({name: decodeEntities(nm[1]), rid: nm[2]});
  const rels = entries['xl/_rels/workbook.xml.rels'].toString('utf8');
  const relMap = {};
  const relRe = /<Relationship[^>]*Id="([^"]*)"[^>]*Target="([^"]*)"[^>]*\/>/g;
  let rl;
  while ((rl = relRe.exec(rels))) relMap[rl[1]] = rl[2].replace(/^\/?xl\//, '').replace(/^\//, '');
  return names.map((entry) => {
    const key = 'xl/' + relMap[entry.rid];
    const xml = entries[key] ? entries[key].toString('utf8') : '';
    return {name: entry.name, rows: parseSheet(xml, shared, dateStyles)};
  });
}

// 伏字化。samples/ はリポジトリ管理外だが、固定データは管理下に入るため。
// 文字列セル中の10桁以上の連数字（電力・通信の「お客様番号」など、顧客を
// 特定しうる識別子）は潰す。判定はヘッダー語と列の型で決まるので影響しない。
const REDACTIONS = [
  [/TOMO\s+NAKAI/gi, 'TEST USER'],
  [/[0-9]{10,}/g, '**********'],
  [/[０-９]{10,}/g, '＊＊＊＊＊＊＊＊＊＊']
];

function redact(value) {
  if (typeof value !== 'string') return value;
  return REDACTIONS.reduce((acc, pair) => acc.replace(pair[0], pair[1]), value);
}

/** 全行を同じ長さの矩形に揃える（実機の矩形読みと同じ）。 */
function rectangularize(rows) {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return rows.map((row) => {
    const out = [];
    for (let i = 0; i < width; i += 1) {
      const cell = row[i];
      out.push(cell === undefined || cell === null ? '' : redact(cell));
    }
    return out;
  });
}

const families = fs.readdirSync(SAMPLES).filter((name) =>
  fs.statSync(path.join(SAMPLES, name)).isDirectory());
fs.mkdirSync(OUT, {recursive: true});

const manifest = [];
families.forEach((family) => {
  fs.readdirSync(path.join(SAMPLES, family))
    .filter((name) => /\.xlsx$/i.test(name))
    .forEach((fileName) => {
      const sheets = readXlsx(path.join(SAMPLES, family, fileName)).map((sheet) => ({
        name: redact(sheet.name),
        rows: rectangularize(sheet.rows)
      }));
      const slug = (family + '__' + fileName.replace(/\.xlsx$/i, ''))
        .replace(/[\\/:*?"<>|\s]+/g, '_');
      fs.writeFileSync(path.join(OUT, slug + '.json'),
        JSON.stringify({family: family, fileName: fileName, fileType: 'xlsx', sheets: sheets}, null, 1));
      manifest.push(slug);
    });
});
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(manifest.sort(), null, 1));
console.log('wrote ' + manifest.length + ' fixtures');
