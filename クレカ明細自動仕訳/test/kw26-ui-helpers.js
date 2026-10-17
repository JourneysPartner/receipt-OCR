'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
  function browserWorld(responses = {}) {
    // 結果だけでは、空の待ち行列で早退した本を、残った本が補えてしまう。
    // Promise.allへ渡す本の寿命を観測し、相手の返事を待っていることも確かめる。
    const promiseGroups = [];
    class ObservedPromise extends Promise {
      static all(values) {
        const settled = values.map(() => false);
        promiseGroups.push(settled);
        values.forEach((value, index) => Promise.resolve(value).then(
          () => { settled[index] = true; }, () => { settled[index] = true; }));
        return super.all(values);
      }
    }
    class Node {
      constructor(tag = 'div') {
        this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
        this.listeners = {}; this._text = ''; this.value = ''; this.checked = false;
        this.disabled = false; this.hidden = false; this.className = '';
        this.dataset = {}; this.attributes = {};
      }
      set textContent(value) {
        this.children.forEach((child) => { child.parentNode = null; });
        this.children = []; this._text = '';
        if (this.tagName === '#TEXT') this._text = String(value);
        else if (String(value)) {
          const child = new Node('#text'); child._text = String(value);
          child.parentNode = this; this.children.push(child);
        }
      }
      get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) { this.children.splice(index, 1); child.parentNode = null; }
        return child;
      }
      get firstChild() { return this.children[0] || null; }
      get lastChild() { return this.children[this.children.length - 1] || null; }
      addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
      fire(name) {
        if (this.disabled) return [];
        return (this.listeners[name] || []).map((listener) => listener({target: this, preventDefault() {}}));
      }
      focus() {
        if (this.disabled || document.activeElement === this) return;
        if (document.activeElement) document.activeElement.blur();
        document.activeElement = this;
        this._focusedValue = this.value;
        this._focusedChecked = this.checked;
      }
      blur() {
        if (document.activeElement !== this) return;
        document.activeElement = null;
        if (this.value !== this._focusedValue || this.checked !== this._focusedChecked)
          this.fire('change');
      }
      setAttribute(name, value) { this.attributes[name] = String(value); }
      getAttribute(name) { return this.attributes[name] || null; }
      scrollIntoView() { this.scrolled = true; }
      showModal() { this.open = true; }
      close() { this.open = false; }
      querySelector(selector) { return find(this, selector)[0] || null; }
      querySelectorAll(selector) { return find(this, selector); }
      closest(tag) {
        let node = this;
        while (node && node.tagName.toLowerCase() !== tag.toLowerCase()) node = node.parentNode;
        return node;
      }
    }
    function find(root, selector) {
      const parts = selector.split(',').map((part) => part.trim());
      const matches = (node, part) => {
        if (part[0] === '.') {
          const [name, pseudo] = part.slice(1).split(':');
          return node.className.split(/\s+/).includes(name) && (!pseudo || pseudo !== 'checked' || node.checked);
        }
        if (part[0] === '#') return node.id === part.slice(1);
        if (part[0] === '[') return Object.hasOwn(node.attributes, part.slice(1, -1));
        return node.tagName.toLowerCase() === part.toLowerCase();
      };
      const result = [];
      function visit(node) {
        node.children.forEach((child) => {
          if (parts.some((part) => matches(child, part))) result.push(child);
          visit(child);
        });
      }
      visit(root); return result;
    }
    const root = new Node('body');
    const ids = {};
    const document = {
      activeElement: null,
      createElement(tag) { return new Node(tag); },
      getElementById(id) {
        if (!ids[id]) { ids[id] = new Node(); ids[id].id = id; root.appendChild(ids[id]); }
        return ids[id];
      },
      querySelector(selector) { return root.querySelector(selector); },
      querySelectorAll(selector) { return root.querySelectorAll(selector); }
    };
    const calls = [];
    const pending = [];
    const runner = {
      withSuccessHandler(success) { this.success = success; return this; },
      withFailureHandler(failure) { this.failure = failure; return this; }
    };
    for (const name of ['webAppBootstrap', 'webAppListFolder', 'webAppListReviews',
      'webAppFinalReview', 'webAppExplainUnknownFile', 'webAppPreviewFormat',
      'webAppSaveFormat', 'webAppRequeueFormatFiles', 'webAppReturnFileToCustomer',
      'webAppPrepareImport', 'webAppWithdrawFormat', 'webAppRunImport', 'webAppResolveReviews',
      'webAppRecheckCustomerFixFile']) {
      runner[name] = (...args) => {
        calls.push({name, args});
        const success = runner.success, failure = runner.failure;
        try {
          const reply = typeof responses[name] === 'function' ? responses[name](...args) : responses[name];
          if (reply && reply.defer === true) {
            pending.push({name, args, reply(value) { success(value); },
              reject(error) { failure(error); }});
          } else if (reply instanceof Error) failure(reply);
          else success(reply);
        } catch (error) { failure(error); }
      };
    }
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', '81_WebAppUi.html'), 'utf8');
    const script = /<script>([\s\S]*?)<\/script>/.exec(source)[1].replace(
      '    bootstrap();',
      '    globalThis.__ui = {state, el, startImport, startProgressTimer, TEXT, bootstrap, renderSelection, renderFiles, renderFormatPanel, previewFormat, saveFormat, returnFormatToCustomer, openFormat, chooseFolder, chooseCustomer, loadFinalReview, formatSetBusy, recheckCustomerFix: typeof recheckCustomerFix === "function" ? recheckCustomerFix : null};');
    const sandbox = {document, Promise: ObservedPromise, google: {script: {run: runner}}, window: {open() { return {}; }},
      setTimeout, clearTimeout, setInterval() { return 1; }, clearInterval() {}, console};
    vm.runInNewContext(script, sandbox);
    return {ui: sandbox.__ui, document, calls, pending, ids, root, Node, promiseGroups};
  }

module.exports = {browserWorld};
