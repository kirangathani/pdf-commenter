import { App, TFile, prepareFuzzySearch } from 'obsidian';

type LinkTarget = {
	file: TFile;
	matchText: string; // the string we fuzzy-match against (basename, alias, or path)
	displayText: string; // what to show in the dropdown
	isAlias: boolean;
};

export class WikilinkSuggest {
	private app: App;
	private textarea: HTMLTextAreaElement;
	private popup: HTMLDivElement;
	private items: LinkTarget[] = [];
	private activeIndex = 0;
	private limit = 12;

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

	private buildLinkTargets(): LinkTarget[] {
		const files = this.app.vault.getMarkdownFiles();
		const targets: LinkTarget[] = [];

		for (const file of files) {
			// Primary target: basename
			targets.push({
				file,
				matchText: file.basename,
				displayText: file.basename,
				isAlias: false,
			});

			// Also match against full path (without extension) for disambiguation
			if (file.parent && file.parent.path !== '/') {
				targets.push({
					file,
					matchText: file.path.replace(/\.md$/, ''),
					displayText: file.path.replace(/\.md$/, ''),
					isAlias: false,
				});
			}

			// Aliases from frontmatter via metadataCache
			const cache = this.app.metadataCache.getFileCache(file);
			const aliases = cache?.frontmatter?.aliases;
			if (Array.isArray(aliases)) {
				for (const alias of aliases) {
					if (typeof alias === 'string' && alias.trim()) {
						targets.push({
							file,
							matchText: alias.trim(),
							displayText: alias.trim(),
							isAlias: true,
						});
					}
				}
			} else if (typeof aliases === 'string' && aliases.trim()) {
				// Handle single alias as string
				targets.push({
					file,
					matchText: aliases.trim(),
					displayText: aliases.trim(),
					isAlias: true,
				});
			}
		}

		return targets;
	}

	private getSuggestions(query: string): LinkTarget[] {
		const targets = this.buildLinkTargets();

		if (!query) {
			// Deduplicate by file (prefer basename entry)
			const seen = new Set<string>();
			const results: LinkTarget[] = [];
			for (const t of targets) {
				if (t.isAlias) continue;
				if (t.file.parent && t.file.parent.path !== '/' && t.matchText.includes('/')) continue;
				if (seen.has(t.file.path)) continue;
				seen.add(t.file.path);
				results.push(t);
				if (results.length >= this.limit) break;
			}
			return results;
		}

		const search = prepareFuzzySearch(query);
		const scored: { target: LinkTarget; score: number }[] = [];

		for (const t of targets) {
			const result = search(t.matchText);
			if (result !== null) {
				scored.push({ target: t, score: result.score });
			}
		}

		// Sort by score descending, then deduplicate by file+displayText
		scored.sort((a, b) => b.score - a.score);
		const seen = new Set<string>();
		const results: LinkTarget[] = [];
		for (const s of scored) {
			const key = `${s.target.file.path}::${s.target.displayText}`;
			if (seen.has(key)) continue;
			seen.add(key);
			results.push(s.target);
			if (results.length >= this.limit) break;
		}

		return results;
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

	private accept(target: LinkTarget): void {
		const trigger = this.getTrigger();
		if (!trigger) return;
		const before = this.textarea.value.slice(0, trigger.start);
		const after = this.textarea.value.slice(this.textarea.selectionStart);
		// Use alias pipe syntax if the match was via an alias
		const linkText = target.isAlias
			? `[[${target.file.basename}|${target.displayText}]]`
			: `[[${target.displayText}]]`;
		this.textarea.value = before + linkText + after;
		const cursorPos = before.length + linkText.length;
		this.textarea.setSelectionRange(cursorPos, cursorPos);
		this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
		this.hide();
	}

	private renderItems(): void {
		this.popup.empty();
		for (let i = 0; i < this.items.length; i++) {
			const target = this.items[i];
			const el = this.popup.createEl('div', { cls: 'mg-suggest-item' });
			el.createSpan({ text: target.displayText });
			// Show folder path for context, and alias indicator
			const folder = target.file.parent?.path;
			const suffix = target.isAlias ? ` (alias for ${target.file.basename})` : '';
			const pathText = (folder && folder !== '/' ? folder : '') + suffix;
			if (pathText) {
				el.createSpan({ cls: 'mg-suggest-path', text: pathText });
			}
			if (i === this.activeIndex) el.addClass('is-active');
			el.addEventListener('mousedown', (e) => {
				e.preventDefault(); // keep textarea focused
				this.accept(target);
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
