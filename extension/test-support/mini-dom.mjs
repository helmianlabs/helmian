// A very small DOM, enough to run the extension's real selectors against a real
// element tree from Node.
//
// It exists so the tests exercise the selector strings the browser will use,
// rather than a hand-waved stub that answers "yes" to whatever it is asked. It
// supports exactly what the extension uses: tag names, class selectors,
// attribute selectors with = and *= and the case-insensitive i flag, and
// comma-separated lists.
//
// It is a test fixture. It is not a DOM implementation and it is not shipped.

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function parseSimpleSelector(selector) {
  const parsed = { tag: null, classes: [], attrs: [] };
  let rest = selector.trim();

  const tagMatch = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tagMatch) {
    parsed.tag = tagMatch[0].toLowerCase();
    rest = rest.slice(tagMatch[0].length);
  }

  const token = /\.([\w-]+)|\[([\w-]+)(?:(\*?=)"([^"]*)"\s*(i)?)?\]/g;
  let match = token.exec(rest);
  while (match !== null) {
    if (match[1]) {
      parsed.classes.push(match[1]);
    } else {
      parsed.attrs.push({
        name: match[2],
        op: match[3] || null,
        value: match[4] === undefined ? null : match[4],
        caseInsensitive: Boolean(match[5]),
      });
    }
    match = token.exec(rest);
  }

  return parsed;
}

function parseSelectorList(selector) {
  return String(selector).split(',').map(parseSimpleSelector);
}

function matchesSimple(node, parsed) {
  if (node.nodeType !== ELEMENT_NODE) return false;
  if (parsed.tag && node.tagName.toLowerCase() !== parsed.tag) return false;

  for (const className of parsed.classes) {
    if (!node.classList.contains(className)) return false;
  }

  for (const attr of parsed.attrs) {
    const actual = node.getAttribute(attr.name);
    if (actual === null) return false;
    if (attr.op === null) continue;
    const haystack = attr.caseInsensitive ? actual.toLowerCase() : actual;
    const needle = attr.caseInsensitive ? attr.value.toLowerCase() : attr.value;
    if (attr.op === '*=') {
      if (!haystack.includes(needle)) return false;
    } else if (haystack !== needle) {
      return false;
    }
  }

  return true;
}

class MiniText {
  constructor(text) {
    this.nodeType = TEXT_NODE;
    this.data = String(text);
    this.parentNode = null;
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === ELEMENT_NODE ? this.parentNode : null;
  }

  get textContent() {
    return this.data;
  }
}

class MiniElement {
  constructor(tagName, attributes = {}) {
    this.nodeType = ELEMENT_NODE;
    this.tagName = String(tagName).toUpperCase();
    this.attributes = new Map();
    this.childNodes = [];
    this.parentNode = null;
    for (const [name, value] of Object.entries(attributes)) {
      this.setAttribute(name, value);
    }
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === ELEMENT_NODE ? this.parentNode : null;
  }

  get classList() {
    const owner = this;
    return {
      contains(name) {
        return String(owner.getAttribute('class') || '').split(/\s+/).includes(name);
      },
      add(name) {
        const current = String(owner.getAttribute('class') || '').split(/\s+/).filter(Boolean);
        if (!current.includes(name)) current.push(name);
        owner.setAttribute('class', current.join(' '));
      },
      remove(name) {
        const current = String(owner.getAttribute('class') || '')
          .split(/\s+/).filter(Boolean).filter((entry) => entry !== name);
        owner.setAttribute('class', current.join(' '));
      },
    };
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  get className() {
    return this.getAttribute('class') || '';
  }

  set className(value) {
    this.setAttribute('class', value);
  }

  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(newNode, referenceNode) {
    const index = this.childNodes.indexOf(referenceNode);
    newNode.parentNode = this;
    if (index === -1) this.childNodes.push(newNode);
    else this.childNodes.splice(index, 0, newNode);
    return newNode;
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index !== -1) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  addEventListener(type, handler) {
    if (!this.listeners) this.listeners = new Map();
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  // Test-side helper: fires whatever addEventListener registered.
  dispatch(type, event = {}) {
    const handlers = (this.listeners && this.listeners.get(type)) || [];
    handlers.forEach((handler) => handler(event));
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this.childNodes.forEach((child) => { child.parentNode = null; });
    this.childNodes = [];
    this.appendChild(new MiniText(value));
  }

  get innerText() {
    return this.textContent;
  }

  * descendants() {
    for (const child of this.childNodes) {
      if (child.nodeType !== ELEMENT_NODE) continue;
      yield child;
      yield* child.descendants();
    }
  }

  matches(selector) {
    return parseSelectorList(selector).some((parsed) => matchesSimple(this, parsed));
  }

  querySelectorAll(selector) {
    const parsedList = parseSelectorList(selector);
    const found = [];
    for (const node of this.descendants()) {
      if (parsedList.some((parsed) => matchesSimple(node, parsed))) found.push(node);
    }
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  closest(selector) {
    let node = this;
    while (node && node.nodeType === ELEMENT_NODE) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
}

// element('pre', { class: 'x' }, [ element('code', {}, ['rm -rf /']) ])
export function element(tagName, attributes = {}, children = []) {
  const node = new MiniElement(tagName, attributes);
  for (const child of children) {
    node.appendChild(typeof child === 'string' ? new MiniText(child) : child);
  }
  return node;
}

export function text(value) {
  return new MiniText(value);
}

// A stand-in for `document`. collectCodeBlocks only ever calls querySelectorAll
// on it, so a root element is a faithful stand-in.
export function documentWith(children) {
  return element('body', {}, children);
}

// A fuller stand-in, for the tests that load ui.js and guard.js — those call
// document.createElement and read document.body.
export function createDocument(children = []) {
  const body = element('body', {}, children);
  const doc = {
    nodeType: 9,
    body,
    documentElement: body,
    createElement: (tagName) => element(tagName),
    createTextNode: (value) => text(value),
    querySelector: (selector) => (body.matches(selector) ? body : body.querySelector(selector)),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
  };
  return doc;
}

export { MiniElement, MiniText };
