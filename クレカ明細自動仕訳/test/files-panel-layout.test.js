'use strict';

/**
 * 「ファイル一覧」の枠を要確認の上へ移した画面の並び（spec_purchase_only.md §9.1 の lay 1〜5）。
 * 値はすべて架空。実在の顧客・カード・明細は使わない。
 */
const fs = require('node:fs');
const path = require('node:path');
const {browserWorld} = require('./kw26-ui-helpers');

module.exports = ({test, assert}) => {
  function pageBody() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', '81_WebAppUi.html'), 'utf8');
    const body = /<body>([\s\S]*?)<script>/.exec(source);
    assert.ok(body, 'body が必要');
    return body[1];
  }

  function panel(html, name) {
    const match = new RegExp('<section class="panel ' + name + '"[\\s\\S]*?(?=<section class="panel|<\\/main>)')
      .exec(html);
    assert.ok(match, name + ' の枠が必要');
    return match[0];
  }

  function balance(text, tag) {
    const opens = (text.match(new RegExp('<' + tag + '\\b', 'g')) || []).length;
    const closes = (text.match(new RegExp('</' + tag + '>', 'g')) || []).length;
    return opens - closes;
  }

  function styleBlock(css, selector) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(escaped + '\\s*\\{([^}]*)\\}').exec(css);
    assert.ok(match, selector + ' の指定が必要');
    return match[1].replace(/\s+/g, ' ');
  }

  test('lay 1: the files panel sits between the drive and review panels directly under main', () => {
    const main = /<main class="workspace">([\s\S]*?)<\/main>/.exec(pageBody());
    assert.ok(main, 'main が必要');
    const html = main[1];
    const driveAt = html.indexOf('<section class="panel drive"');
    const filesAt = html.indexOf('<section class="panel files"');
    const reviewsAt = html.indexOf('<section class="panel reviews"');
    assert.ok(driveAt >= 0 && filesAt > driveAt && reviewsAt > filesAt);
    // ファイル一覧の枠は、Drive の枠を閉じた直後（ほかの要素で囲まれていない）。
    const before = html.slice(0, filesAt).trimEnd();
    assert.match(before, /<\/section>$/);
    assert.equal(balance(before, 'section'), 0);
    assert.equal(balance(before, 'div'), 0);
    assert.match(html.slice(filesAt),
      /^<section class="panel files" aria-labelledby="files-heading">[\s\S]*?<\/section>\s*<section class="panel reviews"/);
  });

  test('lay 2: file list progress reason and import button are in the files panel in order', () => {
    const html = pageBody();
    const files = panel(html, 'files');
    const positions = ['file-list', 'import-progress', 'import-disabled-reason', 'import-button']
      .map((id) => files.indexOf('id="' + id + '"'));
    assert.ok(positions.every((position) => position >= 0), JSON.stringify(positions));
    for (let i = 1; i < positions.length; i += 1) assert.ok(positions[i - 1] < positions[i]);
    const drive = panel(html, 'drive');
    assert.ok(drive.indexOf('id="folder-list"') >= 0);
    for (const id of ['file-list', 'import-button', 'import-progress'])
      assert.equal(drive.indexOf('id="' + id + '"'), -1, id);
  });

  test('lay 3: each moved id appears exactly once in the page', () => {
    const html = pageBody();
    for (const id of ['file-list', 'import-button', 'import-progress', 'files-empty', 'files-content'])
      assert.equal((html.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1, id);
  });

  test('lay 4: the wide grid puts files above reviews in the third column and stacks them narrow', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', '81_WebAppUi.html'), 'utf8');
    const style = /<style>([\s\S]*?)<\/style>/.exec(source);
    assert.ok(style, 'style が必要');
    const mediaAt = style[1].indexOf('@media (max-width: 1120px)');
    assert.ok(mediaAt >= 0, '狭い画面の指定が必要');
    const wide = style[1].slice(0, mediaAt);
    const narrow = style[1].slice(mediaAt);
    assert.match(styleBlock(wide, '.workspace'), /grid-template-rows: auto 1fr;/);
    for (const [selector, column, row] of [
      ['.panel.customers', 'grid-column: 1', 'grid-row: 1 / span 2'],
      ['.panel.drive', 'grid-column: 2', 'grid-row: 1 / span 2'],
      ['.panel.files', 'grid-column: 3', 'grid-row: 1'],
      ['.panel.reviews', 'grid-column: 3', 'grid-row: 2']]) {
      const declarations = styleBlock(wide, selector);
      assert.ok(declarations.includes(column + ';'), selector + ': ' + column);
      assert.ok(declarations.includes(row + ';'), selector + ': ' + row);
    }
    assert.match(styleBlock(narrow, '.workspace'), /grid-template-columns: 220px minmax\(340px, 1fr\);/);
    assert.match(styleBlock(narrow, '.workspace'), /grid-template-rows: auto auto 1fr;/);
    assert.match(styleBlock(narrow, '.panel.files'), /grid-column: 1 \/ -1; grid-row: 2;/);
    assert.match(styleBlock(narrow, '.panel.reviews'), /grid-column: 1 \/ -1; grid-row: 3;/);
  });

  test('lay 5: the files panel follows the selection and the import button keeps its conditions', () => {
    const world = browserWorld();
    const state = world.ui.state;
    world.ui.renderSelection();
    assert.equal(world.ids['files-empty'].hidden, false);
    assert.equal(world.ids['files-content'].hidden, true);
    assert.equal(world.ids['import-button'].disabled, true);
    assert.equal(world.ids['drive-empty'].hidden, false);
    assert.equal(world.ids['drive-content'].hidden, true);
    state.customers = [{customerId: 'C9001', customerName: '架空顧客', canImport: true}];
    state.selectedCustomerId = 'C9001';
    state.selectedFolderId = 'folder_fictional';
    world.ui.renderSelection();
    assert.equal(world.ids['files-empty'].hidden, true);
    assert.equal(world.ids['files-content'].hidden, false);
    assert.equal(world.ids['import-button'].disabled, false);
    assert.equal(world.ids['drive-empty'].hidden, true);
    assert.equal(world.ids['drive-content'].hidden, false);
    state.customers = [{customerId: 'C9002', customerName: '架空の担当外', canImport: false}];
    state.selectedCustomerId = 'C9002';
    world.ui.renderSelection();
    assert.equal(world.ids['files-empty'].hidden, true);
    assert.equal(world.ids['files-content'].hidden, false);
    assert.equal(world.ids['import-button'].disabled, true);
    assert.equal(world.ids['import-disabled-reason'].textContent, world.ui.TEXT.notAssignee);
  });
};
