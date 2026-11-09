'use strict';

// `groupConsecutiveRows`（src/90_Utils.gs）は、入力順のまま連続した行だけを
// ひとまとまりにし、書込範囲を減らす。呼出側は startRow / endRow / rowWrites を
// そのまま A1 レンジと値の並びに使うため、まとめ方・順序・値の欠落の有無を確かめる。
module.exports = ({test, assert, gas}) => {
  const group = writes => gas.call('groupConsecutiveRows', [writes]);
  // vm の配列は Array.prototype が別世界なので、比較用に素の配列へ写す。
  const shape = groups => Array.from(groups, g => ({
    startRow: g.startRow,
    endRow: g.endRow,
    rows: Array.from(g.rowWrites, w => w.row !== undefined ? w.row : w.rowNumber)
  }));
  const isTypeError = pattern => error =>
    error && error.name === 'TypeError' && pattern.test(String(error.message));

  test('gotrial 1: consecutive rows become the smallest number of groups', () => {
    const groups = group([{row: 2}, {row: 3}, {row: 4}, {row: 7}, {row: 9}, {row: 10}]);
    assert.deepEqual(shape(groups), [
      {startRow: 2, endRow: 4, rows: [2, 3, 4]},
      {startRow: 7, endRow: 7, rows: [7]},
      {startRow: 9, endRow: 10, rows: [9, 10]}
    ]);
    // 隣り合う行は1つの範囲にまとめる（1行1リクエストに戻っていないこと）。
    assert.equal(groups[0].endRow - groups[0].startRow + 1, 3);
  });

  test('gotrial 2: gaps and out-of-order input are not merged', () => {
    const groups = group([{row: 5}, {row: 3}, {row: 4}, {row: 8}]);
    // 入力順を並べ替えず、直前の行の次に来たときだけつなげる。
    assert.deepEqual(shape(groups), [
      {startRow: 5, endRow: 5, rows: [5]},
      {startRow: 3, endRow: 4, rows: [3, 4]},
      {startRow: 8, endRow: 8, rows: [8]}
    ]);
  });

  test('gotrial 3: rowNumber is accepted the same way as row', () => {
    const groups = group([{rowNumber: 12}, {rowNumber: 13}, {row: 20}]);
    assert.deepEqual(shape(groups), [
      {startRow: 12, endRow: 13, rows: [12, 13]},
      {startRow: 20, endRow: 20, rows: [20]}
    ]);
  });

  test('gotrial 4: an empty list has no groups and a single row 1 is one group', () => {
    assert.deepEqual(shape(group([])), []);
    const groups = group([{row: 1}]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].startRow, 1);
    assert.equal(groups[0].endRow, 1);
    assert.equal(groups[0].rowWrites.length, 1);
    // 先頭行1と2も連続としてまとめる。
    assert.deepEqual(shape(group([{row: 1}, {row: 2}]))[0], {startRow: 1, endRow: 2, rows: [1, 2]});
  });

  test('gotrial 5: non-array input is rejected instead of silently returning', () => {
    for (const value of [null, undefined, {}, 'rows', 42]) {
      assert.throws(() => group(value), isTypeError(/requires an array/), String(value));
    }
  });

  test('gotrial 6: rows below 1 or non-integer rows are rejected', () => {
    const bad = [{row: 0}, {row: -1}, {row: 2.5}, {row: '3'}, {row: null}, {},
      {rowNumber: 0}, {rowNumber: '4'}, {rowNumber: 1.5}, null];
    for (const write of bad) {
      assert.throws(() => group([write]), isTypeError(/positive row or rowNumber/), JSON.stringify(write));
    }
    // 正しい書込の後ろに不正な行があっても、途中までの結果を返さない。
    assert.throws(() => group([{row: 2}, {row: 3}, {row: 0}]),
      isTypeError(/positive row or rowNumber/));
  });

  test('gotrial 7: each group keeps its writes in input order without mutating the array', () => {
    const writes = [
      {row: 2, values: {f: '架空取引先A'}},
      {row: 3, values: {f: '架空取引先B'}},
      {row: 6, values: {f: '架空取引先C'}}
    ];
    const groups = group(writes);
    assert.deepEqual(Array.from(groups[0].rowWrites, w => w.values.f), ['架空取引先A', '架空取引先B']);
    assert.deepEqual(Array.from(groups[1].rowWrites, w => w.values.f), ['架空取引先C']);
    // 値の参照がそのまま渡るので、呼出側は values を読み直さずに書ける。
    assert.equal(groups[0].rowWrites[0], writes[0]);
    assert.equal(groups[1].rowWrites[0], writes[2]);
    // 入力配列は並べ替えない（呼出側は元の順序で結果を返す）。
    assert.deepEqual(writes.map(w => w.row), [2, 3, 6]);
  });
};
