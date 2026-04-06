import { Plugin, PluginManifest, PluginSettingTab, Setting, FuzzySuggestModal, TFile, App } from "obsidian";
import { VIEW_TYPE_PDF_COMMENTER, PdfCommenterView } from './view';

interface PdfCommenterSettings {
	accentColor: string;
	useObsidianAccent: boolean;
	darkMode: 'auto' | 'light' | 'dark';
}

const DEFAULT_SETTINGS: PdfCommenterSettings = {
	accentColor: '#7c3aed',
	useObsidianAccent: false,
	darkMode: 'auto',
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
	const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!m) return null;
	return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function darkenHex(hex: string, amount: number): string {
	const rgb = hexToRgb(hex);
	if (!rgb) return hex;
	const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
	const r = clamp(rgb.r * (1 - amount));
	const g = clamp(rgb.g * (1 - amount));
	const b = clamp(rgb.b * (1 - amount));
	return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function resolveColorToHex(color: string): string | null {
	const el = document.createElement('div');
	el.style.color = color;
	document.body.appendChild(el);
	const computed = getComputedStyle(el).color;
	el.remove();
	const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(computed);
	if (!m) return null;
	const r = parseInt(m[1]);
	const g = parseInt(m[2]);
	const b = parseInt(m[3]);
	return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function getObsidianAccentHex(): string {
	const raw = getComputedStyle(document.body).getPropertyValue('--interactive-accent').trim();
	if (!raw) return '#7c3aed';
	return resolveColorToHex(raw) ?? '#7c3aed';
}

function applyAccentColor(color: string): void {
	const rgb = hexToRgb(color);
	if (!rgb) return;
	const { r, g, b } = rgb;
	const hover = darkenHex(color, 0.12);

	document.body.style.setProperty('--pdf-commenter-accent', color);
	document.body.style.setProperty('--pdf-commenter-accent-hover', hover);
	document.body.style.setProperty('--pdf-commenter-accent-25', `rgba(${r}, ${g}, ${b}, 0.25)`);
	document.body.style.setProperty('--pdf-commenter-accent-35', `rgba(${r}, ${g}, ${b}, 0.35)`);
	document.body.style.setProperty('--pdf-commenter-accent-40', `rgba(${r}, ${g}, ${b}, 0.4)`);
	document.body.style.setProperty('--pdf-commenter-accent-12', `rgba(${r}, ${g}, ${b}, 0.12)`);
}

function clearAccentColor(): void {
	const props = [
		'--pdf-commenter-accent', '--pdf-commenter-accent-hover',
		'--pdf-commenter-accent-25', '--pdf-commenter-accent-35',
		'--pdf-commenter-accent-40', '--pdf-commenter-accent-12',
	];
	for (const p of props) document.body.style.removeProperty(p);
}

class PdfFileSuggestModal extends FuzzySuggestModal<TFile> {
	getItems(): TFile[] {
		return this.app.vault.getFiles().filter(f => f.extension === 'pdf');
	}
	getItemText(item: TFile): string {
		return item.path;
	}
	onChooseItem(item: TFile): void {
		void this.app.workspace.getLeaf(false).openFile(item);
	}
}

export default class PdfCommenterPlugin extends Plugin {
	settings: PdfCommenterSettings = DEFAULT_SETTINGS;
	private darkModeObserver: MutationObserver | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.applyAccent();
		this.applyDarkMode();
		this.addSettingTab(new PdfCommenterSettingTab(this.app, this));
		// Register the custom view
		this.registerView(
			VIEW_TYPE_PDF_COMMENTER,
			// NOTE: Obsidian's runtime manifest includes `dir` (folder name under .obsidian/plugins).
			// This can differ from `id` during development if the folder name doesn't match.
			(leaf) => new PdfCommenterView(leaf, { pluginId: this.manifest.id, pluginDir: (this.manifest as PluginManifest & { dir?: string }).dir ?? this.manifest.id })
		);

		// Claim .pdf extension from built-in viewer
		// @ts-expect-error viewRegistry is an undocumented internal API
		this.app.viewRegistry.unregisterExtensions(['pdf']);
		this.registerExtensions(['pdf'], VIEW_TYPE_PDF_COMMENTER);

		// Ribbon icon opens a fuzzy file picker filtered to PDFs
		this.addRibbonIcon("eye", "Open PDF", () => {
			new PdfFileSuggestModal(this.app).open();
		});

		// Command to open PDF picker
		this.addCommand({
			id: "open-pdf-viewer",
			name: "Open PDF",
			callback: () => {
				new PdfFileSuggestModal(this.app).open();
			}
		});
	}

	onunload(): void {
		this.darkModeObserver?.disconnect();
		this.darkModeObserver = null;
		document.body.classList.remove('pdf-commenter-dark');
		clearAccentColor();
		// Restore built-in PDF viewer
		// @ts-expect-error viewRegistry is an undocumented internal API
		this.app.viewRegistry.unregisterExtensions(['pdf']);
		// @ts-expect-error viewRegistry is an undocumented internal API
		this.app.viewRegistry.registerExtensions(['pdf'], 'pdf');
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	applyAccent(): void {
		const color = this.settings.useObsidianAccent
			? getObsidianAccentHex()
			: this.settings.accentColor;
		applyAccentColor(color);
	}

	applyDarkMode(): void {
		this.darkModeObserver?.disconnect();
		this.darkModeObserver = null;

		const resolve = () => {
			const mode = this.settings.darkMode;
			let isDark: boolean;
			if (mode === 'auto') {
				isDark = document.body.classList.contains('theme-dark');
			} else {
				isDark = mode === 'dark';
			}
			document.body.classList.toggle('pdf-commenter-dark', isDark);
			if (this.settings.useObsidianAccent) this.applyAccent();
		};

		resolve();

		if (this.settings.darkMode === 'auto') {
			this.darkModeObserver = new MutationObserver(() => resolve());
			this.darkModeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
		}
	}
}

class PdfCommenterSettingTab extends PluginSettingTab {
	plugin: PdfCommenterPlugin;

	constructor(app: App, plugin: PdfCommenterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Use Obsidian accent colour')
			.setDesc('Match the accent colour you have set in Obsidian\'s Appearance settings.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.useObsidianAccent)
				.onChange(async (value) => {
					this.plugin.settings.useObsidianAccent = value;
					this.plugin.applyAccent();
					await this.plugin.saveSettings();
					this.display();
				})
			);

		if (!this.plugin.settings.useObsidianAccent) {
			new Setting(containerEl)
				.setName('Accent colour')
				.setDesc('The colour used for comment markers, highlights, and buttons.')
				.addColorPicker(picker => picker
					.setValue(this.plugin.settings.accentColor)
					.onChange(async (value) => {
						this.plugin.settings.accentColor = value;
						this.plugin.applyAccent();
						await this.plugin.saveSettings();
					})
				);
		}

		new Setting(containerEl)
			.setName('Appearance')
			.setDesc('Control light or dark appearance for comment cards and controls.')
			.addDropdown(dropdown => dropdown
				.addOption('auto', 'Follow Obsidian theme')
				.addOption('light', 'Always light')
				.addOption('dark', 'Always dark')
				.setValue(this.plugin.settings.darkMode)
				.onChange(async (value) => {
					this.plugin.settings.darkMode = value as 'auto' | 'light' | 'dark';
					this.plugin.applyDarkMode();
					await this.plugin.saveSettings();
				})
			);
	}
}
