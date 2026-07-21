/**
 * Minimal polyfills for the Obsidian DOM helpers that pdf-viewer.ts and
 * context-menu.ts rely on. Importing this module first lets the mock harness
 * run the real plugin classes unmodified in a plain browser page.
 */

type ElOptions = {
    cls?: string | string[];
    text?: string;
    attr?: Record<string, string | number | boolean | null>;
};

function applyOptions(el: HTMLElement, o?: ElOptions): HTMLElement {
    if (!o) return el;
    if (o.cls) {
        const classes = Array.isArray(o.cls) ? o.cls : o.cls.split(/\s+/);
        for (const c of classes) if (c) el.classList.add(c);
    }
    if (o.text != null) el.textContent = o.text;
    if (o.attr) {
        for (const [k, v] of Object.entries(o.attr)) {
            if (v == null) continue;
            el.setAttribute(k, String(v));
        }
    }
    return el;
}

function makeEl(tag: string, o?: ElOptions): HTMLElement {
    return applyOptions(document.createElement(tag), o);
}

const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
const anyWindow = window as unknown as Record<string, unknown>;

anyWindow.createEl = (tag: string, o?: ElOptions) => makeEl(tag, o);
anyWindow.createDiv = (o?: ElOptions) => makeEl('div', o);
anyWindow.createSpan = (o?: ElOptions) => makeEl('span', o);
anyWindow.activeDocument = document;
anyWindow.activeWindow = window;

proto.createEl = function (this: HTMLElement, tag: string, o?: ElOptions) {
    const el = makeEl(tag, o);
    this.appendChild(el);
    return el;
};
proto.createDiv = function (this: HTMLElement, o?: ElOptions) {
    const el = makeEl('div', o);
    this.appendChild(el);
    return el;
};
proto.createSpan = function (this: HTMLElement, o?: ElOptions) {
    const el = makeEl('span', o);
    this.appendChild(el);
    return el;
};
proto.empty = function (this: HTMLElement) {
    while (this.firstChild) this.removeChild(this.firstChild);
};
proto.setCssStyles = function (this: HTMLElement, styles: Record<string, string>) {
    for (const [k, v] of Object.entries(styles)) {
        (this.style as unknown as Record<string, string>)[k] = v;
    }
};
proto.addClass = function (this: HTMLElement, ...cls: string[]) { this.classList.add(...cls); };
proto.removeClass = function (this: HTMLElement, ...cls: string[]) { this.classList.remove(...cls); };
proto.toggleClass = function (this: HTMLElement, cls: string, on: boolean) { this.classList.toggle(cls, on); };
proto.hasClass = function (this: HTMLElement, cls: string) { return this.classList.contains(cls); };

// Document.body also needs the helpers (context-menu.ts uses activeDocument.body.createDiv).
export {};
