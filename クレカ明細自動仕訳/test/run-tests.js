'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {GasHarness} = require('./gas-harness');

const gas = new GasHarness();
const loadedFiles = gas.loadProject();
const tests = [];

function test(name, fn) {
  tests.push({name, fn});
}

const testFiles = fs.readdirSync(__dirname)
  .filter((name) => name.endsWith('.test.js'))
  .sort((a, b) => a.localeCompare(b, 'en'));

for (const testFile of testFiles) {
  require(path.join(__dirname, testFile))({test, assert, gas});
}

let failures = 0;
console.log(`Loaded GAS files: ${loadedFiles.join(', ')}`);
for (const {name, fn} of tests) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

console.log(`\n${tests.length - failures}/${tests.length} tests passed`);
if (failures > 0) {
  process.exitCode = 1;
}
