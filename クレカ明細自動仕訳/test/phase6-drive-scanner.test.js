'use strict';

/**
 * 4.8 DriveScanner。
 *
 * 要点：登録済み判定の根拠は恒久ファイルインデックスD列だけであること
 * （INV-05）、モード2が「未取得」と「不一致」を混同しないこと（INV-24）、
 * 一時的なDrive障害が3回まで再試行されること。
 */
module.exports = ({test, assert, gas}) => {
  const plain = (v) => JSON.parse(JSON.stringify(v));
  const blank = (n) => Array(n).fill('');
  const sheetHeader = (n, label) => { const r = blank(n); r[0] = label; return r; };

  function customerRow() {
    const row = blank(37);
    Object.assign(row, {
      0: 'C001', 1: '顧客A', 2: 'TRUE', 3: 'folder1', 5: 'dest1', 7: '入力用シート', 8: '取引先一覧',
      9: 2, 10: 6, 11: 9, 12: 11, 13: 13, 14: 30, 15: '1.0',
      16: 'reviewer@example.com', 17: 'admin@example.com', 18: 0, 20: 'システム情報', 21: 'ACTIVE',
      23: 0, 24: 0, 29: 1, 30: JSON.stringify({B: '利用日'}), 31: '{}', 32: '{}', 33: 30,
      34: '取引先一覧', 35: 'CORPORATE', 36: ''
    });
    return row;
  }

  function indexRow(overrides) {
    const row = blank(13);
    Object.assign(row, {
      0: overrides.fileId, 1: 'C001', 2: overrides.name || 'x.csv',
      3: overrides.state || 'COMPLETED', 4: overrides.binaryHash || 'h'.repeat(64),
      5: '', 6: '3', 7: overrides.revision || 'rev-1',
      8: overrides.modifiedTime || '', 10: '2026-08-01T00:00:00+09:00',
      11: '2026-08-01T00:00:00+09:00'
    });
    return row;
  }

  function setup(indexRows) {
    gas.stubs.reset();
    gas.stubs.createSpreadsheet('master', {sheets: [
      {name: '顧客マスター', values: [sheetHeader(37, '顧客ID'), customerRow()]},
      {name: '恒久ファイルインデックス', values: [sheetHeader(13, 'ファイルID')].concat(indexRows || [])}
    ]});
    gas.stubs.setActiveSpreadsheet('master');
  }

  const hourAgo = () => new Date(Date.now() - 3600 * 1000);
  const justNow = () => new Date(Date.now() - 60 * 1000);

  test('4.8 mode 1: filters by extension, index state, and settling time', () => {
    setup([
      indexRow({fileId: 'done1', state: 'COMPLETED'}),
      indexRow({fileId: 'redo1', state: 'DISCOVERED'})
    ]);
    gas.stubs.createFile('new1', {name: '202512.csv', bytes: Buffer.from('a'), lastUpdated: hourAgo(), createdTime: '2026-08-20T00:00:00Z'});
    gas.stubs.createFile('done1', {name: 'old.csv', bytes: Buffer.from('a'), lastUpdated: hourAgo(), createdTime: '2026-08-10T00:00:00Z'});
    gas.stubs.createFile('redo1', {name: 'redo.xlsx', bytes: Buffer.from('a'), lastUpdated: hourAgo(), createdTime: '2026-08-11T00:00:00Z'});
    gas.stubs.createFile('hot1', {name: 'uploading.csv', bytes: Buffer.from('a'), lastUpdated: justNow(), createdTime: '2026-08-21T00:00:00Z'});
    gas.stubs.createFile('memo1', {name: 'note.txt', bytes: Buffer.from('a'), lastUpdated: hourAgo(), createdTime: '2026-08-22T00:00:00Z'});
    gas.stubs.createFolder('folder1', {fileIds: ['new1', 'done1', 'redo1', 'hot1', 'memo1']});

    const candidates = plain(gas.call('scanUnprocessedFiles', ['C001']));
    assert.deepEqual(candidates.map((c) => c.fileId), ['redo1', 'new1'],
      'COMPLETED, too-recent, and non-csv/xlsx files are all out; order is createdTime asc');
    assert.equal(candidates[0].registered, true);
    assert.equal(candidates[1].registered, false);
  });

  test('4.8: subfolders are searched recursively and paging is followed', () => {
    setup([]);
    const fileIds = [];
    for (let i = 0; i < 120; i += 1) {
      const id = `bulk${String(i).padStart(3, '0')}`;
      gas.stubs.createFile(id, {name: `${id}.csv`, bytes: Buffer.from('a'), lastUpdated: hourAgo(), createdTime: '2026-08-01T00:00:00Z'});
      fileIds.push(id);
    }
    gas.stubs.createFile('deep1', {name: 'deep.csv', bytes: Buffer.from('a'), lastUpdated: hourAgo(), createdTime: '2026-07-01T00:00:00Z'});
    gas.stubs.createFolder('sub1', {fileIds: ['deep1']});
    gas.stubs.createFolder('folder1', {fileIds, subFolderIds: ['sub1']});

    const candidates = plain(gas.call('scanUnprocessedFiles', ['C001']));
    assert.equal(candidates.length, 121, '120 paged files plus one in a subfolder');
    assert.equal(candidates[0].fileId, 'deep1', 'oldest createdTime first');
  });

  test('4.38: a transient Drive failure retries; four failures give up', () => {
    setup([]);
    gas.stubs.createFile('a1', {name: 'a.csv', bytes: Buffer.from('a'), lastUpdated: hourAgo()});
    gas.stubs.createFolder('folder1', {fileIds: ['a1']});

    gas.stubs.setDriveListFailures([429]);
    const ok = plain(gas.call('scanUnprocessedFiles', ['C001']));
    assert.equal(ok.length, 1, 'one 429 must be retried, not surfaced');

    gas.stubs.setDriveListFailures([500, 500, 503, 429]);
    assert.throws(() => gas.call('scanUnprocessedFiles', ['C001']),
      (error) => error && error.code === 'TRANSIENT_DRIVE_ERROR');
  });

  test('INV-24 mode 2: unchanged meta computes no hash; changed meta does', () => {
    const modified = new Date(Date.now() - 24 * 3600 * 1000);
    setup([
      indexRow({fileId: 'same1', modifiedTime: modified.toISOString(), revision: 'rev-1'}),
      indexRow({fileId: 'moved1', modifiedTime: modified.toISOString(), revision: 'rev-0',
        binaryHash: 'h'.repeat(64)})
    ]);
    gas.stubs.createFile('same1', {name: 's.csv', bytes: Buffer.from('abc'), lastUpdated: modified, revisionId: 'rev-1'});
    gas.stubs.createFile('moved1', {name: 'm.csv', bytes: Buffer.from('def'), lastUpdated: modified, revisionId: 'rev-1'});
    gas.stubs.createFolder('folder1', {fileIds: ['same1', 'moved1']});

    const result = plain(gas.call('scanProcessedFilesForChange', ['C001', {}]));
    assert.equal(result.scannedCount, 2);
    const same = result.probes.filter((p) => p.fileId === 'same1')[0];
    assert.equal(same.hashComputed, false, 'null means not-fetched, never mismatch');
    assert.equal(same.changed, false);
    const moved = result.probes.filter((p) => p.fileId === 'moved1')[0];
    assert.equal(moved.hashComputed, true);
    assert.equal(moved.changed, true);
    assert.equal(moved.after.binaryHash.length, 64);
  });

  test('mode 2 is read-only: no state transition, no lease row', () => {
    const modified = new Date(Date.now() - 24 * 3600 * 1000);
    setup([indexRow({fileId: 'same1', modifiedTime: modified.toISOString(), revision: 'rev-1'})]);
    gas.stubs.createFile('same1', {name: 's.csv', bytes: Buffer.from('abc'), lastUpdated: modified, revisionId: 'rev-1'});
    gas.stubs.createFolder('folder1', {fileIds: ['same1']});
    gas.call('scanProcessedFilesForChange', ['C001', {}]);
    const state = gas.stubs.getSpreadsheet('master').getSheetByName('恒久ファイルインデックス')
      .getRange(2, 4).getValue();
    assert.equal(state, 'COMPLETED', 'the probe must not touch the internal state');
  });
};
