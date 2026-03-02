import { App, TFile, prepareFuzzySearch } from 'obsidian';

export class WikilinkSuggest {
	private app: App;
	private textarea: HTMLTextAreaElement;
	private popup: HTMLDivElement;
	private items: TFile[] = [];
	private activeIndex = 0;
	private limit = 8;

	private inputHandler: () => void;
	private keydownHandler: (e: KeyboardEvent) => void;

	constructor(app: App, textarea: HTMLTextAreaElement) {
		this.app = app;
		this.textarea = textarea;

		this.popup = document.createElement('div');
		this.popup.addClass('mg-suggest-container');
		document.body.appendChild(this.popup);

		this.inputHandler = () => this.onInput();
		this.keydownHandler = (e: KeyboardEvent) => this.onKeydown(e);

		this.textarea.addEventListener('input', this.inputHandler);
		this.textarea.addEventListener('keydown', this.keydownHandler);
	}

	destroy(): void {
		this.textarea.removeEventListener('input', this.inputHandler);
		this.textarea.removeEventListener('keydown', this.keydownHandler);
		this.popup.remove();
	}

	private getTrigger(): { start: number; query: string } | null {
		const pos = this.textarea.selectionStart;
		const text = this.textarea.value.slice(0, pos);
		const open = text.lastIndexOf('[[');
		if (open === -1) return null;
		if (text.indexOf(']]', open) !== -1) return null;
		return { start: open, query: text.slice(open + 2) };
	}

	private getSuggestions(query: string): TFile[] {
		const files = this.app.vault.getMarkdownFiles();
		if (!query) return files.slice(0, this.limit);
		const search = prepareFuzzySearch(query);
		return files
			.map(f => ({ file: f, result: search(f.basename) }))
			.filter(x => x.result !== null)
			.sort((a, b) => b.result!.score - a.result!.score)
			.slice(0, this.limit)
			.map(x => x.file);
	}

	private onInput(): void {
		const trigger = this.getTrigger();
		if (!trigger) {
			this.hide();
			return;
		}
		const suggestions = this.getSuggestions(trigger.query);
		if (suggestions.length === 0) {
			this.showEmpty();
			return;
		}
		this.items = suggestions;
		this.activeIndex = 0;
		this.renderItems();
		this.show();
	}

	private onKeydown(e: KeyboardEvent): void {
		if (!this.isVisible()) return;

		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				this.activeIndex = (this.activeIndex + 1) % this.items.length;
				this.updateActive();
				break;
			case 'ArrowUp':
				e.preventDefault();
				this.activeIndex = (this.activeIndex - 1 + this.items.length) % this.items.length;
				this.updateActive();
				break;
			case 'Enter':
				if (this.items.length > 0) {
					e.preventDefault();
					this.accept(this.items[this.activeIndex]);
				}
				break;
			case 'Escape':
				e.preventDefault();
				this.hide();
				break;
		}
	}

	private accept(file: TFile): void {
		const trigger = this.getTrigger();
		if (!trigger) return;
		const before = this.textarea.value.slice(0, trigger.start);
		const after = this.textarea.value.slice(this.textarea.selectionStart);
		const link = `[[${file.basename}]]`;
		this.textarea.value = before + link + after;
		const cursorPos = before.length + link.length;
		this.textarea.setSelectionRange(cursorPos, cursorPos);
		this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
		this.hide();
	}

	private renderItems(): void {
		this.popup.empty();
		for (let i = 0; i < this.items.length; i++) {
			const file = this.items[i];
			const el = this.popup.createEl('div', { cls: 'mg-suggest-item' });
			el.createSpan({ text: file.basename });
			const folder = file.parent?.path;
			if (folder && folder !== '/') {
				el.createSpan({ cls: 'mg-suggest-path', text: folder });
			}
			if (i === this.activeIndex) el.addClass('is-active');
			el.addEventListener('mousedown', (e) => {
				e.preventDefault(); // keep textarea focused
				this.accept(file);
			});
			el.addEventListener('mouseover', () => {
				this.activeIndex = i;
				this.updateActive();
			});
		}
	}

	private showEmpty(): void {
		this.popup.empty();
		this.items = [];
		this.popup.createEl('div', { cls: 'mg-suggest-empty', text: 'No matching notes' });
		this.show();
	}

	private updateActive(): void {
		const children = this.popup.querySelectorAll('.mg-suggest-item');
		children.forEach((el, i) => {
			el.toggleClass('is-active', i === this.activeIndex);
		});
	}

	private isVisible(): boolean {
		return this.popup.hasClass('is-visible');
	}

	private show(): void {
		this.popup.addClass('is-visible');
		this.positionPopup();
	}

	private hide(): void {
		this.popup.removeClass('is-visible');
		this.items = [];
		this.activeIndex = 0;
	}

	private positionPopup(): void {
		const rect = this.textarea.getBoundingClientRect();
		const popupHeight = this.popup.offsetHeight;
		const spaceBelow = window.innerHeight - rect.bottom;
		if (spaceBelow >= popupHeight || spaceBelow >= rect.top) {
			this.popup.setCssStyles({ top: `${rect.bottom + 2}px` });
		} else {
			this.popup.setCssStyles({ top: `${rect.top - popupHeight - 2}px` });
		}
		this.popup.setCssStyles({ left: `${rect.left}px`, width: `${rect.width}px` });
	}
}
