'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createGasStubs} = require('./gas-stubs');

class GasHarness {
  constructor(options = {}) {
    this.srcDir = options.srcDir || path.resolve(__dirname, '..', 'src');
    const stubs = createGasStubs();
    this.stubs = stubs.control;
    this.context = vm.createContext({
      console,
      Date,
      ArrayBuffer,
      Uint8Array,
      Utilities: stubs.Utilities,
      SpreadsheetApp: stubs.SpreadsheetApp,
      Sheets: stubs.Sheets,
      DriveApp: stubs.DriveApp,
      Drive: stubs.Drive,
      Logger: stubs.Logger,
      LockService: stubs.LockService,
      Session: stubs.Session,
      PropertiesService: stubs.PropertiesService,
      ...options.globals
    });
  }

  loadProject() {
    const files = fs.readdirSync(this.srcDir)
      .filter((name) => name.endsWith('.gs'))
      .sort((a, b) => a.localeCompare(b, 'en'));
    for (const file of files) {
      const source = fs.readFileSync(path.join(this.srcDir, file), 'utf8');
      new vm.Script(source, {filename: file}).runInContext(this.context);
    }
    // 既定値を控える。テストは `SETTINGS` を書き換えるので、控えておかないと
    // 書換えが後続のテストファイルへ漏れ、緑・赤がファイル名の並び順に
    // 依存するようになる。
    this.defaultSettings = JSON.parse(JSON.stringify(this.evaluate('SETTINGS')));
    const originalReset = this.stubs.reset.bind(this.stubs);
    this.stubs.reset = () => {
      originalReset();
      this.context.__defaultSettings = this.defaultSettings;
      this.evaluate('Object.keys(__defaultSettings).forEach(function(key) {' +
        ' SETTINGS[key] = __defaultSettings[key]; });');
      delete this.context.__defaultSettings;
    };
    return files;
  }

  evaluate(source, filename = 'test-evaluation.js') {
    return new vm.Script(source, {filename}).runInContext(this.context);
  }

  call(functionName, args = []) {
    this.context.__gasHarnessArgs = args;
    try {
      return this.evaluate(`${functionName}.apply(null, __gasHarnessArgs)`);
    } finally {
      delete this.context.__gasHarnessArgs;
    }
  }

  json(expression) {
    return JSON.parse(JSON.stringify(this.evaluate(expression)));
  }
}

module.exports = {GasHarness};
